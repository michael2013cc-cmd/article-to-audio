#!/usr/bin/env node
/**
 * narrate.mjs — deterministic pipeline: segments -> batch TTS -> verified single mp3.
 *
 * The judgment work (rewriting prose into speakable text) is NOT here; that stays
 * in SKILL.md's procedure. This script only does repeatable local work.
 *
 * Usage:
 *   node narrate.mjs --segments segs.json --out output/foo.mp3 [options]
 *
 *   --segments <file>   JSON: ["para 1", "para 2", ...] or {"segments":[...], "title":"..."}
 *   --out <file>        output mp3 path
 *   --voice <id>        default Chinese (Mandarin)_Reliable_Executive
 *   --speed <n>         0.5-2.0, default 0.95
 *   --emotion <e>       happy|sad|angry|fearful|disgusted|surprised|neutral
 *   --gap <n>           silence seconds between parts, default 0.5
 *   --jobdir <dir>      scratch dir for parts, default ./.tts-narration/<outbasename>
 *   --verify <a,b,c>    comma-separated substrings that MUST appear in the STT transcript
 *   --no-stt            skip the STT round-trip even if --verify given
 *   --keep-script <f>   also write the narration script as markdown next to --out
 *   --verify-only <f>   skip synthesis; just transcribe <f> and report key matches
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOOL = 'connector__matrix__batch_text_to_audio';
const STT = 'connector__matrix__listen_audio';
const BATCH_LIMIT = 10;   // hard server limit per call
const TTS_TIMEOUT = 600_000;

function parseArgs(argv) {
  const a = { gap: 0.5, speed: 0.95, emotion: 'neutral',
              voice: 'Chinese (Mandarin)_Reliable_Executive' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'no-stt') { a.noStt = true; continue; }
    if (k === 'verify-only') { a.verifyOnly = argv[++i]; continue; }
    if (k === 'verify') { a.verify = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean); continue; }
    a[k] = argv[++i];
  }
  for (const req of ['segments', 'out']) {
    if (a.verifyOnly) break;
    if (!a[req]) { console.error(`--${req} is required`); process.exit(2); }
  }
  a.speed = Number(a.speed); a.gap = Number(a.gap);
  return a;
}

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

/** ffprobe: note the SINGLE dash. `--show_entries` fails on ffprobe 5.1 with
 *  "Option not found" AND empty stdout, which surfaces as float('') far from here. */
function duration(file) {
  const out = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const v = parseFloat(out.trim());
  if (!Number.isFinite(v)) throw new Error(`ffprobe returned no duration for ${file}`);
  return v;
}

function loadSegments(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const segs = Array.isArray(raw) ? raw : raw.segments;
  if (!Array.isArray(segs) || !segs.length) throw new Error(`${file} has no segments`);
  // Catch mojibake from shell heredocs before it reaches the TTS engine.
  segs.forEach((s, i) => {
    const bad = [...s].filter(c => c === '�' || (c.codePointAt(0) >= 0xE000 && c.codePointAt(0) < 0xF8FF));
    if (bad.length) throw new Error(`segment ${i + 1} has corrupt chars: ${JSON.stringify(bad)}`);
  });
  return segs;
}

