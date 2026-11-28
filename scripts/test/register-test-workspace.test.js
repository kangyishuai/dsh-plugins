// @ts-check
// scripts/lib/workspace-register.mjs + scripts/register-test-workspace.mjs 的离线单测。
// 全部在 mkdtemp 临时目录里造 DSH_HOME / 测试工作区，不碰真实 ~/.dsh；
// 覆盖复审要求的行为：空 home 初始化、幂等、realpath 去重、保留既有字段、备份、
// live home 默认拒绝（--allow-live 放行）、dry-run 不写盘、不认识的存储拒绝改写。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  emptyWorkspaceStore,
  isLiveHome,
  registerTestWorkspace,
  WORKSPACE_UNIT,
  WorkspaceRegisterError,
} from "../lib/workspace-register.mjs";

const CLI = join(import.meta.dirname, "..", "register-test-workspace.mjs");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** @type {string[]} */
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "dsh-ws-register-"));
  roots.push(root);
  return root;
}

/** @param {string} root */
function makeHome(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

/** @param {string} root @param {string} [name] */
function makeWorkspace(root, name = "workspace") {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} home */
function storeFile(home) {
  return join(home, "storages", "workspace.json");
}

/** @param {string} home */
function readStore(home) {
  return JSON.parse(readFileSync(storeFile(home), "utf8"));
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** 解析 CLI 最后一行 JSON 摘要。 @param {string} stdout */
function cliSummary(stdout) {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("空 home：按宿主格式初始化 workspace.json，并按 realpath 登记第一条工作区", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const workspace = makeWorkspace(root);
  const now = new Date("2026-11-28T00:00:00.000Z");

  assert.deepEqual(emptyWorkspaceStore(), {
    unit: { name: "workspace", version: 2 },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: null,
    },
    tables: { workspaces: {} },
  });
  assert.deepEqual(emptyWorkspaceStore().unit, { ...WORKSPACE_UNIT });

  const summary = registerTestWorkspace({ home, path: workspace, now });
  assert.equal(summary.registered, true);
  assert.equal(summary.alreadyExisted, false);
  assert.equal(summary.written, true);
  assert.equal(summary.backupFile, null);
  assert.match(summary.id, UUID_RE);
  // macOS 的 /tmp、tmpdir() 是软链：写入/摘要都必须用真实路径（宿主按 realpath 绑会话 cwd）。
  assert.equal(summary.path, realpathSync(workspace));
  assert.equal(summary.title, "workspace");
  // home 同样按 realpath 规范化（macOS 临时目录 /var → /private/var）。
  assert.equal(summary.storeFile, storeFile(realpathSync(home)));

  const store = readStore(home);
  assert.deepEqual(store, {
    unit: { name: "workspace", version: 2 },
    global: {
      initialized: true,
      workspaceIds: [summary.id],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: summary.id,
    },
    tables: {
      workspaces: {
        [summary.id]: {
          path: realpathSync(workspace),
          title: "workspace",
          sessionIds: [],
          createdAt: "2026-11-28T00:00:00.000Z",
          updatedAt: "2026-11-28T00:00:00.000Z",
        },
      },
    },
  });
  // 原子写不残留临时文件；首次初始化没有旧文件，不该有备份。
  assert.deepEqual(readdirSync(join(home, "storages")), ["workspace.json"]);
});

test("幂等：同一目录第二次运行返回同一个 id，不写盘、不改标题、不产生备份", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const workspace = makeWorkspace(root);
  const first = registerTestWorkspace({ home, path: workspace, title: "Rewind UI smoke" });
  const before = readFileSync(storeFile(home), "utf8");

  const second = registerTestWorkspace({ home, path: workspace, title: "另一个标题" });
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.written, false);
  assert.equal(second.dryRun, false);
  assert.equal(second.backupFile, null);
  assert.equal(second.id, first.id);
  assert.equal(second.title, "Rewind UI smoke");
  assert.equal(readFileSync(storeFile(home), "utf8"), before, "幂等路径不应改写文件");
  assert.deepEqual(readdirSync(join(home, "storages")), ["workspace.json"]);
  assert.equal(readStore(home).global.workspaceIds.length, 1);
});

