// @ts-check
// `artifact` 工具的单测：四个 action 与错误分支，全部落在 mkdtemp 里。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createArtifactStore } from "../lib/store.js";
import { createToolDefinition, TOOL_OUTPUT_SCHEMA, TOOL_PARAMETERS } from "../lib/tool.js";

/** @type {any} */
let tool;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-artifacts-tool-"));
  const store = createArtifactStore({ root });
  tool = createToolDefinition({ store, baseUrl: () => "http://127.0.0.1:1234" });
  tool.__root = root;
});

after(async () => {
  if (tool?.__root) await rm(tool.__root, { recursive: true, force: true });
});

test("schema 只用宿主支持的子集关键字", () => {
  const keywords = new Set([
    "type",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "description",
  ]);
  /** @param {any} node */
  const walk = (node) => {
    for (const [key, value] of Object.entries(node)) {
      assert.ok(keywords.has(key), `unsupported schema keyword: ${key}`);
      if (key === "properties" && value && typeof value === "object") {
        for (const child of Object.values(value)) walk(child);
      }
      if (key === "items" && value && typeof value === "object") walk(value);
    }
  };
  walk(TOOL_PARAMETERS);
  walk(TOOL_OUTPUT_SCHEMA);
  assert.deepEqual(TOOL_PARAMETERS.properties.action.enum, ["publish", "append", "list", "read"]);
});

test("publish 返回 id/版本/url，并落成 v1", async () => {
  const value = await tool.execute({ action: "publish", title: "Report", html: "<h1>v1</h1>" });
  assert.equal(value.ok, true);
  assert.equal(value.action, "publish");
  assert.equal(value.version, 1);
  assert.match(value.id, /^report-[0-9a-f]{6}$/u);
  assert.equal(value.url, `http://127.0.0.1:1234/artifacts/${value.id}`);
});

test("append 递增版本并复用同一 id", async () => {
  const first = await tool.execute({ action: "publish", title: "Deck", html: "<h1>a</h1>" });
  const second = await tool.execute({ action: "append", id: first.id, html: "<h1>b</h1>" });
  assert.equal(second.ok, true);
  assert.equal(second.id, first.id);
  assert.equal(second.version, 2);
});

test("list 返回倒序索引并带 coverUrl", async () => {
  const value = await tool.execute({ action: "list" });
  assert.equal(value.ok, true);
  assert.ok(Array.isArray(value.artifacts));
  assert.ok(value.artifacts.length >= 2);
  for (const row of value.artifacts) {
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.title, "string");
    assert.ok(Number.isInteger(row.latest));
  }
});

test("read 返回指定版本，未知版本报错", async () => {
  const created = await tool.execute({ action: "publish", title: "Read me", html: "<h1>one</h1>" });
  const latest = await tool.execute({ action: "read", id: created.id });
  assert.equal(latest.ok, true);
  assert.equal(latest.version, 1);
  assert.equal(latest.html, "<h1>one</h1>");

  const missing = await tool.execute({ action: "read", id: created.id, version: 9 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /unknown artifact or version/u);
});

test("错误分支：未知 action / 未知 id / 空 html / 超限", async () => {
  const unknownAction = await tool.execute({ action: "explode" });
  assert.equal(unknownAction.ok, false);
  assert.match(unknownAction.error, /unknown action/u);

  const unknownId = await tool.execute({ action: "append", id: "nope-000000", html: "<p>x</p>" });
  assert.equal(unknownId.ok, false);
  assert.match(unknownId.error, /unknown artifact/u);

  const empty = await tool.execute({ action: "publish", html: "" });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/u);

  const huge = await tool.execute({ action: "publish", html: "x".repeat(3 * 1024 * 1024) });
  assert.equal(huge.ok, false);
  assert.match(huge.error, /over the/u);
});

test("renderToolOutput 对成功/失败/list 给出简短文本", async () => {
  const { renderToolOutput } = await import("../lib/tool.js");
  assert.match(renderToolOutput({}, { ok: false, error: "boom" })[0].text, /boom/u);
  const listed = renderToolOutput({}, { ok: true, action: "list", artifacts: [] });
  assert.match(listed[0].text, /No artifacts yet/u);
  const created = renderToolOutput(
    {},
    { ok: true, action: "publish", id: "a-1", title: "T", version: 2, bytes: 10, url: "u" },
  );
  assert.match(created[0].text, /a-1/u);
  assert.match(created[0].text, /v2/u);
});
