#!/usr/bin/env node
/**
 * enrich-keys.mjs — 為既有的鍵檔補上新的「可接受寫法」，但**不動鍵集合**。
 *
 * 為什麼需要：鍵檔是當初用 pick-keys.mjs 產生的，裡面的 alts 是那時
 * extractCandidates 能想到的寫法。後來正規化器變強（浮點精度、萬／億縮放、
 * 複合單位萬億），新的可接受寫法沒有回填到舊鍵檔裡，於是明明在音頻裡的
 * 數字被判成漏鍵。
 *
 * 規則：
 *   - 鍵集合與順序**完全不變**（覆蓋率數字因此仍可比）
 *   - 只做「alts 的聯集」：舊 alts ∪ 依現行 extractCandidates 重新算出的 alts
 *   - 依鍵值（去掉千分位後）比對候選；對不到就原樣保留
 *
 * 用法：node enrich-keys.mjs --segments <segs.json> --keys <keys.json> [--out <f>]
 */
import fs from 'node:fs';
import { extractCandidates } from './keys.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SEGS = arg('segments'), KEYS = arg('keys'), OUT = arg('out', KEYS);
if (!SEGS || !KEYS) { console.error('usage: enrich-keys.mjs --segments <f> --keys <f> [--out <f>]'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(SEGS, 'utf8'));
const segments = raw.segments || raw;
const keys = JSON.parse(fs.readFileSync(KEYS, 'utf8'));

// 候選索引：鍵值（去千分位）→ alts 聯集
const index = new Map();
for (const c of extractCandidates(segments)) {
  const k = String(c.key).replace(/,/g, '');
  if (!index.has(k)) index.set(k, new Set());
  for (const a of c.alts || []) index.get(k).add(a);
}

let changed = 0, added = 0;
const out = keys.map((k) => {
  const label = typeof k === 'string' ? k : k.key;
  const cand = index.get(String(label).replace(/,/g, ''));
  if (!cand) return k;
  const old = new Set((typeof k === 'object' && k.alts) ? k.alts : [label]);
  const merged = [...old];
  for (const a of cand) if (!old.has(a)) { merged.push(a); added++; }
  if (merged.length !== old.size) changed++;
  return typeof k === 'string' ? k : { ...k, alts: merged };
});

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`${OUT}: ${keys.length} 鍵，${changed} 鍵補上新的可接受寫法（共 ${added} 個 alt）`);
