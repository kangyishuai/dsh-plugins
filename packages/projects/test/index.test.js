// @ts-check
// 包清单自检：不 import 宿主包，纯 Node 可跑。
// 拦「改了 patch 路径 / 漏了 files 白名单条目」这类发版才会暴露的问题。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

describe("package manifest", () => {
  it("包名与发布配置符合仓库约定", () => {
    assert.equal(manifest.name, "@kangyishuai/dsh-projects");
    assert.equal(manifest.type, "module");
    assert.equal(manifest.publishConfig?.access, "public");
    assert.equal(manifest.repository?.directory, "packages/projects");
  });

  it("dsh.bundle.patch 指向的文件存在", () => {
    const patch = manifest.dsh?.bundle?.patch;
    assert.equal(typeof patch, "string");
    assert.ok(existsSync(join(PKG_DIR, patch)), `缺失 ${patch}`);
  });

  it("cordis.patch.yml 的 id 与包名一致", () => {
    const patch = readFileSync(join(PKG_DIR, "cordis.patch.yml"), "utf8");
    assert.match(patch, /id:\s*projects/u);
    assert.match(patch, /name:\s*"@kangyishuai\/dsh-projects"/u);
  });

  it("files 白名单里的每一项都存在（npm pack 只带这些）", () => {
    for (const entry of manifest.files ?? []) {
      assert.ok(existsSync(join(PKG_DIR, entry)), `files 里的 ${entry} 不存在`);
    }
  });

  it("不把宿主包写进 dependencies / peerDependencies", () => {
    const all = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
    };
    const hostPkgs = Object.keys(all).filter((name) => name.startsWith("@deepseek-ai/"));
    assert.deepEqual(hostPkgs, [], `不允许把宿主包声明成依赖：${hostPkgs.join(", ")}`);
  });

  it("不声明 engines.dsh（DSH 预发布阶段 semver 范围不可靠）", () => {
    assert.equal(manifest.engines?.dsh, undefined);
  });
});
