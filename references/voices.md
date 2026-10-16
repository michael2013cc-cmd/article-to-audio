# 音色与语速选择

全量 332 个音色，用 `mcode-tools connector call connector__matrix__get_voice_list --args '{}'` 现取。以下是**按场景整理的推荐**，不是完整目录。

## 默认

```
voice_id: Chinese (Mandarin)_Reliable_Executive
speed:    0.95
emotion:  neutral
```

沉稳男声、公播腔。跑通 5 篇长文（含 35 分钟研究报告）的配置。长文不催眠，繁体简体都能念。

## 按场景换

| 场景 | voice_id | speed | 为什么 |
|---|---|---|---|
| 长文 / 分析报告 | `Chinese (Mandarin)_Reliable_Executive` | 0.95 | 稳定，数字段落不抢戏 |
| 通勤赶时间 | 任意 | 1.15–1.2 | 压缩 15–20% 时长 |
| 睡前 / 放松 | `Chinese (Mandarin)_Warm_Bestie`、`Chinese (Mandarin)_Soft_Girl` | 0.85–0.9 | 语气松，适合散文 |
| 新闻 / 公告 | `Chinese (Mandarin)_News_Anchor`、`Chinese (Mandarin)_Male_Announcer` | 1.0 | 正式播报腔 |
| 电台 / 对谈感 | `Chinese (Mandarin)_Radio_Host`、`Chinese (Mandarin)_Lyrical_Voice` | 1.0 | 有主持人节奏 |
| 讲解 / 教学 | `Chinese (Mandarin)_Sincere_Adult`、`Chinese (Mandarin)_Intellectual_Girl` | 0.95 | 咬字清楚 |
| 粤语 | `Cantonese_ProfessionalHost (F)` / `(M)` | 0.95 | 主持腔，念新闻/报告合适 |
| 英语 | `English_CaptivatingStoryteller`、`English_Steadymentor` | 1.0 | 叙述类 |
| 日语 | `Japanese_GentleButler`、`Japanese_IntellectualSenior` | 1.0 | 稳重 |
| 韩语 | `Korean_SereneWoman`、`Korean_Steadmentor` 类 | 1.0 | 平稳 |

## 语速

- `0.85` — 睡前
- `0.9` — 数据密、想记细节
- `0.95` — 默认
- `1.0` — 平常说话速度
- `1.15` — 通勤
- `1.2` — 只听结论

## emotion

`neutral`（默认）、`happy`、`sad`、`angry`、`fearful`、`disgusted`、`surprised`。

多数情况 `neutral` 最稳。口语化、轻松的内容可以试 `happy`；正式内容用 `neutral`。

## 已验证 / 未验证

**已跑通**：普通话（简体 + 繁体）、中性/开心情绪、0.9–1.2 语速。

**未跑通**：粤语、英语、日语路径未实测。音色名字好听不代表听感好 —— 这个只能试听。

## 怎么试听

写一段 30–60 字的短文，跑：

```bash
node scripts/narrate.mjs --segments probe.json --out probe.mp3
```

比生成整篇快得多。