test("按 realpath 去重：软链写法与真实路径只登记一次", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const real = makeWorkspace(root, "real-workspace");
  const link = join(root, "workspace-link");
  symlinkSync(real, link, "dir");

  const viaLink = registerTestWorkspace({ home, path: link });
  assert.equal(viaLink.path, realpathSync(real));
  const viaReal = registerTestWorkspace({ home, path: real });
  assert.equal(viaReal.alreadyExisted, true);
  assert.equal(viaReal.id, viaLink.id);
  assert.equal(readStore(home).global.workspaceIds.length, 1, "同一 realpath 只能有一条记录");
  assert.equal(Object.keys(readStore(home).tables.workspaces).length, 1);
});

test("保留既有字段：只追加一条工作区，其它字段与默认工作区原样不动", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const workspace = makeWorkspace(root, "new-workspace");
  mkdirSync(join(home, "storages"), { recursive: true });
  const legacy = {
    unit: { name: "workspace", version: 2 },
    global: {
      initialized: false,
      workspaceIds: ["old-id"],
      archivedSessionIds: ["arch-1"],
      pinnedSessionIds: ["pin-1"],
      defaultWorkspaceId: "old-id",
    },
    tables: {
      workspaces: {
        "old-id": {
          path: "/tmp/old-workspace",
          title: "Old",
          sessionIds: ["session-1"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
      extraTable: { keep: true },
    },
    futureField: { doNotDrop: 1 },
  };
  const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
  writeFileSync(storeFile(home), legacyText);

  const now = new Date("2026-11-28T00:00:00.000Z");
  const summary = registerTestWorkspace({ home, path: workspace, now });
  const store = readStore(home);
  assert.deepEqual(store.global.workspaceIds, ["old-id", summary.id]);
  assert.equal(store.global.defaultWorkspaceId, "old-id", "已有默认工作区不能被替换");
  assert.equal(store.global.initialized, false);
  assert.deepEqual(store.global.archivedSessionIds, ["arch-1"]);
  assert.deepEqual(store.global.pinnedSessionIds, ["pin-1"]);
  assert.deepEqual(store.tables.workspaces["old-id"], legacy.tables.workspaces["old-id"]);
  assert.deepEqual(store.tables.extraTable, { keep: true });
  assert.deepEqual(store.futureField, { doNotDrop: 1 });

  // 已有文件必须先备份，且备份是**写前**的原样字节。
  assert.ok(summary.backupFile !== null);
  assert.equal(readFileSync(summary.backupFile, "utf8"), legacyText);
  assert.ok(summary.backupFile.startsWith(`${summary.storeFile}.bak-`));
  assert.ok(summary.backupFile.includes("2026-11-28T00-00-00-000Z"), "备份名带时间戳");
});

test("live home：默认拒绝 $HOME/.dsh 与其 profiles 子目录，--allow-live 才放行", () => {
  const root = makeRoot();
  const fakeHome = join(root, "fake-user-home");
  const liveHome = join(fakeHome, ".dsh");
  mkdirSync(join(liveHome, "profiles", "desktop"), { recursive: true });
  const workspace = makeWorkspace(root);

  assert.equal(isLiveHome(liveHome, fakeHome), true);
  assert.equal(isLiveHome(join(liveHome, "profiles", "desktop"), fakeHome), true);
  assert.equal(isLiveHome(makeHome(root), fakeHome), false);

  for (const home of [liveHome, join(liveHome, "profiles", "desktop")]) {
    assert.throws(
      () => registerTestWorkspace({ home, path: workspace, envHome: fakeHome }),
      (error) =>
        error instanceof WorkspaceRegisterError &&
        error.code === "safety" &&
        /--allow-live/u.test(error.message),
    );
    assert.equal(existsSync(storeFile(home)), false, "拒绝时不能写盘");
  }

  // CLI 退出码区分：安全闸 = 2，且不写盘。
  const denied = runCli(["--home", liveHome, "--path", workspace], { HOME: fakeHome });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /拒绝/u);
  assert.equal(existsSync(storeFile(liveHome)), false);

  const allowed = runCli(["--home", liveHome, "--path", workspace, "--allow-live"], {
    HOME: fakeHome,
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  const summary = cliSummary(allowed.stdout);
  assert.equal(summary.registered, true);
  assert.equal(summary.written, true);
  assert.equal(existsSync(storeFile(liveHome)), true);

  // 库函数同样支持显式放行（供以后别的脚本复用）。
  const other = makeWorkspace(root, "other-workspace");
  const viaLib = registerTestWorkspace({
    home: liveHome,
    path: other,
    allowLive: true,
    envHome: fakeHome,
  });
  assert.equal(viaLib.written, true);
});

test("dry-run：只打印计划，不建目录、不写盘、不做备份", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const workspace = makeWorkspace(root);

  const summary = registerTestWorkspace({ home, path: workspace, dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.written, false);
  assert.equal(summary.backupFile, null);
  assert.match(summary.id, UUID_RE);
  assert.equal(existsSync(join(home, "storages")), false, "dry-run 连 storages 目录都不建");

  const cli = runCli(["--home", home, "--path", workspace, "--dry-run"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /dry-run/u);
  const parsed = cliSummary(cli.stdout);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.written, false);
  assert.equal(existsSync(storeFile(home)), false);
});

test("不认识的 workspace.json 一律拒绝改写（坏 JSON / 别的结构 / 符号链接）", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const workspace = makeWorkspace(root);
  mkdirSync(join(home, "storages"), { recursive: true });

  for (const bad of ['{"oops":', '{"hello":1}', '{"global":{},"tables":{}}']) {
    writeFileSync(storeFile(home), bad);
    assert.throws(
      () => registerTestWorkspace({ home, path: workspace }),
      (error) => error instanceof WorkspaceRegisterError && error.code === "state",
    );
    assert.equal(readFileSync(storeFile(home), "utf8"), bad, "拒绝时原文件必须原样");
    assert.deepEqual(readdirSync(join(home, "storages")), ["workspace.json"], "拒绝时不留备份");
  }

  // workspace.json 是符号链接：原子写会把链接换成普通文件，直接拒绝。
  const target = join(root, "elsewhere.json");
  writeFileSync(target, JSON.stringify(emptyWorkspaceStore()));
  rmSync(storeFile(home));
  symlinkSync(target, storeFile(home));
  assert.throws(
    () => registerTestWorkspace({ home, path: workspace }),
    (error) => error instanceof WorkspaceRegisterError && error.code === "state",
  );
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), emptyWorkspaceStore());
});

