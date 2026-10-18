#!/usr/bin/env node
/**
 * probe-audio.mjs — transcribe the same audio N times and show the spread.
 *
 * WHY: the STT is not deterministic, and on short numeric phrases it varies
 * wildly. Measured on one fixed audio file whose content is "各投 20 億美元":
 *   pass 1 → "20美元"   pass 2 → "2.1億美元"  pass 3 → "20億美元" ✓
 *   pass 4 → "21億美元"  pass 5 → "20億美元" ✓
 * Five readings, three different numbers, two of them correct. A single
 * transcript cannot tell you whether the AUDIO is wrong — only the spread can.
 *
 * The skill's --recheck compares two passes; this script goes further and
 * shows every distinct reading, so you can tell
 *   - "some readings are right"  → the audio is fine, the STT is noisy
 *   - "every reading is wrong the same way" → the audio itself is damaged
 *
 * Usage:
 *   node probe-audio.mjs --file <mp3> [--start 0] [--dur 20] [--times 5]
 *                        [--expect "20億"] [--context 2]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const file = arg('file');
if (!file) { console.error('--file is required'); process.exit(2); }
const start = Number(arg('start', 0));
const dur = Number(arg('dur', 20));
const times = Number(arg('times', 5));
const expect = arg('expect', null);
const ctx = Number(arg('context', 30));

const tmp = path.join('/tmp', `probe_${Date.now()}.mp3`);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-t', String(dur),
  '-i', file, '-c:a', 'libmp3lame', '-b:a', '128k', tmp]);

const readings = [];
for (let i = 0; i < times; i++) {
  const { temp_url } = JSON.parse(execFileSync('mcode-tools',
    ['upload_temp_url', tmp], { encoding: 'utf8' }));
  const args = { audio_info: { url: temp_url, mime_type: 'audio/mpeg', prompt: '逐字轉寫，保留繁體中文' } };
  const d = JSON.parse(execFileSync('mcode-tools',
    ['connector', 'call', 'connector__matrix__listen_audio', '--args', JSON.stringify(args)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  readings.push((d.transcription || '').replace(/\n/g, ' '));
  process.stdout.write(`  读数 ${i + 1}/${times}: `);
  const t = readings[i];
  // The STT may write "200 億" or "200億" — compare without spaces.
  const tn = t.replace(/\s+/g, '');
  const en = expect ? expect.replace(/\s+/g, '') : null;
  const m = en ? tn.indexOf(en) : -1;
  if (m >= 0) console.log(`✓ 含「${expect}」 → …${t.slice(Math.max(0, m - ctx), m + ctx)}…`);
  else console.log(`✗ 不含「${expect}」 → ${t.slice(0, 110)}…`);
}

const uniq = new Set(readings.map(r => r.trim()));
console.log(`\n${uniq.size} 种不同读法（${times} 次转写）`);
if (expect) {
  const hits = readings.filter(r => r.replace(/\s+/g, '').includes(expect.replace(/\s+/g, ''))).length;
  console.log(`含「${expect}」的读数: ${hits}/${times}`);
  console.log(hits > 0
    ? '→ 音频是对的，是 STT 在这个片段上不稳定。'
    : '→ 所有读数都不含该值：音频可能真的不对，需要重渲染。');
}
fs.unlinkSync(tmp);
