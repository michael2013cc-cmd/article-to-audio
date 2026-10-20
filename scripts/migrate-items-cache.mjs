#!/usr/bin/env node
/**
 * migrate-items-cache.mjs — add the spoken text to a legacy items.json.
 *
 * The synthesis cache used to be a bare array of {node_id, file_name}. The
 * resume mechanism is CONTENT-ADDRESSED, so each cached part needs to know
 * what text it was synthesized from.
 *
 * The text is recoverable: every call wrote its request to
 * args_<batch>.json in the job dir, keyed by output_file. This script reads
 * those and back-fills the text.
 *
 * Usage:
 *   node migrate-items-cache.mjs --jobdir .tts-narration/ep08a-upstream
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const jobdir = arg('jobdir');
if (!jobdir) { console.error('--jobdir is required'); process.exit(2); }

const itemsFile = path.join(jobdir, 'items.json');
const items = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
if (items.length && items[0].text) { console.log('already migrated'); process.exit(0); }

// text lookup from the request files
const textOf = new Map();
for (const f of fs.readdirSync(jobdir)) {
  if (!/^args_.*\.json$/.test(f)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(jobdir, f), 'utf8'));
    for (const r of d.requests || []) if (r.output_file) textOf.set(r.output_file, r.text);
  } catch { /* ignore an unreadable args file */ }
}

let filled = 0, missing = 0;
const out = items.map(it => {
  const t = textOf.get(it.file_name);
  if (t === undefined) { missing++; return it; }
  filled++;
  return { ...it, text: t };
});
fs.writeFileSync(itemsFile, JSON.stringify(out, null, 2));
console.log(`migrated: ${filled}/${items.length} parts got their text${missing ? ` (${missing} unmatched — those parts will be re-synthesized)` : ''}`);
if (missing) console.log('unmatched: ' + items.filter(it => textOf.get(it.file_name) === undefined).map(it => it.file_name).join(', '));
