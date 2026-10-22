#!/usr/bin/env node
/**
 * probe-seg.mjs — 對「未命中的鍵」逐一做段級窄視窗複驗。
 *
 * 為什麼需要它：150 秒的長分片 STT 會**整段吞掉密集數字段落**（ep13a 實測：
 * 一行財報數字的 6 個鍵在長轉寫裡完全消失，但音檔本身完全正確）。
 * 鍵未命中 ≠ 音頻缺內容。
 *
 * 做法：找出含有該鍵的段落 → 直接轉寫「那一段自己的 mp3」（Google TTS 備援
 * 每段一個 part_NNN.mp3）→ 在該段轉寫裡找鍵。
 *
 * 用法：
 *   node .parts/probe-seg.mjs --segs chip-research/ep13a_segs.json \
 *        --keys chip-research/ep13a_keys.json \
 *        --jobdir .tts-narration/ep13a-domestic-substitution-google \
 *        [--transcript <長轉寫>] [--prefix part_]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const SEGS = arg('segs');
const KEYS = arg('keys');
const JOBDIR = arg('jobdir');
const TRANSCRIPT = arg('transcript');
const PREFIX = arg('prefix', 'part_');
if (!SEGS || !KEYS || !JOBDIR) {
  console.error('usage: probe-seg.mjs --segs <segs.json> --keys <keys.json> --jobdir <dir> [--transcript <txt>]');
  process.exit(2);
}

const norm = (s) => String(s).replace(/[，]/g, ',').replace(/[。！？；]/g, '\n').replace(/\s+/g, '');

const segs = (JSON.parse(fs.readFileSync(SEGS, 'utf8')).segments || []).map(s => String(s));
const keysRaw = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
const keys = (Array.isArray(keysRaw) ? keysRaw : keysRaw.keys || []).map(k => (typeof k === 'string' ? k : k.key));

// 長轉寫裡沒命中的鍵
let missing = keys;
if (TRANSCRIPT && fs.existsSync(TRANSCRIPT)) {
  const tr = norm(fs.readFileSync(TRANSCRIPT, 'utf8'));
  missing = keys.filter(k => {
    const base = norm(k);
    if (tr.includes(base)) return false;
    const plain = base.replace(/,/g, '');
    if (tr.includes(plain)) return false;
    const int = plain.split('.')[0];
    // 整數形式也算命中（STT 正規化差異）
    return !(int.length >= 2 && tr.includes(int));
  });
}
console.log(`keys total ${keys.length}; missing after long transcript: ${missing.length}`);

// 每個鍵 → 含有它的段號
const segOfKey = new Map();
for (const k of missing) {
  const hits = [];
  segs.forEach((s, i) => { if (norm(s).includes(norm(k))) hits.push(i + 1); });
  segOfKey.set(k, hits);
}

// 收集要探的段號
const segNums = [...new Set([...segOfKey.values()].flat())].sort((a, b) => a - b);
console.log(`segments to probe: ${segNums.join(', ')}`);

const env = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
const stt = (file) => {
  const tu = JSON.parse(execFileSync('mcode-tools', ['upload_temp_url', path.resolve(file)], { encoding: 'utf8', maxBuffer: 1e8, env })).temp_url;
  const args = { audio_info: { url: tu, mime_type: 'audio/mpeg', prompt: '逐字转写，保留繁體中文' } };
  const d = JSON.parse(execFileSync('mcode-tools', ['connector', 'call', 'connector__matrix__listen_audio', '--args', JSON.stringify(args)], { encoding: 'utf8', maxBuffer: 1e8, env }));
  return d.transcription || '';
};

const found = new Map();
for (const n of segNums) {
  const f = path.join(JOBDIR, `${PREFIX}${String(n).padStart(3, '0')}.mp3`);
  if (!fs.existsSync(f)) { console.log(`  段 ${n}: 找不到 ${f}`); continue; }
  let t = '';
  for (let a = 1; a <= 3 && !t.length; a++) {
    try { t = stt(f); } catch (e) { console.log(`  段 ${n} 重試 ${a}: ${String(e.message).slice(0, 60)}`); }
  }
  console.log(`  段 ${n}: ${t.slice(0, 110)}`);
  const nt = norm(t);
  for (const [k, hits] of segOfKey) {
    if (hits.includes(n) && !found.has(k)) {
      const base = norm(k);
      // STT 常吞掉千分位：16,000 → 16000、6,912 → 6912 → 兩種形式都算命中
      const plain = base.replace(/,/g, '');
      if (nt.includes(base) || nt.includes(plain)) found.set(k, true);
    }
  }
}

const stillMissing = missing.filter(k => !found.has(k));
console.log(`\n段級複驗命中 ${missing.length - stillMissing.length}/${missing.length}`);
if (stillMissing.length) {
  console.log('仍未命中:');
  for (const k of stillMissing) console.log(`  - ${k}  (段 ${(segOfKey.get(k) || []).join('/') || '未在稿中找到'})`);
}
process.exit(stillMissing.length ? 1 : 0);