async function synthesize(segs, opts, jobdir) {
  fs.mkdirSync(jobdir, { recursive: true });
  const parts = segs.map((text, i) => ({
    text,
    voice_id: opts.voice,
    speed: opts.speed,
    emotion: opts.emotion,
    output_file: `part_${String(i + 1).padStart(2, '0')}.mp3`,
  }));
  const items = [];
  for (let s = 0; s < parts.length; s += BATCH_LIMIT) {
    const chunk = parts.slice(s, s + BATCH_LIMIT);
    const f = path.join(jobdir, `args_${String(s / BATCH_LIMIT + 1).padStart(2, '0')}.json`);
    fs.writeFileSync(f, JSON.stringify({ requests: chunk }));
    const d = JSON.parse(run('mcode-tools', ['connector', 'call', TOOL, '--args-file', f], { timeout: TTS_TIMEOUT }));
    if (d.code !== 0) throw new Error(`batch ${s / BATCH_LIMIT + 1}: code=${d.code} ${d.message}`);
    if (d.failed_items?.length) console.error(`  !! failed_items: ${JSON.stringify(d.failed_items)}`);
    console.log(`  batch ${s / BATCH_LIMIT + 1}: asked ${chunk.length}, got ${d.success_items.length}`);
    items.push(...d.success_items);
  }
  // GOTCHA: success_items comes back in arbitrary order. Only the output_file
  // name is trustworthy. Sorting by it is not optional.
  items.sort((x, y) => x.file_name.localeCompare(y.file_name));
  const got = items.map(i => i.file_name);
  const want = parts.map(p => p.output_file);
  if (got.join() !== want.join()) throw new Error(`part mismatch\n  want ${want}\n  got  ${got}`);
  return items;
}

function download(items, jobdir) {
  for (const it of items) {
    const dst = path.join(jobdir, `${it.node_id}.mp3`);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 1000) continue;
    const { download_url } = JSON.parse(run('mcode-tools', ['get_asset_url', it.node_id]));
    run('curl', ['-sL', '-o', dst, download_url], { timeout: 300_000 });
  }
}

/** Cross-check: audio length should track text length. Catches swapped parts
 *  and truncated responses that name-based sorting cannot see. */
function checkRatio(items, segs, jobdir) {
  console.log('  per-part check (chars / sec):');
  const rates = items.map((it, i) => {
    const d = duration(path.join(jobdir, `${it.node_id}.mp3`));
    const r = segs[i].length / d;
    console.log(`    ${String(i + 1).padStart(2, '0')} ${String(segs[i].length).padStart(4)}ch ${d.toFixed(1).padStart(6)}s  ${r.toFixed(1).padStart(5)} ch/s`);
    return r;
  });
  const lo = Math.min(...rates), hi = Math.max(...rates);
  if (hi / lo > 3) console.error(`  !! ch/s spread ${(hi / lo).toFixed(1)}x — inspect ordering before shipping`);
}

function merge(items, jobdir, out, gap) {
  const sil = path.join(jobdir, `silence_${gap}.mp3`);
  if (!fs.existsSync(sil)) {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono',
      '-t', String(gap), '-codec:a', 'libmp3lame', '-b:a', '128k', sil]);
  }
  const lines = [];
  items.forEach((it, i) => {
    lines.push(`file '${path.join(jobdir, it.node_id).replace(/'/g, "'\\''")}.mp3'`);
    if (i !== items.length - 1) lines.push(`file '${sil}'`);
  });
  const con = path.join(jobdir, 'concat.txt');
  fs.writeFileSync(con, lines.join('\n'));
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', con, '-c', 'copy', out]);
}

/** The STT endpoint is unreliable on long input, and the failures are silent or
 *  transient — measured on a 37-minute file:
 *    - 33 MB / 35 min whole-file  → 0 chars, no error
 *    - 300 s chunks               → UND_ERR_HEADERS_TIMEOUT partway through
 *    - 150 s chunks               → 15/15 succeeded
 *  So: small chunks, one retry, incremental saves, and never abort the run because
 *  a single piece failed — a lost 14th piece must not throw away the other 13. */
const STT_MAX = 150;

async function sttOnce(file, attempt = 1) {
  try {
    const { temp_url } = JSON.parse(run('mcode-tools', ['upload_temp_url', path.resolve(file)], { timeout: 180_000 }));
    const args = { audio_info: { url: temp_url, mime_type: 'audio/mpeg', prompt: '逐字转写，保留繁體中文' } };
    const d = JSON.parse(run('mcode-tools', ['connector', 'call', STT, '--args', JSON.stringify(args)], { timeout: 240_000 }));
    const t = d.transcription || '';
    if (!t && attempt < 2) { console.log(`    (empty, retrying ${file})`); return sttOnce(file, attempt + 1); }
    return t;
  } catch (e) {
    if (attempt < 2) { console.log(`    (${String(e.message).slice(0, 60)}, retrying)`); return sttOnce(file, attempt + 1); }
    console.error(`    !! gave up on ${path.basename(file)}: ${String(e.message).slice(0, 80)}`);
    return '';
  }
}

