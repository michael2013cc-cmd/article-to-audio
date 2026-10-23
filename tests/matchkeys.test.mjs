/**
 * matchKeys 的行為測試。
 *
 * 2026-10-23 實測缺口：STT 把中文數字寫成帶千分位的阿拉伯數字
 * （腳本「一万二千二百八十八」→ 轉寫「12,288」），而鍵是「12288」，
 * 雙向比對都對不上 → 整個鍵被誤判成「音頻缺內容」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchKeys } from '../scripts/match.mjs';

test('matchKeys 命中轉寫裡帶千分位的同一個數', () => {
  const keys = [{ key: '12288', alts: [] }];
  assert.equal(matchKeys('共 12,288 個加速器', keys).length, 0);
});

test('matchKeys 命中鍵本身帶千分位、轉寫沒帶的情況', () => {
  const keys = [{ key: '14,357', alts: [] }];
  assert.equal(matchKeys('第三方实测 14357', keys).length, 0);
});

test('matchKeys 仍然抓得出真的缺漏', () => {
  const keys = [{ key: '12288', alts: [] }];
  assert.equal(matchKeys('共 96 個加速器', keys).length, 1);
});

test('matchKeys 支援純字串鍵檔', () => {
  assert.equal(matchKeys('共 12,288 個加速器', ['12288']).length, 0);
  assert.equal(matchKeys('共 96 個加速器', ['12288']).length, 1);
});
