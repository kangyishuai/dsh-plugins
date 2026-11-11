// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelKey, normalizeEffort, pairingCheck, resolveRoute, tierOf } from "../lib/route.js";

const TIERS = {
  "deepseek/deepseek-chat": 2,
  "anthropic/claude-opus-4-8": 5,
  "deepseek/deepseek-reasoner": 4,
};

test("modelKey / tierOf", () => {
  assert.equal(modelKey({ provider: "a", model: "b" }), "a/b");
  assert.equal(tierOf(TIERS, { provider: "deepseek", model: "deepseek-chat" }), 2);
  assert.equal(tierOf(TIERS, { provider: "x", model: "y" }), undefined);
});

test("resolveRoute：设置里显式配置优先", () => {
  const result = resolveRoute({
    settings: { provider: "anthropic", model: "claude-opus-4-8", reasoningEffort: "high" },
    mainModel: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.deepEqual(result.route, {
    provider: "anthropic",
    model: "claude-opus-4-8",
    reasoningEffort: "high",
  });
  assert.equal(result.source, "settings");
  assert.equal(result.sameAsMain, false);
});

test("resolveRoute：没配置时回落到会话当前模型，并标记 sameAsMain", () => {
  const result = resolveRoute({
    settings: { provider: "", model: "", reasoningEffort: "" },
    mainModel: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.equal(result.route.provider, "deepseek");
  assert.equal(result.source, "main-model");
  assert.equal(result.sameAsMain, true);
  assert.equal(Object.hasOwn(result.route, "reasoningEffort"), false);
});

test("resolveRoute：都没有时返回空路由（调用方据此跳过）", () => {
  const result = resolveRoute({ settings: { provider: "", model: "", reasoningEffort: "" } });
  assert.equal(result.route.provider, "");
  assert.equal(result.route.model, "");
});

test("pairingCheck：顾问档位 >= 主模型则 ok", () => {
  const result = pairingCheck({
    tiers: TIERS,
    main: { provider: "deepseek", model: "deepseek-chat" },
    advisor: { provider: "deepseek", model: "deepseek-reasoner" },
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.allowed, true);
});

test("pairingCheck：等强可互当", () => {
  const result = pairingCheck({
    tiers: TIERS,
    main: { provider: "deepseek", model: "deepseek-chat" },
    advisor: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.equal(result.kind, "ok");
});

test("pairingCheck：顾问更弱时 warn 放行 / block 拒绝", () => {
  const warn = pairingCheck({
    tiers: TIERS,
    main: { provider: "deepseek", model: "deepseek-reasoner" },
    advisor: { provider: "deepseek", model: "deepseek-chat" },
    enforcement: "warn",
  });
  assert.equal(warn.kind, "weaker");
  assert.equal(warn.allowed, true);

  const block = pairingCheck({
    tiers: TIERS,
    main: { provider: "deepseek", model: "deepseek-reasoner" },
    advisor: { provider: "deepseek", model: "deepseek-chat" },
    enforcement: "block",
  });
  assert.equal(block.allowed, false);
});

test("pairingCheck：没有档位时 unknown —— 不阻断，也不假装通过", () => {
  const result = pairingCheck({
    tiers: {},
    main: { provider: "a", model: "b" },
    advisor: { provider: "c", model: "d" },
  });
  assert.equal(result.kind, "unknown");
  assert.equal(result.allowed, true);
  assert.match(result.message, /未校验/u);
});

test("normalizeEffort 只做 trim", () => {
  assert.equal(normalizeEffort("  high "), "high");
  assert.equal(normalizeEffort(""), "");
});
