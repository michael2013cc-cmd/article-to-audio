/**
 * keys.mjs — verification-key extraction, ranking, and pre-flight validation.
 *
 * WHY THIS EXISTS
 * Hand-written `--verify` lists drift from the script. A key that was never in
 * the narration can never appear in the transcript, so it reports as a "miss"
 * that costs a full TTS+STT cycle to chase. That happened three times in a row
 * during the Episode 3 build (104 / 158 / 69 — none of them were in the script).
 *
 * The fix is structural, not behavioural: keys are DERIVED from the script, and
 * any hand-written key that is absent from the script is rejected before a
 * single API call is made.
 *
 * Two tiers:
 *   A — literal Arabic numerals in the script ("59.2%", "0.993", "3.1").
 *       STT echoes these almost verbatim. Safest anchors. Prefer these.
 *   B — Chinese numerals in the script ("百分之八十六", "六百美元", "三点一"),
 *       converted to Arabic here. STT converts them too, but the conversion is
 *       not guaranteed (units get reformatted, decimals drift), so each tier-B
 *       key carries a set of acceptable renderings and the verifier accepts ANY.
 *
 * A key is therefore a set of alternatives, not a single string.
 *
 * All Chinese-numeral scanning goes through ONE shared scanner so that
 * extraction, normalisation, and linting can never disagree about what counts
 * as a number.
 */

const CN_DIGIT = {
  '零': 0, '〇': 0, '一': 1, '壹': 1, '幺': 1, '二': 2, '两': 2, '貳': 2, '贰': 2,
  '三': 3, '參': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陸': 6, '陆': 6,
  '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9,
};
const CN_SMALL_UNIT = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };
const CN_BIG_UNIT = { '万': 1e4, '萬': 1e4, '亿': 1e8, '億': 1e8 };
const CN_POINT = '点點';
const CN_TRAD_BIG = { '万': '萬', '亿': '億' };

/** Characters that can begin or continue a Chinese numeral run. */
const CN_NUM_CHARS = new Set([
  ...Object.keys(CN_DIGIT), ...Object.keys(CN_SMALL_UNIT), ...Object.keys(CN_BIG_UNIT),
]);

/** Ordinal marker — "第三" is a label, not a figure. */
const CN_ORDINAL = '第';

/** Vague / divisor markers — "数百万" is "several million", "每百万" is
 *  "per million": a unit, not a figure to verify. */
const CN_VAGUE = '数几每';

const isDigit = ch => ch >= '0' && ch <= '9';

/** Parse a Chinese integer part (no decimal point) to a number. Null if malformed.
 *  Accepts Arabic digits too, so mixed forms like "3萬8千" parse. */

/** Read a whole number token starting at i: "1,850" or "1.5" or "13". */
function readNumberAt(s, i) {
  let j = i;
  while (j < s.length && (isDigit(s[j]) || s[j] === ',')) j++;
  let raw = s.slice(i, j);
  while (raw.endsWith(',')) { raw = raw.slice(0, -1); j--; }
  let val = parseFloat(raw.replace(/,/g, ''));
  let end = j;
  if (s[end] === '.' && isDigit(s[end + 1])) {
    let k = end + 1;
    while (k < s.length && isDigit(s[k])) k++;
    val = parseFloat(raw.replace(/,/g, '') + s.slice(end, k));
    end = k;
  }
  return { value: val, end };
}

function parseCnInt(s) {
  if (!s) return null;
  let total = 0, section = 0, num = 0, sawAny = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // Spaces and thousands separators are ignorable inside a number run.
    if (ch === ' ' || ch === '\t' || ch === '\u3000' || ch === ',') continue;
    if (isDigit(ch)) {
      // Consume a whole number token: "1,850", "1.5", "13".
      const { value, end } = readNumberAt(s, i);
      num = value;
      sawAny = true;
      i = end - 1;
    }
    else if (ch in CN_DIGIT) { num = CN_DIGIT[ch]; sawAny = true; }
    else if (ch in CN_SMALL_UNIT) {
      section += (num || 1) * CN_SMALL_UNIT[ch]; num = 0; sawAny = true;
    } else if (ch in CN_BIG_UNIT) {
      const acc = total + section + num;
      total = (acc || 1) * CN_BIG_UNIT[ch];
      section = 0; num = 0; sawAny = true;
    } else return null;
  }
  if (!sawAny) return null;
  // Round: 5.1 × 10^8 is 509999999.99999994 in binary floating point.
  // BUT the rounding must not be applied to large magnitudes: out × 1e6
  // overflows 2^53 (9.007e15) well before 1e8, and the multiply itself
  // loses the precision the rounding was meant to restore. Measured:
  // "294.4 億" → 29439999999.999996 instead of 29440000000.
  const out = total + section + num;
  if (!Number.isFinite(out)) return out;
  if (Math.abs(out) >= 1e6) return Math.round(out);
  return Math.round(out * 1e6) / 1e6;
}

