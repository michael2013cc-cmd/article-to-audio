#!/usr/bin/env node
/**
 * recover-parts.mjs — rebuild parts.json for a job directory that was
 * synthesised before parts.json existed.
 *
 * parts.json maps each script segment to its start offset in the merged mp3,
 * which is what --recheck needs to re-transcribe one specific segment.
 *
 * The node ids are assigned in request order, so sorting them numerically
 * usually reproduces the segment order. But "usually" is not good enough for
 * a tool that decides where to cut audio, so this script VERIFIES the
 * assignment: it checks the chars-per-second spread, and if the id-sorted
 * order looks wrong it falls back to matching segment lengths against part
 * durations.
 *
 * Usage:
 *   node recover-parts.mjs --jobdir <dir> --segments <segs.json> [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const jobdir = arg('jobdir');
const segFile = arg('segments');
if (!jobdir || !segFile) { console.error('--jobdir and --segments are required'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(segFile, 'utf8'));
const segs = Array.isArray(raw) ? raw : raw.segments;

const dur = (f) => parseFloat(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

// Part files only: exclude STT chunks, recheck windows and the silence pad.
const files = fs.readdirSync(jobdir)
  .filter(f => f.endsWith('.mp3') && !/^(stt_|recheck_|silence_)/.test(f))
  .map(f => path.join(jobdir, f));

if (files.length !== segs.length) {
  console.error(`✗ 段落数 ${segs.length} 与音频片段数 ${files.length} 不符`);
  process.exit(3);
}

const durs = files.map(f => dur(f));

/** Assign parts to segments and score the fit by chars-per-second spread. */
function score(order) {
  const rates = segs.map((s, i) => s.length / durs[order[i]]);
  const lo = Math.min(...rates), hi = Math.max(...rates);
  return { spread: hi / lo, order };
}

// Hypothesis 1: node ids are assigned in request order.
const byId = files.map((f, i) => ({ f, i }))
  .sort((a, b) => a.f.localeCompare(b.f, undefined, { numeric: true }))
  .map(x => x.i);
const h1 = score(byId);

// Hypothesis 2: match each segment to the part whose duration fits best.
const remaining = new Set(durs.map((_, i) => i));
const globalRate = segs.reduce((n, s) => n + s.length, 0) / durs.reduce((a, b) => a + b, 0);
const greedy = [];
for (const s of segs) {
  const want = s.length / globalRate;
  let best = null, bestD = Infinity;
  for (const i of remaining) {
    const dd = Math.abs(durs[i] - want);
    if (dd < bestD) { bestD = dd; best = i; }
  }
  remaining.delete(best);
  greedy.push(best);
}
const h2 = score(greedy);

const winner = h1.spread <= h2.spread ? h1 : h2;
console.log(`假设1 (按 node id 排序)  ch/s 离散度 ${h1.spread.toFixed(3)}`);
console.log(`假设2 (按时长匹配)      ch/s 离散度 ${h2.spread.toFixed(3)}`);
console.log(`采用: ${winner === h1 ? '假设1' : '假设2'}`);

if (winner.spread > 1.6) {
  console.error('✗ 两种假设都不干净，顺序存疑 —— 不要再用 --recheck。');
  process.exit(3);
}

const parts = winner.order.map((pi, i) => {
  const d = durs[pi];
  return { index: i, node_id: path.basename(files[pi], '.mp3'), duration: d,
           start: durs.slice(0, 0).length ? 0 : 0 };
});
// start offsets, in segment order
let cur = 0;
for (const p of parts) { p.start = cur; cur += p.duration; }

const out = arg('out', path.join(jobdir, 'parts.json'));
fs.writeFileSync(out, JSON.stringify(parts));
console.log(`✓ parts.json -> ${out}  (${parts.length} 段，总时长 ${cur.toFixed(1)}s)`);
