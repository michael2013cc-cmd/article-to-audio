---
name: article-to-audio
description: |
  Turn a long text article into one listenable mp3 — rewrite the prose for speech,
  synthesize in batches, merge into a single file, and verify by transcribing it back.
  Use this skill whenever the user pastes an article (or refers to one already in
  context) and wants to hear it: 念给我听 / 朗读这篇 / 生成语音 / 做成音频 / 轉成音檔 /
  "念出來" / "read this aloud" / "make this into audio" / "TTS this", or says reading is
  tiring and wants an audio version. Also use it for tables, reports, or anything full of
  figures that would be painful to read but fine to listen to.
  Do NOT use it for: a single short sentence (<200 chars — call
  connector__matrix__synthesize_speech directly instead of running the pipeline);
  requests to summarize or rewrite rather than read aloud; translation; music or song
  generation (use connector__matrix__batch_text_to_music); or video voice-over.
---

# Article to Audio

## Inputs to collect

- **Which text** — a fresh paste, or an article earlier in the conversation. Look back
  before asking; re-asking for text already in context wastes the user's time.
- **Voice / speed** — do not ask. The defaults below are user-confirmed; switch only when
  the user asks for it, or when the article makes another voice obviously better (Cantonese
  source → Cantonese host; English source → English narrator).

User-confirmed defaults: `Chinese (Mandarin)_Reliable_Executive`, speed `0.95`, emotion
`neutral`. Traditional input is fine on the Mandarin voice.

Alternates worth offering when the user signals a different listening situation, or when
feedback says the current voice is wrong:

| Situation | voice_id | speed |
|---|---|---|
| Default / long analysis | `Chinese (Mandarin)_Reliable_Executive` | 0.95 |
| Commuting, time-pressured | any | 1.2 |
| Bedtime / relaxed | `Chinese (Mandarin)_Warm_Bestie`, `Chinese (Mandarin)_Soft_Girl` | 0.9 |
| Cantonese source | `Cantonese_ProfessionalHost (M)` / `(F)` | 0.95 |
| Formal readout | `Chinese (Mandarin)_News_Anchor` | 1.0 |
| English source | `English_CaptivatingStoryteller` | 1.0 |

Full catalog: `connector__matrix__get_voice_list` — 332 voices across Mandarin, Cantonese,
English, Japanese, Korean, Spanish, French, German and more.
`references/voices.md` has the fuller per-scenario table plus what has and has not actually
been tested (only Mandarin, Simplified and Traditional, is verified).

## Verification: how the STT pass actually behaves

Measured on real output, not assumed. These cost real debugging time — treat them
as facts, not guesses.

**Number format is bidirectional.** The STT does not normalise numbers one way:

| Script says | Transcript gets |
|---|---|
| `二零二六年` (Chinese) | `2026年` (Arabic) |
| `共 18 篇` (Arabic) | `共十八篇` (Chinese) |
| `百分之八十六` | `86` |
| `3.1 比 1` | `3.1` |
| `三万八千小时` | `3萬8千小時` (mixed Arabic + Chinese) |

So **every numeric key must accept both forms.** The script writing a figure in
Arabic does *not* guarantee the transcript will be Arabic — a key set built on
that assumption misses for the wrong reason. `numericForms()` generates the
Arabic, Simplified-Chinese and Traditional-Chinese renderings of a value, and the
matcher also normalises the transcript before comparing, which covers the mixed
forms without enumerating them by hand.

**Ranking must not prefer "the script wrote it in Arabic".** That was the earlier
assumption and it was wrong. What makes a key worth having is that the figure is
distinctive (has a unit, a decimal point, or is simply large) — not which script
it came from.

**STT also drops and mangles digits.** `11.3 小时` came back as `1.3小時`. That
is a genuine transcription miss and *should* be reported — a key that misses
after normalisation is a real signal, not noise. The `--check-txt` output
locates the region using the script context the key was derived from, so you can
see what was actually written.

**Strip markdown before the TTS sees it.** The `**` bold markers are never
spoken, but they are not harmless. The same segment synthesized five times:

- with `**` → **5/5 failed**. The sentence stopped early, `42.5 EF` was never
  spoken, and the engine appended hallucinated garbage: *"Don't feel
  uncomfortable."*, *"dofus.com/fm"*, *"Trillium, comma, family."*, *"Trophy
  real cool MF."*
- without → **5/5 correct**, including `42.5 EF`.

