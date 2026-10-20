#!/usr/bin/env node
/**
 * audit-numbers.mjs — compare the numbers in a narration script with the
 * numbers in the source document.
 *
 * Two failure modes this catches, both of which the STT round-trip cannot:
 *
 *  1. A number IN THE SCRIPT that is NOT in the source. Either the writer
 *     invented it, or the source stated it differently and the rewrite
 *     changed its meaning. A factual error the listener hears.
 *  2. A number IN THE SOURCE that is missing from the script. Usually fine
 *     (the rewrite may legitimately drop a number) — but when a whole table
 *     of figures vanishes, that is a silent omission, and the summary said
 *     "must not silently drop tickers, qualifiers, conflicting numbers".
 *
 * Numbers are compared as VALUES, not as strings: "7,065.6" in the script and
 * "7065.6" in the source are the same figure; "12万" and "12 萬" are the same
 * figure. The source is Chinese, the script may be Arabic, and both sides may
 * write 万 or 萬.
 *
 * Usage:
 *   node audit-numbers.mjs --script output/ep08a-upstream.md --source chip-research/B3-*.md
 *   node audit-numbers.mjs --script out.md --source src.md --min-source 50
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const scriptFile = arg('script');
const sourceFile = arg('source');
const minSource = Number(arg('min-source', 100));   // only report big source numbers as "dropped"
if (!scriptFile || !sourceFile) { console.error('--script and --source are required'); process.exit(2); }

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CNU = { 十: 10, 百: 100, 千: 1000 };
const BIGU = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8, 兆: 1e12, 万亿: 1e12, 萬億: 1e12, 兆元: 1e12 };

/** All numeric values in a text: Arabic literals + Chinese numeral runs. */
function numbersIn(text) {
  const out = [];
  // Arabic, with optional thousands separators and decimals
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g)) {
    out.push({ v: parseFloat(m[1].replace(/,/g, '')), raw: m[1], at: m.index });
  }
  // Chinese numeral runs: 十亿 / 二十万 / 三千 / 一点五
  const re = /[零〇一二两三四五六七八九十百千万億亿兆]+(?:点[零〇一二三四五六七八九]+)?/g;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (!/[十百千万億亿兆]/.test(s) && !/点/.test(s)) continue;   // bare 一二三 is usually a word
    const v = parseCn(s);
    if (v !== null) out.push({ v, raw: s, at: m.index });
  }
  return out;
}

function parseCn(s) {
  const [intPart, decPart] = s.split('点');
  let total = 0, section = 0, num = 0, big = 1;
  for (const ch of intPart) {
    if (ch in CN) { num = CN[ch]; continue; }
    if (ch in CNU) { section += (num || 1) * CNU[ch]; num = 0; continue; }
    if (ch in BIGU) {
      const mul = BIGU[ch];
      total += (section + num) * mul;
      section = 0; num = 0; big = mul;
    }
  }
  total += section + num;
  if (decPart) {
    const frac = parseFloat('0.' + [...decPart].map(c => CN[c] ?? 0).join(''));
    total += frac;
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

const script = fs.readFileSync(scriptFile, 'utf8');
const source = fs.readFileSync(sourceFile, 'utf8');

const sn = numbersIn(script);
const sNums = new Set(sn.map(n => Math.round(n.v * 1000) / 1000));
const srcNums = numbersIn(source);
const srcSet = new Set(srcNums.map(n => Math.round(n.v * 1000) / 1000));

// A script number is supported if the source contains the same value.
// Scale-tolerant matching (万/萬, 億/亿) only applies to figures big enough
// for the scale to be meaningful — otherwise "3" would "match" "30000".
function scaleVariants(v) {
  const out = new Set([v]);
  if (v >= 1000) {
    for (const k of [1e4, 1e8, 1e12]) { out.add(v / k); out.add(v * k); }
  }
  return [...out];
}
const coveredByScript = new Set();
for (const v of sNums) for (const k of scaleVariants(v)) coveredByScript.add(Math.round(k * 1000) / 1000);
const near = v => scaleVariants(v).some(k => srcSet.has(Math.round(k * 1000) / 1000));

const unsupported = sn.filter(n => !near(n.v));
const dropped = [...srcSet].filter(v => !coveredByScript.has(Math.round(v * 1000) / 1000) && v >= minSource);

console.log(`\n脚本: ${scriptFile}`);
console.log(`源文: ${sourceFile}`);
console.log(`脚本数字 ${sn.length} 个（去重 ${sNums.size}），源文数字 ${srcSet.size} 个\n`);

console.log(`── 脚本里有、源文里对不上（可能写错或改写走样）: ${unsupported.length} ──`);
const byVal = new Map();
for (const n of unsupported) {
  if (!byVal.has(n.v)) byVal.set(n.v, n);
}
for (const n of [...byVal.values()].sort((a, b) => b.v - a.v).slice(0, 60)) {
  const ctx = script.slice(Math.max(0, n.at - 34), n.at + 34).replace(/\n/g, ' ').replace(/\*\*/g, '');
  console.log(`  ${String(n.raw).padEnd(12)} (${n.v})  …${ctx}…`);
}

console.log(`\n── 源文里的大数字、脚本里没有（可能是漏讲）: ${dropped.length} ──`);
for (const v of [...dropped].sort((a, b) => b - a).slice(0, 60)) console.log(`  ${v}`);

console.log(`\n结论: ${unsupported.length ? '有脚本数字需要核对源文' : '脚本数字全部可在源文找到'}; ${dropped.length} 个源文大数字未出现在脚本（需人工判断是否该讲）`);
