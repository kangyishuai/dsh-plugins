// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  isConfigured,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  normalizeTiers,
  saveSettings,
  settingsPath,
} from "../lib/settings.js";

test("默认设置：默认关闭、没有配置顾问", () => {
  assert.equal(DEFAULT_SETTINGS.mode, "off");
  assert.equal(isConfigured(DEFAULT_SETTINGS), false);
  assert.equal(DEFAULT_SETTINGS.privacyScope, "summary");
  assert.equal(DEFAULT_SETTINGS.redact, true);
  assert.equal(DEFAULT_SETTINGS.priceCacheReadPerMTok, 0);
  assert.equal(DEFAULT_SETTINGS.priceCacheWritePerMTok, 0);
});

test("normalizeSettings 丢弃未知键、夹紧数字、过滤非法模式", () => {
  const out = normalizeSettings({
    mode: "whatever",
    provider: "  deepseek  ",
    model: "deepseek-chat",
    maxTokens: 999999,
    maxCallsPerTurn: -5,
    immuneTurns: 999,
    privacyScope: "all",
    redact: "yes",
    bogus: 1,
  });
  assert.equal(out.mode, "off", "非法模式回落 off");
  assert.equal(out.provider, "deepseek", "字符串会 trim");
  assert.equal(out.maxTokens, 32000, "超出上限被夹紧");
  assert.equal(out.maxCallsPerTurn, 0, "负数被夹到 0（= 不限）");
  assert.equal(out.immuneTurns, 20);
  assert.equal(out.privacyScope, "summary", "非法隐私档回落默认");
  assert.equal(out.redact, true, "非布尔值不改默认");
  assert.equal(Object.hasOwn(out, "bogus"), false);
});

test("金额字段保留小数，不再按整数取整", () => {
  const out = normalizeSettings({
    maxCostPerDay: 0.5,
    workspaceMaxCostPerDay: 1.25,
    priceInputPerMTok: 0.15,
    priceOutputPerMTok: 0.075,
  });
  assert.equal(out.maxCostPerDay, 0.5);
  assert.equal(out.workspaceMaxCostPerDay, 1.25);
  assert.equal(out.priceInputPerMTok, 0.15);
  assert.equal(out.priceOutputPerMTok, 0.075);
});

test("金额字段按精度收口并夹紧区间", () => {
  const out = normalizeSettings({
    maxCostPerDay: 1.239,
    workspaceMaxCostPerDay: -1,
    priceInputPerMTok: 0.123456,
    priceOutputPerMTok: 99999,
  });
  assert.equal(out.maxCostPerDay, 1.24, "预算保留 2 位小数");
  assert.equal(out.workspaceMaxCostPerDay, 0, "负数夹到 0");
  assert.equal(out.priceInputPerMTok, 0.1235, "单价保留 4 位小数");
  assert.equal(out.priceOutputPerMTok, 1000, "超出上限夹到 1000");
});

test("计数字段仍然取整", () => {
  const out = normalizeSettings({ maxCallsPerTurn: 1.6, maxTokens: 4096.7, sessionCap: 3.4 });
  assert.equal(out.maxCallsPerTurn, 2);
  assert.equal(out.maxTokens, 4097);
  assert.equal(out.sessionCap, 3);
});

test("默认币种 USD、汇率 7.2，旧 *Usd 键按 USD 迁移", () => {
  assert.equal(DEFAULT_SETTINGS.currency, "USD");
  assert.equal(DEFAULT_SETTINGS.usdToCny, 7.2);
  const usd = normalizeSettings({ maxCostPerDayUsd: 10, workspaceMaxCostPerDayUsd: 20 });
  assert.equal(usd.currency, "USD");
  assert.equal(usd.maxCostPerDay, 10);
  assert.equal(usd.workspaceMaxCostPerDay, 20);
  const cny = normalizeSettings({ currency: "CNY", usdToCny: 7.2, maxCostPerDayUsd: 10 });
  assert.equal(cny.currency, "CNY");
  assert.equal(cny.maxCostPerDay, 72, "10 USD 按 7.2 迁成 72 CNY");
});

test("缓存单价按金额字段归一化，0 = 不计", () => {
  const out = normalizeSettings({
    priceCacheReadPerMTok: 0.123456,
    priceCacheWritePerMTok: 99999,
  });
  assert.equal(out.priceCacheReadPerMTok, 0.1235);
  assert.equal(out.priceCacheWritePerMTok, 1000);
  assert.equal(normalizeSettings({}).priceCacheReadPerMTok, 0);
});

test("currency / usdToCny 归一化", () => {
  assert.equal(normalizeSettings({ currency: "CNY" }).currency, "CNY");
  assert.equal(normalizeSettings({ currency: "EUR" }).currency, "USD");
  assert.equal(normalizeSettings({ usdToCny: 0 }).usdToCny, 7.2);
  assert.equal(normalizeSettings({ usdToCny: 20 }).usdToCny, 20);
  assert.equal(normalizeSettings({ usdToCny: 1000 }).usdToCny, 100);
});

test("tracePrompt 默认首尾预览，非法值回落，off 保留", () => {
  assert.equal(DEFAULT_SETTINGS.tracePrompt, "preview");
  assert.equal(normalizeSettings({ tracePrompt: "off" }).tracePrompt, "off");
  assert.equal(normalizeSettings({ tracePrompt: "preview" }).tracePrompt, "preview");
  assert.equal(normalizeSettings({ tracePrompt: "whatever" }).tracePrompt, "preview");
});

test("mergeSettings 只覆盖 patch 里出现的键", () => {
  const base = normalizeSettings({ mode: "advisory", provider: "p", model: "m", maxTokens: 1024 });
  const next = mergeSettings(base, { maxTokens: 2048 });
  assert.equal(next.maxTokens, 2048);
  assert.equal(next.provider, "p");
  assert.equal(next.mode, "advisory");
});

test("normalizeTiers 只保留合法档位", () => {
  const tiers = normalizeTiers({ "a/b": 3, "c/d": "2", "": 1, "e/f": "x", "g/h": -1 });
  assert.deepEqual(tiers, { "a/b": 3, "c/d": 2 });
});

test("saveSettings 原子写 + loadSettings 读回一致", async () => {
  const home = await mkdtemp(join(tmpdir(), "advisor-settings-"));
  const saved = await saveSettings({
    home,
    settings: normalizeSettings({ mode: "advisory", provider: "deepseek", model: "deepseek-chat" }),
  });
  assert.equal(settingsPath(home), join(home, "advisor.settings.json"));
  const raw = JSON.parse(await readFile(settingsPath(home), "utf8"));
  assert.equal(raw.provider, "deepseek");

  const loaded = await loadSettings({ home });
  assert.deepEqual(loaded, saved);
  assert.equal(isConfigured(loaded), true);
});

test("loadSettings 遇到坏文件回落到默认值而不是抛错", async () => {
  const home = await mkdtemp(join(tmpdir(), "advisor-settings-bad-"));
  await writeFile(settingsPath(home), "{not json", "utf8");
  const loaded = await loadSettings({ home });
  assert.equal(loaded.mode, "off");
  assert.equal(loaded.maxTokens, DEFAULT_SETTINGS.maxTokens);
});
