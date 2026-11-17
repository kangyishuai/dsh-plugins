// @ts-check
// 单元测试：tools.js 的工具面（名称、schema 形状、错误映射、projectId 兜底）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildToolDefinitions, TOOL_NAMES, toToolError } from "../lib/tools.js";

/** 记录调用的假 handlers。 */
function fakeHandlers() {
  /** @type {Array<[string, any[]]>} */
  const calls = [];
  /** @type {(name: string) => (...args: any[]) => any} */
  const record =
    (name) =>
    (...args) => {
      calls.push([name, args]);
      if (name === "listProjects") return [];
      if (name === "addEvidence") return { id: "ev-1" };
      if (name === "addClaim") return { id: "claim-1" };
      if (name === "addFeature") return { id: "feat-1", name: "x" };
      if (name === "addUnknown") return { id: "unk-1" };
      if (name === "exportSpecPack") return { data: { path: "/tmp/x" }, summary: "ok" };
      return { id: "p" };
    };
  return {
    calls,
    handlers: {
      openProject: record("openProject"),
      listProjects: record("listProjects"),
      getProject: record("getProject"),
      updateProject: record("updateProject"),
      addEvidence: record("addEvidence"),
      listEvidence: record("listEvidence"),
      showEvidence: record("showEvidence"),
      addClaim: record("addClaim"),
      listClaims: record("listClaims"),
      searchClaims: record("searchClaims"),
      selectClaims: record("selectClaims"),
      addFeature: record("addFeature"),
      listFeatures: record("listFeatures"),
      addUnknown: record("addUnknown"),
      listUnknowns: record("listUnknowns"),
      resolveUnknown: record("resolveUnknown"),
      addObligation: record("addObligation"),
      listObligations: record("listObligations"),
      closeObligation: record("closeObligation"),
      reopenObligation: record("reopenObligation"),
      advanceLoop: record("advanceLoop"),
      startBuilder: record("startBuilder"),
      awaitBuilder: record("awaitBuilder"),
      startBuild: record("startBuild"),
      runCheck: record("runCheck"),
      loopStatus: record("loopStatus"),
      exportSpecPack: record("exportSpecPack"),
    },
  };
}

test("注册 9 个工具且名字符合约定", () => {
  const { handlers } = fakeHandlers();
  const definitions = buildToolDefinitions(handlers, () => undefined);
  assert.equal(definitions.length, 9);
  assert.deepEqual(
    definitions.map((item) => item.name),
    Object.values(TOOL_NAMES),
  );
  for (const definition of definitions) {
    assert.equal(typeof definition.description, "string");
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.output.schema.type, "object");
    assert.equal(typeof definition.execute, "function");
  }
});

test("projectId 省略时用会话记忆；都没有则返回 project-not-found", async () => {
  const { handlers, calls } = fakeHandlers();
  const definitions = buildToolDefinitions(handlers, () => "remembered");
  const evidence = definitions.find((item) => item.name === TOOL_NAMES.evidence);
  const ok = await evidence.execute({ action: "list" }, { agent: { id: "s1" } });
  assert.equal(ok.ok, true);
  assert.equal(calls.at(-1)?.[1][0], "remembered");

  const definitions2 = buildToolDefinitions(handlers, () => undefined);
  const evidence2 = definitions2.find((item) => item.name === TOOL_NAMES.evidence);
  const missing = await evidence2.execute({ action: "list" }, { agent: { id: "s1" } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "project-not-found");
});

test("open 缺 title 返回 invalid-input，不抛异常", async () => {
  const { handlers } = fakeHandlers();
  const definitions = buildToolDefinitions(handlers, () => undefined);
  const projectTool = definitions.find((item) => item.name === TOOL_NAMES.project);
  const result = await projectTool.execute({ action: "open" }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-input");
  assert.match(result.error.hint, /description/);
});

test("未知 action 返回 invalid-input", async () => {
  const { handlers } = fakeHandlers();
  const definitions = buildToolDefinitions(handlers, () => "p");
  const claim = definitions.find((item) => item.name === TOOL_NAMES.claim);
  const result = await claim.execute({ action: "explode" }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-input");
});

test("错误映射：未知 code 落到 internal，已知 code 带 hint", () => {
  const unknown = toToolError(new Error("boom"));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "internal");
  assert.equal(unknown.error.hint, undefined);

  const known = toToolError(Object.assign(new Error("x"), { code: "project-not-found" }));
  assert.equal(known.error.code, "project-not-found");
  assert.match(String(known.error.hint), /case_project/);
});

test("select 传空数组时由 actions 报错（工具层不吞）", async () => {
  const { handlers } = fakeHandlers();
  // 覆盖 selectClaims 抛错的分支
  handlers.selectClaims = () => {
    throw Object.assign(new Error("claimIds 不能为空"), { code: "invalid-input" });
  };
  const definitions = buildToolDefinitions(handlers, () => "p");
  const claim = definitions.find((item) => item.name === TOOL_NAMES.claim);
  const result = await claim.execute({ action: "select", claimIds: [] }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-input");
});
