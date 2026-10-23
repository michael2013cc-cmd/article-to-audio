#!/usr/bin/env node
/**
 * rerender-c4.mjs — 精準重渲染 C4（ep18）的兩個段落並重新合併。
 *
 * 背景（2026-10-23）：
 *  1. 稿子把國標號寫成「国标四千零八百七十九号」＝4879，源文是 GB 40879。
 *     → 事實錯誤，音頻也錯。
 *  2. 開場缺「第 18 篇，共 18 篇」框架句，聽眾不知道這是第 18 篇。
 *
 * 只重渲染受影響的兩段（第 1 段、第 38 段），其餘 57 段音訊原封不動，
 * 沿用原 concat.txt 的順序與 0.5 秒段間靜音重新合併。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const JOB = '.tts-narration/C4-tokens-per-mw';
const TOOL = 'connector__matrix__batch_text_to_audio';
const VOICE = 'Chinese (Mandarin)_Reliable_Executive';
const SPEED = 0.95;
const EMOTION = 'neutral';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
}

// ---- 1. 取出 59 段的原文（args 檔依序）與音檔順序（concat.txt）--------
const argFiles = fs.readdirSync(JOB).filter(f => /^args_\d+\.json$/.test(f)).sort();
const segs = [];
for (const af of argFiles) {
  const j = JSON.parse(fs.readFileSync(path.join(JOB, af), 'utf8'));
  for (const r of (j.requests || [])) segs.push(r.text);
}
const order = fs.readFileSync(path.join(JOB, 'concat.txt'), 'utf8').trim().split('\n')
  .map(l => l.trim().replace(/^file\s*'/, '').replace(/'$/, '').split('/').pop())
  .filter(f => f !== 'silence_0.5.mp3');

if (segs.length !== order.length) {
  console.error(`✗ 段數不一致：args ${segs.length} vs concat ${order.length}`);
  process.exit(1);
}

// ---- 2. 套用兩處修正 ----------------------------------------------------
const FRAME = '第 18 篇，共 18 篇。';
const GB_OLD = '国标四千零八百七十九号';
const GB_NEW = '国标 GB 40879 号';

if (!segs[0].startsWith('C4，每兆瓦 Token')) {
  console.error('✗ 第 1 段開頭與預期不符'); process.exit(1);
}
segs[0] = FRAME + segs[0];

const gbIdx = segs.findIndex(t => t.includes(GB_OLD));
if (gbIdx < 0) { console.error('✗ 找不到國標那一句'); process.exit(1); }
segs[gbIdx] = segs[gbIdx].replace(GB_OLD, GB_NEW);

const targets = [0, gbIdx];
console.log(`將重渲染 ${targets.length} 段：`);
for (const i of targets) {
  console.log(`  段 ${i + 1} → ${order[i]}`);
  console.log(`    ${segs[i].slice(0, 96)}`);
}

// ---- 3. 呼叫平台 TTS ----------------------------------------------------
const requests = targets.map(i => ({
  text: segs[i], voice_id: VOICE, speed: SPEED, emotion: EMOTION,
  output_file: `part_${String(i + 1).padStart(3, '0')}.mp3`,
}));
const argFile = path.join(JOB, 'args_rerender.json');
fs.writeFileSync(argFile, JSON.stringify({ requests }));

let d;
for (let attempt = 1; attempt <= 40; attempt++) {
  try {
    const raw = run('mcode-tools', ['connector', 'call', TOOL, '--args-file', argFile], { timeout: 300_000 });
    d = JSON.parse(raw);
    if (d.code === 0 && (d.success_items || []).length === targets.length) break;
    console.log(`  attempt ${attempt}: code=${d.code} got ${(d.success_items || []).length}/${targets.length} — ${String(d.message || '').slice(0, 110)}`);
  } catch (e) {
    console.log(`  attempt ${attempt}: ${String(e.message).slice(0, 110)}`);
  }
  d = null;
  execFileSync('sleep', ['20']);
}
if (!d) { console.error('✗ 平台持續不可用，放棄（可重跑本腳本）'); process.exit(2); }
if ((d.success_items || []).length !== targets.length) { console.error('✗ 取得數量不符'); process.exit(3); }

// ---- 4. 下載並替換音檔 --------------------------------------------------
for (let k = 0; k < targets.length; k++) {
  const it = d.success_items[k];
  const { download_url } = JSON.parse(run('mcode-tools', ['get_asset_url', it.node_id], { timeout: 180_000 }));
  const tmp = path.join(JOB, `rerender_${it.node_id}.mp3`);
  run('curl', ['-sL', '-o', tmp, download_url], { timeout: 300_000 });
  const sz = fs.statSync(tmp).size;
  if (sz < 1000) { console.error(`✗ 下載檔過小 (${sz}B)`); process.exit(4); }
  // 覆蓋對應位置的舊音檔
  const dst = path.join(JOB, order[targets[k]]);
  fs.copyFileSync(tmp, dst);
  fs.unlinkSync(tmp);
  const dur = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst]).trim();
  console.log(`  ✓ 段 ${targets[k] + 1} → ${order[targets[k]]}  ${(sz / 1024).toFixed(0)} KB / ${Number(dur).toFixed(2)}s`);
}

// ---- 5. 用原順序重新合併 -------------------------------------------------
const listFile = path.join(JOB, 'concat_rerender.txt');
// ffmpeg 的 concat demuxer 會把相對路徑解析成「list 檔所在目錄 + 路徑」，
// 所以這裡必須用絕對路徑，否則路徑會被疊成 .tts-narration/xxx/.tts-narration/xxx/。
const abs = f => path.resolve(JOB, f);
const lines = [];
for (let i = 0; i < order.length; i++) {
  lines.push(`file '${abs(order[i])}'`);
  if (i < order.length - 1) lines.push(`file '${abs('silence_0.5.mp3')}'`);
}
fs.writeFileSync(listFile, lines.join('\n') + '\n');
const out = 'output/C4-tokens-per-mw.mp3';
// 副檔名必須仍以 .mp3 結尾，否則 ffmpeg 推不出輸出格式。
const tmpOut = 'output/C4-tokens-per-mw.new.mp3';
run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', tmpOut, '-y']);
fs.renameSync(tmpOut, out);
const dur = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).trim();
const sz = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`\n✓ 重新合併：${out}  ${(Number(dur) / 60).toFixed(2)} 分 / ${sz} MB`);

// ---- 6. 更新 59 段文字快照（供下次比對）---------------------------------
fs.writeFileSync('/tmp/c4_segs59.json', JSON.stringify(segs, null, 1));
console.log('  已更新 /tmp/c4_segs59.json');
