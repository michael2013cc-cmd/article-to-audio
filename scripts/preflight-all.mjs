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
import { preflight, normalizeScript } from './keys.mjs';

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
  // 「TTS 迴圈」檢查：把稿子正規化（＝模擬 TTS 把數字念出來、STT 讀回來），
  // 再拿正交化後的文字去比對鍵。連自己的稿子都對不上的鍵，**永遠不可能命中**
  // —— 那是鍵與稿件表示形式對不上，不是音頻的問題。
  // 實測抓到過 6 個（ep15a 的 5.38／2.69 億、ep15b 的 459.68 萬／4.8 萬、
  // ep16a 的 14.07 億）：稿寫「5.38 亿元」，TTS 念「五点三八億」，
  // 正交化成 538000000，鍵「5.38」就再也比不中了。
  const rt = normalizeScript([normalizeScript([segs.join('\n')])]);
  const rtMissing = keys.filter((k) => {
    // A key file may hold plain strings instead of {key, alts} objects.
    const label = typeof k === 'object' && k !== null ? k.key : k;
    const alts = (typeof k === 'object' && k !== null && Array.isArray(k.alts) && k.alts.length)
      ? k.alts : [label];
    const forms = [...alts, label];
    for (const f of forms) {
      const plain = String(f).replace(/,/g, '');
      if (plain !== f) forms.push(plain);
    }
    return !forms.some((f) => rt.includes(f));
  });
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

  // 假鍵偵測：自動產生的鍵可能是「別人產品型號內部的數字」——
  // MI355X 的 355、gfx950 的 950、Llama-3.3-70B 的 3.3、Qwen3.5-397B-A17B 的 397/17、
  // GLM-5.2 的 5.2、Kimi-K2.6 的 2.6。
  // 這些數字確實出現在稿子裡，但不是數據，TTS 念出來時常變形 → 回聽必然報 miss。
  // 判斷法：把鍵當 regex 回代稿子，若**所有**出現位置的前一個字元都是英數/連字號/點
  // （數字接在某個 token 後面，屬於那個 token 的一部分），就是疑似假鍵。
  //
  // 2026-10-23 修正：原本要求「前後都要是 tokenish」，結果漏掉
  // "GLM-5.2、MiniMax" —— 數字後面跟的是全形頓號「、」，不在 tokenish 集合裡，
  // 於是整個判定被放行。改成只看前一個字元：數字接在英數/連字號/點後面
  // 就是 token 內部，後面是什麼都不影響。
  const suspect = [];
  for (const k of keys) {
    // 鍵檔可能是「字串陣列」或「物件陣列 {key, alts, ...}」——
    // keys.mjs 的 preflight() 兩種都收，這裡也要一致，否則字串格式會直接 crash。
    const label = (k && typeof k === 'object') ? String(k.key ?? '') : String(k ?? '');
    if (!label) continue;
    const n = label.replace(/,/g, '');
    const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const hits = [];
    let m;
    const whole = segs.join('\n');
    while ((m = re.exec(whole)) !== null) {
      const before = whole.slice(Math.max(0, m.index - 1), m.index);
      const before2 = whole.slice(Math.max(0, m.index - 2), m.index - 1);
      const after = whole.slice(m.index + n.length, m.index + n.length + 1);
      // 數字落在某個 token 內部的三種樣態：
      //   1. 前一個字元是英文字母         → MI355X / gfx950 / HBM4
      //   2. 前一個字元是連字號或點，而那個前面是英數 → GLM-5.2 / Kimi-K2.6 / Llama-3.3
      //   3. 前一個字元是連字號，且數字後面接英文字母 → Llama-3.3-70B 的 70
      // 純數字接在數字後面不算（3.5 可能是 13.5 的一部分，那是真的）。
      const insideToken = /[A-Za-z]/.test(before)
        || (/[-.]/.test(before) && /[A-Za-z0-9]/.test(before2))
        || (before === '-' && /[A-Za-z]/.test(after));
      hits.push(insideToken);
      if (hits.length >= 6) break;
    }
    if (hits.length && hits.every(Boolean)) suspect.push(label);
  }

  const flag = bogus.length || rtMissing.length || corrupt || long || tail || (consistent !== '一致' && consistent !== 'n/a');
  if (flag) bad = 1;
  console.log(
    `${path.basename(segsPath).replace(/_segs\.json$/, '').padEnd(6)} segs=${String(segs.length).padStart(3)}` +
    `  keys=${String(keys.length).padStart(3)}` +
    `  假鍵=${bogus.length ? bogus.join(',') : '0'}` +
    `  迴圈不中=${rtMissing.length ? rtMissing.map((k) => k.key).join(',') : '0'}` +
    `  損壞=${corrupt}  超長=${long}  段尾裸數字=${tail}` +
    `  md↔segs=${consistent}${flag ? '   ✗' : '   ✓'}`,
  );
  if (bogus.length) console.log(`        ↳ 這些鍵不在稿子裡，會被報成「未命中」：${bogus.join(', ')}`);
  if (rtMissing.length) {
    console.log(`        ↳ 這些鍵連「TTS 念出來再讀回來」的稿子都比不中，**永遠不可能命中**（鍵缺縮放形式）：${rtMissing.map((k) => (typeof k === 'object' && k !== null ? k.key : k)).join(', ')}`);
    console.log(`          修法：node scripts/enrich-keys.mjs --segments ${path.basename(segsPath)} --keys ${path.basename(keysPath)}`);
  }
  if (suspect.length) console.log(`        ⚠ 疑似型號內部的假鍵（建議人工確認後刪除）：${suspect.join(', ')}`);
  if (tail) {
    console.log(`        ↳ 段尾裸數字段落：${tailHits.map(([i, s]) => `${i}「${s.replace(/\*\*|__/g, '').trim().slice(-24)}」`).join('  ')}`);
  }
}
console.log(bad ? '\n有段落需要處理' : '\n全部通過 ✅');
process.exit(bad);
