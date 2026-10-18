#!/usr/bin/env node
/**
 * audit-segments.mjs — find silently-truncated segments in a merged mp3.
 *
 * WHY: a TTS generation failure can drop the tail of a segment. The audio
 * stays plausible, the ch/s ratio of that segment goes UP (same character
 * count, less audio), and nothing in the transcript obviously says "missing".
 * The merged file is a concatenation of parts separated by `--gap` seconds of
 * silence, so the segment boundaries can be recovered by silence detection —
 * no need to trust node ids or file order.
 *
 * Usage:
 *   node audit-segments.mjs --mp3 <file> --segments <segs.json> [--gap 0.5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const mp3 = arg('mp3');
const segFile = arg('segments');
const gap = Number(arg('gap', 0.5));
if (!mp3 || !segFile) { console.error('--mp3 and --segments are required'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(segFile, 'utf8'));
const segs = Array.isArray(raw) ? raw : raw.segments;

const dur = (f) => parseFloat(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

// Find the silences that separate the parts.
// silencedetect writes to stderr, so capture it explicitly.
const proc = spawnSync('ffmpeg', ['-v', 'info', '-i', mp3,
  '-af', 'silencedetect=noise=-42dB:d=0.18', '-f', 'null', '-'],
  { encoding: 'utf8' });
const stderr = (proc.stderr || '') + (proc.stdout || '');
const silences = [];
for (const line of stderr.split('\n')) {
  const m = line.match(/silence_start:\s*([0-9.]+).*silence_end:\s*([0-9.]+)/);
  if (m) silences.push([parseFloat(m[1]), parseFloat(m[2])]);
}
const total = dur(mp3);

console.log(`音频总长 ${total.toFixed(1)}s，检出 ${silences.length} 段静音（段间间隙应为 ${segs.length - 1}）`);

// Rebuild segment durations from the silence positions.
const bounds = [0];
for (const [s, e] of silences) { if (e - s < gap * 2) bounds.push(e); }
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
console.log('  段    字数    时长     ch/s    偏离');
const flagged = [];
for (const r of rows) {
  const dev = r.cps / med;
  const mark = dev > 1.28 ? '  <<< 偏快：可能被截断' : (dev < 0.72 ? '  <<< 偏慢' : '');
  if (dev > 1.28 || dev < 0.72) flagged.push({ ...r, dev });
  if (dev > 1.15 || dev < 0.85 || Math.abs(r.i - 43) < 1) {
    console.log(`  ${String(r.i).padStart(3)} ${String(r.chars).padStart(6)} ${r.dur.toFixed(1).padStart(7)}s ${r.cps.toFixed(2).padStart(7)}  ${dev.toFixed(2)}x${mark}`);
  }
}
console.log(`\n异常段: ${flagged.length}/${rows.length}`);
for (const f of flagged) {
  console.log(`\n  第 ${f.i} 段 (${f.chars}字, ${f.dur.toFixed(1)}s, ${f.cps.toFixed(2)} ch/s, ${f.dev.toFixed(2)}x中位)`);
  console.log(`    ${segs[f.i - 1].slice(0, 110)}`);
}
