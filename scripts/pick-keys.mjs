#!/usr/bin/env node
/**
 * pick-keys.mjs — build a verification-key file that mixes the auto-ranked
 * candidates with the figures a human decided actually matter.
 *
 * The auto ranker scores by "distinctiveness" and happily hands back 67, 66,
 * 55 — round two-digit percentages that prove little. The headline numbers
 * (Q2 revenue, the CoWoS demand curve, the customer allocation) are the ones
 * worth proving, and they are often NOT in the top-N because the ranker
 * prefers decimals and small percentages.
 *
 * Every key still comes from the script's own candidate list, so it carries
 * the full set of accepted renderings ("45,000" | "45000" | "四万五千").
 * A value that does not appear in the script is reported and skipped — it can
 * never appear in the transcript.
 *
 * Usage:
 *   node pick-keys.mjs --segments segs.json --out keys.json \
 *        --auto 25 --values 402,7065.6,2694,1222
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractCandidates, rankCandidates } from './keys.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const file = arg('segments');
if (!file) { console.error('--segments is required'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const segs = Array.isArray(raw) ? raw : raw.segments;

const autoN = Number(arg('auto', 25));
const want = (arg('values', '') || '').split(',').map(s => s.trim()).filter(Boolean)
  .map(v => ({ raw: v, num: Number(v.replace(/,/g, '')) }))
  .filter(v => Number.isFinite(v.num));

const cands = extractCandidates(segs);
const picked = [];
const seen = new Set();
const add = c => {
  if (!c || seen.has(c.key)) return;
  seen.add(c.key);
  picked.push({ key: c.key, alts: c.alts, context: c.context, segment: c.segment + 1 });
};

for (const c of rankCandidates(cands, autoN)) add(c);

const missing = [];
for (const w of want) {
  // Match by numeric value; the candidate key may carry a thousands separator.
  const c = cands.find(x => x.value === w.num) ||
            cands.find(x => x.alts.some(a => a.replace(/,/g, '') === w.raw.replace(/,/g, '')));
  if (c) add(c); else missing.push(w.raw);
}

const out = arg('out');
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(picked, null, 2));
  console.log(`wrote ${out} — ${picked.length} keys`);
} else {
  console.log(JSON.stringify(picked, null, 2));
}
if (missing.length) {
  console.log(`\n⚠ ${missing.length} requested values are NOT in the script (skipped): ${missing.join(', ')}`);
}