`narrate.mjs` strips markdown from the spoken text automatically
(`scripts/md.mjs`); the written script keeps the markers. If you call the TTS
connector directly, strip it yourself.

**Two different failure modes, and the difference tells you which one you hit.**
Re-transcribe the same audio with different chunk boundaries and compare:

| | Pass 1 | Pass 2 | Diagnosis |
|---|---|---|---|
| STT hallucination | wrong | **right** | the audio is fine, the transcript lied |
| TTS corruption | **wrong** | **same wrong** | the audio itself is damaged — re-render it |

Consistent-wrong across two passes means the damage is in the audio. A
hallucinated tail shows up as stray English, a URL, or a plausible-sounding
phrase that is not in the script at all — *"Trillium, comma, family."* was
never written by anyone.

**The TTS makes intermittent errors on short numeric phrases.** Same text, same
voice, same speed — synthesized five times, two of them wrong: `各投 20 億美元`
came out as `2 億` or `21 億`. That is a factual error the listener hears, and
re-writing the text does not help — only re-synthesizing does. It hit the
NVIDIA→Lumentum/Coherent investment figure ($2B each) in Episode 5.

Fix with `--redo <n>`: re-synthesize one segment, rebuild the merge, done.
`node scripts/narrate.mjs --segments segs.json --out out.mp3 --redo 41`

**The STT is not deterministic, and on short numbers it varies wildly.** One
fixed, *correct* audio file, transcribed five times, gave: `20美元`, `2.1億美元`,
`20億美元` ✓, `21億美元`, `20億美元` ✓. Three different numbers from one
recording. So:

- **A single transcript cannot tell you whether the audio is wrong.**
- `probe-audio.mjs` is the arbiter: transcribe the same window N times and look
  at the spread. Some readings correct → the audio is fine, the STT is noisy.
  Every reading the same wrong value → the audio is damaged, use `--redo`.
  ```bash
  node scripts/probe-audio.mjs --file out.mp3 --start 479 --dur 14 \
    --times 6 --expect "20億"
  ```
- `--recheck` is the cheap version of the same idea: it re-transcribes with
  shifted chunk boundaries and matches against the **union**. Use
  `--recheck-passes 3` (not the default 2) — a two-sample union can miss a
  figure that is really there, because the STT only produced the right reading
  in 4 of 6 passes.

**STT can hallucinate a whole passage.** This is the finding that changed the
verification design. On a real 13-minute segment, the first transcript rendered
a specification as `GLM-4-9B, 14.3B, 40 layers, 64 experts, 2024-06-05,
1000萬美元, zhipu.ai` — every number replaced with a plausible wrong one. A
second pass over **the same audio**, cut at different boundaries, produced
`GLM-5.3, 744B, 78 layers, 256 experts, 2026-08-28, 1億美元, z.ai` — correct
in every particular. The audio was never wrong; the transcript was.

Consequences:

- **A missing key does not mean the audio is missing the content.** It may mean
  the STT invented something else. Never report a miss as a content error
  without a second opinion.
- `--recheck` settles it: it re-transcribes the whole file with shifted chunk
  boundaries (97 s chunks offset by 31 s, so no boundary lines up with the
  standard 150 s pass) and matches the key against the **union** of both
  passes. Present in either → the audio has it. Absent from both → check
  whether both passes agree on the same wrong value (TTS damage → re-render) or
  disagree (STT noise → the audio is fine).
- Corollary: a key that *hits* is trustworthy, but a transcript as a whole is
  not — quote the numbers, not the prose, when reporting.

**STT mangles proper nouns and jargon too**: `长时程` → `常識成`,
`复利` → `福利價值`, `AlphaEvolve` → `AlphaEvlove`, `字节 Seed` → `字節C`.
Judge on digits, scores and the conclusion sentence; do not regenerate the whole
audio over a misspelled name. But do check that a mangled term is still
*recognisable* — `常識成自主性` is a word salad that a listener will stumble on,
and that is worth fixing in the script by writing the term differently.

**Do not trust node ids for ordering.** The `success_items` come back in
arbitrary order and their node ids are assigned by asset-creation time, not
request time — sorting by id gives a chars-per-second spread of 50–120x, i.e.
garbage. Only the `output_file` name is trustworthy. (`recover-parts.mjs` can
rebuild a job's segment map afterwards, but it can only get the order right by
matching lengths, which is good enough to be uncertain — do not cut audio on
its word.)

## Procedure

