#!/usr/bin/env node
/**
 * md2segs.mjs — turn a narration markdown into a segments JSON for narrate.mjs.
 *
 * Rules (measured, not guessed):
 *  - One paragraph = one segment, so the merged audio has a natural breath
 *    at every original paragraph break.
 *  - A segment longer than --max (default 120 chars) is split again, at the
 *    last sentence terminator before the cut point, so no segment ends
 *    mid-clause. Long paragraphs make the TTS mangle proper nouns: a
 *    235-char segment dropped BOTH "MI-455X" and "Lisa Su"; split into
 *    117 + 120 it recovered them.
 *  - Headings (## / ###) become their own segment, so the structure is
 *    audible. H1/H2/H3 markers are stripped.
 *
 * Usage:
 *   node md2segs.mjs --md out/ep08a.md --out chip-research/ep08a_segs.json [--max 120]
 *   node md2segs.mjs --md out/ep08a.md --out x.json --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { max: 120 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k === 'dry-run') { a.dryRun = true; continue; }
    a[k] = argv[++i];
  }
  return a;
}

const TERMINATORS = '。！？；…】』」"）)';

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    // Look for the last terminator inside [max*0.45, max].
    // The search must start at max-1, not max: a terminator sitting exactly at
    // index max would give cut = max+1 and emit a segment one char over the
    // limit — which never gets re-split, so the over-long segment survives
    // into the TTS and into the STT boundary check.
    let cut = -1;
    for (let i = Math.min(max - 1, rest.length - 1); i >= Math.floor(max * 0.45); i--) {
      if (TERMINATORS.includes(rest[i])) { cut = i + 1; break; }
    }
    if (cut === -1) {
      // No terminator in range — fall back to the last comma/、/space, then hard-cut.
      for (let i = Math.min(max - 1, rest.length - 1); i >= Math.floor(max * 0.45); i--) {
        if (',，、 '.includes(rest[i])) { cut = i + 1; break; }
      }
    }
    if (cut === -1) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.md || !a.out) { console.error('--md and --out are required'); process.exit(2); }
  const raw = fs.readFileSync(a.md, 'utf8');
  const blocks = raw.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  const segments = [];
  for (const b of blocks) {
    const isHeading = /^#{1,6}\s/.test(b);
    const text = b.replace(/^#{1,6}\s+/, '').trim();
    if (!text) continue;
    if (isHeading) { segments.push(text); continue; }
    for (const s of splitLong(text, a.max)) segments.push(s);
  }

  // A split can land right before a closing "**", leaving a segment that is
  // nothing but markdown markers. Spoken, that is an EMPTY segment — the TTS
  // would produce a blank audio part and the merge would carry a silent gap.
  // Fold those back into the previous segment.
  const MARKERS_ONLY = /^[\*_`#~\-\s]+$/;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments.length > 1 && MARKERS_ONLY.test(segments[i]) && segments[i].length <= 4) {
      const j = i > 0 ? i - 1 : 1;
      segments[j] = (segments[j] + ' ' + segments[i]).trim();
      segments.splice(i, 1);
    }
  }

  if (a.dryRun) {
    const lens = segments.map(s => s.length);
    const over = segments.filter(s => s.length > a.max + 40);
    console.log(`paragraphs=${blocks.length} segments=${segments.length}`);
    console.log(`chars=${segments.reduce((n, s) => n + s.length, 0)}`);
    console.log(`min=${Math.min(...lens)} max=${Math.max(...lens)} avg=${Math.round(lens.reduce((x, y) => x + y, 0) / lens.length)}`);
    console.log(`over ${a.max + 40}: ${over.length}`);
    over.slice(0, 5).forEach(s => console.log(`  [${s.length}] ${s.slice(0, 60)}…`));
    return;
  }

  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, JSON.stringify({ segments }, null, 2));
  console.log(`wrote ${a.out} — ${segments.length} segments, ${segments.reduce((n, s) => n + s.length, 0)} chars`);

  // A segment that ENDS on a bare number is a silent-audio risk. The TTS
  // reads the last token of a segment in isolation, and a trailing figure
  // like "…覆盖 300" or "…统一总线 2" is exactly the shape that gets
  // mis-read (measured: "20 億美元" became "21 億"; "1.45 秒" became "1.38").
  // It is also a sign the cut landed on a comma/space instead of a
  // sentence terminator. Fix it in the SCRIPT: split the paragraph so the
  // boundary falls on a full stop.
  const bareNumber = [];
  segments.forEach((s, i) => {
    const tail = s.replace(/\*\*|__/g, '').trim();
    if (/[\d,.]$/.test(tail)) bareNumber.push({ n: i + 1, tail: tail.slice(-24) });
  });
  if (bareNumber.length) {
    console.log(`\n⚠ ${bareNumber.length} 個段落以裸數字結尾（易被 TTS 念錯，建議在稿子裡讓切點落在句號上）：`);
    for (const b of bareNumber) console.log(`  段 ${b.n}  …${b.tail}`);
  }
}

main();
