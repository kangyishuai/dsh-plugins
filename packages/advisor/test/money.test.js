// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_USD_TO_CNY,
  formatMoney,
  fromUsd,
  normalizeCurrency,
  normalizeRate,
  toUsd,
} from "../lib/money.js";

test("normalizeCurrency / normalizeRate", () => {
  assert.equal(normalizeCurrency("CNY"), "CNY");
  assert.equal(normalizeCurrency("USD"), "USD");
  assert.equal(normalizeCurrency("EUR"), "USD");
  assert.equal(normalizeRate(7.2), 7.2);
  assert.equal(normalizeRate(0), DEFAULT_USD_TO_CNY);
  assert.equal(normalizeRate(-1), DEFAULT_USD_TO_CNY);
  assert.equal(normalizeRate(0.01), 0.1);
  assert.equal(normalizeRate(1000), 100);
});

test("toUsd / fromUsd 按 1 USD = 7.2 CNY 互转", () => {
  assert.equal(toUsd(7.2, "CNY", 7.2), 1);
  assert.equal(toUsd(1, "USD", 7.2), 1);
  assert.equal(fromUsd(1, "CNY", 7.2), 7.2);
  assert.equal(fromUsd(1, "USD", 7.2), 1);
  assert.equal(toUsd(Number.NaN, "CNY", 7.2), 0);
  assert.equal(fromUsd(Number.NaN, "CNY", 7.2), 0);
});

test("formatMoney 使用 $ / ¥ 和指定小数位", () => {
  assert.equal(formatMoney(0.004, "USD"), "$0.0040");
  assert.equal(formatMoney(0.029, "CNY"), "¥0.0290");
  assert.equal(formatMoney(10, "CNY", 2), "¥10.00");
  assert.equal(formatMoney(Number.NaN, "USD", 2), "$0.00");
});