1. **Rewrite the text for the ear before touching the TTS engine.** This step decides
   whether the result is listenable or merely audible — it is the actual work. Read
   `references/text-conversion.md` for the rule table and before/after examples, then
   produce narration segments. Applying the TTS to the raw article is the common failure:
   it reads out URLs, reads `+1.79%` as "plus one point seven nine percent", and recites
   tables cell by cell.

   **If the article embeds images, open every one and narrate its contents.** A research
   report's chart often carries the finding; the surrounding prose only states the claim.
   Extract the values and write them as sentences where the image appeared.

2. **Drop non-article content, and say what you dropped.** Agent process logs ("先读取
   数据插件的使用说明") and closing questions addressed to the assistant ("要不要我把这段
   并进清单档") are not article content. Removing them silently misrepresents the source;
   removing them *and flagging it* is the contract. Same for source citations at the end —
   offer them as a spoken footer rather than reading URLs inline.

3. **Split into segments of ≤300 characters at paragraph boundaries.** One paragraph per
   segment usually works; a long paragraph may need two. A segment that ends mid-clause
   produces a rushed-sounding gap once merged.

   Use the splitter, do not hand-write the segment list:

   ```bash
   node scripts/md2segs.mjs --md output/ep08a.md --out chip-research/ep08a_segs.json --dry-run
   node scripts/md2segs.mjs --md output/ep08a.md --out chip-research/ep08a_segs.json
   ```

   It caps segments at ~120 characters, cuts at a sentence terminator, and folds
   away a segment that would be nothing but markdown markers (a split that lands
   right before a closing `**` produces a segment that speaks as an EMPTY audio
   part — the merge then carries a silent gap).

   **Why 120 and not 300:** a 235-character segment dropped BOTH "MI-455X" and
   "Lisa Su" in the same rendering; split into 117 + 120 the recovery rate went
   from 0/5 to 4/5–6/6. Long segments make the TTS mangle proper nouns.

4. **Write the segments to JSON** — `{"segments": ["...", "..."]}` — and lint the number
   rendering before spending any API budget:

   ```bash
   node scripts/narrate.mjs --segments segs.json --lint-numbers
   ```

   This flags numbers written in Chinese that STT will mangle — Chinese decimals
   (`二点五` → the point is often lost) and Chinese big numbers (`三百万亿` → the magnitude
   is ambiguous, and `三百万亿` literally parses as 3×10¹⁴ while the speaker means 3×10¹¹).
   **Fix them in the script**: write `2.5`, `3,000億` or `300T`. A Chinese-written figure is
   both harder to hear correctly and harder to verify later.

5. **Derive the verification keys from the script — never hand-write them.** This is a hard
   rule, not a preference. A hand-written key that was never spoken can never appear in the
   transcript, so it reports as a "miss" and costs a full TTS+STT cycle to chase. It happened
   three times in a row on one episode (`104`, `158`, `69` — none of them were in the script).

   ```bash
   node scripts/extract-keys.mjs --segments segs.json --top 30   # inspect candidates
   node scripts/narrate.mjs --segments segs.json --out output/<name>.mp3 \
     --auto-verify 25 --keep-script output/<name>.md              # derive + verify
   ```

   `--auto-verify N` picks the top N figures straight from the script: literal-Arabic
   figures first (STT echoes those almost verbatim), then Chinese-numeral figures converted
   to Arabic, spread across segments so one dense paragraph cannot eat the whole budget.
   Each converted figure carries a set of accepted renderings, so `十亿美元` is accepted as
   `1000000000`, `10億` or `100000萬` — whichever the STT happened to produce.

   **The auto ranker is not the whole answer.** It scores by distinctiveness and happily
   returns `67`, `66`, `55` — round two-digit percentages that prove little — while the
   headline figures (Q2 revenue, the demand curve, the customer allocation) sit below the
   cut. Combine the two:

   ```bash
   node scripts/pick-keys.mjs --segments segs.json --out keys.json --auto 26 \
     --values 402,7065.6,2694,1222
   node scripts/narrate.mjs --segments segs.json --out output/ep08a.mp3 \
     --verify-file keys.json --keep-script output/ep08a.md
   ```

   `--verify-file` carries the full alt set per key, so `45,000` is also accepted as
   `45000` and `四万五千` — the STT does not preserve the separator. A value that is not
   in the script is reported and skipped; the pre-flight gate still blocks any key that
   the script does not contain.

   If you do pass `--verify` by hand, the script **pre-flight-checks it against the script
   and exits 3 before making any API call** if a key is not actually there. That is the
   safety net; the auto-derivation is the primary path.

   The script handles batching (>10 segments means multiple calls), re-sorting the
   response, downloading, the inter-segment silence, and the merge.

6. **After a run, iterate on keys for free.** The transcript is saved at
   `.tts-narration/<job>/transcript.txt`. To try a different key set without re-running
   anything:

   ```bash
   node scripts/narrate.mjs --segments segs.json --out output/<name>.mp3 \
     --auto-verify 25 --check-txt .tts-narration/<job>/transcript.txt
   ```

   `--check-txt` makes no API calls at all. `--verify-only <mp3>` re-transcribes and
   re-checks against the audio, which does cost a STT pass.

   If a key misses, run `--recheck` before concluding anything about the audio —
   it re-transcribes with shifted boundaries and tells you whether the key is
   really absent or the first transcript was wrong:

   ```bash
   node scripts/narrate.mjs --segments segs.json --out output/<name>.mp3 \
     --auto-verify 25 --recheck
   ```

7. **Report the result with the numbers that matter**: total duration, segment count, and
   the verification result. Mention anything dropped in step 2. If a key misses, say
   plainly whether the audio is wrong or the transcript was — run `--recheck` and let
   it decide. "Unverified" is not the same as "verified".

## Output contract

- One mp3 at `output/<name>.mp3` — merged, with 0.5s gaps between segments. Not a
  directory of fragments: the user is going to press play once, on a phone, maybe walking.
- A matching `output/<name>.md` narration script (via `--keep-script`) so they can read
  along or re-run with edits.
- Delivered via `<deliver-assets><media src="..." /></deliver-assets>`, mp3 first.
- A short note on what was changed for the ear and what verification passed.

## Offline audits — run these before spending API budget

A transcript round-trip can only tell you whether a number SURVIVED synthesis. It cannot
tell you whether the number was ever right. These two audits cost nothing:

```bash
# Does every number in the script trace back to the source? And which source
# numbers never made it into the script?
node scripts/audit-numbers.mjs --script output/ep08a.md --source chip-research/B3-*.md

# Is every synthesized segment the right length? A truncated segment has the same
# character count but less audio, so its ch/s ratio goes UP.
node scripts/audit-segments.mjs --jobdir .tts-narration/ep08a-upstream --segments segs.json
```

`audit-numbers.mjs` caught a **10× error** that the STT pass would have happily
transcribed back: the source said `$220 億` (22 billion) and the script said `22 億`
(2.2 billion). The STT verified what was written; the script was wrong.

`audit-segments.mjs` has two modes. `--jobdir` measures each part file directly and is
exact. `--mp3` falls back to silence detection on a merged file, which is weaker — the
TTS inserts its own pauses inside a segment, so silence does not mean boundary. The
silence regex must pair `silence_start` and `silence_end` across LINES: ffmpeg prints
them separately, and a one-line regex matches nothing and reports "0 段静音" while
quietly producing a garbage per-segment table.

## Interrupted runs — resume without re-spending

The synthesis result is cached in `.tts-narration/<job>/items.json`, and the resume is
**content-addressed**: each cached part records the TEXT it was synthesized from, so
editing one paragraph re-renders that paragraph and keeps the audio of every untouched
one — even when the edit re-splits a paragraph and shifts every later index.

```bash
node scripts/migrate-items-cache.mjs --jobdir .tts-narration/ep08a-upstream  # legacy cache
node scripts/narrate.mjs --segments segs.json --out out.mp3 --verify-file keys.json
```

To see what a resume would cost before running it, compare the cached texts with the
current segments. 87 of 108 segments reused meant 21 TTS calls instead of 108.

**The upstream TTS rate-limits bursts.** Measured: batches of 10 gave 4 failures in
batch 5 and up to 7 in batch 9, all `err_code 429`. The client now sends batches of 6
with a 2 s pause, and re-requests only the missing parts in small batches with a growing
delay — the upstream message says "retry the SAME request after a brief delay (do not
change the prompt)".

