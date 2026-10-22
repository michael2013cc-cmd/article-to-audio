#!/usr/bin/env node
/**
 * rt-check.mjs — 「TTS 迴圈」健全性檢查（零 API 成本）。
 *
 * 問題來源：驗證時會出現「這個鍵怎麼都命中不了」的情況。查下去才發現，
 * 有些鍵**連自己的稿子都比對不到**——不是音頻的問題，是鍵與稿件的表示形式
 * 對不上（例如稿寫「9,216」，TTS 念「九千二百一十六」，STT 回「9216」，
 * 任何一版都比不中「9,216」）。
 *
 * 做法：把稿子正交化（normalizeScript 會把中文數字／萬億換算回阿拉伯，
 * 等同於模擬 TTS 把數字念出來、STT 再讀回來的結果），然後拿正交化後的
 * 文字去跑 matchKeys。任何比不中的鍵都是**先天不可能命中**的鍵。
 *
 * 用法：
 *   node rt-check.mjs --segments chip-research/ep14a_segs.json \
 *        --keys chip-research/ep14a_keys.json
 *   node rt-check.mjs --all          # 掃描 chip-research 下所有 *_segs.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeScript } from './keys.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

/** 與 narrate.mjs 的 matchKeys 同一套邏輯（副本，避免拉進整個 narrate 模組）。 */
function matchKeys(text, keys) {
  const norm = normalizeScript([text]);
  const missing = [];
  for (const k of keys) {
    const label = typeof k === 'object' && k !== null ? k.key : k;
    const alts = (typeof k === 'object' && k !== null && Array.isArray(k.alts) && k.alts.length) ? k.alts : [label];
    const forms = [...alts, label];
    for (const f of forms) {
      const plain = f.replace(/,/g, '');
      if (plain !== f) forms.push(plain);
    }
    const found = forms.some(f => text.includes(f) || norm.includes(f));
    if (!found) missing.push(k);
  }
  return missing;
}

const load = (segsPath, keysPath) => {
  const raw = JSON.parse(fs.readFileSync(segsPath, 'utf8'));
  const segments = raw.segments || raw;
  const kr = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const keys = (Array.isArray(kr) ? kr : kr.keys || []).map(k => (typeof k === 'string' ? { key: k, alts: [k] } : k));
  return { segments, keys };
};

const pairs = [];
if (argv.includes('--all')) {
  const dir = 'chip-research';
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\w+)_segs\.json$/.exec(f);
    if (!m) continue;
    const kf = path.join(dir, `${m[1]}_keys.json`);
    if (fs.existsSync(kf)) pairs.push([path.join(dir, f), kf]);
  }
} else {
  const S = arg('segments'), K = arg('keys');
  if (!S || !K) { console.error('usage: rt-check.mjs --segments <f> --keys <f>  |  --all'); process.exit(2); }
  pairs.push([S, K]);
}

let bad = 0;
for (const [sp, kp] of pairs) {
  const { segments, keys } = load(sp, kp);
  const script = segments.join('\n');
  // 正交化兩次：第一次把中文數字換成阿拉伯，第二次處理連續替換的殘留
  const rt = normalizeScript([normalizeScript([script])]);
  const missing = matchKeys(rt, keys);
  const tag = path.basename(kp).replace('_keys.json', '');
  if (!missing.length) {
    console.log(`  ✅ ${tag}: ${keys.length} 鍵全部能對上「TTS 念出來再讀回來」的結果`);
  } else {
    bad++;
    console.log(`  ⚠️  ${tag}: ${keys.length - missing.length}/${keys.length} 能對上`);
    for (const m of missing) console.log(`       - ${m.key}  (可接受寫法: ${(m.alts || []).join(' / ')})`);
  }
}
console.log(bad ? `\n${bad} 個鍵檔有先天比不上的鍵。` : '\n全部鍵檔健全。');
process.exit(bad ? 1 : 0);
