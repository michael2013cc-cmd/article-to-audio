#!/usr/bin/env node
/**
 * audio-sweep.mjs — 音檔完整性掃描（零 API 成本）。
 *
 * 檢查每一個分段 mp3：
 *   - 時長離群（過短＝被截斷，過長＝可能重複合成）
 *   - 平均音量過低（空段或近乎無聲）
 *   - 峰值削波（削波＝TTS 失真）
 *
 * 為什麼需要這一層：STT 驗證只覆蓋「轉寫得出來的內容」，
 * 一段**靜音**或**被截斷**的音檔在轉寫裡可能只是少幾個字，
 * 看起來像「STT 漏鍵」，實際上是音檔本身壞了。這一層先把音檔層的問題挑出來。
 *
 * 用法：node .parts/audio-sweep.mjs [jobdir ...]
 *        node .parts/audio-sweep.mjs            # 掃描 .tts-narration 下所有分段
 */
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const all = argv.length ? argv : fs.readdirSync('.tts-narration')
  .map(d => path.join('.tts-narration', d))
  .filter(d => fs.statSync(d).isDirectory());
// The .tts-narration dir also holds scratch dirs from other experiments
// (talkback_ecosystem_study, eval_ops_q3, t2..tC, ...). They are NOT part of
// the 18-episode series, and one of them raised a false clipping flag, so
// series mode keeps only the episode jobdirs.
const SERIES = /^(ep\d+[a-z]?|C4)-/;
const dirs = argv.length ? all : all.filter(d => SERIES.test(path.basename(d)));
const skipped = all.filter(d => !SERIES.test(path.basename(d)));

let totalBad = 0;
for (const dir of dirs) {
  // 兩種命名：備援版是 part_NNN.mp3，平台版是 <node_id>.mp3
  const files = fs.readdirSync(dir)
    .filter(f => /^part_\d+\.mp3$/.test(f) || /^\d{12,}\.mp3$/.test(f)).sort();
  if (!files.length) continue;
  const rows = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let d = 0, mean = null, peak = null;
    try {
      d = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString().trim());
      // volumedetect writes to STDERR, not stdout — capturing only stdout
      // silently disabled every volume check (the 2026-10-22 first version
      // of this script reported "no anomalies" without ever reading a level).
      const res = spawnSync('ffmpeg', ['-v', 'info', '-i', p, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1e8 });
      const out = (res.stderr || '') + (res.stdout || '');
      const mm = /mean_volume: (-?[\d.]+) dB/.exec(out);
      const pm = /max_volume: (-?[\d.]+) dB/.exec(out);
      mean = mm ? parseFloat(mm[1]) : null;
      peak = pm ? parseFloat(pm[1]) : null;
    } catch (e) { rows.push({ f, d: -1, mean: null, peak: null, err: true }); continue; }
    rows.push({ f, d, mean, peak });
  }
  const ds = rows.map(r => r.d).filter(x => x > 0).sort((a, b) => a - b);
  if (!ds.length) { console.log(`  ⚠ ${dir}: 無法讀取任何分段`); totalBad++; continue; }
  const med = ds[Math.floor(ds.length / 2)];
  // Thresholds tuned against real false positives (2026-10-23):
  //  - a TTS segment can legitimately be 1.44 s ("核心产品") or 58.75 s
  //    (a 307-character table read out as prose), so the duration band is
  //    wide: below 1.0 s or above 5x the median.
  //  - peak -0.1 dB is NOT clipping: decoding the four loudest samples
  //    found ZERO full-scale samples. Clipping requires actual full-scale
  //    samples, so the dB threshold sits at 0.0.
  const bad = rows.filter(r => r.err || r.d < 1.0 || r.d > med * 5 || (r.mean !== null && r.mean < -45) || (r.peak !== null && r.peak >= 0));
  // A jobdir can hold STALE files: the resume cache is content-addressed, so
  // editing the script and re-splitting leaves the old parts behind. Those are
  // housekeeping, not a delivery bug — the merge uses the current segs only.
  // Measured: ep03b's jobdir held 156 mp3 for 52 segments, with 28 groups of
  // byte-identical leftovers. The delivered file was 13.66 min = 52 x 15.8 s,
  // so none of the stale parts reached it.
  // Report the count separately so a stale file never masks a real anomaly.
  let curSegs = null;
  const segGuess = 'chip-research/' + path.basename(dir).replace(/-google$/, '').replace(/-(.*)$/, '_$1') + '_segs.json';
  if (fs.existsSync(segGuess)) {
    try { curSegs = (JSON.parse(fs.readFileSync(segGuess, 'utf8')).segments || []).length; } catch (e) { curSegs = null; }
  }
  const staleCount = curSegs !== null && rows.length > curSegs ? rows.length - curSegs : 0;
  const label = path.basename(dir);
  if (!bad.length) {
    console.log(`  ✅ ${label.padEnd(42)} ${String(rows.length).padStart(3)} 段  中位 ${med.toFixed(1)}s  無異常${staleCount ? `  （其中 ${staleCount} 個為改稿分段後的舊檔，不在交付檔內）` : ''}`);
  } else {
    console.log(`  ⚠  ${label.padEnd(42)} ${String(rows.length).padStart(3)} 段  ${bad.length} 段異常`);
    for (const r of bad) console.log(`       ${r.f}  ${r.d.toFixed(2)}s  mean=${r.mean} peak=${r.peak}${r.err ? '  (讀取失敗)' : ''}`);
    totalBad += bad.length;
  }
}
if (skipped.length) console.log(`\n略過 ${skipped.length} 個非系列目錄：${skipped.map(d => path.basename(d)).join(', ')}`);
console.log(totalBad ? `\n共 ${totalBad} 段需要處理。` : '\n全部音檔層檢查通過 ✅');
process.exit(totalBad ? 1 : 0);
