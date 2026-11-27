// @ts-check
// 路由单测：假 req/res，不启真实 server。覆盖鉴权、方法、404 与两个 GET 资源。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createRouteHandler } from "../lib/route.js";
import { createArtifactStore } from "../lib/store.js";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createArtifactStore>} */
let store;
/** @type {string} */
let artifactId;

/**
 * 造一个最小 req/res：res 记录状态码、响应头与 body。
 * @param {{ method?: string, url?: string }} input
 */
function fakeExchange({ method = "GET", url = "/artifacts/x" } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  const res = {
    statusCode: 0,
    body: "",
    setHeader(/** @type {string} */ key, /** @type {string} */ value) {
      headers[key.toLowerCase()] = value;
    },
    end(/** @type {string} */ body = "") {
      res.body = body ?? "";
    },
  };
  return { req: { method, url }, res, headers };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-artifacts-route-"));
  store = createArtifactStore({ root });
  const meta = await store.create({ title: "Route demo", html: "<h1>hello</h1>" });
  artifactId = meta.id;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("未认证：requestRejection 的码原样返回", async () => {
  const handler = createRouteHandler({
    store,
    connection: () => ({ requestRejection: () => 401 }),
  });
  const { req, res } = fakeExchange({ url: `/artifacts/${artifactId}` });
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, "");
});

test("非 GET/HEAD：405 且带 allow", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res, headers } = fakeExchange({ method: "POST", url: `/artifacts/${artifactId}` });
  await handler(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(headers.allow, "GET, HEAD");
});

test("GET 页面：200 + CSP + nosniff + no-store + 版本头", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res, headers } = fakeExchange({ url: `/artifacts/${artifactId}` });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(headers["content-type"], /text\/html/u);
  assert.match(headers["content-security-policy"], /default-src 'none'/u);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["cache-control"], "private, no-store");
  assert.equal(headers["x-artifact-version"], "1");
  assert.equal(res.body, "<h1>hello</h1>");
});

test("GET 指定版本：?v=1 命中，?v=9 不存在", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const hit = fakeExchange({ url: `/artifacts/${artifactId}?v=1` });
  await handler(hit.req, hit.res);
  assert.equal(hit.res.statusCode, 200);

  const miss = fakeExchange({ url: `/artifacts/${artifactId}?v=9` });
  await handler(miss.req, miss.res);
  assert.equal(miss.res.statusCode, 404);
});

test("HEAD 返回同样的头但没有 body", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res, headers } = fakeExchange({ method: "HEAD", url: `/artifacts/${artifactId}` });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(headers["x-artifact-version"], "1");
  assert.equal(res.body, "");
});

test("封面：200 + image/svg+xml；未知 id 404；多余子路径 404", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const cover = fakeExchange({ url: `/artifacts/${artifactId}/cover.svg` });
  await handler(cover.req, cover.res);
  assert.equal(cover.res.statusCode, 200);
  assert.match(cover.headers["content-type"], /image\/svg\+xml/u);
  assert.match(cover.res.body, /^<svg/u);

  const unknown = fakeExchange({ url: "/artifacts/nope-000000/cover.svg" });
  await handler(unknown.req, unknown.res);
  assert.equal(unknown.res.statusCode, 404);

  const nested = fakeExchange({ url: `/artifacts/${artifactId}/x/y` });
  await handler(nested.req, nested.res);
  assert.equal(nested.res.statusCode, 404);
});

test("空 id 与根路径都是 404", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const empty = fakeExchange({ url: "/artifacts/" });
  await handler(empty.req, empty.res);
  assert.equal(empty.res.statusCode, 404);

  const other = fakeExchange({ url: "/elsewhere" });
  await handler(other.req, other.res);
  assert.equal(other.res.statusCode, 404);
});

test("handler 内部异常被吞成 500，不冒泡", async () => {
  const broken = {
    read: async () => {
      throw new Error("disk on fire");
    },
  };
  const handler = createRouteHandler({
    store: /** @type {any} */ (broken),
    connection: () => undefined,
  });
  const { req, res } = fakeExchange({ url: "/artifacts/anything" });
  await handler(req, res);
  assert.equal(res.statusCode, 500);
});

