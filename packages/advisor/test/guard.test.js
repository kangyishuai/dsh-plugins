// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkBudget,
  estimateCostUsd,
  fingerprint,
  immuneActive,
  isHollowAdvice,
  rememberFingerprint,
  severityRank,
} from "../lib/guard.js";
import { normalizeSettings } from "../lib/settings.js";

test("fingerprint 忽略大小写、空白与标点差异", () => {
  const a = fingerprint("先补边界测试，再改实现。");
  const b = fingerprint("先补边界测试 再改实现");
  assert.equal(a, b);
  assert.notEqual(a, fingerprint("先补边界测试再改实现，但顺序相反"));
});

test("rememberFingerprint：窗口内重复、窗口外放行、表有上限", () => {
  const now = 1_700_000_000_000;
  const first = rememberFingerprint(new Map(), "abc", now, 1000);
  assert.equal(first.duplicate, false);

  const again = rememberFingerprint(first.table, "abc", now + 500, 1000);
  assert.equal(again.duplicate, true);

  const later = rememberFingerprint(again.table, "abc", now + 2000, 1000);
  assert.equal(later.duplicate, false, "超过窗口后应当重新放行");

  /** @type {Map<string, number>} */
  let table = new Map();
  for (let index = 0; index < 4200; index += 1) {
    table = rememberFingerprint(table, `id-${index}`, now).table;
  }
  assert.equal(table.size <= 4096, true, "去重表必须有界");
});

test("immuneActive 只在窗口内为真", () => {
  assert.equal(immuneActive({ lastDeliveryTurn: 1, currentTurn: 3, immuneTurns: 3 }), true);
  assert.equal(immuneActive({ lastDeliveryTurn: 1, currentTurn: 4, immuneTurns: 3 }), false);
  assert.equal(immuneActive({ lastDeliveryTurn: null, currentTurn: 9, immuneTurns: 3 }), false);
  assert.equal(immuneActive({ lastDeliveryTurn: 1, currentTurn: 2, immuneTurns: 0 }), false);
});

test("checkBudget 按固定顺序返回第一个不满足的条件", () => {
  const settings = normalizeSettings({
    maxCallsPerTurn: 1,
    maxCallsPerSession: 5,
    maxCallsPerHour: 2,
    maxCostPerDay: 1,
  });
  const now = Date.now();
  /** @param {any} counters */
  const codeOf = (counters) => {
    const result = checkBudget({ settings, counters, now });
    return result.ok ? "ok" : result.code;
  };

  assert.equal(codeOf({ turnCalls: 0, sessionCalls: 0, hourStamps: [], dayCostUsd: 0 }), "ok");
  assert.equal(
    codeOf({ turnCalls: 1, sessionCalls: 1, hourStamps: [], dayCostUsd: 0 }),
    "turn_limit",
  );
  assert.equal(
    codeOf({ turnCalls: 0, sessionCalls: 5, hourStamps: [], dayCostUsd: 0 }),
    "session_limit",
  );
  assert.equal(
    codeOf({ turnCalls: 0, sessionCalls: 1, hourStamps: [now - 1000, now - 2000], dayCostUsd: 0 }),
    "hour_limit",
  );
  assert.equal(
    codeOf({ turnCalls: 0, sessionCalls: 1, hourStamps: [], dayCostUsd: 2 }),
    "day_budget",
  );
});

test("checkBudget：人民币限额按汇率换算成 USD 再比较", () => {
  const settings = normalizeSettings({
    maxCallsPerTurn: 0,
    maxCallsPerSession: 0,
    maxCallsPerHour: 0,
    maxCostPerDay: 7.2,
    currency: "CNY",
    usdToCny: 7.2,
  });
  const now = Date.now();
  const result = checkBudget({
    settings,
    counters: {
      turnCalls: 0,
      sessionCalls: 0,
      hourStamps: [],
      dayCostUsd: 0.9,
    },
    estimatedCostUsd: 0.2,
    now,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "day_budget");
  assert.equal(result.limit, 1, "7.2 CNY / 7.2 = 1 USD");
  assert.equal(result.used, 0.9);
});

test("checkBudget：0 表示不限制", () => {
  const settings = normalizeSettings({
    maxCallsPerTurn: 0,
    maxCallsPerSession: 0,
    maxCallsPerHour: 0,
    maxCostPerDay: 0,
  });
  const result = checkBudget({
    settings,
    counters: {
      turnCalls: 99,
      sessionCalls: 99,
      hourStamps: Array.from({ length: 99 }, () => Date.now()),
      dayCostUsd: 99,
    },
    now: Date.now(),
  });
  assert.deepEqual(result, { ok: true });
});

test("estimateCostUsd：单价为 0 时不算钱", () => {
  assert.equal(
    estimateCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      priceInputPerMTok: 0,
      priceOutputPerMTok: 0,
    }),
    0,
  );
  assert.equal(
    estimateCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      priceInputPerMTok: 2,
      priceOutputPerMTok: 8,
    }),
    2,
  );
  assert.equal(
    estimateCostUsd({
      inputTokens: 0,
      outputTokens: 500_000,
      priceInputPerMTok: 2,
      priceOutputPerMTok: 8,
    }),
    4,
  );
  assert.equal(
    estimateCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      priceInputPerMTok: 2,
      priceOutputPerMTok: 8,
      priceCacheReadPerMTok: 0.5,
      priceCacheWritePerMTok: 1,
    }),
    11.5,
    "缓存读/写是额外输入侧 token，分别乘缓存单价",
  );
  assert.equal(
    estimateCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      priceInputPerMTok: 2,
      priceCacheReadPerMTok: 0,
    }),
    2,
    "缓存单价 0 = 不计缓存部分",
  );
});

test("isHollowAdvice 精确匹配空洞建议，不做包含匹配", () => {
  assert.equal(isHollowAdvice("LGTM"), true);
  assert.equal(isHollowAdvice("  nothing to add.  "), true);
  assert.equal(isHollowAdvice("没问题"), true);
  assert.equal(isHollowAdvice("Stop."), true);
  // 包含匹配会误杀真正的 blocker，这里必须为 false。
  assert.equal(isHollowAdvice("Stop the migration: it drops the users table."), false);
  assert.equal(isHollowAdvice("No issues found, but the retry loop has no backoff."), false);
});

test("severityRank 单调", () => {
  assert.equal(severityRank("nit") < severityRank("concern"), true);
  assert.equal(severityRank("concern") < severityRank("blocker"), true);
});
