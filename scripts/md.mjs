/**
 * md.mjs — strip markdown emphasis before text reaches the TTS engine.
 *
 * MEASURED, NOT ASSUMED. The same segment synthesized 5 times:
 *   with "**"  → 5/5 FAILED. The sentence stopped early, "42.5 EF" was never
 *                 spoken, and the engine appended hallucinated garbage:
 *                 "Don't feel uncomfortable.", "dofus.com/fm",
 *                 "Trillium, comma, family.", "Trophy real cool MF."
 *   without    → 5/5 correct, including "42.5 EF".
 *
 * The asterisks are never spoken, so removing them costs nothing — and it
 * removes a class of silent audio corruption that a transcript check can
 * only catch after the fact. The written script keeps the markers; only the
 * spoken text is stripped.
 */
export function stripMarkdown(text) {
  return text
    .replace(/\*\*\*([^]*?)\*\*\*/g, '$1')              // bold+italic
    .replace(/\*\*([^]*?)\*\*/g, '$1')                    // bold
    .replace(/__([^]*?)__/g, '$1')                        // bold (underscore)
    // Italic must not be wrapped in spaces — that is how "2 * 3 * 4" stays intact.
    .replace(/(?<![\w*])\*(?!\s)([^*\n]*\S[^*\n]*)\*(?!\s)/g, '$1')
    .replace(/(?<![\w_])_(?!\s)([^_\n]*\S[^_\n]*)_(?!\s)/g, '$1')
    .replace(/~~([^]*?)~~/g, '$1')                        // strikethrough
    .replace(/`([^`]*)`/g, '$1')                          // inline code
    .replace(/^\s*#{1,6}\s+/gm, '')                      // headings
    .replace(/^\s*>\s?/gm, '')                           // block quote
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')              // link → text
    // Only doubled leftovers are markers. A single "*" may be a multiplication
    // sign in prose, so it stays.
    .replace(/\*\*|__/g, '')
    .replace(/\n{2,}/g, '\n')                            // collapse blank lines
    .trim();
}
