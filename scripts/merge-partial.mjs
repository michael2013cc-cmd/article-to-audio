#!/usr/bin/env node
/**
 * merge-partial.mjs — merge the parts that exist, for offline auditing.
 *
 * Used when synthesis is interrupted (a rate limit, a billing block) and the
 * already-synthesized parts still need an integrity check: ordering, silent
 * truncation, per-segment speed. Costs nothing but ffmpeg — no API calls.
 *
 * Usage:
 *   node merge-partial.mjs --jobdir .tts-narration/ep08a-upstream \
 *        --segments chip-research/ep08a_segs.json --out output/ep08a-partial.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = k => argv.includes(`--${k}`);

const jobdir = arg('jobdir');
const segFile = arg('segments');
const out = arg('out');
const gap = Number(arg('gap', 0.5));
if (!jobdir || !segFile || !out) { console.error('--jobdir, --segments and --out are required'); process.exit(2); }

const items = JSON.parse(fs.readFileSync(path.join(jobdir, 'items.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(segFile, 'utf8'));
const segs = Array.isArray(raw) ? raw : raw.segments;

// Map part number -> local file, using the node_id each part was downloaded as.
const byName = new Map();
for (const it of items) {
  const n = Number(String(it.file_name).match(/(\d+)/)?.[1]);
  const f = path.join(jobdir, `${it.node_id}.mp3`);
  if (Number.isFinite(n) && fs.existsSync(f)) byName.set(n, f);
}

const order = [...byName.keys()].sort((a, b) => a - b);
console.log(`parts available: ${order.length} of ${segs.length}`);
if (!order.length) { console.error('no parts on disk'); process.exit(3); }

// Only merge a contiguous prefix — a gap in the middle would silently produce
// an audio file that jumps from one section to another.
const contiguous = [];
for (let i = 1; i <= segs.length; i++) {
  if (!byName.has(i)) break;
  contiguous.push(i);
}
if (contiguous.length < order.length) {
  console.log(`!! only a contiguous prefix is mergeable: ${contiguous.length} segments (parts present but not contiguous: ${order.filter(n => n > contiguous.length).join(',')})`);
}
if (contiguous.length < segs.length) {
  console.log(`NOTE: merging ${contiguous.length}/${segs.length} segments — this is a PARTIAL file, not the deliverable.`);
}

// Build the concat list: part, silence, part, silence, ...
const tmp = path.join(jobdir, 'concat_partial.txt');
const lines = [];
// The concat demuxer resolves relative entries against the concat FILE's
// directory, not cwd — so every entry here must be absolute.
const tmpDir = fs.mkdtempSync(path.join(path.resolve(jobdir), 'sil_'));
for (let k = 0; k < contiguous.length; k++) {
  lines.push(`file '${path.resolve(byName.get(contiguous[k]))}'`);
  if (k < contiguous.length - 1) {
    const sil = path.join(tmpDir, `s${k}.mp3`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=32000:cl=mono`,
      '-t', String(gap), '-c:a', 'libmp3lame', '-b:a', '128k', sil]);
    lines.push(`file '${sil}'`);
  }
}
fs.writeFileSync(tmp, lines.join('\n') + '\n');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', tmp, '-c', 'copy', out]);
const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim());
console.log(`merged ${contiguous.length} parts -> ${out}  ${(dur / 60).toFixed(2)} min`);

// Write the matching partial segs file so audit-segments.mjs can use it.
const partialSegs = path.join(path.dirname(segFile), path.basename(segFile).replace(/_segs\.json$/, '_segs_partial.json'));
fs.writeFileSync(partialSegs, JSON.stringify({ segments: segs.slice(0, contiguous.length) }, null, 2));
console.log(`partial segs -> ${partialSegs}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