/** Walk backwards over " 1.5" / " 13" / "3" and return the index where the
 *  number starts, or -1 if there is no number there. */
function numberStartBefore(chars, idx) {
  let i = idx - 1;
  while (i >= 0 && chars[i] === ' ') i--;                 // optional space
  if (i < 0 || !isDigit(chars[i])) return -1;
  let j = i;
  while (j >= 0 && isDigit(chars[j])) j--;                 // integer part
  let start = j + 1;
  // The decimal point may sit BEFORE the integer digits: "1.5 萬億".
  if (start - 1 >= 0 && chars[start - 1] === '.' && start - 2 >= 0 && isDigit(chars[start - 2])) {
    let k = start - 2;
    while (k >= 0 && isDigit(chars[k])) k--;
    start = k + 1;
  }
  // A thousands separator may sit before the digits: "1,850 億" is 1850億.
  if (start - 1 >= 0 && chars[start - 1] === ',' && start - 2 >= 0 && isDigit(chars[start - 2])) {
    let k = start - 2;
    while (k >= 0 && (isDigit(chars[k]) || chars[k] === ',')) k--;
    start = k + 1;
  }
  return start;
}

/**
 * Parse a Chinese numeral run into a number.
 * Handles: 二十九 / 一百二十八点七 / 三千亿 / 百分之八十六 / 一点五 / 六百
 * Returns { value, bigUnit } — bigUnit is '亿'/'万' when the run ended on a
 * large unit, which is the case where STT tends to reformat the number.
 */
export function parseChineseNumber(run) {
  let s = run;
  let bigUnit = null;
  const last = s[s.length - 1];
  if (last in CN_BIG_UNIT) { bigUnit = last; s = s.slice(0, -1); }

  const pi = [...s].findIndex(c => CN_POINT.includes(c));
  let intPart = s, fracPart = '';
  if (pi >= 0) {
    intPart = [...s].slice(0, pi).join('');
    fracPart = [...s].slice(pi + 1).join('');
  }
  intPart = intPart.replace(/^百分之/, '');
  if (!intPart && !fracPart) return null;

  const iv = fracPart ? (parseCnInt(intPart) ?? 0) : parseCnInt(intPart);
  if (iv === null) return null;
  if (!fracPart) {
    // Round: 5.1 × 10^8 is 509999999.99999994 in binary floating point.
    // The rounding must not be applied above 1e6: v × 1e6 overflows 2^53
    // and the multiply itself destroys the precision the rounding restores.
    // Measured: "294.4 億" → 29439999999.999996 instead of 29440000000.
    const v = bigUnit ? iv * CN_BIG_UNIT[bigUnit] : iv;
    if (!Number.isFinite(v)) return { value: v, bigUnit };
    return { value: Math.abs(v) >= 1e6 ? Math.round(v) : Math.round(v * 1e6) / 1e6, bigUnit };
  }
  let frac = '';
  for (const ch of fracPart) {
    if (ch in CN_DIGIT) frac += CN_DIGIT[ch];
    else if (ch === '半') frac += '5';
    else return null;
  }
  if (!frac) return null;
  const dv = iv + Number('0.' + frac);
  return { value: Math.round(dv * 1e6) / 1e6, bigUnit };
}

