#!/usr/bin/env node
/**
 * probe-seg-platform.mjs — 對平台版（MiniMax 語音）音檔做段級窄視窗複驗。
 *
 * 平台版的 jobdir 裡每段一個 mp3，但**檔名是 node_id**（不是 part_NNN.mp3），
 * 需要靠 items.json 的 node_id 欄位做「段號 → 檔案」的對照。
 *
 * 用法：
 *   node .parts/probe-seg-platform.mjs --segs chip-research/ep08a_segs.json \
 *        --keys chip-research/ep08a_keys.json \
 *        --jobdir .tts-narration/ep08a-upstream --transcript <txt>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SEGS = arg('segs'), KEYS = arg('keys'), JOBDIR = arg('jobdir'), TRANSCRIPT = arg('transcript');
if (!SEGS || !KEYS || !JOBDIR) { console.error('usage: probe-seg-platform.mjs --segs <f> --keys <f> --jobdir <d> [--transcript <f>]'); process.exit(2); }

const norm = (s) => String(s).replace(/[，]/g, ',').replace(/[。！？；]/g, '\n').replace(/\s+/g, '');
const segs = (JSON.parse(fs.readFileSync(SEGS, 'utf8')).segments || []).map(String);
const kr = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
const keys = (Array.isArray(kr) ? kr : kr.keys || []).map(k => (typeof k === 'string' ? k : k.key));

// items.json: 依段序列出 {node_id, file_name, text}
// CRITICAL: items.json 是**插入順序**寫的，不是 file_name 順序——narrate.mjs 在
// 合併前才 sort。用插入順序對照會整段錯位，探到別的段的音檔。
// 2026-10-23 實測：ep14a 用插入順序對照，探到「Anthropic 與三星」那段，
// 而要找的 13.4 在第 24 段 → 段級複驗 0/3，看起來像音頻缺內容。
const items = JSON.parse(fs.readFileSync(path.join(JOBDIR, 'items.json'), 'utf8'))
  .sort((a, b) => a.file_name.localeCompare(b.file_name, undefined, { numeric: true }));

let missing = keys;
if (TRANSCRIPT && fs.existsSync(TRANSCRIPT)) {
  const tr = norm(fs.readFileSync(TRANSCRIPT, 'utf8'));
  missing = keys.filter(k => {
    const b = norm(k), p = b.replace(/,/g, '');
    if (tr.includes(b) || tr.includes(p)) return false;
    const int = p.split('.')[0];
    return !(int.length >= 2 && tr.includes(int));
  });
}
console.log(`keys ${keys.length}; missing ${missing.length}`);

const segOfKey = new Map();
for (const k of missing) {
  const hits = [];
  segs.forEach((s, i) => { if (norm(s).includes(norm(k))) hits.push(i + 1); });
  segOfKey.set(k, hits);
}
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
  const it = items[n - 1];
  if (!it) { console.log(`  段 ${n}: items.json 沒有對應`); continue; }
  const cands = [path.join(JOBDIR, it.file_name), path.join(JOBDIR, it.node_id + '.mp3')];
  const f = cands.find(p => fs.existsSync(p));
  if (!f) { console.log(`  段 ${n}: 找不到 mp3 (${cands.join(' | ')})`); continue; }
  let t = '';
  for (let a = 1; a <= 3 && !t.length; a++) { try { t = stt(f); } catch (e) { console.log(`  段 ${n} 重試 ${a}: ${String(e.message).slice(0, 60)}`); } }
  console.log(`  段 ${n} [${path.basename(f)}]: ${t.slice(0, 130)}`);
  const nt = norm(t);
  for (const [k, hits] of segOfKey) {
    if (hits.includes(n) && !found.has(k)) {
      const b = norm(k), p = b.replace(/,/g, '');
      if (nt.includes(b) || nt.includes(p)) found.set(k, true);
    }
  }
}

const still = missing.filter(k => !found.has(k));
console.log(`\n段級複驗命中 ${missing.length - still.length}/${missing.length}`);
for (const k of still) console.log(`  - ${k}  (段 ${(segOfKey.get(k) || []).join('/') || '稿中未找到'})`);
process.exit(still.length ? 1 : 0);
