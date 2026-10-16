# Text conversion rules — 给人看的文档 → 给人听的稿子

These rules come from four real articles (market analysis, stock report, accessibility
survey, long-form essay). Every example below is a real before/after.

## The core distinction

| For reading | For listening |
|---|---|
| Can look back up | Cannot — once heard, gone |
| Can skim a table | Must linearize it |
| Can re-read a number | Gets one pass at it |
| Can skip a citation | Costs you time and focus |

Anything that costs a listener a rewind is a bug, not a style choice.

## Rules

### 1. Strip markdown links entirely

`[港股收评：恒生指数涨1.79%](https://m.toutiao.com/article/7694582003026395686/)`
→ drop the whole bracket.

Reading a URL aloud is ~15 seconds of noise per citation, and the article titles duplicate
what the prose already says. When the article's flow breaks around a citation cluster, the
cleanest spoken form is an explicit signpost rather than silence:

`細節見 [季度財報說明](url) 與 [法說會逐字稿](url)` → 「細節的部分，這裡就不念了，請你回去看原文。」

For a source that genuinely adds information, offer it as a spoken footer at the end
("以上数据主要来自……") rather than inline.

### 2. Numbers become spoken forms

| Raw | Spoken |
|---|---|
| `+1.79%` | 上漲百分之一點七九 |
| `-5.31%` | 下跌百分之五點三一 |
| `568.47 元` | 五百六十八點四七元 |
| `+24.9%` | 同比增長百分之二十四點九 |
| `0.05–2.0 秒` | 零點零五秒到兩秒之間 |
| `+10.1%` | 增加百分之十點一 |

A leading `+` reads as "plus" and a bare `%` string gets mangled. Always attach the
direction to the number as a word.

### 3. Tables become sentences

The single highest-impact rule. A table read aloud is a catechism.

Raw:

```
| 年度 | 预测净利润 | 对应 PE |
| 2026E | 72.2 亿 | 约 57 倍 |
| 2027E | 103.9 亿 | 约 40 倍 |
```

Spoken: 「二零二六年，预测净利润七十二点二亿，同比增长约百分之三十一，按现价对应约五十七倍市盈率。二零二七年，一百零三点九亿，对应约四十倍。」

Keep the header words in the spoken form — "按现价对应" carries the caveat the table
implied in its column header.

### 4. Acronyms: three different treatments

Decide per term, don't apply one blanket rule.

| Treatment | Examples | Why |
|---|---|---|
| **Expand** | `PE`→市盈率, `ROE`→净资产收益率, `EPS`→每股收益, `DCF`→现金流折现, `ARR`→年经常性收入, `beta`→贝塔效应, `MCU`→微控制器, `DRAM`→動態隨機存取記憶體 | Spoken letters carry no meaning |
| **Keep + gloss once** | `iFinD`, `ETF`, `AppleVis`, `NVDA`, `TalkBack` | Already a pronounceable name; the name *is* the identifier |
| **Replace with meaning** | `alt／label`→替代文字或標籤, `rotor`→轉盤, `vibe coding`→AI 輔助寫程式, `WCAG 失败`→无障碍失败 | Zero information for a listener |

**The test: can a listener decode the spoken letters into something?** A pronounceable
brand or product name (`NVDA`, `AppleVis`) survives being read aloud. An initialism whose
meaning only exists as written text (`MCU`, `PE`, `ROE`, `WCAG`) does not.

**Company tickers and short codes are information — do not silently drop them.** If the
article says "DA 與 RBV 差距", replacing it with "兩家公司" removes something the reader
needs. Either keep the ticker pronounceable in the audio ("D A 與 R B V"), or say
"這兩家同業" *and* leave the written form in the accompanying `.md` script so the mapping
survives. Silently deleting a name is the failure mode here, not speaking it.

### 5. Mixed-language handling for UI features

Technical proper nouns stay; interface feature names get translated, because a listener
wants the function, not the string in the settings menu.

- `Liquid Glass` → keep (design language, everyone knows it)
- `Reduce Motion` → 減少動態效果（Reduce Motion）— gloss first, name after
- `Ask About Screen／Describe Screen／Explore Screen` → 問螢幕、描述螢幕、探索螢幕
- `Item Overview` → 項目概覽
- `Magic Tap` → keep
- `Live Captions` → 現場字幕（Live Captions）

Gloss the first occurrence, then drop the English. Repeating both wastes 2 seconds each time.

### 6. Units and ranges

| Raw | Spoken |
|---|---|
| `-5.4pct` | 下滑五點四個百分點 |
| `+12%～15%` | 成長百分之十二到百分之十五 |
| `2,370` | 兩千三百七十 (drop the thousands separator) |
| `7.26 億股` | 七點二六億股 |

`pct` is not a unit a listener can decode. A tilde range needs the bound repeated so it
does not sound like the second number is a separate fact.

### 6. Em-dashes become periods

`……需求增速，营业成本同比 +29.4%，快于收入增速` — the model will run straight through a
`——` without breathing, producing one run-on sentence. Convert structural dashes to `。`
Keep a dash only when it's a genuine interruption mid-clause.

### 7. Drop meta-content, and report it

Not article content:

- Agent process logs — 「先读取 iFinD 数据插件的使用说明」「数据源接口已确认」
- Questions the article asks the reader — 「要不要我把这段并进清单档？」
- Disclaimers belong *in* the article if present (「不构成投资建议」) — that's a real
  disclosure, keep it.

Tell the user what you removed. Silently truncating the source is misrepresentation even
when the judgment is right.

### 8. Segmenting

- ≤300 characters per segment
- Break at paragraph boundaries, never mid-clause
- Bold markers `**text**` → just `text`
- One idea per segment when the article has clear sections; it gives natural pauses

## What stays judgment, not rule

Whether a passage is *content* or *meta* (rule 7) cannot be regexed. Same for how much of
a dense data section to keep in a "listenable" version. The rules above remove known-bad
constructs; deciding what the listener actually needs is the part worth your attention.
