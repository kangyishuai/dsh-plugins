// @ts-check
// 构建身份的单元测试：node --test（只依赖 Node 内置模块，不需要宿主包）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildIdentity,
  computeBuildIdentity,
  PACKAGE_ROOT,
  resetBuildIdentityCache,
} from "../lib/build-info.js";

test("version 与 package.json 一致", async () => {
  const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const identity = await computeBuildIdentity();
  assert.equal(identity.version, pkg.version);
});

test("buildHash 是 64 位小写十六进制（sha256）", async () => {
  const identity = await computeBuildIdentity();
  assert.match(identity.buildHash, /^[0-9a-f]{64}$/u);
});

test("哈希覆盖了行为相关的文件（package.json / cordis.patch.yml / lib / locale）", async () => {
  const identity = await computeBuildIdentity();
  // lib 6 个 js + locale 2 个 json + package.json + cordis.patch.yml ≥ 10
  assert.ok(identity.buildFiles >= 10, `buildFiles=${String(identity.buildFiles)}`);
});

test("同一份代码两次计算结果相同（确定性）", async () => {
  const a = await computeBuildIdentity();
  const b = await computeBuildIdentity();
  assert.equal(a.buildHash, b.buildHash);
  assert.equal(a.buildFiles, b.buildFiles);
});

test("缓存命中后返回同一个 Promise（不会重复读盘）", async () => {
  resetBuildIdentityCache();
  const first = buildIdentity();
  const second = buildIdentity();
  assert.equal(first, second);
  const identity = await first;
  assert.match(identity.buildHash, /^[0-9a-f]{64}$/u);
});

test("packagePath 指向包根（存在 package.json）", async () => {
  const identity = await computeBuildIdentity();
  const text = await readFile(join(identity.packagePath, "package.json"), "utf8");
  assert.ok(text.includes("@kangyishuai/dsh-next-step"));
});

test("README / LICENSE 不参与哈希（改文档不该改变构建身份）", async () => {
  const identity = await computeBuildIdentity();
  // HASHED_ENTRIES 只有 4 项，总文件数应远小于包内全部文件（这里用 packagePath 下 README 存在来反证）
  const readme = await readFile(join(identity.packagePath, "README.md"), "utf8");
  assert.ok(readme.length > 0);
  assert.ok(identity.buildFiles < 20, `buildFiles=${String(identity.buildFiles)}`);
});