**Sort the parts NUMERICALLY.** `success_items` comes back in arbitrary order and only
the `output_file` name is trustworthy, but `localeCompare` without `{numeric: true}`
sorts `part_11` BEFORE `part_100` — a 100+ segment job silently mis-orders every part
from #11 onward. The part names are padded to three digits, and the sort is numeric.

## Failure handling

- **`failed_items` non-empty** — the script prints them. Re-run only the missing indices;
  do not silently ship an article with a missing section.
- **ch/s spread wider than 3x in the per-part check** — parts are likely misordered or one
  came back truncated. Investigate before delivering; a wrong order is worse than no file.
- **STT reports a missing key** — distinguish a real problem from STT noise first. STT
  routinely mangles Latin proper nouns (`vibe coding` → `web coding`, `Leporini` → a
  different name) and numeric boundaries shift between runs. Judge on digits, scores and
  the conclusion sentence; do not regenerate over a misspelled name. Check the saved
  transcript first (`--check-txt`, no API cost) to see what STT actually wrote for that
  stretch; re-run `--verify-only` only if you need to re-transcribe the audio itself.
  A key that is "missing" may sit in a window that was not sampled.
- **A key is missing from the script itself** — the pre-flight gate exits 3 with the
  offending keys named. Do not "fix" it by editing the key to something plausible; the
  figure is either not in the narration (add it) or not worth verifying (drop it).
