# 平台專屬筆記：minimax-cloud（mcode-tools connector）

> **這份文件只適用於 minimax-cloud 平台（`connector__matrix__*` 這組工具）。**
>
> `article-to-audio` 這個 skill 本身**與平台無關** —— 改寫、分段、鍵覆蓋、
> 合併、驗收這一層都不綁任何供應商。真正綁平台的是 `scripts/narrate.mjs` 裡
> 呼叫 TTS／STT 的那幾個函式，以及下面這份文件。
>
> 要換 TTS 後端，**只需要換那幾個函式**；下面記的坑大部分會自動失效。
> 留在這份文件裡而不是散在 SKILL.md，是為了讓 skill 在別的地方用時，
> 不會有一堆看不懂的 minimax 專屬敘述混在流程說明裡。

實測環境：sandbox + `NODE_TLS_REJECT_UNAUTHORIZED=0`，`mcode-tools` CLI，`IS_SANDBOX=1`。

---

## 1. 故障指紋對照表

| 症狀 | 性質 | 有沒有繞法 |
|---|---|---|
| `audio post-processing failed: an internal server-side error occurred` | 生成管線全掛 | ❌ 伺服器端，只能等 |
| `music post-processing failed: …` | 同上（音樂） | ❌ |
| `the user's plan balance has run out; this is a billing limit…` | 帳務額度 | ❌ 要使用者充值 |
| `error: invalid signature (path=…/connected-tools/list)` | sandbox 出口簽章 | ✅ 換連線模式 |
| `text-to-audio failed: upstream is cu…` | 上游瞬斷 | ✅ 重試 |
| STT 回 200 但 `transcription` 塞的是**濾器說明文字** | 內容濾器吞掉整片 | ✅ 切小片重取 |
| STT 回 200 但 `transcription` 是**空字串** | 視窗太短、或平台層錯誤 | ✅ 換視窗／看 `message` 欄位 |

**最容易搞混的是最後兩列**：兩者都是「回 200、內容是空的或亂的」。
`transcription` 空 → 先看 `message` 欄位有沒有平台錯誤訊息，
有就是平台層問題（不是視窗長度）；`message` 也是空才是視窗問題。

---

## 2. 生成管線全掛（最常見）

**症狀**

```
batch_text_to_audio  → {"code":0,"message":"all 1 failed:
                         audio post-processing failed: an internal server-side error occurred"}
synthesize_speech    → {"code":500,"message":"audio post-processing failed: …"}
batch_text_to_music  → {"code":0,"message":"all 1 failed:
                         music post-processing failed: an internal server-side error occurred"}
listen_audio (STT)   → ✅ 正常
connector tools       → ✅ 200
```

**兩個關鍵判讀**

1. **`connector tools` 回 200 不代表 TTS 能用。**
   只探測工具列表會誤判成「可用」，於是每輪輪詢都跑一輪昂貴合成才失敗。
   健康檢查一定要**先打一發最簡單的單句 TTS**。
2. **語音和音樂同時壞 = 整個生成管線壞**，不是語音模型壞。
   STT 正常是因為 STT 只回文字，不產出資產、不經過後處理。

換 voice / 換 emotion / 換文字長度 / 換語言**全都一樣失敗** → 與輸入無關，
是伺服器端問題，**沒有任何客戶端繞法**（bearer token、換 region、換 base URL 都無效）。

**實測會自己好**：一次量到 30 小時 42 分。之後又進入「隨機開關」型 ——
同一分鐘內 5/5 成功，下一分鐘 24/24 全敗。**判斷「已恢復」要多次取樣**，
單次成功只是抓到窗口。

**批次大小與成功率無關**：受控 A/B（同時段、批次 6／2／1）成功率相同。
「小批次比較容易成功」是假相關（成功率高只是因為跑得較晚、窗口恰好開）。
**不要因此改 `BATCH_LIMIT`。**

---

## 3. 402 帳務額度

```
the user's plan balance has run out; this is a billing limit on the user's own
subscription plan, not a temporary system error or rate limit
```

這是**帳務上限，不是限流、不是暫時故障**。重試完全沒有用。

**處理順序**

1. 立刻停止呼叫 TTS／STT 連接器。
2. **把已經合成的部分下載下來** —— asset 的 node_id 會過期，先抓回本地。
3. 告訴使用者要充值。
4. 其餘全部可以離線完成：寫稿、跑 `audit-numbers.mjs`、準備 segs 與 keys 檔案、
   在播放清單裡留一條續跑指令。

