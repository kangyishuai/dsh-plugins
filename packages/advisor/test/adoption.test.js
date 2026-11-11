// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeAdoption, signalsOf, summarizeAdoption } from "../lib/adoption.js";

const events = [
  { type: "turn/start", data: { turn: 1 } },
  {
    type: "plugin:advisor/advice",
    data: {
      adviceId: "adv_1",
      advice: "先补 src/retry.ts 的用例",
      severity: "concern",
      summary: "先补用例",
      anchors: { checked: 1, verified: 1 },
    },
  },
  { type: "tool/call", data: { tool: "read", args: { path: "src/retry.ts" } } },
  {
    type: "plugin:advisor/advice",
    data: {
      adviceId: "adv_2",
      advice: "把 backoff 改成指数退避",
      severity: "nit",
      summary: "改 backoff",
      anchors: { checked: 1, verified: 0 },
    },
  },
];

test("signalsOf 抽路径、反引号命令与证据 ref，过短的丢掉", () => {
  const signals = signalsOf({
    advice: "改 `go test ./...` 并看 src/retry.ts",
    evidence: [{ ref: "call_1" }, { ref: "ab" }],
  });
  assert.equal(signals.includes("src/retry.ts"), true);
  assert.equal(signals.includes("go test ./..."), true);
  assert.equal(signals.includes("call_1"), true);
  assert.equal(
    signals.some((s) => s.length < 3),
    false,
  );
});

test("attributeAdoption：后续事件出现信号 → adopted", () => {
  const outcome = attributeAdoption(events, 1, events[1].data);
  assert.equal(outcome.verdict, "adopted");
  assert.equal(outcome.why, "src/retry.ts");
});

test("attributeAdoption：后续没有信号 → unknown（不硬认领）", () => {
  const outcome = attributeAdoption(events, 3, events[3].data);
  assert.equal(outcome.verdict, "unknown");
});

test("attributeAdoption：建议里没有可追踪信号 → unknown", () => {
  assert.equal(attributeAdoption(events, 1, { advice: "再想想" }).verdict, "unknown");
});

test("summarizeAdoption 汇总投递/采纳/锚点", () => {
  const summary = summarizeAdoption(events, [
    { index: 1, data: events[1].data },
    { index: 3, data: events[3].data },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.adopted, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.anchorsChecked, 2);
  assert.equal(summary.anchorsVerified, 1);
  assert.equal(summary.items[0].adviceId, "adv_1");
});