/** All accepted renderings of a value, most-likely first. */
function renderings(value, bigUnit) {
  const out = new Set();
  if (Number.isInteger(value)) {
    out.add(String(value));
    if (bigUnit) {
      const trad = CN_TRAD_BIG[bigUnit];
      const base = bigUnit === '亿' ? 1e8 : 1e4;
      const scaled = value / base;
      if (Number.isInteger(scaled) && scaled > 0) {
        out.add(`${scaled}${trad}`);
        const altScaled = value / 1e4;   // same number expressed in 万
        if (Number.isInteger(altScaled) && altScaled > 0) out.add(`${altScaled}萬`);
      }
    }
  } else {
    out.add(String(value));
    // A decimal with a big unit also has a scaled rendering: "294.4 億" is
    // 29,440,000,000 once the TTS reads the unit out. Without this alt the
    // key "294.4" can never match a transcript that says the scaled form.
    if (bigUnit) {
      const base = bigUnit === '亿' ? 1e8 : 1e4;
      const scaled = value * base;
      if (Number.isFinite(scaled) && Math.abs(scaled) >= 1e6) {
        out.add(String(Math.round(scaled)));
      }
    }
  }
  return [...out];
}

const CN_DIGITS = '零一二三四五六七八九';
const CN_UNITS = ['', '十', '百', '千'];
const CN_BIGS = ['', '万', '亿', '万亿'];

/** Integer part in Chinese numerals. 20 → 二十, 110 → 一百一十, 38000 → 三万八千. */
function cnInt(n) {
  if (n === 0) return '零';
  if (n < 10) return CN_DIGITS[n];
  for (let i = CN_BIGS.length - 1; i >= 1; i--) {
    const base = Math.pow(10000, i);
    if (n >= base) {
      const high = Math.floor(n / base);
      const rest = n % base;
      let s = cnInt(high) + CN_BIGS[i];
      if (rest) s += (rest < base / 10 ? '零' : '') + cnInt(rest);
      return s;
    }
  }
  const d = String(n).split('').map(Number);
  let s = '', zero = false;
  for (let i = 0; i < d.length; i++) {
    const digit = d[i], unit = CN_UNITS[d.length - 1 - i];
    if (digit === 0) { zero = true; continue; }
    if (zero && s) s += '零';
    s += CN_DIGITS[digit] + unit;
    zero = false;
  }
  // 十八, not 一十八
  if (n >= 10 && n < 20 && s.startsWith('一')) s = s.slice(1);
  return s;
}

/**
 * The Chinese-numeral rendering of an Arabic value.
 *
 * WHY: the STT pass does NOT normalise number format one way. Measured on a
 * real 13-minute transcript:
 *   - script "二零二六年"  → STT "2026年"   (Chinese → Arabic)
 *   - script "共 18 篇"    → STT "共十八篇" (Arabic → Chinese!)
 *   - script "百分之八十六" → STT "86"      (Chinese → Arabic)
 *   - script "3.1 比 1"    → STT "3.1"      (Arabic → Arabic)
 * The direction is not predictable, so EVERY numeric key must accept both
 * forms. Ranking numeric keys on "the script wrote it in Arabic, so STT will
 * too" is simply wrong.
 */
export function toChineseNumber(value) {
  if (!Number.isFinite(value)) return null;
  const neg = value < 0;
  const v = Math.abs(value);
  const intPart = Math.floor(v);
  const frac = v - intPart;
  let s = cnInt(intPart);
  if (frac > 1e-9) {
    let f = '';
    // Ten digits is plenty; trailing zeros are dropped.
    let digits = (v.toFixed(6).split('.')[1] || '').replace(/0+$/, '');
    for (const ch of digits) f += CN_DIGITS[Number(ch)];
    s += '点' + f;
  }
  return (neg ? '负' : '') + s;
}

/** Traditional-Chinese variant of a Chinese numeral string. */
function toTraditional(s) {
  return s.replace(/点/g, '點').replace(/万/g, '萬').replace(/亿/g, '億');
}

/**
 * Every rendering the STT might plausibly produce for a numeric value.
 * Used for tier-A keys too — the script's Arabic form is NOT a guarantee that
 * the transcript will be Arabic.
 */
export function numericForms(value) {
  const out = new Set();
  if (Number.isInteger(value)) {
    out.add(String(value));
  } else {
    out.add(String(value));
  }
  const cn = toChineseNumber(value);
  if (cn) {
    out.add(cn);
    const tw = toTraditional(cn);
    if (tw !== cn) out.add(tw);
  }
  // The same number in the other scale, e.g. 1000000000 / 10億 / 100000萬
  if (Number.isInteger(value)) {
    for (const [div, unit] of [[1e8, '億'], [1e4, '萬']]) {
      if (value % div === 0 && value / div > 0) {
        out.add(`${value / div}${unit}`);
        out.add(`${value / div}${unit === '億' ? '亿' : '万'}`);
      }
    }
  }
  return [...out];
}

