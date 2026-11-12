// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPool, dayKey, normalizePool } from "../lib/budget.js";
import {
  builtinPrice,
  builtinRank,
  checkAllowlist,
  effectivePrice,
  effectiveRank,
} from "../lib/catalog.js";

test("builtinRank：最长匹配优先，认不出就是 undefined", () => {
  assert.equal(builtinRank("deepseek/deepseek-v4.1-flash"), 3);
  assert.equal(builtinRank("deepseek/deepseek-v4-pro"), 6);
  assert.equal(builtinRank("claude-opus-4-8"), 7);
  assert.equal(builtinRank("some-unknown-model"), undefined);
});

test("builtinPrice：认不出返回 undefined（不瞎猜）", () => {
  assert.deepEqual(builtinPrice("deepseek-v4.1-flash"), { input: 0.1, output: 0.3 });
  assert.equal(builtinPrice("mystery"), undefined);
});

test("effectiveRank：用户声明覆盖内置，缺省回落内置", () => {
  assert.equal(effectiveRank({}, { provider: "a", model: "deepseek-v4-pro" }), 6);
  assert.equal(
    effectiveRank({ "a/deepseek-v4-pro": 1 }, { provider: "a", model: "deepseek-v4-pro" }),
    1,
  );
  assert.equal(effectiveRank({}, { provider: "a", model: "mystery" }), undefined);
});

test("effectivePrice：设置优先 > 内置 > 不算钱", () => {
  assert.deepEqual(
    effectivePrice({ priceInputPerMTok: 2, priceOutputPerMTok: 8 }, "deepseek-v4.1-flash"),
    { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, source: "settings", cacheSource: "none" },
  );
  assert.deepEqual(
    effectivePrice({ priceInputPerMTok: 0, priceOutputPerMTok: 0 }, "deepseek-v4.1-flash"),
    {
      input: 0.1,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0,
      source: "builtin",
      cacheSource: "none",
    },
  );
  assert.deepEqual(effectivePrice({ priceInputPerMTok: 0, priceOutputPerMTok: 0 }, "mystery"), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    source: "none",
    cacheSource: "none",
  });
});

test("effectivePrice：人民币单价按汇率折算成 USD", () => {
  assert.deepEqual(
    effectivePrice(
      {
        currency: "CNY",
        usdToCny: 7.2,
        priceInputPerMTok: 7.2,
        priceOutputPerMTok: 14.4,
      },
      "mystery",
    ),
    {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      source: "settings",
      cacheSource: "none",
    },
  );
});

test("effectivePrice：缓存单价只有用户设置，内置价不猜缓存", () => {
  assert.deepEqual(
    effectivePrice(
      { priceCacheReadPerMTok: 0.5, priceCacheWritePerMTok: 1 },
      "deepseek-v4.1-flash",
    ),
    {
      input: 0.1,
      output: 0.3,
      cacheRead: 0.5,
      cacheWrite: 1,
      source: "builtin",
      cacheSource: "settings",
    },
  );
  assert.deepEqual(
    effectivePrice(
      {
        currency: "CNY",
        usdToCny: 7.2,
        priceCacheReadPerMTok: 7.2,
        priceCacheWritePerMTok: 14.4,
      },
      "mystery",
    ),
    {
      input: 0,
      output: 0,
      cacheRead: 1,
      cacheWrite: 2,
      source: "none",
      cacheSource: "settings",
    },
  );
});

test("checkAllowlist：空名单不限制；命中 provider/model 或裸 id 放行", () => {
  assert.equal(checkAllowlist([], { provider: "a", model: "b" }).allowed, true);
  assert.equal(checkAllowlist(["a/b"], { provider: "a", model: "b" }).allowed, true);
  assert.equal(checkAllowlist(["b"], { provider: "a", model: "b" }).allowed, true);
  assert.equal(checkAllowlist(["x/y"], { provider: "a", model: "b" }).allowed, false);
});

test("预算池：跨日清零，按调用数与金额双闸", () => {
  const pool = normalizePool({ day: "2000-01-01", calls: 9, costUsd: 9 }, "2026-11-11");
  assert.deepEqual(pool, { day: "2026-11-11", calls: 0, costUsd: 0 });

  const settings = {
    workspaceMaxCallsPerDay: 10,
    workspaceMaxCostPerDay: 1,
    currency: "USD",
    usdToCny: 7.2,
  };
  assert.equal(checkPool({ calls: 9, costUsd: 0 }, settings).ok, true);
  /** @param {any} result */
  const codeOf = (result) => (result.ok ? "ok" : result.code);
  assert.equal(codeOf(checkPool({ calls: 10, costUsd: 0 }, settings)), "workspace_calls");
  assert.equal(codeOf(checkPool({ calls: 0, costUsd: 1 }, settings)), "workspace_budget");
  assert.equal(codeOf(checkPool({ calls: 0, costUsd: 0.9 }, settings, 0.2)), "workspace_budget");
  const cny = {
    workspaceMaxCallsPerDay: 10,
    workspaceMaxCostPerDay: 7.2,
    currency: "CNY",
    usdToCny: 7.2,
  };
  assert.equal(codeOf(checkPool({ calls: 0, costUsd: 1 }, cny)), "workspace_budget");
  assert.equal(dayKey(new Date("2026-11-11T12:00:00Z")).length, 10);
});
