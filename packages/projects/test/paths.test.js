// @ts-check
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveDataRoot } from "../lib/paths.js";

test("paths: 配置 > DSH_HOME > ~/.dsh（桌面无 DSH_HOME 的回归）", () => {
  assert.equal(
    resolveDataRoot({ dataRoot: "/custom/root" }, { DSH_HOME: "/srv/dsh-env" }, "/home/me"),
    "/custom/root",
  );
  assert.equal(
    resolveDataRoot({ dataRoot: "  " }, { DSH_HOME: "/srv/dsh-env" }, "/home/me"),
    "/srv/dsh-env/projects",
  );
  assert.equal(
    resolveDataRoot({}, { DSH_HOME: "/srv/dsh-env" }, "/home/me"),
    "/srv/dsh-env/projects",
  );
  // 2026-11-18 真机故障：桌面版进程没有任何 DSH_HOME，旧实现直接抛错。
  assert.equal(resolveDataRoot(undefined, {}, "/home/me"), "/home/me/.dsh/projects");
  assert.equal(resolveDataRoot({}, { DSH_HOME: "  " }, "/home/me"), "/home/me/.dsh/projects");
});

test("paths: 配置里的相对路径按 cwd 解析", () => {
  assert.equal(resolveDataRoot({ dataRoot: "rel" }, {}, "/home/me"), resolve("rel"));
});
