// @ts-check
// 单元测试：tools.js 的工具面（名称、schema 形状、错误映射、projectId 兜底）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildToolDefinitions, TOOL_NAMES, toToolError } from "../lib/tools.js";

/** 记录调用的假 handlers。 */
function fakeHandlers() {
  /** @type {Array<[string, any[]]>} */
  /** @type {any[]} */
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
      overview: record("overview"),
      runCycle: record("runCycle"),
      closePreview: record("closePreview"),
      closeProject: record("closeProject"),
      exportReport: record("exportReport"),
      startBuilder: record("startBuilder"),
      awaitBuilder: record("awaitBuilder"),
      awaitLogin: record("awaitLogin"),
      inspectApp: record("inspectApp"),
      startBuild: record("startBuild"),
      runCheck: record("runCheck"),
      loopStatus: record("loopStatus"),
      exportSpecPack: record("exportSpecPack"),
    },
  };
}

test("注册 11 个工具且名字符合约定", () => {
  const { handlers } = fakeHandlers();
  const definitions = buildToolDefinitions(handlers, () => undefined);
  assert.equal(definitions.length, 11);
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

test("cycle 只给 cwd 时不再起 builder（cwd 是构建目录）", async () => {
  /** @type {any[]} */
  const calls = [];
  const handlers = {
    getProject: async () => ({ project: { id: "p" }, capabilities: {} }),
    runCycle: async (/** @type {any} */ _id, /** @type {any} */ input) => {
      calls.push(input);
      return { loop: { closed: 0, open: 0, rounds: [] }, summary: "ok" };
    },
    listProjects: async () => [],
    diagnose: async () => ({}),
  };
  const definitions = buildToolDefinitions(handlers, () => "p");
  const build = definitions.find((item) => item.name === "case_build");
  await build.execute(
    { action: "cycle", projectId: "p", command: 'node -e "0"', cwd: "/tmp/impl" },
    {},
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].builder, undefined, "只给 cwd 不应该起 builder");
  await build.execute(
    {
      action: "cycle",
      projectId: "p",
      command: 'node -e "0"',
      cwd: "/tmp/impl",
      prompt: "写个 demo",
    },
    {},
  );
  assert.ok(
    calls[1].builder && calls[1].builder.prompt === "写个 demo",
    "显式 prompt 才起 builder",
  );
});

test("builder 会话不能写账本（builder-readonly）", async () => {
  /** @type {any[]} */
  const calls = [];
  const handlers = {
    listProjects: async () => {
      calls.push("list");
      return [];
    },
    openProject: async () => {
      calls.push("open");
      return { id: "p" };
    },
    isBuilderSession: (/** @type {any} */ id) => id === "session-builder-1",
    getProject: async () => ({ project: { id: "p" } }),
  };
  const definitions = buildToolDefinitions(handlers, () => "p");
  const project = definitions.find((item) => item.name === "case_project");
  const asBuilder = { agent: { id: "session-builder-1" } };
  const asOwner = { agent: { id: "session-owner" } };

  const denied = await project.execute({ action: "open", title: "X" }, asBuilder);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "builder-readonly");
  assert.equal(calls.includes("open"), false, "被拒时不应真的建项目");

  const allowed = await project.execute({ action: "open", title: "X" }, asOwner);
  assert.equal(allowed.ok, true);
  assert.equal(calls.includes("open"), true);
});

test("没有 isBuilderSession 实现时守卫不误伤", async () => {
  const handlers = { listProjects: async () => [], openProject: async () => ({ id: "p" }) };
  const definitions = buildToolDefinitions(handlers, () => "p");
  const project = definitions.find((item) => item.name === "case_project");
  const result = await project.execute({ action: "open", title: "X" }, { agent: { id: "s1" } });
  assert.equal(result.ok, true);
});
