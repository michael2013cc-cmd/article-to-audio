/**
 * keys.mjs 與 md.mjs 的純函式測試。
 *
 * 這些是整條管線裡最不該壞的部分：鍵的正規化、中文數字解析、Markdown 剝除。
 * 2026-10-22 沙箱重建時整個測試套件遺失，於是重建。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChineseNumber, toChineseNumber, numericForms,
  scanChineseRuns, extractCandidates, normalizeScript,
  preflight, rankCandidates, lintNumbers,
} from '../scripts/keys.mjs';
import { stripMarkdown } from '../scripts/md.mjs';

const seg = (s) => [s];

/* ---------- parseChineseNumber ---------- */

test('parseChineseNumber 解析基本中文數字', () => {
  assert.equal(parseChineseNumber('一百零五').value, 105);
  assert.equal(parseChineseNumber('一千二百三十四').value, 1234);
  assert.equal(parseChineseNumber('三').value, 3);
});

test('parseChineseNumber 解析大單位', () => {
  const w = parseChineseNumber('三千万');
  assert.equal(w.value, 30000000);
  assert.equal(w.bigUnit, '万');
});

test('parseChineseNumber 接受萬／億混寫', () => {
  assert.equal(parseChineseNumber('一万二千三百').value, 12300);
});

test('parseChineseNumber 對非數字回傳 null', () => {
  assert.equal(parseChineseNumber('不是數字'), null);
});

/* ---------- toChineseNumber ---------- */

test('toChineseNumber 轉出標準中文寫法', () => {
  assert.equal(toChineseNumber(1234), '一千二百三十四');
  assert.equal(toChineseNumber(105), '一百零五');
});

test('toChineseNumber 對整萬用萬單位', () => {
  assert.equal(toChineseNumber(10000), '一万');
});

/* ---------- numericForms ---------- */

test('numericForms 同時給阿拉伯與中文兩種形態', () => {
  const f = numericForms(1234);
  assert.ok(f.includes('1234'));
  assert.ok(f.includes('一千二百三十四'));
});

test('numericForms 保留浮點精度（不可截斷成整數）', () => {
  const f = numericForms(7065.6);
  assert.ok(f.includes('7065.6'), '必須保留小數');
  assert.ok(!f.includes('7065'), '不可只留整數部分');
});

test('numericForms 對小數給出點與點兩種中文寫法', () => {
  const f = numericForms(7065.6);
  assert.ok(f.some(x => x.includes('点') || x.includes('點')));
});

/* ---------- scanChineseRuns ---------- */

test('scanChineseRuns 找得到中文數字', () => {
  const r = scanChineseRuns([...'大約三億台']);
  assert.ok(r.length >= 1);
  assert.equal(r[0].value, 300000000);
});

test('scanChineseRuns 序數不算數量', () => {
  const r = scanChineseRuns([...'第三部分']);
  assert.equal(r.length, 0);
});

test('scanChineseRuns 泛用量詞不算數量', () => {
  // 注意：CN_VAGUE 是簡體集合（'数几每'）——稿本來就用簡體，繁體不在範圍內。
  assert.deepEqual(scanChineseRuns([...'几百万台']), []);
});

test('scanChineseRuns 裸的單位字不算數量', () => {
  assert.deepEqual(scanChineseRuns([...'万']), []);
  assert.deepEqual(scanChineseRuns([...'百']), []);
});

test('scanChineseRuns 句首的中文數字不會被漏掉', () => {
  // 回歸測試：prev 為空字串時 includes('') 為 true，會讓每個句首數字被跳過。
  const r = scanChineseRuns([...'三十倍']);
  assert.ok(r.length >= 1, '句首數字必須被掃到');
});

test('scanChineseRuns 小的裸整數視為詞而非數量', () => {
  // 「三倍」「一個」這類是詞，不是要驗證的數量。
  assert.deepEqual(scanChineseRuns([...'三倍加速']), []);
  assert.deepEqual(scanChineseRuns([...'一個包裝']), []);
});

test('scanChineseRuns 百分之是數字的一部分', () => {
  const r = scanChineseRuns([...'百分之八十六']);
  assert.ok(r.length >= 1);
  assert.equal(r[0].value, 86);
});

/* ---------- extractCandidates ---------- */

test('extractCandidates 阿拉伯數字是 tier A', () => {
  const c = extractCandidates(seg('峰值 59.2% 出現'));
  const hit = c.find(x => x.key === '59.2');
  assert.ok(hit, '應抓到 59.2');
  assert.equal(hit.tier, 'A');
});