實測：平台額度用盡時，**TTS 與 STT 同時被擋**（跟第 2 節的「只有生成管線壞、
STT 正常」不同）。兩者的區分方式就是看 STT 能不能用。

---

## 4. `invalid signature` 與四模式探測

```
error: invalid signature (path=/minimax-cloud/api/v1/connectors/connected-tools/list)
```

簽章由 sandbox 出口產生，**本地沒有 token 可以刷新**。但它跟第 2 節的指紋不同，
而且**有繞法**：換連線模式。

| 模式 | 環境變數 |
|---|---|
| `standalone-relaxed` | `env -u IS_SANDBOX` + `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `standalone-strict` | `env -u IS_SANDBOX` |
| `sandbox-relaxed` | `IS_SANDBOX=1` + `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `sandbox-strict` | `IS_SANDBOX=1` |

**探測順序**：standalone-relaxed → standalone-strict → sandbox-relaxed → sandbox-strict。
命中就記下來，這一輪都用那個模式。

**探測的請求格式必須跟生產完全相同**：

```json
{"requests":[{"text":"…","voice_id":"…","speed":0.95,"emotion":"neutral","output_file":"part_001.mp3"}]}
```

用 `{"texts":[…]}` 探測會得到**跟真故障長得一樣的錯誤訊息**，一定會誤判。

---

## 5. STT 的兩個坑

### 5.1 內容濾器把整片吃掉（回 200 但內容是垃圾）

`listen_audio` 遇到內容濾器時，**連接器回 200**，但 `transcription` 欄位塞的是
**濾器自己的英文說明文字**：

```
blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, securit…
```

150 秒分片整段從轉寫裡消失 —— 流程卻回報成功。實測 8 片被吃掉，約 20% 音訊無轉寫。

**必須主動偵測**，不能只看「有沒有回字」。
偵測到濾器字樣 → 視為失敗 → 用**同一時間範圍**切 3 個 50 秒子片重取
（fast seek 落 keyframe 或更早，所以子片可以重疊，但不能留縫）。

### 5.2 短視窗回空或回亂碼

同一段音訊，10 秒視窗回「不是纯粹」（原文沒這四字），20 秒視窗才正確；
另一個 20 秒視窗直接回空字串。

- 稽核視窗**至少 20 秒**。
- 回空或怪異 → **換視窗長度重取**，不要立刻判定音頻有問題。
- 「內容到底在不在」**只能靠段級複驗**（轉寫那一段自己的音檔）判定。

### 5.3 長分片會吞掉密集數字段落

150 秒的長分片 STT 會**整段吞掉密集數字**（實測一行財報數字的 6 個鍵在長轉寫裡
完全消失，但音檔本身完全正確）。

→ **長轉寫的鍵覆蓋率不能單獨當結論**，漏鍵一定要用段級複驗補。

---

## 6. 連線層的介面細節

```bash
# 合成（批次）
mcode-tools connector call connector__matrix__batch_text_to_audio --args-file args.json
# → {"code":0,"message":"ok","total_requested":N,"total_success":N,
#    "success_items":[{"node_id":"…","file_name":"…"}],"failed_items":[…]}

# 取下載網址
mcode-tools get_asset_url <node_id>      # → {"node_id":"…","download_url":"…"}

# 上傳本地檔（給 STT 用）
mcode-tools upload_temp_url <file>        # → {"temp_url":"…"}

# STT
mcode-tools connector call connector__matrix__listen_audio --args-file stt.json
# args: {"audio_info":{"url":"…","mime_type":"audio/mpeg","prompt":"逐字转写，保留繁體中文"}}
```

**幾個會咬人的細節**

- **STT 回傳的是繁體中文。** 比對稿子前要先轉簡體，或在比對時容忍繁簡差異。
- **STT 會自己加千分位逗號**（腳本「一万二千二百八十八」→ 轉寫「12,288」），
  鍵卻是「12288」→ 雙向都對不上。**比對時要把轉寫端的逗號也去掉。**
- **平台版 jobdir 的音檔檔名是 node_id**（不是 `part_NNN.mp3`），
  要靠 `items.json` 的 `node_id` 欄位做「段號 → 檔案」對照。
- **`items.json` 是插入順序寫的，不是 file_name 順序。**
  `narrate.mjs` 在合併前才 sort。直接用插入順序對照段號會整段錯位
  （實測探到別的段的音檔，段級複驗 0/3，看起來像音頻缺內容）。
  **對照一定要依 `file_name` 數值排序。**
