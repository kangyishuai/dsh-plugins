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
  tool.__store = store;
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

/** 1x1 透明 PNG：图片路径验证 data: URL 解码。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("多类型：publish markdown/json/csv，read 回文本，kind 出现在结果里", async () => {
  for (const item of [
    { kind: "markdown", content: "# 标题\n正文" },
    { kind: "json", content: '{"a":1}' },
    { kind: "csv", content: "a,b\n1,2\n" },
  ]) {
    const created = await tool.execute({ action: "publish", title: `T ${item.kind}`, ...item });
    assert.equal(created.ok, true);
    assert.equal(created.kind, item.kind);
    const read = await tool.execute({ action: "read", id: created.id });
    assert.equal(read.kind, item.kind);
    assert.equal(read.text, item.content);
    assert.equal(read.html, undefined);
  }
});

test("图片：data: URL 解码后按原字节落盘，read 给带版本的 URL", async () => {
  const content = `data:image/png;base64,${PNG_BASE64}`;
  const created = await tool.execute({ action: "publish", title: "Chart", kind: "image", content });
  assert.equal(created.ok, true);
  assert.equal(created.kind, "image");
  const meta = await tool.__store.readMeta(created.id);
  assert.equal(meta.kind, "image");
  assert.equal(meta.mime, "image/png");
  assert.equal(meta.versions[0].bytes, Buffer.from(PNG_BASE64, "base64").length);
  const read = await tool.execute({ action: "read", id: created.id });
  assert.equal(read.ok, true);
  assert.equal(read.kind, "image");
  assert.equal(read.text, "");
  assert.match(read.url, /\?v=1$/u);
});

test("图片：裸 base64 需要 mime；非法内容与未知类型报错", async () => {
  const bare = await tool.execute({
    action: "publish",
    kind: "image",
    content: PNG_BASE64,
    mime: "image/png",
  });
  assert.equal(bare.ok, true);
  const invalid = await tool.execute({
    action: "publish",
    kind: "image",
    content: "not-base64!!!",
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /base64/u);
  const unknownKind = await tool.execute({ action: "publish", kind: "xls", content: "a" });
  assert.equal(unknownKind.ok, false);
  assert.equal(unknownKind.code, "artifacts/unsupported-kind");
});

test("归属：sessionId/toolCallId 从 exec 推导，projectId/threadId 由调用方给", async () => {
  const created = await tool.execute(
    { action: "publish", title: "Owned", html: "<p>o</p>", projectId: "proj-1", threadId: "t-1" },
    { agent: { id: "sess-1" }, callId: "call-1" },
  );
  assert.equal(created.ok, true);
  const meta = await tool.__store.readMeta(created.id);
  assert.equal(meta.projectId, "proj-1");
  assert.equal(meta.sessionId, "sess-1");
  assert.equal(meta.threadId, "t-1");
  assert.deepEqual(meta.source, { sessionId: "sess-1", toolCallId: "call-1", via: "tool" });

  const appended = await tool.execute(
    { action: "append", id: created.id, html: "<p>o2</p>" },
    { agent: { id: "sess-2" }, callId: "call-2" },
  );
  assert.equal(appended.ok, true);
  const after = await tool.__store.readMeta(created.id);
  // meta 记首次产生者；版本记各自来源。
  assert.equal(after.sessionId, "sess-1");
  assert.deepEqual(after.versions[1].source, {
    sessionId: "sess-2",
    toolCallId: "call-2",
    via: "tool",
  });
});

test("list 支持 projectId / kind / title 过滤，并返回 count 与 summary", async () => {
  const a = await tool.execute(
    { action: "publish", title: "Alpha report", html: "<p>a</p>", projectId: "proj-list" },
    { agent: { id: "s" } },
  );
  await tool.execute(
    {
      action: "publish",
      title: "Beta notes",
      kind: "markdown",
      content: "# b",
      projectId: "proj-list",
    },
    { agent: { id: "s" } },
  );
  await tool.execute({
    action: "publish",
    title: "Elsewhere",
    html: "<p>e</p>",
    projectId: "other",
  });

  const byProject = await tool.execute({ action: "list", projectId: "proj-list" });
  assert.equal(byProject.ok, true);
  assert.equal(byProject.artifacts.length, 2);
  assert.equal(byProject.count, 2);
  assert.equal(byProject.summary.count, 2);
  assert.ok(byProject.summary.bytes > 0);

  const byKind = await tool.execute({ action: "list", projectId: "proj-list", kind: "markdown" });
  assert.deepEqual(
    byKind.artifacts.map((/** @type {any} */ row) => row.kind),
    ["markdown"],
  );

  const byTitle = await tool.execute({ action: "list", projectId: "proj-list", title: "alpha" });
  assert.deepEqual(
    byTitle.artifacts.map((/** @type {any} */ row) => row.id),
    [a.id],
  );

  const empty = await tool.execute({ action: "list", projectId: "proj-empty" });
  assert.deepEqual(empty.artifacts, []);
});

test("错误码：超限与归档后追加都带稳定 code", async () => {
  const huge = await tool.execute({ action: "publish", html: "x".repeat(3 * 1024 * 1024) });
  assert.equal(huge.ok, false);
  assert.equal(huge.code, "artifacts/too-large");
  const created = await tool.execute({ action: "publish", title: "Frozen", html: "<p>f</p>" });
  await tool.__store.archive(created.id, true);
  const appended = await tool.execute({ action: "append", id: created.id, html: "<p>x</p>" });
  assert.equal(appended.ok, false);
  assert.equal(appended.code, "artifacts/archived");
});

test("renderToolOutput：list 带类型与汇总，read 给正文", async () => {
  const { renderToolOutput } = await import("../lib/tool.js");
  const listed = renderToolOutput(
    {},
    {
      ok: true,
      action: "list",
      count: 1,
      summary: { count: 1, bytes: 12 },
      artifacts: [{ id: "a-1", title: "T", kind: "json", latest: 1, bytes: 12 }],
    },
  );
  assert.match(listed[0].text, /1 artifact\(s\), 12 B total/u);
  assert.match(listed[0].text, /json/u);
  const read = renderToolOutput({}, { ok: true, action: "read", id: "a-1", text: "# body" });
  assert.equal(read[0].text, "# body");
  const published = renderToolOutput(
    {},
    {
      ok: true,
      action: "publish",
      id: "a-1",
      title: "T",
      version: 1,
      bytes: 5,
      kind: "csv",
      url: "u",
    },
  );
  assert.match(published[0].text, /csv/u);
});
