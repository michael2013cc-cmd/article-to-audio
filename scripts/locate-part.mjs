#!/usr/bin/env node
/**
 * locate-part.mjs — find where a known part's audio sits inside a merged file.
 *
 * WHY: a merged file whose provenance is uncertain (which run produced it?
 * was the part order right?) is a delivery risk. The TTS is stochastic, so
 * the SAME text synthesized twice is not bit-identical — a raw PCM comparison
 * fails. But the ENERGY ENVELOPE is stable: same words, same voice, same
 * speed → the same loudness contour, frame by frame.
 *
 * Method: decode both to 8 kHz mono PCM, reduce to 20 ms RMS frames, and
 * slide the template over the file with a normalised cross-correlation. The
 * peak offset is where the part lives.
 *
 * Usage:
 *   node locate-part.mjs --mp3 merged.mp3 --part part.mp3 [--rate 8000] [--frame 20]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const mp3 = arg('mp3');
const part = arg('part');
const rate = Number(arg('rate', 8000));
const frameMs = Number(arg('frame', 20));
if (!mp3 || !part) { console.error('--mp3 and --part are required'); process.exit(2); }

function pcm(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le',
    '-ar', String(rate), '-ac', '1', '-'], { maxBuffer: 512 * 1024 * 1024 });
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function envelope(samples, rate, frameMs) {
  const hop = Math.max(1, Math.round(rate * frameMs / 1000));
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) { const v = samples[base + i]; sum += v * v; }
    env[f] = Math.sqrt(sum / hop);
  }
  return env;
}

const fileEnv = envelope(pcm(mp3), rate, frameMs);
const partEnv = envelope(pcm(part), rate, frameMs);

// Normalise: a long loud passage and a short quiet one must compare fairly.
function zscore(a, from = 0, to = a.length) {
  let m = 0;
  for (let i = from; i < to; i++) m += a[i];
  m /= (to - from);
  let v = 0;
  for (let i = from; i < to; i++) v += (a[i] - m) ** 2;
  const sd = Math.sqrt(v / (to - from)) || 1e-9;
  const out = new Float32Array(to - from);
  for (let i = from; i < to; i++) out[i - from] = (a[i] - m) / sd;
  return out;
}

const T = zscore(partEnv);
const F = zscore(fileEnv);
let best = { score: -Infinity, at: 0 };
const scores = [];
for (let i = 0; i + T.length <= F.length; i++) {
  let s = 0;
  for (let j = 0; j < T.length; j++) s += T[j] * F[i + j];
  scores.push(s / T.length);
  if (s / T.length > best.score) best = { score: s / T.length, at: i };
}
// Show the top 5 well-separated peaks.
const sorted = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
const peaks = [];
for (const p of sorted) {
  if (peaks.some(q => Math.abs(q.i - p.i) < T.length * 0.5)) continue;
  peaks.push(p);
  if (peaks.length >= 5) break;
}
console.log(`\n模板帧数 ${T.length} (${(T.length * frameMs / 1000).toFixed(1)}s)  文件帧数 ${F.length} (${(F.length * frameMs / 1000).toFixed(1)}s)`);
console.log('最佳匹配位置:');
for (const p of peaks) {
  console.log(`  t = ${(p.i * frameMs / 1000).toFixed(1)}s   corr = ${p.s.toFixed(4)}`);
}
