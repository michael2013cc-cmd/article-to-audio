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

test('matchKeys 命中 STT 的三種千分位寫法', () => {
  // 2026-10-23 實測：STT 寫千分位有三种樣子，鍵都沒有任何分隔符。
  //   ep18  「12,288」  半形逗號
  //   ep16b 「1，180」  全形逗號
  //   ep16b 「一 180」  中文數字 + 空格（normalizeScript 後變成「1 180」）
  for (const t of ['對匯總表 12,288 個加速器', '對匯總表 12，288 個加速器',
                   '對匯總表十二 288 個加速器', '對匯總表 12288 個加速器']) {
    assert.equal(matchKeys(t, [{ key: '12288', alts: [] }]).length, 0, t);
  }
  for (const t of ['對匯總表 1,180 EFLOPS', '對匯總表 1，180 EFLOPS',
                   '對匯總表一 180 EFLOPS', '對匯總表 1180 EFLOPS']) {
    assert.equal(matchKeys(t, [{ key: '1,180', alts: [] }]).length, 0, t);
    assert.equal(matchKeys(t, [{ key: '1180', alts: [] }]).length, 0, t);
  }
});

test('matchKeys 仍然抓得出真的缺漏', () => {
  assert.equal(matchKeys('對匯總表一，085 EFLOPS', [{ key: '1,180', alts: [] }]).length, 1);
});
