// @ts-check
// 契约对账（静态扫描，不 import service.js——它依赖只在宿主里存在的包）：
//   1) service.js 里的 async 方法集 == declareRemote 集合 == LIBRARY_METHODS；
//   2) docs/plugin-conventions.md §8.3 的方法表：每个方法一行，且**列出的每个参数名**在源码里真实存在；
//   3) §8.4 的错误码表覆盖代码里会发出的全部 `artifacts/*` code；
//   4) 几个关键返回字段（remove.trashRoot / latest.versionSource / latest.totalBytes / trash.trashKey）真的在返回里；
//   5) version() 报的包名/版本与 package.json 一致（防止文档/探针说谎）。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTRACT, createArtifactLibrary, LIBRARY_METHODS } from "../lib/library.js";
import { createArtifactStore } from "../lib/store.js";

const serviceUrl = new URL("../lib/service.js", import.meta.url);
const libraryUrl = new URL("../lib/library.js", import.meta.url);
const storeUrl = new URL("../lib/store.js", import.meta.url);
const docsUrl = new URL("../../../docs/plugin-conventions.md", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

/**
 * @param {URL} url
 * @returns {Promise<string>}
 */
async function readSource(url) {
  return readFile(url, "utf8");
}

/** @returns {Promise<string>} `§8` 起到底的文档片段 */
async function readContractSection() {
  const docs = await readSource(docsUrl);
  const start = docs.indexOf("## 8. ");
  assert.ok(start >= 0, "docs/plugin-conventions.md should have section 8 (cross-plugin contract)");
  return docs.slice(start);
}

test("service.js：每个 Remote 方法都 declareRemote，且没有多写/漏写", async () => {
  const source = await readSource(serviceUrl);
  /** @type {string[]} */
  const methods = [];
  for (const match of source.matchAll(/^ {2}async (\w+)\(/gmu)) methods.push(String(match[1]));
  /** @type {string[]} */
  const declared = [];
  for (const match of source.matchAll(/declareRemote\(ArtifactsService, "(\w+)"\)/gu))
    declared.push(String(match[1]));
  // 生产代码用 `for (const method of LIBRARY_METHODS) declareRemote(...)`；两种写法都要能被认出来。
  const looped =
    /for \(const method of LIBRARY_METHODS\) declareRemote\(ArtifactsService, method\)/u.test(
      source,
    );
  const declaredSet = new Set(looped ? [...methods] : declared);
  assert.deepEqual(
    new Set(methods),
    declaredSet,
    `Remote methods and declareRemote calls must match: methods=${methods.join(",")} declared=${[...declaredSet].join(",")}`,
  );
  assert.deepEqual(new Set(methods), new Set(LIBRARY_METHODS));
  assert.equal(new Set(declared).size, declared.length, "duplicate declareRemote");
});

test("§8.3 方法表：每个方法一行，表里列的每个参数名都在源码里存在", async () => {
  const section = await readContractSection();
  const source = [await readSource(libraryUrl), await readSource(storeUrl)].join("\n");
  const tableStart = section.indexOf("### 8.3");
  const tableEnd = section.indexOf("### 8.4");
  assert.ok(tableStart >= 0 && tableEnd > tableStart, "§8.3 must exist before §8.4");
  const methodTable = section.slice(tableStart, tableEnd);
  /** @type {Map<string, string[]>} */
  const documented = new Map();
  for (const line of methodTable.split("\n")) {
    const match = /^\|\s*`artifacts\/(\w+)`\s*\|([^|]*)\|/u.exec(line);
    if (match === null) continue;
    /** @type {string[]} */
    const params = [];
    for (const param of match[2].matchAll(/`([A-Za-z][A-Za-z0-9]*)\??`/gu)) params.push(param[1]);
    documented.set(match[1], params);
  }
  for (const method of LIBRARY_METHODS) {
    assert.ok(documented.has(method), `§8.3 must document artifacts/${method}`);
  }
  assert.deepEqual([...documented.keys()].sort(), [...LIBRARY_METHODS].sort());
  for (const [method, params] of documented) {
    for (const param of params) {
      if (["string", "number", "boolean", "null", "Row", "Summary", "epoch", "ms"].includes(param))
        continue;
      assert.match(
        source,
        new RegExp(`\\b${param}\\b`, "u"),
        `§8.3 documents ${method}'s parameter \`${param}\` but the source never mentions it`,
      );
    }
  }
  assert.match(section, new RegExp(CONTRACT.replace("/", "\\/"), "u"));
});

test("§8.4 错误码表覆盖代码会发出的全部 artifacts/* code", async () => {
  const section = await readContractSection();
  const source = [await readSource(libraryUrl), await readSource(storeUrl)].join("\n");
  /** @type {Set<string>} */
  const codes = new Set();
  for (const match of source.matchAll(/"(artifacts\/[a-z-]+)"/gu)) codes.add(match[1]);
  assert.ok(codes.size >= 6, `expected several error codes, got ${[...codes].join(",")}`);
  for (const code of codes) {
    assert.match(section, new RegExp(code.replace("/", "\\/"), "u"), `§8.4 must document ${code}`);
  }
});

test("关键返回字段真实存在：trashRoot / versionSource / totalBytes / trashKey", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-artifacts-contract-"));
  try {
    const store = createArtifactStore({ root });
    const library = createArtifactLibrary({ store });
    const meta = await store.create({
      title: "Contract",
      html: "<p>v1</p>",
      projectId: "p",
      source: { sessionId: "s", toolCallId: "c", via: "tool" },
    });
    const latest = await library.latest({ id: meta.id });
    assert.equal(typeof latest.totalBytes, "number");
    assert.deepEqual(latest.versionSource, { sessionId: "s", toolCallId: "c", via: "tool" });

    const removed = await library.remove({ projectId: "p", dryRun: true });
    assert.equal(typeof removed.trashRoot, "string");
    assert.equal(removed.restorable, true);

    await library.remove({ projectId: "p" });
    const trash = await library.trash();
    assert.equal(trash.artifacts.length, 1);
    assert.equal(typeof trash.artifacts[0].trashKey, "string");
    assert.ok(trash.artifacts[0].trashedAt > 0);

    const purged = await library.purge({ ids: [trash.artifacts[0].trashKey] });
    assert.deepEqual(purged.purged, [trash.artifacts[0].trashKey]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version() 与 package.json 一致，contract 是 artifacts/2", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-artifacts-contract-"));
  try {
    const store = createArtifactStore({ root });
    const library = createArtifactLibrary({ store });
    const info = await library.version();
    const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
    assert.equal(info.plugin, pkg.name);
    assert.equal(info.packageVersion, pkg.version);
    assert.equal(info.contract, "artifacts/2");
    assert.equal(CONTRACT, "artifacts/2");
    assert.ok(Array.isArray(info.methods) && info.methods.includes("list"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docs/testing/artifacts.md 与真实测试命令不漂移", async () => {
  const testing = await readFile(
    new URL("../../../docs/testing/artifacts.md", import.meta.url),
    "utf8",
  );
  assert.match(testing, /pnpm --filter @kangyishuai\/dsh-artifacts test/u);
  assert.match(testing, /artifacts\/list/u);
});
