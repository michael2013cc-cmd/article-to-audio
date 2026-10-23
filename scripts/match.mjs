/**
 * match.mjs — 驗證鍵的比對。
 *
 * 純函式模組：narrate.mjs 是 CLI 腳本，import 進來就會執行參數解析，
 * 所以比對邏輯放在這裡，測試才能直接驗它的行為。
 */
import { normalizeScript } from './keys.mjs';

/**
 * 回傳「在這段文字裡找不到」的鍵。
 *
 * 比對三個層次：
 *   1. 原文（容忍 TTS 沒念出來的空白／標點差異）
 *   2. 正規化後（中文數字 → 阿拉伯數字）
 *   3. 去掉千分位後（STT 常自己加逗號）
 *
 * 2026-10-23 實測（ep18 C4）：腳本寫「一万二千二百八十八個加速器」，
 * STT 轉寫成「12,288 個加速器」，而鍵是「12288」。少了第 3 層，
 * 這個鍵會被誤判成「音頻缺內容」。
 */
export function matchKeys(text, keys) {
  const norm = normalizeScript([text]);
  const normNoSep = norm.replace(/,/g, '');
  const missing = [];
  for (const k of keys) {
    // A key file may hold plain strings instead of {key, alts} objects.
    const label = typeof k === 'object' && k !== null ? k.key : k;
    const alts = (typeof k === 'object' && k !== null && Array.isArray(k.alts) && k.alts.length)
      ? k.alts : [label];
    const forms = [...alts, label];
    // The key carries thousands separators ("45,000") but the normalised
    // transcript never does: the TTS reads "45,000" as "四萬五千", which
    // normalises to "45000". Comparing the comma-bearing key against it
    // always misses. Add the separator-free form as an accepted rendering.
    // Measured on ep08a: 45,000 / 30,000 / 25,000 all missed this way.
    for (const f of forms) {
      const plain = String(f).replace(/,/g, '');
      if (plain !== f) forms.push(plain);
    }
    const found = forms.some(f => text.includes(f) || norm.includes(f) || normNoSep.includes(f));
    if (!found) missing.push(k);
  }
  return missing;
}
