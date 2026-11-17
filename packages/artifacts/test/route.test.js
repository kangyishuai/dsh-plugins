// @ts-check
// 路由单测：假 req/res，不启真实 server。覆盖鉴权、方法、404 与两个 GET 资源。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
