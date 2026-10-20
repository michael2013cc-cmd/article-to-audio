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
 *   --auto-verify <n>   derive the top-N verification keys from the script itself
 *   --list-keys [n]     print ranked key candidates derived from the script, then exit
 *   --lint-numbers      report numbers written in Chinese (harder to verify), then exit
 *   --no-stt            skip the STT round-trip even if --verify given
 *   --keep-script <f>   also write the narration script as markdown next to --out
 *   --verify-only <f>   skip synthesis; just transcribe <f> and report key matches
 *   --check-txt <f>     match keys against an existing plain-text transcript (no API calls)
 *   --recheck-passes <n> how many shifted re-transcriptions --recheck does (default 2).
 *                       Two is not enough for phrases the STT is unstable on:
 *                       "20 億美元" was read correctly in only 4 of 6 passes, so a
 *                       2-sample union can miss a figure that is really in the audio.
 *   --recheck           for keys missing from the transcript, re-transcribe just that
 *                       segment's audio to tell "the audio is wrong" from "the STT was wrong"
 *   --redo <n>          re-synthesize segment n (1-based), then re-merge and re-verify
 *                       — for the intermittent TTS number errors, which hit ~40% of
 *                       the time on phrases like "20 億美元" and cannot be fixed by
 *                       re-writing the text
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractCandidates, rankCandidates, preflight, lintNumbers, normalizeScript } from './keys.mjs';
import { stripMarkdown } from './md.mjs';

const TOOL = 'connector__matrix__batch_text_to_audio';
const STT = 'connector__matrix__listen_audio';
const BATCH_LIMIT = 6;    // server hard limit is 10, but bursts of 10 trip a 429 rate limit
const BATCH_PAUSE = 2000; // ms between batches
const TTS_TIMEOUT = 600_000;

function parseArgs(argv) {
  const a = { gap: 0.5, speed: 0.95, emotion: 'neutral',
              voice: 'Chinese (Mandarin)_Reliable_Executive' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'no-stt') { a.noStt = true; continue; }
    if (k === 'verify-only') { a.verifyOnly = argv[++i]; continue; }
    if (k === 'check-txt') { a.checkTxt = argv[++i]; continue; }
    if (k === 'recheck') { a.recheck = true; continue; }
    if (k === 'recheck-passes') { a.recheckPasses = Number(argv[++i] || 2); continue; }
    if (k === 'redo') { a.redo = Number(argv[++i]); continue; }
    if (k === 'verify') { a.verify = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean); continue; }
    if (k === 'verify-file') { a.verifyFile = argv[++i]; continue; }
    if (k === 'auto-verify') { a.autoVerify = Number(argv[++i] || 25); continue; }
    if (k === 'list-keys') {
      const nxt = argv[i + 1];
      a.listKeys = (nxt && !nxt.startsWith('--')) ? Number(nxt) : 30;
      if (nxt && !nxt.startsWith('--')) i++;
      continue;
    }
    if (k === 'lint-numbers') { a.lintNumbers = true; continue; }
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

/** Segments as written (for the script file) and as spoken (for the TTS). */
function loadSpoken(file) {
  const raw = loadSegments(file);
  return { segs: raw, spoken: raw.map(stripMarkdown) };
}

