#!/usr/bin/env node
/**
 * audit-segments.mjs — find silently-truncated segments.
 *
 * WHY: a TTS generation failure can drop the tail of a segment. The audio
 * stays plausible, the ch/s ratio of that segment goes UP (same character
 * count, less audio), and nothing in the transcript obviously says "missing".
 *
 * TWO MODES, in order of reliability:
 *
 *  --jobdir <dir>   measure every synthesized part file directly (ffprobe on
 *                   the part, not on the merged file). This is exact: the
 *                   part IS the segment, so no boundary detection is needed.
 *  --mp3 <file>    fall back to silence detection on a merged file. Weaker:
 *                   the TTS inserts its own pauses inside a segment, so
 *                   "silence" does not mean "segment boundary". Used only to
 *                   sanity-check the merge, never to accuse a segment.
 *
 * Usage:
 *   node audit-segments.mjs --jobdir .tts-narration/ep08a-upstream --segments segs.json
 *   node audit-segments.mjs --mp3 out.mp3 --segments segs.json [--gap 0.5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const jobdir = arg('jobdir');
const mp3 = arg('mp3');
const segFile = arg('segments');
const gap = Number(arg('gap', 0.5));
if (!segFile || (!jobdir && !mp3)) { console.error('--segments and (--jobdir | --mp3) are required'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(segFile, 'utf8'));
const segs = Array.isArray(raw) ? raw : raw.segments;

const dur = (f) => {
  try {
    return parseFloat(execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }).trim());
  } catch { return 0; }
};

/* ---------------- mode 1: per-part files (exact) ---------------- */
if (jobdir) {
  const items = JSON.parse(fs.readFileSync(path.join(jobdir, 'items.json'), 'utf8'));
  const byNum = new Map();
  for (const it of items) {
    const n = Number(String(it.file_name).match(/(\d+)/)?.[1]);
    const f = path.join(jobdir, `${it.node_id}.mp3`);
    if (Number.isFinite(n) && fs.existsSync(f)) byNum.set(n, f);
  }
  const rows = [];
  for (let i = 1; i <= segs.length; i++) {
    const f = byNum.get(i);
    if (!f) { rows.push({ i, chars: segs[i - 1].length, dur: 0, missing: true }); continue; }
    rows.push({ i, chars: segs[i - 1].length, dur: dur(f), cps: 0 });
  }
  const live = rows.filter(r => r.dur > 0);
  const rates = live.map(r => r.chars / r.dur).sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)];
  const total = live.reduce((n, r) => n + r.dur, 0);
  console.log(`段数 ${segs.length}  已有音频 ${live.length}  缺失 ${rows.length - live.length}`);
  console.log(`音频总长 ${total.toFixed(1)}s (${(total / 60).toFixed(2)} min，含段间静音约 ${((live.length - 1) * gap).toFixed(1)}s)`);
  console.log(`中位语速 ${med.toFixed(2)} 字/秒\n`);
  const flagged = [];
  for (const r of live) {
    r.cps = r.chars / r.dur;
    r.dev = r.cps / med;
    if (r.dev > 1.28 || r.dev < 0.6) flagged.push(r);
  }
  console.log('  段    字数    时长     ch/s    偏离');
  for (const r of live) {
    const mark = r.dev > 1.28 ? '  <<< 偏快：可能被截断' : (r.dev < 0.6 ? '  <<< 偏慢' : '');
    if (r.dev > 1.15 || r.dev < 0.85 || flagged.includes(r)) {
      console.log(`  ${String(r.i).padStart(3)} ${String(r.chars).padStart(6)} ${r.dur.toFixed(1).padStart(7)}s ${r.cps.toFixed(2).padStart(7)}  ${r.dev.toFixed(2)}x${mark}`);
    }
  }
  const missing = rows.filter(r => r.missing);
  console.log(`\n异常段: ${flagged.length}/${live.length}`);
  for (const f of flagged) {
    console.log(`\n  第 ${f.i} 段 (${f.chars}字, ${f.dur.toFixed(1)}s, ${f.cps.toFixed(2)} ch/s, ${f.dev.toFixed(2)}x中位)`);
    console.log(`    ${segs[f.i - 1].slice(0, 110)}`);
  }
  if (missing.length) {
    console.log(`\n缺音频的段 (${missing.length}): ${missing.map(m => m.i).join(', ')}`);
  }
  process.exit(flagged.length ? 5 : 0);
}

/* ---------------- mode 2: merged file (sanity only) ---------------- */
const total = dur(mp3);
const proc = spawnSync('ffmpeg', ['-v', 'info', '-i', mp3,
  '-af', 'silencedetect=noise=-42dB:d=0.18', '-f', 'null', '-'], { encoding: 'utf8' });
const stderr = (proc.stderr || '') + (proc.stdout || '');
// ffmpeg prints silence_start and silence_end on SEPARATE lines, so they must
// be paired up by hand. A one-line regex silently matched nothing.
const silences = [];
let openStart = null;
for (const line of stderr.split('\n')) {
  const s = line.match(/silence_start:\s*([0-9.]+)/);
  if (s) { openStart = parseFloat(s[1]); continue; }
  const e = line.match(/silence_end:\s*([0-9.]+)/);
  if (e && openStart !== null) { silences.push([openStart, parseFloat(e[1])]); openStart = null; }
}
console.log(`音频总长 ${total.toFixed(1)}s，检出 ${silences.length} 段静音（段间间隙应为 ${segs.length - 1}）`);
if (!silences.length) {
  console.log('  → 没有检出任何静音：合并方式可能与预期不同，或音频是连续的。');
  process.exit(0);
}
const gaps = silences.filter(([s, e]) => e - s >= gap * 0.8);
console.log(`  其中长度 ≥ ${(gap * 0.8).toFixed(2)}s 的有 ${gaps.length} 段（最可能是段间间隙）`);
const bounds = [0];
for (const [, e] of gaps) bounds.push(e);
bounds.push(total);
const rows = [];
for (let i = 0; i < segs.length; i++) {
  const a = bounds[i] ?? 0;
  const b = bounds[i + 1] ?? total;
  const d = Math.max(0.1, b - a);
  rows.push({ i: i + 1, chars: segs[i].length, dur: d, cps: segs[i].length / d });
}
const rates = rows.map(r => r.cps).sort((x, y) => x - y);
const med = rates[Math.floor(rates.length / 2)];
console.log(`中位语速 ${med.toFixed(2)} 字/秒\n`);
for (const r of rows) {
  const dev = r.cps / med;
  if (dev > 1.28 || dev < 0.72) {
    console.log(`  ${String(r.i).padStart(3)} ${String(r.chars).padStart(6)} ${r.dur.toFixed(1).padStart(7)}s ${r.cps.toFixed(2).padStart(7)}  ${dev.toFixed(2)}x  ${segs[r.i - 1].slice(0, 50)}`);
  }
}
