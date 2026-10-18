#!/usr/bin/env node
/**
 * test-keys.mjs — regression tests for the key derivation logic.
 * Zero dependencies. Run: node scripts/test-keys.mjs
 */
import {
  parseChineseNumber, scanChineseRuns, extractCandidates,
  normalizeScript, preflight, rankCandidates, lintNumbers, numericForms,
} from './keys.mjs';
import { stripMarkdown } from './md.mjs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      得到 ${g}\n      期望 ${w}`); }
};
const ok = (label, cond) => eq(label, !!cond, true);

console.log('\n── 中文字数解析 ──');
eq('二十九', parseChineseNumber('二十九')?.value, 29);
eq('一百二十八点七', parseChineseNumber('一百二十八点七')?.value, 128.7);
eq('百分之八十六', parseChineseNumber('百分之八十六')?.value, 86);
eq('六百', parseChineseNumber('六百')?.value, 600);
eq('三千亿', parseChineseNumber('三千亿')?.value, 3e11);
eq('万亿 (隐含一)', parseChineseNumber('万亿')?.value, 1e12);
eq('一点五', parseChineseNumber('一点五')?.value, 1.5);
eq('二十', parseChineseNumber('二十')?.value, 20);

console.log('\n── 整句扫描（回归：空串 includes 陷阱）──');
const scan = s => scanChineseRuns([...s]).map(r => r.value);
eq('句首「一点五小时」', scan('一点五小时'), [1.5]);
eq('句首「一百万亿」', scan('一百万亿 token'), [1e14]);
eq('句首「三百万亿」', scan('三百万亿 token'), [3e14]);
eq('「百分之九十二掉到百分之六十三」', scan('百分之九十二掉到百分之六十三'), [92, 63]);
eq('「三点一比一」', scan('智能体对人类工作日是三点一比一'), [3.1]);
eq('序数不计入', scan('第一章 第三个 一半'), []);
eq('阿拉伯数字不计入中文字数扫描', scan('下降 59.2%'), []);

console.log('\n── 归一化：中文稿 ↔ 阿拉伯键 ──');
const segs = ['智能体对人类工作日是三点一比一。', '中位研究员日推理消耗超过六百美元。'];
const norm = normalizeScript(segs);
ok('归一化后含 3.1', norm.includes('3.1'));
ok('归一化后含 600', norm.includes('600'));

console.log('\n── 预检门：不在稿子里的键必须被抓住 ──');
eq('抓到 104/158/69',
   preflight([{ key: '104', alts: ['104'] }, { key: '158', alts: ['158'] },
              { key: '69', alts: ['69'] }], segs), ['104', '158', '69']);
eq('放行稿中已有的 3.1', preflight([{ key: '3.1', alts: ['3.1'] }], segs), []);
eq('放行中文稿对应的 3.1（归一化命中）', preflight([{ key: '3.1', alts: ['3.1'] }],
   ['智能体对人类工作日是三点一比一。']), []);

console.log('\n── 候选提取：层级判定 ──');
const mixed = ['五成视野约十二小时，但八成视野仅约一点五小时。', '配额下降 59.2%。'];
const cands = extractCandidates(mixed);
const t59 = cands.find(c => c.key === '59.2');
eq('59.2 是 A 级（稿中字面）', t59?.tier, 'A');
const t15 = cands.find(c => c.key === '1.5');
eq('1.5 是 B 级（中文小数转换）', t15?.tier, 'B');
ok('1.5 至少接受阿拉伯形式', t15?.alts.includes('1.5'));

console.log('\n── 排序：跨段分散 + A 级优先 ──');
const many = Array.from({ length: 12 }, (_, i) => `第 ${i} 段 59.2% 数值 ${i * 3}.7 倍 规模 ${i + 2}`);
const ranked = rankCandidates(extractCandidates(many), 10);
const segSet = new Set(ranked.map(c => c.segment));
ok('取到的键分散在多个段', segSet.size >= 4);
ok('全部候选都是稿中真实存在的',
   preflight(ranked, many).length === 0);

