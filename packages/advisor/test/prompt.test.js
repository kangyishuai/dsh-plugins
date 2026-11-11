// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVICE_MAX, extractJsonObject, parseAdvice } from "../lib/prompt.js";

test("parseAdvice：合法 reviewed", () => {
  const result = parseAdvice(
    JSON.stringify({
      verdict: "reviewed",
      severity: "concern",
      advice: "先补边界测试再改实现。",
      risks: ["现有测试覆盖不到空数组"],
      acceptance: ["新增一条空数组用例"],
      evidence: [{ kind: "tool_result", ref: "call_123" }],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.advice.verdict, "reviewed");
  assert.equal(result.advice.severity, "concern");
  assert.deepEqual(result.advice.risks, ["现有测试覆盖不到空数组"]);
  assert.deepEqual(result.advice.evidence, [{ kind: "tool_result", ref: "call_123" }]);
});

test("parseAdvice：declined 允许空建议", () => {
  const result = parseAdvice('{"verdict":"declined"}');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.advice.verdict, "declined");
});

test("parseAdvice：容忍 ```json 围栏与前后散文", () => {
  const raw =
    '好的，我的结论是：\n```json\n{"verdict":"reviewed","advice":"换个思路"}\n```\n以上。';
  const result = parseAdvice(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.advice.advice, "换个思路");
});

test("parseAdvice：非法 severity 回落 nit", () => {
  const result = parseAdvice('{"verdict":"reviewed","severity":"fatal","advice":"x"}');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.advice.severity, "nit");
});

test("parseAdvice：reviewed 但建议为空 → invalid", () => {
  const result = parseAdvice('{"verdict":"reviewed","advice":"   "}');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid");
});

test("parseAdvice：纯散文 → unparsed；空串 → empty", () => {
  const prose = parseAdvice("我觉得应该先跑测试。");
  assert.equal(prose.ok, false);
  if (!prose.ok) assert.equal(prose.reason, "unparsed");

  const empty = parseAdvice("   ");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty");
});

test("parseAdvice：超长建议被截断并留痕，证据条目被过滤", () => {
  const long = "x".repeat(ADVICE_MAX + 100);
  const result = parseAdvice(
    JSON.stringify({
      verdict: "reviewed",
      advice: long,
      evidence: [
        { kind: "tool_result", ref: "ok" },
        { kind: "tool_result", ref: 42 },
        { nope: true },
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.advice.advice.length > ADVICE_MAX, true);
  assert.equal(result.advice.advice.includes("已截断"), true);
  assert.deepEqual(result.advice.evidence, [{ kind: "tool_result", ref: "ok" }]);
});

test("extractJsonObject 能跳过字符串里的花括号", () => {
  const raw = '{"a":"}","b":{"c":1}}tail';
  assert.equal(extractJsonObject(raw), '{"a":"}","b":{"c":1}}');
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject('{"unclosed": 1'), null);
});
