#!/usr/bin/env node
/**
 * extract-keys.mjs — list verification-key candidates for a narration script.
 *
 * Use this BEFORE spending TTS+STT budget. It answers: "which numbers in this
 * script are worth verifying, and what will STT actually emit for each?"
 *
 * Usage:
 *   node extract-keys.mjs --segments segs.json [options]
 *
 *   --segments <file>   narration segments JSON (required)
 *   --top <n>           how many ranked keys to show, default 30
 *   --tier <a|b|both>   filter by tier, default both
 *   --all               list every candidate, not just the ranked top
 *   --json              machine-readable output
 *   --lint              only show rendering warnings
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractCandidates, rankCandidates, preflight, lintNumbers } from './keys.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = k => argv.includes(`--${k}`);

const file = arg('segments');
if (!file) { console.error('--segments is required'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const segs = Array.isArray(raw) ? raw : raw.segments;
if (!Array.isArray(segs) || !segs.length) { console.error('no segments in file'); process.exit(2); }

const tier = arg('tier', 'both');
const topN = Number(arg('top', 30));

if (flag('lint')) {
  const warns = lintNumbers(segs);
  console.log(`\n渲染提示 (${warns.length}) — 这些数字用中文写法，回听校验容易失真：\n`);
  for (const w of warns) {
    const arrow = w.suggest ? ` → ${w.suggest}` : ' → ？（量级歧义，需手工改写）';
    console.log(`  段 ${String(w.segment).padStart(2)}  ${w.run}${arrow}`);
    console.log(`        ${w.reason}`);
    console.log(`        ${w.context}`);
  }
  console.log('');
  process.exit(0);
}

let cands = extractCandidates(segs);
if (tier === 'a') cands = cands.filter(c => c.tier === 'A');
else if (tier === 'b') cands = cands.filter(c => c.tier === 'B');

const ranked = rankCandidates(cands, flag('all') ? cands.length : topN);
const bogus = preflight(ranked, segs);

if (flag('json')) {
  console.log(JSON.stringify({
    file: path.resolve(file),
    totalCandidates: cands.length,
    ranked: ranked.map(c => ({ key: c.key, alts: c.alts, tier: c.tier, value: c.value,
      segment: c.segment + 1, count: c.count, score: c.score, context: c.context })),
    lint: lintNumbers(segs),
  }, null, 2));
  process.exit(0);
}

console.log(`\n源文件: ${path.resolve(file)}`);
console.log(`段落数: ${segs.length}   候选数字: ${cands.length}\n`);
console.log('  #  段   层级  值        候选键 / 接受形式              上下文');
console.log('  ── ──── ──── ────────── ────────────────────────── ─────────────────────');
ranked.forEach((c, i) => {
  const alts = c.alts.length > 1 ? c.alts.join(' | ') : c.alts[0];
  console.log(
    `  ${String(i + 1).padStart(2)} ${String(c.segment + 1).padStart(4)} ` +
    `${c.tier === 'A' ? ' A ' : ' B '} ${String(c.value).padStart(9)} ` +
    `${alts.padEnd(26).slice(0, 26)} ${c.context.slice(0, 40)}`
  );
});

console.log('\n直接可用的 --verify 列表：');
console.log('  ' + ranked.map(c => c.alts[0]).join(',') + '\n');
console.log('提示：带 | 的候选键表示 STT 可能采用多种写法，命中任意一种即算通过。');
if (bogus.length) console.log(`\n  !! 这些键不在稿子里（已拦截）: ${bogus.join(', ')}`);
console.log('');