console.log('\n── Lint：中文大数 / 小数必须被提示 ──');
const lint = lintNumbers(['大约三百万亿 token，增速是二点五倍。', '一百二十八点七天。']);
ok('检出中文大数', lint.some(w => w.run.includes('三百万亿')));
ok('中文大数标为量级歧义', lint.find(w => w.run.includes('三百万亿'))?.ambiguous === true);
ok('检出中文小数', lint.some(w => w.run.includes('二点五')));

console.log('\n── 数字形态是双向的（实测：STT 两种形态都会出）──');
eq('18 → 阿拉伯 + 中文', numericForms(18).includes('18') && numericForms(18).includes('十八'), true);
eq('59.2 → 含繁体点', numericForms(59.2).includes('五十九點二'), true);
eq('3.1 → 含繁体点', numericForms(3.1).includes('三點一'), true);
eq('128.7 → 完整中文', numericForms(128.7).includes('一百二十八点七'), true);
eq('38000 → 三万八千', numericForms(38000).includes('三万八千'), true);
eq('1e9 → 十亿与10億', numericForms(1e9).includes('十亿') && numericForms(1e9).includes('10億'), true);

console.log('\n── 中阿混排：3萬8千 = 38000 ──');
eq('扫描 3萬8千', scan('3萬8千小時'), [38000]);
eq('扫描 134個任務（纯阿拉伯不算中文数）', scan('EdgeBench 134個任務'), []);
eq('归一化 3萬8千', normalizeScript(['3萬8千小時']), '38000小時');
eq('归一化 共十八篇', normalizeScript(['共十八篇']), '共18篇');
eq('扫描 13萬4000（多位数在万前）', scan('13萬4000顆 TPU'), [134000]);
eq('归一化 13萬4000', normalizeScript(['13萬4000顆 TPU']), '134000顆 TPU');
eq('扫描 3億', scan('3億美元'), [300000000]);
eq('扫描 1.5 万亿（数字+空格+中文单位）', scan('1.5 萬億美元'), [1.5e12]);
eq('扫描 54 万亿韩元', scan('54 萬億韓元'), [5.4e13]);
eq('扫描 3 萬億 token', scan('3 萬億 token'), [3e12]);
eq('扫描 1,850 億（千分位+中文单位）', scan('1,850 億美元'), [1.85e11]);
eq('扫描 20 億', scan('20 億美元'), [2e9]);

console.log('\n── 千分位逗号是一个数，不是三个 ──');
eq('1,048,576 作为一个键', extractCandidates(['上下文 1,048,576 token'])
   .map(c => c.key).includes('1,048,576'), true);
eq('键接受去逗号形式', extractCandidates(['上下文 1,048,576 token'])
   .find(c => c.key === '1,048,576')?.alts.includes('1048576'), true);

console.log('\n── 键必须双向可匹配（脚本阿拉伯 ↔ 字幕中文）──');
const t = '第三篇，共十八篇，進度機制換引擎。';
const k18 = { key: '18', alts: numericForms(18) };
ok('阿拉伯键命中中文字幕', k18.alts.some(a => t.includes(a)));

console.log('\n── Markdown 必须在进 TTS 前剥掉（带 ** 会静默损坏音频）──');
eq('粗体', stripMarkdown('**最高 9,216 核的 pod，42.5 EF**。'), '最高 9,216 核的 pod，42.5 EF。');
eq('粗体+标签', stripMarkdown('**Google**：**TPU 8t**'), 'Google：TPU 8t');
eq('斜体', stripMarkdown('*强调*'), '强调');
eq('删除线', stripMarkdown('~~删~~'), '删');
eq('行内代码', stripMarkdown('见 `code`'), '见 code');
eq('链接只留文字', stripMarkdown('见 [文档](http://x.com)'), '见 文档');
eq('无标记文本不变', stripMarkdown('普通文本'), '普通文本');
eq('不会误删正文中的乘号', stripMarkdown('2 * 3 = 6'), '2 * 3 = 6');
eq('多个乘号不误判为斜体', stripMarkdown('2 * 3 * 4'), '2 * 3 * 4');

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