- **A key misses after normalisation** — do NOT assume the audio is wrong. Run
  `--recheck --recheck-passes 3`. The STT hallucinates whole passages AND varies
  wildly on short numbers; a second or third pass with different chunk
  boundaries usually contradicts the first. If the union still misses, use
  `probe-audio.mjs` on that stretch: some correct readings → the audio is fine;
  every reading identically wrong → re-render that segment with `--redo <n>`.
  A wrong *number* in the audio is a factual error, not a cosmetic one —
  fix it before shipping.
- **STT returns 0 chars, or times out partway** — the endpoint is unreliable above a few
  minutes and fails *silently or transiently*. Measured: 33 MB whole-file → 0 chars no
  error; 300 s chunks → `UND_ERR_HEADERS_TIMEOUT`; 150 s chunks → clean. The script chunks
  at 150 s, retries once, saves the transcript after every piece, and reports which pieces
  failed instead of aborting. Re-run `--verify-only` to retry only those. Partial
  transcripts are still worth checking — a key that is "missing" may simply sit in a
  window you did not sample, so confirm where the number actually occurs before treating
  it as a content error.
- **ffprobe "Option not found" with empty stdout** — the script was called with
  `--show_entries`; ffprobe 5.1 needs the single-dash `-show_entries`. This surfaces as a
  confusing `float('')` far from the cause.
- **TTS or STT unavailable / network failing** — say so plainly and point at the script.
  Do not substitute a web TTS site and hand the user a copy-paste chore. A 0-char STT pass
  means "unverified", not "verified" — report it that way.
- **HTTP 402 "the user's plan balance has run out"** — this is a BILLING limit on the
  user's own plan, not a rate limit and not a transient fault. Retrying does not help.
  Stop calling the TTS/STT connectors, download whatever parts were already synthesized
  (asset node ids expire — pull them to the workspace), and tell the user to top up.
  Everything else can still be finished offline: write the script, run `audit-numbers.mjs`,
  prepare the segment and key files, and leave a resume command in the playlist.

## Examples

Input: a 2,800-character article with five markdown tables, inline percentages, and
citations. Output: a ~8 minute mp3 plus a markdown script, delivered as one file, with the
tables rewritten as prose, percentages spoken as 「百分之九十五點九」, and the last few
figures confirmed present by a transcribe-back pass.

Input: 「把上面这篇念给我听」 with no article in the current turn. Look back in the
conversation first — if a prior article is unambiguous, use it; if several are candidates,
ask which one rather than picking.

## 并发保护（必须遵守）

任务目录 `.tts-narration/<输出文件名>/` 是**按输出文件名唯一定位**的，不是按运行定位。
所以同一个工作目录里如果有两个进程同时跑（另一个 agent、另一个终端、或你自己忘了上一条还在跑），
它们会互相覆盖 `transcript.txt` 和 `parts.json`，导致**已完成的校验结果被静默替换**。

`narrate.mjs` 现在会在任务目录里写 `.lock`（PID）。如果该 PID 还活着，新进程会**直接退出并报退出码 5**，
不会开始任何 API 调用。看到这个提示就换个 `--out` 文件名，或者等那个进程结束。

> 实测教训：平台的自动化评测 agent 会在同一个 `/workspace` 里用同一套技能跑同一个任务。
> 它的一次 `--verify-only` 覆盖了我已完成的 `transcript.txt`，
> 日志里出现两套互相矛盾的校验结果（25/25 与 20/25 交错）。
> 音频文件本身没坏（重验确认），但如果当时没察觉就会误判成「音频损坏」。
