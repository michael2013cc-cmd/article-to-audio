#!/usr/bin/env node
/**
 * rerender-segment.mjs — 單段重渲染，直到 STT 確認關鍵數字正確為止。
 *
 * 為什麼需要它：平台的 TTS 對某些小數的**念法是不穩定的**。
 * 2026-10-23 在 ep14 實測：稿子寫「13.4 PFLOPS MXFP4」，同一段文字反覆渲染，
 * 有時念成「13.4 PFLOPS」，有時念成「13 PFLOPS」（小數位整個被吞掉）；
 * 「Offline 1.04M、Server 1.02M」則固定念成「1 4M」「1 2M」（把零吞了）。
 * 這不是 STT 的一時手誤 —— 同一段音檔用三種提示詞轉寫，結果一致。
 *
 * 修法不是「猜一個寫法」，而是：**反覆重渲染 + 每次都用 STT 驗收**，
 * 只有當所有目標數字都在轉寫裡出現時才接受那一版。
 *
 * 用法：
 *   node scripts/rerender-segment.mjs \
 *     --jobdir .tts-narration/ep14b-model-silicon \
 *     --segments chip-research/ep14b_segs.json \
 *     --index 127 \
 *     --expect 1.04 1.02 \
 *     [--text "要改寫的新文字（省略則用原文字）"] \
 *     [--tries 12] [--reads 2]
 *
 * 通過後會：
 *   1. 用通過的那一版覆蓋 jobdir 裡該段的 mp3（檔名 = 原本的 node_id.mp3）
 *   2. 印出新的 concat 清單（沿用原本的順序與段間靜音）
 *   3. 呼叫端可以據此重新合併
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
// 多值參數：--expect 1.04 1.02 → 吃到下一個 -- 為止
const argAll = (n) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(argv[k]);
  return out;
};
const flag = (n) => argv.includes('--' + n);

const JOBDIR = arg('jobdir');
const SEGMENTS = arg('segments');
const INDEX = Number(arg('index'));
const EXPECT = argAll('expect');
const NEWTEXT = arg('text');
const TRIES = Number(arg('tries', 12));
const READS = Number(arg('reads', 2));
const VOICE = arg('voice', 'Chinese (Mandarin)_Reliable_Executive');
const SPEED = Number(arg('speed', 0.95));
const EMOTION = arg('emotion', 'neutral');

if (!JOBDIR || !SEGMENTS || Number.isNaN(INDEX)) {
  console.error('usage: --jobdir <d> --segments <f> --index <n> --expect <n1 n2> [--text <t>]');
  process.exit(2);
}

const TOOL = 'connector__matrix__batch_text_to_audio';
const STT = 'connector__matrix__listen_audio';
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });

// ---- 1. 找出該段目前的文字與音檔 ----------------------------------------
const items = JSON.parse(fs.readFileSync(path.join(JOBDIR, 'items.json'), 'utf8'))
  .sort((a, b) => a.file_name.localeCompare(b.file_name, undefined, { numeric: true }));
const segs = (JSON.parse(fs.readFileSync(SEGMENTS, 'utf8')).segments || []).map(String);
const item = items[INDEX];
if (!item) { console.error(`✗ items.json 沒有第 ${INDEX} 段`); process.exit(3); }
const text = NEWTEXT || segs[INDEX] || item.text;
const target = path.join(JOBDIR, `${item.node_id}.mp3`);
console.log(`  段 ${INDEX + 1}  音檔 ${item.node_id}.mp3`);
console.log(`  原文字：${String(item.text).slice(0, 90)}`);
if (NEWTEXT) console.log(`  新文字：${text.slice(0, 90)}`);

// ---- 2. STT 讀一段音檔 ---------------------------------------------------
function transcribe(file, prompt = '逐字转写，保留繁體中文') {
  const url = JSON.parse(run('mcode-tools', ['upload_temp_url', file])).temp_url;
  fs.writeFileSync('/tmp/_rs_stt.json', JSON.stringify({ audio_info: { url, mime_type: 'audio/mpeg', prompt } }));
  try {
    const d = JSON.parse(run('mcode-tools', ['connector', 'call', STT, '--args-file', '/tmp/_rs_stt.json']));
    return String(d.transcription || '');
  } catch (e) { return ''; }
}

// ---- 3. 反覆渲染 + 驗收 --------------------------------------------------
let accepted = null;
for (let t = 1; t <= TRIES; t++) {
  const argsFile = path.join(JOBDIR, `args_rerender_${t}.json`);
  fs.writeFileSync(argsFile, JSON.stringify({ requests: [{
    text, voice_id: VOICE, speed: SPEED, emotion: EMOTION,
    output_file: `rerender_${String(t).padStart(2, '0')}.mp3`,
  }] }));
  let d = null;
  for (let a = 1; a <= 8; a++) {
    try {
      d = JSON.parse(run('mcode-tools', ['connector', 'call', TOOL, '--args-file', argsFile]));
      if (d.code === 0 && (d.success_items || []).length) break;
      d = null;
    } catch (e) { d = null; }
    execFileSync('sleep', ['6']);
  }
  if (!d) { console.log(`  第 ${t} 次：TTS 失敗，重試`); continue; }

  const nid = d.success_items[0].node_id;
  const { download_url } = JSON.parse(run('mcode-tools', ['get_asset_url', nid]));
  const tmp = path.join(JOBDIR, `_cand_${nid}.mp3`);
  run('curl', ['-sL', '-o', tmp, download_url]);

  // 每個候選讀 READS 次，**全部**都要看到目標數字才算通過
  const reads = [];
  for (let r = 0; r < READS; r++) reads.push(transcribe(tmp));
  const ok = reads.length === READS && reads.every(x =>
    x && !/blocked by Gemini/.test(x) && EXPECT.every(e => x.includes(e)));
  console.log(`  第 ${t} 次：${ok ? '✅ 通過' : '❌ 不符'}  ${reads[0] ? reads[0].replace(/\n/g, ' ').slice(0, 96) : '(轉寫空)'}`);
  if (ok) { accepted = tmp; break; }
  fs.unlinkSync(tmp);
}

if (!accepted) {
  console.error(`\n✗ ${TRIES} 次都沒通過（目標：${EXPECT.join(' ')}）`);
  process.exit(4);
}

// ---- 4. 覆蓋原音檔 + 重建 concat 清單 -----------------------------------
fs.copyFileSync(accepted, target);
fs.unlinkSync(accepted);
console.log(`\n✓ 已覆蓋 ${target}`);

const concat = path.join(JOBDIR, 'concat.txt');
if (fs.existsSync(concat)) {
  const lines = fs.readFileSync(concat, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const out = lines.map(l => {
    const base = l.replace(/^file\s*'/, '').replace(/'$/, '').split('/').pop();
    return `file '${path.resolve(JOBDIR, base)}'`;
  });
  fs.writeFileSync(path.join(JOBDIR, 'concat_rerender.txt'), out.join('\n') + '\n');
  console.log(`  已產生 concat_rerender.txt（${out.length} 行，沿用原本順序）`);
}
console.log(`  接著合併：ffmpeg -v error -f concat -safe 0 -i <concat_rerender.txt> -c copy <out>.mp3 -y`);
