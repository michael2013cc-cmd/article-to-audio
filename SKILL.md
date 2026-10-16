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

## Procedure

1. **Rewrite the text for the ear before touching the TTS engine.** This step decides
   whether the result is listenable or merely audible — it is the actual work. Read
   `references/text-conversion.md` for the rule table and before/after examples, then
   produce narration segments. Applying the TTS to the raw article is the common failure:
   it reads out URLs, reads `+1.79%` as "plus one point seven nine percent", and recites
   tables cell by cell.

2. **Drop non-article content, and say what you dropped.** Agent process logs ("先读取
   数据插件的使用说明") and closing questions addressed to the assistant ("要不要我把这段
   并进清单档") are not article content. Removing them silently misrepresents the source;
   removing them *and flagging it* is the contract. Same for source citations at the end —
   offer them as a spoken footer rather than reading URLs inline.

3. **Split into segments of ≤300 characters at paragraph boundaries.** One paragraph per
   segment usually works; a long paragraph may need two. A segment that ends mid-clause
   produces a rushed-sounding gap once merged.

4. **Write the segments to JSON** — `{"segments": ["...", "..."]}` — and run:

   ```bash
   node scripts/narrate.mjs --segments segs.json --out output/<name>.mp3 \
     --verify "<key figure>,<key figure>,..." --keep-script output/<name>.md
   ```

   The script handles batching (>10 segments means multiple calls), re-sorting the
   response, downloading, the inter-segment silence, and the merge. Give `--verify` the
   article's load-bearing numbers — they are what prove the audio says the right thing.

5. **Write `--verify` keys in Arabic digits, not Chinese numerals.** The STT pass
   normalizes spoken numbers back to digits, so `"393.5"` matches and `"三百九十三点五"`
   never will. Matching zero keys usually means the wrong keys, not broken audio.

6. **Report the result with the numbers that matter**: total duration, segment count, and
   the verification result. Mention anything dropped in step 2.

## Output contract

- One mp3 at `output/<name>.mp3` — merged, with 0.5s gaps between segments. Not a
  directory of fragments: the user is going to press play once, on a phone, maybe walking.
- A matching `output/<name>.md` narration script (via `--keep-script`) so they can read
  along or re-run with edits.
- Delivered via `<deliver-assets><media src="..." /></deliver-assets>`, mp3 first.
- A short note on what was changed for the ear and what verification passed.

## Failure handling

- **`failed_items` non-empty** — the script prints them. Re-run only the missing indices;
  do not silently ship an article with a missing section.
- **ch/s spread wider than 3x in the per-part check** — parts are likely misordered or one
  came back truncated. Investigate before delivering; a wrong order is worse than no file.
- **STT reports a missing key** — distinguish a real problem from STT noise first. STT
  routinely mangles Latin proper nouns (`vibe coding` → `web coding`, `Leporini` → a
  different name) and numeric boundaries shift between runs. Judge on digits, scores and
  the conclusion sentence; do not regenerate over a misspelled name. Re-run
  `--verify-only` to see whether a miss is stable before acting on it.
- **STT returns 0 chars on a long file** — the endpoint silently gives up past roughly
  3 minutes / 3 MB. The script chunks anything longer, so a 0-char result means the
  chunking path is broken, not that the audio is. The transcript is saved to
  `<jobdir>/transcript.txt` for grepping.
- **ffprobe "Option not found" with empty stdout** — the script was called with
  `--show_entries`; ffprobe 5.1 needs the single-dash `-show_entries`. This surfaces as a
  confusing `float('')` far from the cause.
- **TTS unavailable** — say so plainly and point at the article. Do not substitute a web
  TTS site and hand the user a copy-paste chore.

## Examples

Input: a 2,800-character article with five markdown tables, inline percentages, and
citations. Output: a ~8 minute mp3 plus a markdown script, delivered as one file, with the
tables rewritten as prose, percentages spoken as 「百分之九十五點九」, and the last few
figures confirmed present by a transcribe-back pass.

Input: 「把上面这篇念给我听」 with no article in the current turn. Look back in the
conversation first — if a prior article is unambiguous, use it; if several are candidates,
ask which one rather than picking.