async function transcribeFull(out, jobdir) {
  fs.mkdirSync(jobdir, { recursive: true });
  const total = duration(out);
  const tfile = path.join(jobdir, 'transcript.txt');
  if (total <= STT_MAX) return sttOnce(out);
  const n = Math.ceil(total / STT_MAX);
  const failed = [];
  let text = '';
  for (let i = 0; i < n; i++) {
    const piece = path.join(jobdir, `stt_${i}.mp3`);
    run('ffmpeg', ['-y', '-v', 'error', '-ss', String(i * STT_MAX), '-t', String(STT_MAX),
      '-i', out, '-c', 'copy', piece]);
    const t = await sttOnce(piece);
    console.log(`    piece ${i + 1}/${n} (${((i + 1) * STT_MAX).toFixed(0)}s): ${t.length} chars`);
    if (!t.length) failed.push(i + 1);
    text += t;
    // Save after EVERY piece: a failure at the end must not discard the rest.
    fs.writeFileSync(tfile, text);
  }
  if (failed.length) console.error(`  !! ${failed.length}/${n} pieces failed: ${failed.join(', ')} — re-run --verify-only to retry just those`);
  return text;
}

const a = parseArgs(process.argv);
const jobdir = path.resolve(a.jobdir || path.join('.tts-narration', path.basename(a.out, '.mp3')));

if (a.verifyOnly) {
  const t = await transcribeFull(a.verifyOnly, jobdir);
  fs.writeFileSync(path.join(jobdir, 'transcript.txt'), t);
  const missing = (a.verify || []).filter(k => !t.includes(k));
  console.log(`STT ${t.length} chars; ${(a.verify || []).length - missing.length}/${(a.verify || []).length} keys matched`);
  if (missing.length) console.log(`keys not matched: ${missing.join(', ')}`);
  console.log(`transcript -> ${path.join(jobdir, 'transcript.txt')}`);
  process.exit(0);
}

const segs = loadSegments(a.segments);
// jobdir resolved above; ffmpeg's concat demuxer resolves relative entries against
// the concat.txt directory, not cwd — a relative jobdir silently doubles the prefix.
const chars = segs.reduce((n, s) => n + s.length, 0);
console.log(`segments: ${segs.length}  chars: ${chars}  est min: ${(chars / 260).toFixed(1)}`);

console.log('synthesizing...');
const items = await synthesize(segs, a, jobdir);
console.log('downloading...');
download(items, jobdir);
checkRatio(items, segs, jobdir);
merge(items, jobdir, a.out, a.gap);
const d = duration(a.out);
console.log(`merged -> ${a.out}  ${(d / 60).toFixed(2)} min  ${(fs.statSync(a.out).size / 1048576).toFixed(2)} MB`);

if (a.verify?.length && !a.noStt) {
  console.log('verifying (STT round-trip)...');
  const t = await transcribeFull(a.out, jobdir);
  fs.writeFileSync(path.join(jobdir, 'transcript.txt'), t);
  const missing = a.verify.filter(k => !t.includes(k));
  console.log(`  STT ${t.length} chars; ${a.verify.length - missing.length}/${a.verify.length} keys matched`);
  if (missing.length) console.log(`  keys not matched: ${missing.join(', ')}`);
}
if (a['keep-script']) {
  const md = path.resolve(a['keep-script']);
  fs.writeFileSync(md, segs.join('\n\n') + '\n');
  console.log(`script -> ${md}`);
}
