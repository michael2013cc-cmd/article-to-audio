/**
 * CLI 層整合測試：md2segs（稿→分段）與 preflight-all（稿件層全量預檢）。
 *
 * 這兩道是管線上最關鍵的閘門：
 *  - 分段切錯 → 音檔的句子順序會錯位
 *  - 預檢漏掉假鍵 → 驗證時會出現「音頻明明有數字，卻說沒命中」���無意義追查
 *
 * 全部離線執行，不碰網路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));

const run = (script, args) => {
  try {
    const stdout = execFileSync('node', [path.join(SCRIPTS, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

const writeTmp = (name, content) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return p;
};

const segsOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).segments;

/* ---------- md2segs ---------- */

test('md2segs 以空行切段', () => {
  const md = writeTmp('a.md', '第一段。\n\n第二段。\n\n第三段。');
  const out = path.join(TMP, 'a_segs.json');
  const r = run('md2segs.mjs', ['--md', md, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(segsOf(out).length, 3);
});

test('md2segs 超長段會再切，且不超過上限', () => {
  const long = '這是一個很長的句子。'.repeat(20);
  const md = writeTmp('b.md', long);
  const out = path.join(TMP, 'b_segs.json');
  const r = run('md2segs.mjs', ['--md', md, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  for (const s of segsOf(out)) {
    assert.ok(s.length <= 120, `段長 ${s.length} 超過 120`);
  }
});

test('md2segs 切點落在句號，不落在逗號或頓號', () => {
  const md = writeTmp('c.md', '前半句，後半句，還有更多，然後結束。'.repeat(12));
  const out = path.join(TMP, 'c_segs.json');
  run('md2segs.mjs', ['--md', md, '--out', out]);
  for (const s of segsOf(out)) {
    // 段尾不可是逗號、頓號、空格、數字
    assert.ok(!/[\d,.、]$/.test(s), `段尾落在不該落的地方：「${s.slice(-12)}」`);
  }
});

test('md2segs 段尾不該是裸數字', () => {
  // 這正是 ep14c 曾踩到的坑：「8,700 token 每秒」被切成「8,」｜「700 token 每秒」
  const md = writeTmp('d.md', '吞吐量达到 8,700 token 每秒，这是基准值。');
  const out = path.join(TMP, 'd_segs.json');
  run('md2segs.mjs', ['--md', md, '--out', out]);
  for (const s of segsOf(out)) {
    assert.ok(!/[\d,.]$/.test(s), `段尾是裸數字：「${s.slice(-12)}」`);
  }
});

test('md2segs 在 segs.json 保留 markdown（剝除發生在 TTS 前）', () => {
  // md2segs 保留原稿的 ** 標記（narrate.mjs 在送進 TTS 前才 stripMarkdown），
  // 因為 segments.md 要能對回原稿。剝除本身由 md.mjs 的 stripMarkdown 負責。
  const md = writeTmp('e.md', '**重點** 在這裡。');
  const out = path.join(TMP, 'e_segs.json');
  run('md2segs.mjs', ['--md', md, '--out', out]);
  const t = segsOf(out).join('');
  assert.ok(t.includes('**'), 'segs.json 應保留 markdown 標記');
});

test('md2segs 缺少必要參數時 exit 2', () => {
  const r = run('md2segs.mjs', ['--md', 'x.md']);
  assert.equal(r.code, 2);
});

/* ---------- preflight-all ---------- */

test('preflight-all 對乾淨的一組回 exit 0', () => {
  const md = writeTmp('f.md', '峰值是 59.2%，沒有問題。');
  const out = path.join(TMP, 'f_segs.json');
  run('md2segs.mjs', ['--md', md, '--out', out]);
  const keys = writeTmp('f_keys.json', JSON.stringify(['59.2']));
  const r = run('preflight-all.mjs', ['--pair', `${out}:${keys}:${md}`]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('preflight-all 抓得出不在稿中的鍵', () => {
  const md = writeTmp('g.md', '峰值是 59.2%，沒有問題。');
  const out = path.join(TMP, 'g_segs.json');
  run('md2segs.mjs', ['--md', md, '--out', out]);
  const keys = writeTmp('g_keys.json', JSON.stringify(['59.2', '888888']));
  const r = run('preflight-all.mjs', ['--pair', `${out}:${keys}:${md}`]);
  assert.equal(r.code, 1, '有假鍵時應 exit 1');
  assert.match(r.stdout + r.stderr, /888888/);
});

test('preflight-all 抓得出損壞字元 U+FFFD', () => {
  const md = writeTmp('h.md', '這裡有個壞字元 � 應該被發現。');
  const out = path.join(TMP, 'h_segs.json');
  run('md2segs.mjs', ['--md', md, '--out', out]);
  const keys = writeTmp('h_keys.json', JSON.stringify([]));
  const r = run('preflight-all.mjs', ['--pair', `${out}:${keys}:${md}`]);
  assert.equal(r.code, 1, '有損壞字元時應 exit 1');
});

test('preflight-all 抓得出超長段', () => {
  const long = '這是一個很長的句子。'.repeat(20);
  const md = writeTmp('i.md', long);
  const out = path.join(TMP, 'i_segs.json');
  // 繞過切分，直接塞一個超長段
  fs.writeFileSync(out, JSON.stringify({ segments: [long] }));
  const keys = writeTmp('i_keys.json', JSON.stringify([]));
  const r = run('preflight-all.mjs', ['--pair', `${out}:${keys}`]);
  assert.equal(r.code, 1, '有超長段時應 exit 1');
});

test('preflight-all 缺 --pair 時 exit 2', () => {
  const r = run('preflight-all.mjs', []);
  assert.equal(r.code, 2);
});

test('preflight-all 缺必要參數時 usage 訊息要出現', () => {
  const r = run('preflight-all.mjs', []);
  assert.match(r.stderr + r.stdout, /--pair/);
});
