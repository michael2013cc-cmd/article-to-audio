#!/usr/bin/env node
/**
 * preflight-all.mjs — 稿件層全量預檢，一次過關掉所有會在合成階段炸掉的東西。
 *
 * 背景：narrate.mjs 的預檢閘門只擋「驗證鍵不在稿子裡」。但還有一整類問題是在
 * TTS 之前就該抓的，抓到了就不用燒音頻預算：
 *
 *   1. 假鍵       — 驗證鍵不在稿子裡 → 永遠命中不了，報告成 miss，白跑一輪 TTS+STT
 *   2. 損壞字元   — U+FFFD。narrate.mjs 的 loadSegments 會直接報錯中止
 *   3. 超長段     — 段長 > 120 字，STT 分片邊界與 TTS 呼吸都會受影響
 *   4. 段尾裸數字 — 段尾是「1」或「8,」這種形狀時，TTS 把它單獨念出來最容易錯
 *   5. md↔segs   — 稿子改了但 segs 沒重生成 → 音頻跟稿子對不上
 *
 * 用法：
 *   node scripts/preflight-all.mjs --pair chip-research/ep12a_segs.json:chip-research/ep12a_keys.json:output/ep12a.md
 *   node scripts/preflight-all.mjs --pair a.json:b.json --pair c.json:d.json:script.md
 *
 * 離線、不呼叫任何 API。exit 0 = 全過，exit 1 = 有段落要修。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { preflight } from './keys.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const pairs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--pair') pairs.push(argv[i + 1]);
}
if (!pairs.length) {
  console.error('用法：node scripts/preflight-all.mjs --pair <segs.json>:<keys.json>[:<script.md>] [--pair ...]');
  process.exit(2);
}

const loadSegs = (p) => {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.segments;
  return arr.map((s) => (typeof s === 'string' ? s : (s.text || s.content || '')));
};

let bad = 0;
for (const spec of pairs) {
  const [segsPath, keysPath, mdPath] = spec.split(':');
  const missing = [segsPath, keysPath].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.log(`${segsPath}  ✗ 缺檔案：${missing.join(', ')}`);
    bad = 1;
    continue;
  }
  const segs = loadSegs(segsPath);
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const bogus = preflight(keys, segs);
  const corrupt = segs.filter((s) => /\ufffd/.test(s)).length;
  const long = segs.filter((s) => s.length > 120).length;
  // 與 md2segs.mjs 用同一條規則（去 markdown 後以數字／逗號／句點結尾），
  // 兩邊判定不一致會製造假警報。
  const isBareTail = (s) => /[\d,.]$/.test(s.replace(/\*\*|__/g, '').trim());
  const tailHits = segs.map((s, i) => [i + 1, s]).filter(([, s]) => isBareTail(s));
  const tail = tailHits.length;

  let consistent = 'n/a';
  if (mdPath) {
    if (!fs.existsSync(mdPath)) {
      consistent = '稿子缺檔';
    } else {
      const tmp = path.join('/tmp', `pf_${path.basename(segsPath)}`);
      try {
        execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'md2segs.mjs'),
          '--md', mdPath, '--out', tmp], { stdio: 'ignore' });
        const re = loadSegs(tmp);
        consistent = re.join('|') === segs.join('|') ? '一致' : `不一致(md2segs=${re.length} vs segs=${segs.length})`;
        fs.unlinkSync(tmp);
      } catch {
        consistent = 'md2segs 失敗';
      }
    }
  }

  const flag = bogus.length || corrupt || long || tail || (consistent !== '一致' && consistent !== 'n/a');
  if (flag) bad = 1;
  console.log(
    `${path.basename(segsPath).replace(/_segs\.json$/, '').padEnd(6)} segs=${String(segs.length).padStart(3)}` +
    `  keys=${String(keys.length).padStart(3)}` +
    `  假鍵=${bogus.length ? bogus.join(',') : '0'}` +
    `  損壞=${corrupt}  超長=${long}  段尾裸數字=${tail}` +
    `  md↔segs=${consistent}${flag ? '   ✗' : '   ✓'}`,
  );
  if (bogus.length) console.log(`        ↳ 這些鍵不在稿子裡，會被報成「未命中」：${bogus.join(', ')}`);
  if (tail) {
    console.log(`        ↳ 段尾裸數字段落：${tailHits.map(([i, s]) => `${i}「${s.replace(/\*\*|__/g, '').trim().slice(-24)}」`).join('  ')}`);
  }
}
console.log(bad ? '\n有段落需要處理' : '\n全部通過 ✅');
process.exit(bad);