/**
 * THE shared Chinese-numeral scanner.
 * Returns [{ start, end, run, value, bigUnit, hasPoint }] over a char array.
 */
export function scanChineseRuns(chars) {
  const runs = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!CN_NUM_CHARS.has(c) && !CN_POINT.includes(c)) continue;
    // A run must not begin mid-run.
    // NOTE: `prev` is '' at index 0, and String.includes('') is TRUE — so the
    // emptiness check must be explicit or every sentence starting with a
    // numeral gets skipped.
    const prev = i > 0 ? chars[i - 1] : '';
    if (prev && (CN_NUM_CHARS.has(prev) || CN_POINT.includes(prev))) continue;
    // Ordinals are labels, not figures: 第三 / 第一
    if (prev === CN_ORDINAL) continue;
    // 数百万 / 几百万 — a vague quantity, not a figure to verify.
    if (prev && CN_VAGUE.includes(prev)) continue;

    // A run may start with an Arabic number when a big unit follows it:
    // "13萬4000" is 134000, and the leading 13 belongs to the run.
    // A space may separate them: "1.5 萬億" is 1.5 × 10^12.
    let start = i;
    if (c in CN_BIG_UNIT) {
      const ns = numberStartBefore(chars, i);
      if (ns >= 0) start = ns;
    }

    let j = i, sawPoint = false, hasDigit = false;
    // "百分之" is part of the numeral, not a separate word: 百分之八十六 = 86.
    if (c === '百' && chars[i + 1] === '分' && chars[i + 2] === '之') {
      j += 3; hasDigit = true;
    }
    while (j < chars.length) {
      const ch = chars[j];
      if (CN_NUM_CHARS.has(ch) || isDigit(ch)) { hasDigit = true; j++; continue; }
      if (CN_POINT.includes(ch)) {
        if (sawPoint) break;
        sawPoint = true; j++; continue;
      }
      break;
    }
    if (!hasDigit) continue;
    const run = chars.slice(start, j).join('');
    // A lone unit character (百 / 千 / 万 / 亿) is a fragment, not a figure.
    if (run.length === 1 && !(run[0] in CN_DIGIT)) continue;
    const parsed = parseChineseNumber(run);
    if (!parsed || !Number.isFinite(parsed.value)) continue;
    // Bare small integers are words, not figures ("一个", "两次").
    if (!parsed.bigUnit && !sawPoint && parsed.value < 10) continue;
    // A run anchored by an Arabic prefix ("5.1 億") already has a tier-A
    // candidate for the Arabic part, which is the robust key. The derived
    // value (510000000) is a form the STT is unlikely to produce, so it is
    // not a useful key — and a fragile one at that.
    const anchored = start < i && /[0-9]/.test(run[0]);
    runs.push({ start, end: j, run, value: parsed.value, bigUnit: parsed.bigUnit,
                hasPoint: sawPoint, anchored });
    i = j - 1;
  }
  return runs;
}

/**
 * Scan text for numeric candidates.
 * Returns [{ key, alts, tier, value, segment, context, count }]
 * tier 'A' = literal Arabic in the script, tier 'B' = converted from Chinese.
 */
