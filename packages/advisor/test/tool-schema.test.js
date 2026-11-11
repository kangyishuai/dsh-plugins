// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderToolOutput,
  TOOL_NAME,
  TOOL_OUTPUT_SCHEMA,
  TOOL_PARAMETERS,
  unsupportedSchemaKeywords,
} from "../lib/tool-schema.js";

test("工具名与 Claude 的 advisor 工具一致", () => {
  assert.equal(TOOL_NAME, "advisor");
});

test("工具参数是零必填（对齐原版 input 永远为空）", () => {
  assert.equal(TOOL_PARAMETERS.type, "object");
  assert.equal(Object.hasOwn(TOOL_PARAMETERS, "required"), false);
  assert.deepEqual(Object.keys(TOOL_PARAMETERS.properties), ["focus"]);
});

test("工具 schema 只用了宿主支持的子集关键字", () => {
  // docs/runtime/0.2.2-rc.1.md §9.10：minimum / maximum 会让 register() 静默失败。
  assert.deepEqual(unsupportedSchemaKeywords(TOOL_PARAMETERS), []);
  assert.deepEqual(unsupportedSchemaKeywords(TOOL_OUTPUT_SCHEMA), []);
});

test("renderToolOutput 覆盖四种状态且不抛", () => {
  const reviewed = renderToolOutput(
    {},
    {
      status: "reviewed",
      severity: "concern",
      advice: "先补测试",
      risks: ["覆盖不足"],
      acceptance: ["新增用例"],
      model: "a/b",
      usage: "1k in",
    },
  );
  assert.equal(reviewed[0].type, "text");
  assert.match(reviewed[0].text, /顾问已复核/u);
  assert.match(reviewed[0].text, /先补测试/u);

  const declined = renderToolOutput({}, { status: "declined", model: "a/b" });
  assert.match(declined[0].text, /无需建议/u);

  const skipped = renderToolOutput({}, { status: "skipped", reason: "顾问已关闭" });
  assert.match(skipped[0].text, /未徵询/u);

  const unavailable = renderToolOutput(
    {},
    { status: "unavailable", code: "overloaded", reason: "容量不足" },
  );
  assert.match(unavailable[0].text, /overloaded/u);

  const empty = renderToolOutput({}, undefined);
  assert.equal(typeof empty[0].text, "string");
});

test("unsupportedSchemaKeywords 能抓到 minimum", () => {
  const bad = { type: "object", properties: { n: { type: "number", minimum: 1 } } };
  assert.deepEqual(unsupportedSchemaKeywords(bad), ["$.properties.n.minimum"]);
});