- **asset 的 node_id 會過期** —— 合成了就要抓回本地，不要等整篇跑完再下載。
- `batch_text_to_audio` 呼叫失敗時，**一次批次失敗不該讓整段放棄**；
  改成「這批全失敗」交給補抓機制，前面的進度就能跨輪次累積。

---

## 7. 沙箱環境的坑

### 7.1 pod 會被回收重建

沙箱 pod 會被回收，**所有行程會同時死掉**，連已經 `setsid` 脫離的也一樣。
實測：鏈子安靜地死在某一刻，pid 檔留著但行程全沒了。

- 長駐程序必須 `setsid nohup … &` 脫離＋ watchdog 監督。
- watchdog 判定存活**必須排除僵屍**：`kill -0` 對 Z 狀態行程仍回成功，
  要同時看 `ps -o stat=`。
- **整篇產出存在時 watchdog 要自己退出**（否則會無限重啟、每次看到檔案已存在又退出）。
- 重啟前先殺掉殘留的 `narrate.mjs`（殺輪詢器不會殺子行程），再手動 `rm .lock`。
- **不要用 `pkill -f`／`pgrep -f` 做單一實例保險** —— 會匹配到自己所在的殼層。
  用 pidfile 指定 PID。

### 7.2 工作目錄的鎖

任務目錄 `.tts-narration/<輸出檔名>/` 是**按輸出檔名唯一定位**的，不是按執行定位。
兩個行程同時跑同一個輸出檔名會互相覆蓋 `transcript.txt` 與 `parts.json`，
已完成的校驗結果會被**靜默替換**。

`narrate.mjs` 會在任務目錄寫 `.lock`（PID）。PID 還活著時新行程直接以退出碼 5 結束。

### 7.3 續跑快取只能合併、永不覆蓋

- 續跑快取（`items.json`）**只能合併，永不覆蓋**。
- **續跑失敗 ≠ 快取壞掉** —— 續跑失敗時只有 JSON 解析失敗才從頭重合成。
- 續跑是**內容定址**的（用文字配對，不是用索引），所以改稿子重切段落時，
  沒動到的段落會沿用既有音檔。

### 7.4 沙箱裡沒有 `bc`

時間運算用 `node -e` 算，不要用 `bc`（不存在）。

---

## 8. 平台語音的合併參數

- 平台語音：**32000 Hz / mono / 128 kbps**。備援語音（Google TTS）：
  **24000 Hz / mono / 64 kbps**。**合併時的靜音取樣率與位元率必須從第一段推導，
  不可寫死**，否則拼接出來的音檔會有雜訊。
- 段間靜音 0.5 秒。
- 合併後總時長略長＝MP3 padding，時長帳要容許這個差。
- 驗收時還有兩個坑（ffmpeg concat 的 header frame、反序對照組的選法），
  記在 `references/fallback-voice.md` 的「驗收要注意兩個坑」。

---

## 9. STT 的語言模型漂移（ASR 會把年份認成另一年）

**2026-10-23 在 ep15a／ep17b 實測。**

長分片 STT 轉寫某個年份時，會**整段鎖死在另一個年份**，把
「2026」寫成「2024」，連帶把 arXiv 編號 `2607.26633` 認成 `2407.20633`
（2024 年 7 月的另一篇真論文）。

**關鍵事實**

| | 稿子（源文也對） | 長分片轉寫 | 窄視窗轉寫（2 種提示詞） |
|---|---|---|---|
| ep15a 段 113 | MICRO 2026、arXiv 2607.26633、2026-07-29 | MICRO 2024、arXiv **2407.20633** | **2026、2607.26633 ✅** |
| ep17b 段 47 | 中兴 2026 年 4 月论文 | 中興 2024 年 4 月論文 | **2026 ✅** |

同一集前面 27 個 2026 都轉寫正常，只有中間一段漂走 → **ASR 的語言模型
在那一段被「2024」這個更常見的先驗帶走**。TTS 不會中途換念法。

**結論：鍵覆蓋報「少了某個鍵」不等於音檔缺內容。** 年份、編號這類
「有強先驗的 token」特別容易中招。**一定要用段級窄視窗複驗再下結論。**
判斷式：

- 窄視窗複驗**聽得到** → 音檔沒問題，是長轉寫的漂移。
- 窄視窗複驗**也沒有** → 音檔真的缺，用 `rerender-segment.mjs` 重渲染。

**注意**：同一段用不同提示詞轉寫，**可能一個被內容濾器擋掉**，
所以要準備 2–3 種提示詞（其中一種被擋是常事）。