/** 1x1 透明 PNG：验证图片走原始字节，不被 UTF-8 转码破坏。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("多类型 Content-Type：markdown/csv 走 text/plain，json 走 application/json", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const cases = [
    { kind: "markdown", content: "# hi", type: /text\/plain/u, ext: "md" },
    { kind: "csv", content: "a,b\n1,2\n", type: /text\/plain/u, ext: "csv" },
    { kind: "json", content: '{"a":1}', type: /application\/json/u, ext: "json" },
  ];
  for (const item of cases) {
    const meta = await store.create({
      title: `Route ${item.kind}`,
      kind: item.kind,
      content: item.content,
    });
    const { req, res, headers } = fakeExchange({ url: `/artifacts/${meta.id}` });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.match(headers["content-type"], item.type);
    assert.equal(headers["x-artifact-kind"], item.kind);
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(res.body, item.content);
    // 非 html 类型不给 html 的 CSP（那条 CSP 会禁掉页面样式，对文本没意义）。
    assert.equal(headers["content-security-policy"], undefined);
  }
});

test("图片：送原始字节，Content-Type 来自 MIME，并带沙箱 CSP", async () => {
  const meta = await store.create({ title: "Route image", kind: "image", data: PNG });
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res, headers } = fakeExchange({ url: `/artifacts/${meta.id}` });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(headers["content-type"], "image/png");
  assert.equal(headers["x-artifact-kind"], "image");
  assert.match(headers["content-security-policy"], /sandbox/u);
  assert.deepEqual(res.body, PNG);
});

test("download=1：加 attachment 并带版本与扩展名", async () => {
  const meta = await store.create({ title: "Export", kind: "markdown", content: "# x" });
  await store.append(meta.id, { content: "# y" });
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res, headers } = fakeExchange({ url: `/artifacts/${meta.id}?v=1&download=1` });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(headers["content-disposition"], /^attachment;/u);
  assert.match(headers["content-disposition"], /v1\.md/u);
  assert.equal(res.body, "# x");
});

test("归档的 artifact 仍可读（保留只读），但不再能追加", async () => {
  const meta = await store.create({ title: "Archived", html: "<h1>frozen</h1>" });
  await store.archive(meta.id, true);
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res, headers } = fakeExchange({ url: `/artifacts/${meta.id}` });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "<h1>frozen</h1>");
  assert.equal(headers["x-artifact-version"], "1");
});

test("编码斜杠 / 穿越 / 点开头 id 一律 400，绝不落进文件系统", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const bad = [
    "/artifacts/..%2Foutside",
    "/artifacts/%2e%2e%2foutside",
    "/artifacts/foo%2Fbar",
    "/artifacts/foo%5Cbar",
    "/artifacts/.hidden",
    "/artifacts/..%2F..%2Fetc%2Fpasswd",
  ];
  for (const url of bad) {
    const { req, res } = fakeExchange({ url });
    await handler(req, res);
    assert.equal(res.statusCode, 400, `${url} should be 400, got ${res.statusCode}`);
    assert.equal(res.body, "bad artifact id");
  }
  // 正常 id 不受影响：未知 id 仍是 404（不是 400）。
  const { req, res } = fakeExchange({ url: "/artifacts/nope-000000" });
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test("AUD-ARTIFACTS-04：畸形百分号编码 → 400，且不泄露内部错误文本", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  for (const url of ["/artifacts/%", "/artifacts/%E0%A4%A", "/artifacts/%ZZ", "/artifacts/ok%Z"]) {
    const { req, res } = fakeExchange({ url });
    await handler(req, res);
    assert.equal(res.statusCode, 400, `${url} should be 400, got ${res.statusCode}`);
    assert.doesNotMatch(res.body, /URI|route error|malformed|decode/iu);
  }
});

test("AUD-ARTIFACTS-05：?v= 存在但不是正整数 → 400，不静默回落最新版", async () => {
  const handler = createRouteHandler({ store, connection: () => undefined });
  const bad = ["abc", "1.5", "0", "-1", "", "1e2", "2abc", " 1"];
  for (const value of bad) {
    const { req, res } = fakeExchange({
      url: `/artifacts/${artifactId}?v=${encodeURIComponent(value)}`,
    });
    await handler(req, res);
    assert.equal(res.statusCode, 400, `?v=${JSON.stringify(value)} should be 400`);
    assert.doesNotMatch(res.body, /<h1>hello<\/h1>/u, "must not silently serve the latest version");
  }
  // 合法版本不受影响。
  const ok = fakeExchange({ url: `/artifacts/${artifactId}?v=1` });
  await handler(ok.req, ok.res);
  assert.equal(ok.res.statusCode, 200);
});

test("AUD-ARTIFACTS-02：版本文件被篡改 → 500 + 明确文案，不送坏正文", async () => {
  const meta = await store.create({ title: "Tampered route", html: "<h1>good</h1>" });
  await writeFile(join(store.root, meta.id, "v1.html"), "<h1>evil payload</h1>", "utf8");
  const handler = createRouteHandler({ store, connection: () => undefined });
  const { req, res } = fakeExchange({ url: `/artifacts/${meta.id}` });
  await handler(req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, "artifact version corrupted");
  assert.doesNotMatch(res.body, /evil|<h1>/u);
});