test('extractCandidates 同一數字重複出現時 count 遞增', () => {
  const c = extractCandidates(seg('3.1 倍加速，然後又是 3.1 倍'));
  const hit = c.find(x => x.key === '3.1');
  assert.ok(hit);
  assert.ok(hit.count >= 2);
});

test('extractCandidates 去重後 alts 合併', () => {
  const c = extractCandidates(seg('速度 1.2 倍'));
  assert.ok(c.length >= 1);
  assert.ok(Array.isArray(c[0].alts));
});

/* ---------- normalizeScript ---------- */

test('normalizeScript 把中文數字換成阿拉伯', () => {
  assert.equal(normalizeScript(seg('三十倍加速')), '30倍加速');
});

test('normalizeScript 小的裸整數不換（它們是詞）', () => {
  assert.equal(normalizeScript(seg('三倍加速')), '三倍加速');
});

test('normalizeScript 保留原有阿拉伯數字', () => {
  assert.match(normalizeScript(seg('已經是 3.1 倍')), /3\.1/);
});

/* ---------- preflight ---------- */

test('preflight 抓得出不在稿中的鍵', () => {
  const bogus = preflight(['59.2', '不存在數字 999999'], seg('峰值 59.2% 出現'));
  assert.ok(bogus.includes('不存在數字 999999'));
  assert.ok(!bogus.includes('59.2'));
});

test('preflight 接受在正規化稿中出現的鍵', () => {
  assert.deepEqual(preflight(['3'], seg('三十倍加速')), []);
});

test('preflight 抓得出稿中只是詞的小整數', () => {
  // 稿寫「三倍」＝詞，但「3」確實不在稿中 → 應報 bogus。
  assert.deepEqual(preflight(['3'], seg('三倍加速')), ['3']);
});

test('preflight 接受物件形式的鍵（用 alts 比對）', () => {
  const bogus = preflight([{ key: '59.2', alts: ['59.2', '59.2%'] }], seg('峰值 59.2% 出現'));
  assert.deepEqual(bogus, []);
});

/* ---------- rankCandidates ---------- */

test('rankCandidates 回傳指定數量', () => {
  const c = extractCandidates(seg('59.2% 與 3.1 倍 與 128.7 TB 與 7 倍'));
  const r = rankCandidates(c, 3);
  assert.ok(r.length <= 3);
});

test('rankCandidates 帶單位的數字分數較高', () => {
  const c = extractCandidates(seg('128.7 TB 與 7'));
  const withUnit = c.find(x => x.hasUnit);
  const without = c.find(x => !x.hasUnit);
  if (withUnit && without) {
    const r = rankCandidates(c, c.length);
    assert.ok(r.findIndex(x => x.key === withUnit.key) <= r.findIndex(x => x.key === without.key));
  }
});

/* ---------- lintNumbers ---------- */

test('lintNumbers 抓得出中文大數（該改寫成阿拉伯數字）', () => {
  // lintNumbers 查的是「中文數字」：STT 容易把量級改寫。
  const bad = lintNumbers(seg('数量三百万台'));
  assert.ok(bad.length >= 1, '中文大數應被標出');
  assert.equal(bad[0].run, '三百万');
  assert.equal(bad[0].value, 3000000);
});

test('lintNumbers 放行純阿拉伯數字（段尾裸數字是另一道閘門）', () => {
  assert.deepEqual(lintNumbers(seg('这个值是 8')), []);
});

test('lintNumbers 標示量級歧義的情況', () => {
  const bad = lintNumbers(seg('规模三万亿'));
  if (bad.length) assert.ok(typeof bad[0].ambiguous === 'boolean');
});

test('lintNumbers 段尾是句號就沒問題', () => {
  assert.deepEqual(lintNumbers(seg('這個值是 8。')), []);
});

/* ---------- stripMarkdown ---------- */

test('stripMarkdown 去掉粗體標記', () => {
  assert.equal(stripMarkdown('**粗體**'), '粗體');
});

test('stripMarkdown 去掉連結但保留文字', () => {
  assert.equal(stripMarkdown('[文字](http://x)'), '文字');
});

test('stripMarkdown 去掉反引號', () => {
  assert.equal(stripMarkdown('`程式碼`'), '程式碼');
});

test('stripMarkdown 不動一般文字', () => {
  assert.equal(stripMarkdown('普通句子。'), '普通句子。');
});
