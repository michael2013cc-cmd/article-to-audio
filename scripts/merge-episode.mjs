#!/usr/bin/env node
/**
 * merge-episode.mjs — concatenate the segment mp3s of one episode into the
 * full-length file.
 *
 * The rule: SAME mp3 parameters on every part (32000 Hz / mono / 128 kbps),
 * binary concat with 0.5 s of silence between segments, NO re-encode. A
 * re-encode would shift the bitstream and invalidate the per-segment
 * verification that was already done on the parts.
 *
 * The merged file is a little longer than "sum of segments + silences" because
 * every mp3 segment carries encoder padding at its end. That is normal.
 *
 * Usage:
 *   node merge-episode.mjs --out output/ep08-upstream.mp3 \
 *        --parts output/ep08a-upstream.mp3,output/ep08b-upstream.mp3,output/ep08c-upstream.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const out = arg('out');
const partsArg = arg('parts');
const gap = Number(arg('gap', 0.5));
if (!out || !partsArg) { console.error('--out and --parts are required'); process.exit(2); }

const parts = partsArg.split(',').map(s => s.trim()).filter(Boolean);
if (!parts.length) { console.error('no parts'); process.exit(2); }

// Every part must share the same codec parameters, or the concat is not
// a clean binary join.
const probe = (f) => {
  const o = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,sample_rate,channels,bit_rate', '-show_entries', 'format=duration',
    '-of', 'json', f], { encoding: 'utf8' });
  const d = JSON.parse(o);
  const s = d.streams[0];
  return { codec: s.codec_name, sr: s.sample_rate, ch: s.channels, br: s.bit_rate, dur: parseFloat(d.format.duration) };
};
const metas = parts.map(probe);
const ref = metas[0];
for (let i = 1; i < metas.length; i++) {
  if (metas[i].codec !== ref.codec || metas[i].sr !== ref.sr || metas[i].ch !== ref.ch) {
    console.error(`✗ 第 ${i + 1} 段參數不一致：${JSON.stringify(metas[i])} vs ${JSON.stringify(ref)}`);
    process.exit(3);
  }
}
console.log(`參數一致：${ref.codec} / ${ref.sr} Hz / ${ref.ch} ch / ${ref.br} bps`);

const tmpDir = fs.mkdtempSync(path.join(path.resolve('/tmp'), 'epmerge-'));
const lines = [];
let total = 0;
for (let i = 0; i < parts.length; i++) {
  lines.push(`file '${path.resolve(parts[i])}'`);
  total += metas[i].dur;
  if (i !== parts.length - 1) {
    const sil = path.join(tmpDir, `s${i}.mp3`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono',
      '-t', String(gap), '-c:a', 'libmp3lame', '-b:a', '128k', sil]);
    lines.push(`file '${sil}'`);
    total += gap;
  }
}
const conf = path.join(tmpDir, 'concat.txt');
fs.writeFileSync(conf, lines.join('\n') + '\n');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', conf, '-c', 'copy', out]);
fs.rmSync(tmpDir, { recursive: true, force: true });

const d = probe(out);
console.log(`合併 ${parts.length} 段 -> ${out}`);
console.log(`  時長 ${(d.dur / 60).toFixed(2)} min  (分段和 ${(total / 60).toFixed(2)} min，差 ${(d.dur - total).toFixed(1)}s = 每段 mp3 編碼 padding)`);
console.log(`  ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