export function extractCandidates(segments) {
  const seen = new Map();
  const push = (c) => {
    const k = c.key;
    if (seen.has(k)) {
      const prev = seen.get(k);
      prev.count++;
      prev.alts = [...new Set([...prev.alts, ...c.alts])];
      // A literal-Arabic sighting always wins the tier label.
      if (c.tier === 'A') prev.tier = 'A';
      return;
    }
    seen.set(k, c);
  };

  segments.forEach((text, si) => {
    const chars = [...text];

    // ---- Tier A: literal Arabic numerals --------------------------------
    for (let i = 0; i < chars.length; i++) {
      if (!isDigit(chars[i])) continue;
      // A digit followed by a Chinese unit belongs to a Chinese-number run
      // ("3萬8千"), which the Chinese scanner handles as one value.
      if (CN_NUM_CHARS.has(chars[i + 1])) { continue; }
      let j = i;
      while (j < chars.length && isDigit(chars[j])) j++;
      // Thousands separators: "1,048,576" is one number, not three.
      while (j < chars.length && chars[j] === ',' && isDigit(chars[j + 1])
             && isDigit(chars[j + 2]) && isDigit(chars[j + 3])) {
        j += 4;
        while (j < chars.length && isDigit(chars[j])) j++;
      }
      // A decimal part may follow the comma-grouped integer: "7,065.6" is ONE
      // number. Without this the scanner stopped at "7,065" and dropped ".6",
      // so the key could never be matched by a transcript that said 7,065.6.
      if (j < chars.length && chars[j] === '.' && isDigit(chars[j + 1])) {
        j++;
        while (j < chars.length && isDigit(chars[j])) j++;
      }
      let k = j;
      while (k < chars.length && '％%万亿倍x×$￥'.includes(chars[k])) k++;
      const num = chars.slice(i, j).join('').replace(/\.+$/, '');
      if (!num || num === '.') { i = j - 1; continue; }
      const suffix = chars.slice(j, k).join('');
      const value = parseFloat(num.replace(/,/g, ''));
      if (!Number.isFinite(value)) { i = j - 1; continue; }
      // A trailing big unit scales the value: the script's "294.4 億" is read
      // out as 二百九十四點四億, which the normaliser turns into
      // "29440000000" — a rendering the key "294.4" would never match.
      // The house style puts a space between the figure and a Chinese unit
      // ("294.4 億美元"), and the suffix scan stops at that space, so the
      // unit is also looked for one space further out. Bounded to a 4-char
      // window and a single optional space so "35.7 到 2028 年约 2 萬" cannot
      // bind a distant 萬 to the wrong figure.
      const altList = [num, ...numericForms(value), num.replace(/,/g, '')];
      const win = chars.slice(j, j + 4).join('').replace(/^[  ]+/, '');
      const sfx = suffix.replace(/^[  ]+/, '');
      // 万亿 / 萬億 is a COMPOUND unit (万 × 亿 = 1e12), not 万 (1e4).
      const bigC = /^([万萬亿億])/.exec(sfx)?.[1]
        || /^([万萬]亿|億|[亿億][万萬])/.exec(win)?.[1]
        || /^([万萬])/.exec(win)?.[1]
        || /^([亿億])/.exec(win)?.[1];
      if (bigC && !Number.isInteger(value)) {
        const isYi = /[亿億]/.test(bigC);
        const isWan = /[万萬]/.test(bigC);
        const base = isYi && isWan ? 1e12 : (isYi ? 1e8 : 1e4);
        const scaled = value * base;
        if (Number.isFinite(scaled)) altList.push(String(Math.round(scaled)));
      }
      push({
        key: num,
        // The literal form belongs in the alt set: "46,225" must match a
        // transcript that says "46,225", not only the comma-free variant.
        alts: [...new Set(altList)],
        tier: 'A',
        value,
        segment: si,
        count: 1,
        context: context(chars, i, k),
        hasUnit: suffix.length > 0,
      });
      i = k - 1;
    }

    // ---- Tier B: Chinese numerals ---------------------------------------
    for (const r of scanChineseRuns(chars)) {
      if (r.anchored) continue;   // tier A already covers the Arabic part
      const alts = renderings(r.value, r.bigUnit);
      push({
        key: alts[0],
        alts,
        tier: 'B',
        value: r.value,
        segment: si,
        count: 1,
        context: context(chars, r.start, r.end),
        hasUnit: !!r.bigUnit,
        cnText: r.run,
      });
    }
  });

  return [...seen.values()];
}

function context(chars, from, to, width = 26) {
  const s = chars.slice(Math.max(0, from - width), to + width).join('');
  return s.replace(/\n/g, ' ').trim();
}

/**
 * Normalised script text: every Chinese numeral run replaced by its Arabic
 * rendering. Used so that a hand-written key like "3.1" is accepted when the
 * script says "三点一", and vice versa.
 */
export function normalizeScript(segments) {
  const chars = [...segments.join('\n')];
  const runs = scanChineseRuns(chars);
  const byStart = new Map(runs.map(r => [r.start, r]));
  const out = [];
  let i = 0;
  while (i < chars.length) {
    const r = byStart.get(i);
    if (r) {
      out.push(renderings(r.value, r.bigUnit)[0]);
      i = r.end;
    } else {
      out.push(chars[i]);
      i++;
    }
  }
  return out.join('');
}

