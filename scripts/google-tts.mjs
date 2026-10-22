#!/usr/bin/env node
/**
 * google-tts.mjs — 平台 TTS 掛掉時的備援語音合成。
 *
 * 用 Google 翻譯的 TTS 端點（純 HTTPS GET，不用 websocket、不用 key）：
 *   https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=<urlencoded>
 *
 * 為什麼需要它：2026-10-22 平台的音訊**生成**管線整個掛掉
 * （語音 "audio post-processing failed"、音樂 "music post-processing failed"，
 *   而 STT 正常），沒有任何客戶端繞法。這個備援讓第 13 篇不必等平台修好。
 *
 * 產出格式：mp3 / 24000 Hz / mono / 64 kbps（平台的語音是 32000 Hz / 128 kbps，
 * 所以備援音檔的音色與前 12 篇**不一致**——交付時必須標明）。
 *
 * 用法：
 *   node google-tts.mjs --segments chip-research/ep13a_segs.json \
 *                        --out output/ep13a-google.mp3 [--tl zh-CN] [--pace 120]
 *
 * 續跑：每段存成 <jobdir>/part_NNN.mp3，已存在就跳過 → 中斷後重跑不浪費。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const a = {
  segments: arg('segments'),
  out: arg('out'),
  tl: arg('tl', 'zh-CN'),
  pace: Number(arg('pace', 120)),
  maxChars: Number(arg('max-chars', 190)),
  jobdir: arg('jobdir'),
  limit: Number(arg('limit', 0)),
};

if (!a.segments || !a.out) {
  console.error('用法：node google-tts.mjs --segments <segs.json> --out <mp3>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Markdown 剝除（與 md.mjs 同一套規則） ---------- */
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .trim();
}

/* ---------- 切塊：優先落在句號，其次逗號 ---------- */
function chunkText(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (const p of ['。', '！', '？', '；']) {
      const i = rest.lastIndexOf(p, max);
      if (i > cut) cut = i;
    }
    if (cut < 0) {
      for (const p of ['，', '、', ',']) {
        const i = rest.lastIndexOf(p, max);
        if (i > cut) cut = i;
      }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/* ---------- 取音檔 ---------- */
async function fetchChunk(text, attempt = 1) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(a.tl)}&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error(`回應過小 (${buf.length} bytes)`);
    return buf;
  } catch (e) {
    if (attempt < 4) {
      await sleep(800 * attempt);
      return fetchChunk(text, attempt + 1);
    }
    throw new Error(`取音檔失敗：${String(e.message).slice(0, 80)}`);
  }
}

/* ---------- 主流程 ---------- */
const raw = JSON.parse(fs.readFileSync(a.segments, 'utf8'));
const segs = (Array.isArray(raw) ? raw : raw.segments)
  .map((s) => (typeof s === 'string' ? s : (s.text || s.content || '')))
  .filter((s) => s.trim());
const jobdir = a.jobdir || path.join('.tts-narration', path.basename(a.out, '.mp3') + '-google');
fs.mkdirSync(jobdir, { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });

console.log(`備援合成：${segs.length} 段 → ${a.out}`);
console.log(`  工作目錄：${jobdir}`);

const list = a.limit > 0 ? segs.slice(0, a.limit) : segs;
let made = 0, reused = 0, failed = 0;
const t0 = Date.now();

for (let i = 0; i < list.length; i++) {
  const part = path.join(jobdir, `part_${String(i + 1).padStart(3, '0')}.mp3`);
  if (fs.existsSync(part) && fs.statSync(part).size > 1000) { reused++; continue; }

  const text = stripMarkdown(list[i]);
  const chunks = chunkText(text, a.maxChars);
  const chunkFiles = [];
  for (let c = 0; c < chunks.length; c++) {
    const cf = path.join(jobdir, `chunk_${String(i + 1).padStart(3, '0')}_${c + 1}.mp3`);
    try {
      const buf = await fetchChunk(chunks[c]);
      fs.writeFileSync(cf, buf);
      chunkFiles.push(cf);
    } catch (e) {
      console.error(`  !! 段 ${i + 1} 第 ${c + 1} 塊失敗：${e.message}`);
      failed++;
      break;
    }
  }
  if (!chunkFiles.length) continue;

  if (chunkFiles.length === 1) {
    fs.copyFileSync(chunkFiles[0], part);
  } else {
    const listFile = path.join(jobdir, `concat_${String(i + 1).padStart(3, '0')}.txt`);
    // ffmpeg 以 concat 清單檔所在的目錄解析相對路徑 → 一律用絕對路徑
    fs.writeFileSync(listFile, chunkFiles.map((f) => `file '${path.resolve(f)}'`).join('\n'));
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', part]);
  }
  made++;
  if (made % 20 === 0) {
    const rate = (Date.now() - t0) / 1000;
    console.log(`  ${i + 1}/${list.length} 段（新做 ${made}／沿用 ${reused}）  ${rate.toFixed(0)}s`);
  }
  if (a.pace > 0) await sleep(a.pace);
}

if (failed) {
  console.error(`\n有 ${failed} 塊取不到音檔 —— 產出的音檔不完整，未合併。`);
  process.exit(1);
}

// 合併成單一 mp3
const parts = [];
for (let i = 0; i < list.length; i++) {
  const p = path.join(jobdir, `part_${String(i + 1).padStart(3, '0')}.mp3`);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) parts.push(p);
}
if (!parts.length) { console.error('沒有任何分段音檔'); process.exit(1); }

const finalList = path.join(jobdir, 'concat_all.txt');
fs.writeFileSync(finalList, parts.map((f) => `file '${path.resolve(f)}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', finalList, '-c', 'copy', a.out]);
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a.out]).toString().trim();
console.log(`\n完成 → ${a.out}`);
console.log(`  新做 ${made} 段／沿用 ${reused} 段／共 ${parts.length} 段`);
console.log(`  時長 ${(parseFloat(dur) / 60).toFixed(2)} 分`);