/** One connector call for a chunk of parts. Returns {ok:[], failed:[indices]}. */
function callBatch(chunk, jobdir, tag) {
  const f = path.join(jobdir, `args_${tag}.json`);
  fs.writeFileSync(f, JSON.stringify({ requests: chunk }));
  const d = JSON.parse(run('mcode-tools', ['connector', 'call', TOOL, '--args-file', f], { timeout: TTS_TIMEOUT }));
  if (d.code !== 0) throw new Error(`${tag}: code=${d.code} ${d.message}`);
  return d;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Resume is CONTENT-ADDRESSED, not index-addressed.
 *
 * A cache keyed on "part_034" breaks the moment the script is edited: fixing
 * one number can re-split a paragraph and shift every later index. Keying on
 * the spoken TEXT means an edited paragraph re-renders and every untouched
 * paragraph keeps its audio, no matter how the indices moved.
 *
 * `resume` is [{ text, node_id, file_name }].
 */
async function synthesize(segs, opts, jobdir, resume = [], cachePath = null) {
  fs.mkdirSync(jobdir, { recursive: true });
  const save = () => { if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(items.map(i => ({ ...i, text: i.text })), null, 2)); };
  const parts = segs.map((text, i) => ({
    text,
    voice_id: opts.voice,
    speed: opts.speed,
    emotion: opts.emotion,
    output_file: `part_${String(i + 1).padStart(3, '0')}.mp3`,
  }));
  const items = [];
  const have = new Set();
  // Pool of previously synthesized parts, keyed by their spoken text.
  const pool = new Map();
  for (const it of resume) {
    if (!it.text) continue;
    if (!pool.has(it.text)) pool.set(it.text, []);
    pool.get(it.text).push(it);
  }
  // Claim one cached part per matching segment (a text used twice needs two).
  for (const p of parts) {
    const q = pool.get(p.text);
    if (!q || !q.length) continue;
    const it = q.shift();
    if (have.has(it.file_name)) continue;
    items.push({ ...it, text: p.text });
    have.add(it.file_name);
  }
  if (items.length) console.log(`  resuming: ${items.length} part(s) reused by content (${resume.length} cached)`);

  // Pass 1: full batches. Skip the ones we already have.
  for (let s = 0; s < parts.length; s += BATCH_LIMIT) {
    const chunkAll = parts.slice(s, s + BATCH_LIMIT);
    const chunk = chunkAll.filter(p => !have.has(p.output_file));
    if (!chunk.length) continue;
    const d = callBatch(chunk, jobdir, String(s / BATCH_LIMIT + 1).padStart(2, '0'));
    const failed = d.failed_items?.length || 0;
    if (failed) console.error(`  !! ${failed} failed in batch ${s / BATCH_LIMIT + 1}: ${d.failed_items[0].error_msg}`);
    console.log(`  batch ${s / BATCH_LIMIT + 1}: asked ${chunk.length}, got ${d.success_items.length}`);
    for (let k = 0; k < d.success_items.length; k++) {
      const it = d.success_items[k];
      items.push({ ...it, text: chunk[k] ? chunk[k].text : '' });
      have.add(it.file_name);
    }
    save();
    // The upstream TTS is RATE-LIMITED (err_code 429) on bursts. Pacing the
    // batches is cheaper than a retry storm.
    await sleep(failed ? 4000 : BATCH_PAUSE);
  }

  // Pass 2: re-request ONLY the parts that are missing, in small batches with
  // a growing delay. The upstream message says: "retry the SAME request after
  // a brief delay (do not change the prompt)".
  let missing = parts.filter(p => !have.has(p.output_file));
  let attempt = 0;
  while (missing.length && attempt < 6) {
    attempt++;
    const size = Math.max(1, Math.min(4, 10 - attempt * 2));
    console.log(`  retry pass ${attempt}: ${missing.length} missing, batches of ${size}`);
    let progressed = false;
    for (let s = 0; s < missing.length; s += size) {
      const chunk = missing.slice(s, s + size);
      const d = callBatch(chunk, jobdir, `retry${attempt}_${String(s / size + 1).padStart(2, '0')}`);
      for (let k = 0; k < d.success_items.length; k++) {
        const it = d.success_items[k];
        items.push({ ...it, text: chunk[k] ? chunk[k].text : '' });
        have.add(it.file_name);
        progressed = true;
      }
      save();
      if (d.failed_items?.length) {
        console.error(`  !! still failing: ${d.failed_items[0].error_msg}`);
      }
      await sleep(3000 * attempt);
    }
    const before = missing.length;
    missing = parts.filter(p => !have.has(p.output_file));
    if (!progressed && missing.length === before) await sleep(15000);
  }
  if (missing.length) {
    throw new Error(`part synthesis failed for ${missing.length} part(s) after retries: ${missing.map(m => m.output_file).join(', ')}`);
  }

  // GOTCHA: success_items comes back in arbitrary order. Only the output_file
  // name is trustworthy. Sorting by it is not optional.
  //
  // The sort MUST be numeric-aware. With 2-digit padding "part_11" < "part_100"
  // lexicographically, so a 100+ segment job silently mis-orders every part
  // from #11 onward. `numeric: true` compares the digit runs as numbers.
  items.sort((x, y) => x.file_name.localeCompare(y.file_name, undefined, { numeric: true }));
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
function checkRatio(items, segs, jobdir, gap = 0) {
  console.log('  per-part check (chars / sec):');
  const parts = [];
  let cursor = 0;
  const rates = items.map((it, i) => {
    const d = duration(path.join(jobdir, `${it.node_id}.mp3`));
    const r = segs[i].length / d;
    console.log(`    ${String(i + 1).padStart(2, '0')} ${String(segs[i].length).padStart(4)}ch ${d.toFixed(1).padStart(6)}s  ${r.toFixed(1).padStart(5)} ch/s`);
    // The merged file inserts `gap` seconds of silence BETWEEN segments, so
    // the offset of segment i in the MERGED file includes i gaps.
    parts.push({ index: i, node_id: it.node_id, duration: d, start: cursor });
    cursor += d + gap;
    return r;
  });
  // Record offsets so a later --recheck can re-transcribe ONE segment.
  fs.writeFileSync(path.join(jobdir, 'parts.json'), JSON.stringify(parts));
  const lo = Math.min(...rates), hi = Math.max(...rates);
  if (hi / lo > 3) console.error(`  !! ch/s spread ${(hi / lo).toFixed(1)}x — inspect ordering before shipping`);
  return parts;
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


/**
 * Re-transcribe a file with DIFFERENT chunk boundaries.
 *
 * The STT can hallucinate a plausible-but-wrong passage — measured on a real
 * segment, one pass rendered "GLM-5.3, 744B, 78 layers, 2026-08-28" as
 * "GLM-4-9B, 14.3B, 40 layers, 2024-06-05", while a pass over the SAME audio
 * with different cuts got every one of them right. A second pass with
 * shifted boundaries therefore contradicts the first, and the union of the two
 * is far more trustworthy than either alone.
 *
 * The chunk size and offset are deliberately coprime with the 150 s standard
 * pass so no boundary lines up.
 */
async function transcribeShifted(file, jobdir, chunk = 97, offset = 31) {
  const total = duration(file);
  const pieces = [];
  let i = 0;
  while (offset + i * chunk < total) {
    const start = offset + i * chunk;
    const len = Math.min(chunk, total - start);
    if (len < 3) break;
    const p = path.join(jobdir, `shift_${i}.mp3`);
    run('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-t', String(len),
      '-i', file, '-c:a', 'libmp3lame', '-b:a', '128k', p]);
    const t = await sttOnce(p);
    console.log(`    shifted piece ${i + 1} (${start.toFixed(0)}s): ${t.length} chars`);
    pieces.push(t);
    i++;
  }
  return pieces.join('\n');
}


/**
 * Process lock on the job directory.
 *
 * WHY: two runs writing the same jobdir clobber each other. This actually
 * happened — an automated evaluation agent ran the same skill in the same
 * /workspace and its `--verify-only` pass overwrote a finished transcript.txt
 * with a partial one, and its render left a stray output file. The audio was
 * unaffected, but the cached transcript was silently replaced.
 *
 * The lock is a PID file. If the recorded PID is still alive, another run owns
 * the jobdir and we refuse rather than race.
 */
function acquireLock(jobdir) {
  const lock = path.join(jobdir, '.lock');
  fs.mkdirSync(jobdir, { recursive: true });
  if (fs.existsSync(lock)) {
    const pid = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
    let alive = false;
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) {
      console.error(`✗ 任务目录被占用：${jobdir}`);
      console.error(`  另一个进程 (PID ${pid}) 正在用这个目录。再跑一次会互相覆盖字幕和分片。`);
      console.error(`  换个 --out 文件名，或等那个进程结束再跑。`);
      process.exit(5);
    }
    // Stale lock from a crashed run — take it over.
    console.error(`  (发现上次残留的锁 PID ${pid}，已接管)`);
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => { try { fs.unlinkSync(lock); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  return release;
}

const a = parseArgs(process.argv);
const outRef = a.out || a.verifyOnly || 'audio';
const jobdir = path.resolve(a.jobdir || path.join('.tts-narration', path.basename(outRef, '.mp3')));

/**
 * Locate a missing key in the transcript using the SCRIPT context it came from.
 * A key derived from the script knows the words around it; if those words are
 * in the transcript, the region is found and we can show what was actually
 * written there. Far more useful than guessing at number shapes.
 */
function findNearMiss(text, key, scriptContext) {
  if (scriptContext) {
    // Longest distinctive token in the context: CJK runs and ASCII words.
    const tokens = scriptContext.match(/[一-鿿]{3,}|[A-Za-z][A-Za-z0-9_.+-]{2,}/g) || [];
    tokens.sort((a, b) => b.length - a.length);
    for (const tok of tokens.slice(0, 6)) {
      const i = text.indexOf(tok);
      if (i >= 0) {
        const start = Math.max(0, i - 35);
        const end = Math.min(text.length, i + 45);
        return `（稿中上下文「${tok}」）…${text.slice(start, end)}…`;
      }
    }
  }
  // Fall back to a same-shape numeric candidate.
  const num = String(key).match(/\d+(?:\.\d+)?/);
  if (!num) return null;
  const s = num[0];
  const [int, dec] = s.split('.');
  const intPat = int.length > 1 ? `\\d{0,${int.length}}` : '\\d';
  const pat = dec ? `${intPat}\\.\\d{0,${dec.length}}` : `${intPat}\\d{0,1}`;
  const re = new RegExp(pat, 'g');
  const keyDigits = s.replace(/\D/g, '');
  let best = null, bestScore = -1, m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const candDigits = m[0].replace(/\D/g, '');
    // Same digit count is the strong signal; then digit overlap.
    let k = 0, score = 0;
    for (const ch of candDigits) {
      if (ch === keyDigits[k]) { score++; k++; }
    }
    score -= Math.abs(candDigits.length - keyDigits.length) * 2;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best) return null;
  const i = best.index;
  const start = Math.max(0, i - 25);
  const end = Math.min(text.length, i + best[0].length + 35);
  return `«${best[0]}» ` + text.slice(start, end);
}

/** Verification keys are {key, alts}: a key passes if ANY of its accepted
 *  renderings appears in the transcript.
 *
 *  The transcript is checked in BOTH its raw form and a number-normalised
 *  form. The STT pass renders numbers inconsistently — measured on a real
 *  13-minute transcript:
 *    "二零二六年" (script) → "2026年"   (Chinese → Arabic)
 *    "共 18 篇"   (script) → "共十八篇" (Arabic  → Chinese)
 *    "3萬8千"                (mixed Arabic + Chinese)
 *  Normalising the transcript to Arabic makes one Arabic key cover all of
 *  them, instead of enumerating every spelling by hand. */
function matchKeys(text, keys) {
  const norm = normalizeScript([text]);
  const missing = [];
  for (const k of keys) {
    const forms = [...(k.alts?.length ? k.alts : []), k.key];
    const found = forms.some(f => text.includes(f) || norm.includes(f));
    if (!found) missing.push(k);
  }
  return missing;
}

/** PRE-FLIGHT GATE. A key that is not in the script can never be in the
 *  transcript, so it is guaranteed to report as a miss. Catch it here — before
 *  burning TTS + STT budget — instead of chasing it after the fact. */
function gateKeys(keys, segs) {
  if (!keys.length) return;
  const bogus = preflight(keys, segs);
  if (!bogus.length) return;
  console.error(`\n✗ 预检失败：${bogus.length} 个校验键不在口播稿里，命中不了。`);
  console.error(`  无效键: ${bogus.join(', ')}`);
  console.error('  这些键是凭记忆手写的，稿子里根本没有 —— 报告成「未命中」会白跑一轮 TTS+STT。');
  console.error('  请改用脚本自动生成的键：node extract-keys.mjs --segments <file>\n');
  process.exit(3);
}

/** Build the verification key set: hand-written keys plus/minus auto-derived. */
function buildKeys(segs, a) {
  let keys = (a.verify || []).map(s => ({ key: s, alts: [s] }));
  if (a.verifyFile) {
    // A key file carries the full alt set, so "45,000" is also accepted as
    // "45000" and "四万五千" — the STT does not preserve the separator.
    const file = JSON.parse(fs.readFileSync(a.verifyFile, 'utf8'));
    const list = Array.isArray(file) ? file : (file.keys || []);
    for (const k of list) {
      const key = typeof k === 'object' ? String(k.key) : String(k);
      const alts = (typeof k === 'object' && Array.isArray(k.alts) && k.alts.length) ? k.alts : [key];
      if (!keys.some(x => x.key === key)) {
        keys.push({ key, alts, context: typeof k === 'object' ? k.context : undefined, segment: typeof k === 'object' ? k.segment : undefined });
      }
    }
    console.log(`verify-file: ${list.length} keys loaded from ${a.verifyFile}`);
  }
  if (a.autoVerify && segs) {
    const picked = rankCandidates(extractCandidates(segs), a.autoVerify);
    for (const c of picked) {
      if (!keys.some(k => k.key === c.key)) keys.push({ key: c.key, alts: c.alts, context: c.context, segment: c.segment });
    }
    console.log(`auto-verify: ${picked.length} keys derived from the script`);
  }
  return keys;
}

if (a.verifyOnly) {
  const segs = a.segments ? loadSegments(a.segments) : null;
  acquireLock(jobdir);
  const keys = buildKeys(segs, a);
  if (segs) gateKeys(keys, segs);
  const t = await transcribeFull(a.verifyOnly, jobdir);
  fs.writeFileSync(path.join(jobdir, 'transcript.txt'), t);
  const missing = matchKeys(t, keys);
  console.log(`STT ${t.length} chars; ${keys.length - missing.length}/${keys.length} keys matched`);
  if (missing.length) console.log(`keys not matched: ${missing.map(m => m.key).join(', ')}`);
  console.log(`transcript -> ${path.join(jobdir, 'transcript.txt')}`);
  process.exit(0);
}

const { segs, spoken } = loadSpoken(a.segments);
acquireLock(jobdir);
const stripped = spoken.filter((x, i) => x !== segs[i]).length;
if (stripped) console.log(`markdown stripped from ${stripped}/${segs.length} segments before TTS`);

// --lint-numbers: editorial report, no API calls.
if (a.lintNumbers) {
  const warns = lintNumbers(segs);
  console.log(`\n渲染提示 (${warns.length}) — 这些数字用中文写法，回听校验容易失真：\n`);
  for (const w of warns) {
    console.log(`  段 ${String(w.segment).padStart(2)}  ${w.run}  → ${w.value}`);
    console.log(`        ${w.context}`);
  }
  console.log('');
  process.exit(0);
}

// --list-keys: show the derived candidates, no API calls.
if (a.listKeys) {
  const cands = extractCandidates(segs);
  const picked = rankCandidates(cands, a.listKeys);
  console.log(`\n候选数字 ${cands.length} 个，按校验价值排序取前 ${picked.length}：\n`);
  console.log('  #  段   层级  值         接受形式                    上下文');
  console.log('  ── ──── ──── ────────── ────────────────────────── ─────────────────');
  picked.forEach((c, i) => {
    const alts = c.alts.length > 1 ? c.alts.join(' | ') : c.alts[0];
    console.log(`  ${String(i + 1).padStart(2)} ${String(c.segment + 1).padStart(4)} ` +
      `${c.tier === 'A' ? ' A ' : ' B '} ${String(c.value).padStart(9)} ` +
      `${alts.padEnd(26).slice(0, 26)} ${c.context.slice(0, 40)}`);
  });
  console.log('\n--auto-verify ' + picked.length + '  或  --verify ' + picked.map(c => c.alts[0]).join(',') + '\n');
  process.exit(0);
}

// Build the verification key set: hand-written keys plus/minus auto-derived.
const keys = buildKeys(segs, a);
gateKeys(keys, segs);
if (keys.length) console.log(`verify keys: ${keys.length} (all present in script)`);


/**
 * --redo <n>: re-synthesize one segment and rebuild the merged file.
 *
 * WHY: the TTS makes intermittent errors on short numeric phrases. Measured:
 * "各投 20 億美元" came out as "2 億" or "21 億" in roughly 40% of syntheses —
 * a factual error the listener hears. Re-writing the text does not help;
 * only re-synthesizing does. (Three independent STT readings of one bad file
 * all agree it is wrong, so this is detectable.)
 */
if (a.redo) {
  const { segs, spoken } = loadSpoken(a.segments);
  const partsFile = path.join(jobdir, 'parts.json');
  if (!fs.existsSync(partsFile)) { console.error('✗ 缺少 parts.json'); process.exit(3); }
  const parts = JSON.parse(fs.readFileSync(partsFile, 'utf8'));
  const idx = a.redo - 1;
  if (idx < 0 || idx >= segs.length) { console.error(`✗ 段号越界 (1..${segs.length})`); process.exit(3); }
  const text = spoken[idx];
  console.log(`重渲染第 ${a.redo} 段 (${text.length} 字):\n  ${text.slice(0, 90)}…`);
  const one = await synthesize([text], a, jobdir);
  const it = one[0];
  const dst = path.join(jobdir, `${it.node_id}.mp3`);
  if (!fs.existsSync(dst)) {
    const { download_url } = JSON.parse(run('mcode-tools', ['get_asset_url', it.node_id]));
    run('curl', ['-sL', '-o', dst, download_url], { timeout: 300_000 });
  }
  parts[idx] = { index: idx, node_id: it.node_id, duration: duration(dst), start: parts[idx].start };
  let cur = 0;
  for (const p of parts) { p.start = cur; cur += p.duration + a.gap; }
  fs.writeFileSync(partsFile, JSON.stringify(parts));
  console.log(`新片段 ${it.node_id}, ${parts[idx].duration.toFixed(1)}s`);
  merge(parts, jobdir, a.out, a.gap);
  console.log(`merged -> ${a.out}  ${(duration(a.out) / 60).toFixed(2)} min`);
  process.exit(0);
}

/**
 * --recheck: settle whether a missing key means the AUDIO is wrong or the
 * TRANSCRIPT is wrong.
 *
 * Method: re-transcribe the whole file with shifted chunk boundaries and
 * match the key against the union of both passes. A key present in either
 * pass is in the audio. A key absent from both is genuinely missing.
 */
if (a.recheck) {
  const tfile = path.join(jobdir, 'transcript.txt');
  const pass1 = fs.existsSync(tfile) ? fs.readFileSync(tfile, 'utf8') : '';
  const missing = matchKeys(pass1, keys);
  if (!missing.length) {
    console.log('✓ 字幕里全部命中，无需复核。');
    process.exit(0);
  }
  console.log(`首次转写缺 ${missing.length} 个键，用错位分片重转来分辨：\n`);
  console.log(`  (原始字幕 ${pass1.length} 字)`);
  const nPass = a.recheckPasses || 2;
  const offsets = [31, 47, 63, 79];
  let union = pass1;
  for (let p = 0; p < nPass; p++) {
    const t = await transcribeShifted(a.out, jobdir, 97, offsets[p % offsets.length]);
    fs.writeFileSync(path.join(jobdir, `transcript_shifted${p + 1}.txt`), t);
    union += '\n' + t;
  }
  const stillMissing = matchKeys(union, keys);
  const noise = missing.filter(m => !stillMissing.some(x => x.key === m.key));
  const real = stillMissing.filter(m => !noise.some(x => x.key === m.key));
  for (const m of noise) {
    console.log(`  ${m.key} → ✓ 音频里确实有（首次转写是 STT 误差）`);
  }
  for (const m of real) {
    console.log(`  ${m.key} → ✗ ${nPass + 1} 次转写都没有`);
    const near = findNearMiss(union, m.key, m.context);
    if (near) console.log(`      重转字幕: ${near.replace(/\n/g, ' ')}`);
  }
  console.log(`\n复核结论：${noise.length} 个是字幕误差，${real.length} 个仍未命中。`);
  if (real.length) {
    console.log('  → 样本量有限，不能直接断定音频坏了。STT 在短数字短语上极不稳定：');
    console.log('     同一份正确音频，同一段连转 5 次可能给出 3 个不同的数字。');
    console.log('     请用探针定论：');
    console.log('       node scripts/probe-audio.mjs --file <mp3> --start <s> --dur <d> --times 6 --expect "<值>"');
    console.log('     若多次读数里有正确值 → 音频是好的，是 STT 噪声；');
    console.log('     若所有读数都是同一个错值 → 音频确实坏了，用 --redo <段号> 重渲染。');
  }
  process.exit(real.length ? 4 : 0);
}

// --check-txt: match keys against an already-produced transcript. No API calls,
// so keys can be iterated for free after a run.
if (a.checkTxt) {
  const t = fs.readFileSync(a.checkTxt, 'utf8');
  const missing = matchKeys(t, keys);
  console.log(`\ntranscript: ${a.checkTxt}  (${t.length} chars)`);
  console.log(`keys: ${keys.length - missing.length}/${keys.length} matched`);
  if (missing.length) {
    console.log(`not matched: ${missing.map(m => m.key).join(', ')}`);
    for (const m of missing) {
      const near = findNearMiss(t, m.key, m.context);
      if (near) console.log(`  ${m.key} → ${near.replace(/\n/g, ' ')}`);
      else console.log(`  ${m.key} → 字幕里找不到任何接近的写法`);
    }
    console.log('  → 先看字幕里这段的实际写法，再判断是识别差异还是真的缺内容。');
  } else {
    console.log('✓ 全部命中。');
  }
  process.exit(0);
}
// jobdir resolved above; ffmpeg's concat demuxer resolves relative entries against
// the concat.txt directory, not cwd — a relative jobdir silently doubles the prefix.
const chars = spoken.reduce((n, s) => n + s.length, 0);
console.log(`segments: ${segs.length}  chars: ${chars}  est min: ${(chars / 260).toFixed(1)}`);

console.log('synthesizing...');
// Cache the synthesis result. A failure AFTER this point (a bad sort, a failed
// download, a merge problem) must not cost another 11 TTS batches.
const itemsCache = path.join(jobdir, 'items.json');
let items = null;
if (fs.existsSync(itemsCache)) {
  try {
    const cached = JSON.parse(fs.readFileSync(itemsCache, 'utf8'));
    console.log(`  cache: ${cached.length} part(s) on disk`);
    items = await synthesize(spoken, a, jobdir, cached, itemsCache);
  } catch (e) { console.error(`  cache unreadable, re-synthesizing: ${e.message}`); }
}
if (!items) {
  items = await synthesize(spoken, a, jobdir, [], itemsCache);
}
fs.writeFileSync(itemsCache, JSON.stringify(items.map(i => ({ ...i })), null, 2));
console.log('downloading...');
download(items, jobdir);
checkRatio(items, spoken, jobdir, a.gap);
merge(items, jobdir, a.out, a.gap);
const d = duration(a.out);
console.log(`merged -> ${a.out}  ${(d / 60).toFixed(2)} min  ${(fs.statSync(a.out).size / 1048576).toFixed(2)} MB`);

if (keys.length && !a.noStt) {
  console.log('verifying (STT round-trip)...');
  const t = await transcribeFull(a.out, jobdir);
  fs.writeFileSync(path.join(jobdir, 'transcript.txt'), t);
  const missing = matchKeys(t, keys);
  console.log(`  STT ${t.length} chars; ${keys.length - missing.length}/${keys.length} keys matched`);
  if (missing.length) {
    console.log(`  keys not matched: ${missing.map(m => m.key).join(', ')}`);
    // A miss means one of three things, in this order of likelihood:
    //   1. STT heard it differently (homophone / reformat) -> check the transcript
    //   2. the window was not sampled -> re-run --verify-only
    //   3. it genuinely is not in the audio -> re-listen to that stretch
    console.log('  → 先看 .tts-narration/<job>/transcript.txt 里这段的实际写法，再判断是识别差异还是真的缺内容。');
  }
}
if (a['keep-script']) {
  const md = path.resolve(a['keep-script']);
  fs.writeFileSync(md, segs.join('\n\n') + '\n');
  console.log(`script -> ${md}`);
}