test("CLI：默认标题取目录名，输出可解析的 JSON 摘要；--title 可覆盖", () => {
  const root = makeRoot();
  const home = makeHome(root);
  const workspace = makeWorkspace(root, "dsh-rewind-ui-smoke");

  const created = runCli(["--home", home, "--path", workspace]);
  assert.equal(created.status, 0, created.stderr);
  const createdSummary = cliSummary(created.stdout);
  assert.match(createdSummary.id, UUID_RE);
  assert.equal(createdSummary.alreadyExisted, false);
  assert.equal(createdSummary.path, realpathSync(workspace));
  assert.equal(createdSummary.title, "dsh-rewind-ui-smoke");
  assert.equal(readStore(home).tables.workspaces[createdSummary.id].title, "dsh-rewind-ui-smoke");

  const other = makeWorkspace(root, "second-workspace");
  const titled = runCli(["--home", home, "--path", other, "--title", "Rewind UI"]);
  assert.equal(titled.status, 0, titled.stderr);
  const titledSummary = cliSummary(titled.stdout);
  assert.equal(titledSummary.title, "Rewind UI");
  assert.equal(readStore(home).tables.workspaces[titledSummary.id].title, "Rewind UI");

  // 缺必填参数：用法错误，退出码 1。
  const usage = runCli(["--home", home]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /用法/u);
});