/**
 * Pre-flight: which of these keys are not actually in the script?
 * A key counts as present if it appears in the raw script OR in the normalised
 * script OR as any of its accepted renderings.
 */
export function preflight(keys, segments) {
  const raw = segments.join('\n');
  const norm = normalizeScript(segments);
  const bogus = [];
  for (const k of keys) {
    const label = (typeof k === 'object' && k !== null) ? String(k.key) : String(k);
    const forms = (typeof k === 'object' && k !== null && Array.isArray(k.alts) && k.alts.length)
      ? k.alts : [label];
    const found = forms.some(f => raw.includes(f) || norm.includes(f))
      || raw.includes(label) || norm.includes(label);
    if (!found) bogus.push(label);
  }
  return bogus;
}

/**
 * Rank candidates for verification value, then spread the picks across
 * segments so a single dense paragraph cannot monopolise the key budget.
 */
export function rankCandidates(candidates, topN = 25) {
  const scored = candidates.map(c => {
    let s = 0;
    // NOTE: tier A no longer means "more reliable" — the STT renders numbers
    // in either form regardless of how the script wrote them. What still
    // matters is that the figure is distinctive and carries a unit.
    if (c.hasUnit) s += 4;                     // 59.2% / 3.1x / 300万
    if (String(c.value).includes('.')) s += 3;  // 0.993 / 128.7 — precise figures
    if (c.value >= 100) s += 2;                // distinctive even in Chinese form
    if (c.value >= 10) s += 1;
    if (c.count === 1) s += 1;                 // distinctive
    if (c.value < 10) s -= 2;                  // 3 / 5 — too generic to prove anything
    if (c.value < 10 && c.count > 3) s -= 3;
    if (c.tier === 'B' && c.hasUnit) s -= 2;   // unit reformatting risk
    return { ...c, score: s };
  }).sort((a, b) => b.score - a.score || b.value - a.value);

  const perSeg = new Map();
  const picked = [];
  const rest = [];
  for (const c of scored) {
    const n = perSeg.get(c.segment) || 0;
    if (n < 2) { picked.push(c); perSeg.set(c.segment, n + 1); }
    else rest.push(c);
  }
  for (const c of rest) {
    if (picked.length >= topN) break;
    picked.push(c);
  }
  return picked.slice(0, topN);
}

/**
 * Rendering warnings — editorial, not blocking.
 * Big numbers written in Chinese are hard for STT to reproduce faithfully, and
 * decimals written in Chinese often lose their point. Both are worth writing
 * as Arabic in the source script.
 */
/** Proper nouns that contain numerals — a name, not a figure. */
const NAME_ALLOW = ['零一万物', '零零后', '一九八四'];

export function lintNumbers(segments) {
  const warns = [];
  segments.forEach((text, si) => {
    const chars = [...text];
    for (const r of scanChineseRuns(chars)) {
      // A numeral inside a proper noun is part of the name, not a figure.
      if (NAME_ALLOW.some(n => n.includes(r.run))) continue;
      // Anchored by an Arabic prefix ("5.1 億"): the Arabic part is the key,
      // and the unit is unambiguous enough for the STT to get right.
      if (r.anchored) continue;
      const big = r.value >= 100000 || !!r.bigUnit;
      if (!big && !r.hasPoint) continue;
      // "三百万亿" is ambiguous: 3×10^11 (三千亿) or 3×10^14 (literal parse).
      // Both humans and STT get it wrong, so no value is suggested — rewrite it.
      const hasWan = /[万萬]/.test(r.run);
      const hasYi = /[亿億]/.test(r.run);
      const ambiguous = hasWan && hasYi;
      warns.push({
        segment: si + 1,
        run: r.run,
        value: r.value,
        ambiguous,
        suggest: ambiguous ? null : String(r.value),
        reason: ambiguous
          ? '量级歧义（同时含「万」与「亿」）—— 建议改成「三千亿」这类无歧义写法，或直接写阿拉伯数字'
          : r.hasPoint
            ? '中文小数 —— STT 容易丢小数点，建议写阿拉伯数字'
            : '中文大数 —— STT 容易改写量级，建议写阿拉伯数字',
        context: context(chars, r.start, r.end, 18),
      });
    }
  });
  return warns;
}
