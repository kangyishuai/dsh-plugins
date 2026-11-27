// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { projectCwd, projectWorkspaceDir, resolveDataRoot, workspaceKey } from "../lib/paths.js";
import { ProjectStore } from "../lib/store.js";

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

// —— AUD-PROJ-01：会话 cwd 的单一出口（无目录项目绝不能把数据根当 cwd） ——

test("paths: workspaceKey 只留单段安全字符，空输入不返回空串", () => {
  assert.equal(workspaceKey("prj_abc-123"), "prj_abc-123");
  assert.equal(workspaceKey("../../etc"), "etc");
  assert.equal(workspaceKey("a/b"), "ab");
  assert.equal(workspaceKey(""), "project");
  assert.equal(workspaceKey(undefined), "project");
});

test("paths: projectWorkspaceDir 永远在 <dataRoot>/workspaces 下（容忍尾斜杠）", () => {
  assert.equal(projectWorkspaceDir("/data/projects", "prj_1"), "/data/projects/workspaces/prj_1");
  assert.equal(projectWorkspaceDir("/data/projects/", "prj_1"), "/data/projects/workspaces/prj_1");
  assert.equal(
    projectWorkspaceDir("/data/projects", "../../x"),
    "/data/projects/workspaces/x",
    "非法 id 不能逃出 workspaces",
  );
});

test("真实 store：无目录项目的 cwd 是专用工作区，绝不是数据根", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-projects-paths-"));
  try {
    const store = new ProjectStore({ root }).load();
    const project = store.createProject("no-dirs");
    const cwd = projectCwd(project, root);
    assert.equal(cwd, join(root, "workspaces", project.id));
    assert.notEqual(cwd, root);
    // 绑了目录就用第一个目录
    const withDirs = store.createProject("with-dirs", { dirs: ["/tmp/some-repo"] });
    assert.equal(projectCwd(withDirs, root), "/tmp/some-repo");
    // dirs 里的空串不能当 cwd（旧实现会直接返回空串）
    assert.equal(projectCwd({ id: "p2", dirs: ["", "  "] }, root), `${root}/workspaces/p2`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
