/**
 * cache.mjs — 續跑快取（items.json）的讀寫。
 *
 * 2026-10-22 的教訓：快取**只能合併，永不覆蓋**。
 *
 * 舊版 narrate.mjs 的 save() 是 `fs.writeFileSync(cachePath, items)`，
 * 而續跑失敗時又被誤判成「快取壞掉」→ 從空池重合成 → 第一次 save()
 * 就把累積了 60 段的進度清空（ep13a 實際發生過）。
 *
 * 規則：
 *  - 以 (node_id, file_name, text) 三元組去重
 *  - 磁碟上已存在的項目一律保留
 *  - 讀不出來回傳空陣列（呼叫端要區分「空」與「壞」）
 */
import fs from 'node:fs';

/** 合併新舊項目，磁碟上的舊項目一律保留。 */
export function mergeCacheItems(prev, next) {
  const seen = new Set();
  const merged = [];
  for (const it of [...(prev || []), ...(next || [])]) {
    if (!it || !it.text || !it.node_id) continue;
    const k = `${it.node_id}|${it.file_name}|${it.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ ...it });
  }
  return merged;
}

/** 讀快取；讀不出來回傳空陣列（呼叫端要區分「空」與「壞」）。 */
export function loadCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
