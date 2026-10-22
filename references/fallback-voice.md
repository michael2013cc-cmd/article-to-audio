# 備援語音：平台 TTS 掛掉時怎麼辦

> 2026-10-22 實測。這是平台音訊**生成**管線全面故障時的應對手冊。

## 故障的樣貌

平台的音訊生成後端可能整個壞掉，症狀是：

```
batch_text_to_audio  → {"code":0,"message":"all 1 failed:
                         audio post-processing failed: an internal server-side error occurred"}
synthesize_speech    → {"code":500,"message":"audio post-processing failed: ..."}
batch_text_to_music  → {"code":0,"message":"all 1 failed:
                         music post-processing failed: an internal server-side error occurred"}
listen_audio (STT)   → ✅ 正常
connector tools       → ✅ 200
```

**兩個關鍵判讀**：

1. **`connector tools` 回 200 不代表 TTS 能用。** 只探測工具列表會誤判成「可用」，
   然後每次輪詢都跑一輪昂貴合成才失敗。合成前一定要先打一發最簡單的單句 TTS
   做健康檢查。
2. **語音和音樂同時壞 = 整個生成管線壞**，不是語音模型壞。
   STT 正常是因為 STT 只回文字，不產出資產、不經過後處理。

換 voice / 換 emotion / 換文字長度 / 換語言**全都一樣失敗** → 與輸入無關，
是伺服器端問題，**沒有任何客戶端繞法**（OAuth bearer、換 region、換 base URL 都無效）。

## 備援：Google Translate TTS

```bash
node scripts/google-tts.mjs \
  --segments chip-research/ep13a_segs.json \
  --out output/ep13a-domestic-substitution.google.mp3 \
  [--tl zh-CN] [--pace 120] [--max-chars 190]
```

端點是純 HTTPS GET，不用 websocket、不用 key：

```
https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=<urlencoded>
```

特性：

| 項目 | 值 |
|---|---|
| 單次長度上限 | 200 字（超過回 HTTP 400）→ 腳本會自動分塊 |
| 分塊切點 | 優先落在句號，其次逗號 |
| 音檔格式 | mp3 / 24000 Hz / mono / 64 kbps（平台語音是 32000 Hz / 128 kbps） |
| 穩定性 | 連續 15 次請求 15/15 成功、5 秒、零限流 |
| 音色 | 單一中文女聲，**與平台語音不一致** |
| 語速 | 比平台語音慢約 27%（同樣字數的稿，時長多 25–30%） |
| 中英混排專名 | 讀得對（Bernstein、TrendForce、Bloomberg Intelligence 都正確） |
| 數字 | 讀得對，STT 迴圈驗證數字全部還原 |

## 產出檔名要帶 `.google` 後綴

平台版與備援版**必須能並存**，因為兩者音色不同，最後由使用者挑。
平台版：`output/<tag>-<slug>.mp3`；備援版：`output/<tag>-<slug>.google.mp3`。
交付時一定要標明用的是哪個音色。

## 驗收要注意兩個坑

**① 合併檔與分段檔不能做 PCM 位元組比對。**
ffmpeg 的 concat demuxer 會略過每個檔案的 Xing/Info header frame，
合併檔與分段檔的取樣會差一幀（24 kHz 下 48 ms）→ 樣本級 md5 必然不同，
但**內容完全一致**。用能量包絡互相關判斷（見 `verify-episode.mjs`）。

**② 反序對照組不能用「另一段的開頭」。**
各段開頭句幾乎一樣（「第 13 篇，共 18 篇。…這一篇分三段，這是第 X 段」），
錯配也會有 0.9 以上的高相關 —— 那是對照組設計不良，不是音檔問題。
要用「不同段的中段內容」當對照。

## 續跑

`google-tts.mjs` 每段存成 `<jobdir>/part_NNN.mp3`，已存在就跳過 → 中斷後重跑不浪費。
`jobdir` 預設是 `.tts-narration/<輸出檔名>-google`。
