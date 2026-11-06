// @ts-check
// files.js 的单测：存储布局、路径安全、before 捕获、entry 记录、恢复计划/执行、
// 冲突检测、救援点/回收站、回滚、保留与 GC。全部在 mkdtemp 临时目录里跑。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CONFLICT_REASONS,
  createFileStore,
  FILE_ERROR_CODES,
  MAX_FILE_BYTES,
  SKIP_REASONS,
  safeRelativePath,
} from "../lib/files.js";

/**
 * 简单的可推进时钟。
 * @param {number} [start]
 * @returns {{now: () => number, advance: (ms?: number) => number}}
 */
function createClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms = 1000) {
      value += ms;
      return value;
    },
  };
}

/**
 * 在临时目录里创建一个 store + 工作目录。
 * @param {Record<string, any>} [options] 传给 store 的 options
 * @param {{fs?: any}} [extra]
 * @returns {Promise<{root: string, home: string, cwd: string, store: ReturnType<typeof createFileStore>, clock: ReturnType<typeof createClock>}>}
 */
async function makeStore(options = {}, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "session-rewind-files-"));
  const home = path.join(root, "data");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const clock = createClock();
  let counter = 0;
  const store = createFileStore({
    home,
    options,
    ...(extra.fs === undefined ? {} : { fs: extra.fs }),
    now: clock.now,
    randomHex: () => {
      counter += 1;
      return counter.toString(16).padStart(8, "0");
    },
  });
  return { root, home, cwd, store, clock };
}

/**
 * 递归列出目录树（相对路径，排序后）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listTree(dir) {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (/** @type {any} */ (error).code === "ENOENT") return [];
    throw error;
  }
  return items
    .map((item) => path.relative(dir, path.join(/** @type {any} */ (item).parentPath, item.name)))
    .sort();
}

/**
 * 断言某个 path 的当前文本。
 * @param {string} filePath
 * @param {string} expected
 * @returns {Promise<void>}
 */
async function assertText(filePath, expected) {
  assert.equal(await readFile(filePath, "utf8"), expected);
}

/**
 * 造一个「按需失败」的 fs/promises 替身（写/读命中 predicate 时抛 EACCES）。
 * @param {(file: string) => boolean} shouldFailWrite 写路径判定
 * @param {(file: string) => boolean} [shouldFailRead] 读路径判定
 * @returns {any}
 */
function makeFailingFs(shouldFailWrite, shouldFailRead) {
  /**
   * @param {string} message
   * @returns {Error}
   */
  const denial = (message) => Object.assign(new Error(message), { code: "EACCES" });
  return {
    ...defaultFs,
    /**
     * @param {string} file
     * @param {any} data
     * @param {any} [options]
     * @returns {Promise<void>}
     */
    async writeFile(file, data, options) {
      if (shouldFailWrite(String(file))) throw denial(`EACCES: cannot write ${file}`);
      await defaultFs.writeFile(file, data, options);
    },
    /**
     * @param {string} file
     * @param {any} [options]
     * @returns {Promise<any>}
     */
    async readFile(file, options) {
      if (shouldFailRead?.(String(file)) === true) throw denial(`EACCES: cannot read ${file}`);
      return defaultFs.readFile(file, options);
    },
  };
}

test("safeRelativePath: 接受 cwd 内路径并归一化成 POSIX 相对路径", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "session-rewind-path-"));
  const cwd = path.join(root, "work");
  const inside = safeRelativePath(cwd, "src/app.ts");
  assert.deepEqual(inside.ok, true);
  assert.equal(inside.ok && inside.relPath, "src/app.ts");
  assert.equal(inside.ok && inside.absPath, path.join(cwd, "src/app.ts"));
  const absolute = safeRelativePath(cwd, path.join(cwd, "a", "b.txt"));
  assert.equal(absolute.ok && absolute.relPath, "a/b.txt");
  const dotted = safeRelativePath(cwd, "./src/../src/x.ts");
  assert.equal(dotted.ok && dotted.relPath, "src/x.ts");
  await rm(root, { recursive: true, force: true });
});

test("safeRelativePath: 拒绝逃逸、.git、node_modules 与空输入", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "session-rewind-path-"));
  const cwd = path.join(root, "work");
  assert.deepEqual(safeRelativePath(cwd, "../outside.txt"), {
    ok: false,
    reason: SKIP_REASONS.outsideCwd,
  });
  assert.deepEqual(safeRelativePath(cwd, "/etc/passwd"), {
    ok: false,
    reason: SKIP_REASONS.outsideCwd,
  });
  assert.deepEqual(safeRelativePath(cwd, ".git/config"), {
    ok: false,
    reason: SKIP_REASONS.excluded,
  });
  assert.deepEqual(safeRelativePath(cwd, "a/node_modules/x/y.js"), {
    ok: false,
    reason: SKIP_REASONS.excluded,
  });
  assert.deepEqual(safeRelativePath(cwd, ""), { ok: false, reason: SKIP_REASONS.invalidPath });
  assert.deepEqual(safeRelativePath(cwd, "a\0b"), { ok: false, reason: SKIP_REASONS.invalidPath });
  assert.deepEqual(safeRelativePath(cwd, "."), { ok: false, reason: SKIP_REASONS.invalidPath });
  await rm(root, { recursive: true, force: true });
});

test("resolveWorkspacePath: 跳过符号链接，拒绝通过符号链接逃逸", async () => {
  const { root, cwd, store } = await makeStore();
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));
  await symlink(outside, path.join(cwd, "linkdir"));
  const linkedFile = await store.resolveWorkspacePath(cwd, "link.txt");
  assert.deepEqual(linkedFile, { ok: false, reason: SKIP_REASONS.symlink });
  const linkedDir = await store.resolveWorkspacePath(cwd, "linkdir/secret.txt");
  assert.equal(linkedDir.ok, false);
  assert.equal(linkedDir.ok === false && linkedDir.reason, SKIP_REASONS.outsideCwd);
  const created = await store.resolveWorkspacePath(cwd, "new/nested/file.txt");
  assert.equal(created.ok, true);
  assert.equal(created.ok && created.existed, false);
  await rm(root, { recursive: true, force: true });
});

test("captureBefore: 区分新建与改动，保留权限位", async () => {
  const { root, cwd, store } = await makeStore();
  const existing = path.join(cwd, "mode.txt");
  await writeFile(existing, "content");
  await chmod(existing, 0o640);
  const captured = await store.captureBefore(cwd, "mode.txt");
  assert.equal(captured.ok, true);
  assert.equal(captured.ok && captured.existedBefore, true);
  assert.equal(captured.ok && captured.text, "content");
  assert.equal(captured.ok && captured.mode, 0o640);
  const created = await store.captureBefore(cwd, "brand-new.txt");
  assert.equal(created.ok, true);
  assert.equal(created.ok && created.existedBefore, false);
  assert.equal(created.ok && created.content, null);
  await rm(root, { recursive: true, force: true });
});

test("recordChange: 写入 before/after blob 与 entry（含删除）", async () => {
  const { root, cwd, store } = await makeStore();
  const created = await store.recordChange({
    sessionId: "session-a",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "call-1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "hello",
  });
  assert.equal(created.ok, true);
  assert.equal(created.ok && created.entry.existedBefore, false);
  assert.equal(created.ok && created.entry.beforeHash, null);
  assert.equal(created.ok && created.entry.bytes, 5);
  assert.match(String(created.ok && created.entry.afterHash), /^sha256:/);
  const afterBlob = await store.readBlob(created.ok ? created.entry.afterHash : null);
  assert.equal(afterBlob?.toString("utf8"), "hello");

  const updated = await store.recordChange({
    sessionId: "session-a",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "call-2",
    path: "a.txt",
    beforeContent: "hello",
    afterContent: "hello world",
    mode: 0o600,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.ok && updated.entry.existedBefore, true);
  assert.equal(updated.ok && updated.entry.mode, 0o600);

  const deleted = await store.recordChange({
    sessionId: "session-a",
    cwd,
    anchorSeq: 7,
    tool: "apply_patch",
    callId: "call-3",
    path: "b.txt",
    beforeContent: "bye",
    afterContent: null,
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.ok && deleted.entry.afterHash, null);

  const entries = await store.entriesForSession("session-a");
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["a.txt", "a.txt", "b.txt"],
  );
  assert.equal(entries[0].anchorSeq, 5);
  assert.equal(entries[2].anchorSeq, 7);
  await rm(root, { recursive: true, force: true });
});

test("recordChange: 超过 8 MiB 上限时 skip 并记录原因", async () => {
  const { root, cwd, store } = await makeStore({ maxFileBytes: 8 });
  const result = await store.recordChange({
    sessionId: "session-size",
    cwd,
    anchorSeq: 1,
    tool: "write",
    callId: "call-size",
    path: "big.txt",
    beforeContent: null,
    afterContent: "0123456789",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, SKIP_REASONS.tooLarge);
  const entries = await store.entriesForSession("session-size");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].skipped, SKIP_REASONS.tooLarge);
  await rm(root, { recursive: true, force: true });
});

test("recordChange: 含 NUL 的内容按二进制跳过", async () => {
  const { root, cwd, store } = await makeStore();
  const result = await store.recordChange({
    sessionId: "session-bin",
    cwd,
    anchorSeq: 1,
    tool: "write",
    callId: "call-bin",
    path: "bin.dat",
    beforeContent: Buffer.from([0, 1, 2, 3]),
    afterContent: Buffer.from([0, 4]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, SKIP_REASONS.binary);
  await writeFile(path.join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  const captured = await store.captureBefore(cwd, "bin.dat");
  assert.equal(captured.ok, false);
  assert.equal(captured.ok === false && captured.reason, SKIP_REASONS.binary);
  await rm(root, { recursive: true, force: true });
});

test("recordChange: 拒绝 cwd 外的路径（不落 entry）", async () => {
  const { root, cwd, store } = await makeStore();
  const result = await store.recordChange({
    sessionId: "session-escape",
    cwd,
    anchorSeq: 1,
    tool: "write",
    callId: "call-escape",
    path: "../escape.txt",
    beforeContent: null,
    afterContent: "nope",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, SKIP_REASONS.outsideCwd);
  assert.deepEqual(await store.entriesForSession("session-escape"), []);
  await rm(root, { recursive: true, force: true });
});

test("planRestore: 每个 path 取锚点内最早的 before，新建文件进回收站", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 3,
    tool: "write",
    callId: "c1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "v1",
  });
  await writeFile(path.join(cwd, "a.txt"), "v2");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c2",
    path: "a.txt",
    beforeContent: "v1",
    afterContent: "v2",
  });
  await writeFile(path.join(cwd, "b.txt"), "b");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 7,
    tool: "write",
    callId: "c3",
    path: "b.txt",
    beforeContent: null,
    afterContent: "b",
  });

  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  assert.equal(plan.available, true);
  assert.equal(plan.tracked, true);
  assert.deepEqual(
    plan.restore.map((item) => item.path),
    ["a.txt"],
  );
  assert.deepEqual(
    plan.trash.map((item) => item.path),
    ["b.txt"],
  );
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[0].beforeHash !== null, true);
  assert.equal(plan.actions[0].afterHash !== null, true);

  // targetSeq 3：a.txt 在 3 之后被创建 -> 也要移入回收站
  const earliest = await store.planRestore({ sessionId: "s", targetSeq: 3, cwd });
  assert.deepEqual(earliest.restore, []);
  assert.deepEqual(earliest.trash.map((item) => item.path).sort(), ["a.txt", "b.txt"]);

  // 位置参数形式同样可用
  const positional = await store.planRestore("s", 5);
  assert.deepEqual(
    positional.restore.map((item) => item.path),
    ["a.txt"],
  );
  await rm(root, { recursive: true, force: true });
});

test("planRestore: 无 entry 时 available=false，且计划阶段不写任何东西", async () => {
  const { root, home, cwd, store } = await makeStore();
  const empty = await store.planRestore({ sessionId: "nothing", targetSeq: 0, cwd });
  assert.equal(empty.available, false);
  assert.equal(empty.tracked, false);

  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 1,
    tool: "write",
    callId: "c1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "v1",
  });
  const before = await listTree(home);
  const workspaceBefore = await listTree(cwd);
  await store.planRestore({ sessionId: "s", targetSeq: 1, cwd });
  assert.deepEqual(await listTree(home), before);
  assert.deepEqual(await listTree(cwd), workspaceBefore);
  await rm(root, { recursive: true, force: true });
});

test("planRestore: 冲突检测 modified-externally / missing / unexpected-file", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "modified.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 2,
    tool: "write",
    callId: "c1",
    path: "modified.txt",
    beforeContent: null,
    afterContent: "v1",
  });
  await writeFile(path.join(cwd, "missing.txt"), "m");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 2,
    tool: "write",
    callId: "c2",
    path: "missing.txt",
    beforeContent: null,
    afterContent: "m",
  });
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 2,
    tool: "apply_patch",
    callId: "c3",
    path: "unexpected.txt",
    beforeContent: "u",
    afterContent: null,
  });

  await writeFile(path.join(cwd, "modified.txt"), "external");
  await rm(path.join(cwd, "missing.txt"));
  await writeFile(path.join(cwd, "unexpected.txt"), "u");

  const plan = await store.planRestore({ sessionId: "s", targetSeq: 2, cwd });
  assert.equal(plan.available, false);
  const byPath = new Map(plan.conflicts.map((conflict) => [conflict.path, conflict.reason]));
  assert.equal(byPath.get("modified.txt"), CONFLICT_REASONS.modifiedExternally);
  assert.equal(byPath.get("missing.txt"), CONFLICT_REASONS.missing);
  assert.equal(byPath.get("unexpected.txt"), CONFLICT_REASONS.unexpectedFile);
  assert.deepEqual(plan.actions, []);
  await rm(root, { recursive: true, force: true });
});

test("summarize: 按目标给出 tracked/anchorCount/fileCount/totalBytes", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 2,
    tool: "write",
    callId: "c1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "v1",
  });
  await writeFile(path.join(cwd, "b.txt"), "bb");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 4,
    tool: "write",
    callId: "c2",
    path: "b.txt",
    beforeContent: null,
    afterContent: "bb",
  });

  const all = await store.summarize("s", 0);
  assert.equal(all.tracked, true);
  assert.equal(all.anchorCount, 2);
  assert.equal(all.fileCount, 2);
  assert.equal(all.totalBytes, 4);
  assert.equal(all.available, true);

  const laterOnly = await store.summarize({ sessionId: "s", targetSeq: 4 });
  assert.equal(laterOnly.anchorCount, 1);
  assert.equal(laterOnly.fileCount, 1);

  const none = await store.summarize("missing", 0);
  assert.deepEqual(none, {
    tracked: false,
    anchorCount: 0,
    fileCount: 0,
    totalBytes: 0,
    available: false,
  });
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: 写回 before 内容 + 新建文件进回收站 + 生成救援点", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await chmod(path.join(cwd, "a.txt"), 0o640);
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "v0",
    afterContent: "v1",
    mode: 0o640,
  });
  await writeFile(path.join(cwd, "a.txt"), "v2");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c2",
    path: "a.txt",
    beforeContent: "v1",
    afterContent: "v2",
  });
  await writeFile(path.join(cwd, "new.txt"), "x");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "c3",
    path: "new.txt",
    beforeContent: null,
    afterContent: "x",
  });

  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  assert.equal(plan.available, true);
  const result = await store.applyRestore({
    sessionId: "s",
    cwd,
    plan,
    auditId: "audit-1",
    audit: true,
  });
  assert.deepEqual(result.restored, ["a.txt"]);
  assert.deepEqual(result.trashed, ["new.txt"]);
  assert.deepEqual(result.failed, []);
  assert.equal(typeof result.rescueId, "string");
  // 同一 (anchor, path) 多次改动只保留最早的 before（设计 §1）
  await assertText(path.join(cwd, "a.txt"), "v0");
  assert.equal((await defaultFs.stat(path.join(cwd, "a.txt"))).mode & 0o777, 0o640);
  await assert.rejects(readFile(path.join(cwd, "new.txt"), "utf8"), /ENOENT/);

  const trash = await store.listTrash({ sessionId: "s" });
  assert.equal(trash.length, 1);
  assert.equal(trash[0].id, "audit-1");
  assert.deepEqual(
    trash[0].paths.map((item) => item.path),
    ["new.txt"],
  );
  await assertText(path.join(store.paths.trash, "s", "audit-1", "files", "new.txt"), "x");

  const rescues = await store.listRescues({ sessionId: "s" });
  assert.equal(rescues.length, 1);
  assert.equal(rescues[0].targetSeq, 5);
  assert.equal((await store.listRescues("s")).length, 1);
  const audit = await store.readAudit({ sessionId: "s" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].id, "audit-1");
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: 缺省不写 audit.jsonl（由 service 统一写，避免重复）", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "new.txt"), "x");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "c1",
    path: "new.txt",
    beforeContent: null,
    afterContent: "x",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  const result = await store.applyRestore({ sessionId: "s", cwd, plan, auditId: "audit-no-audit" });
  assert.equal(result.trashed.length, 1);
  assert.deepEqual(await store.readAudit({ sessionId: "s" }), []);
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: beforeApply 在救援点之后、文件写入之前调用", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "v0",
    afterContent: "v1",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  /** @type {any} */
  let observed = null;
  const result = await store.applyRestore({
    sessionId: "s",
    cwd,
    plan,
    auditId: "audit-hook",
    audit: true,
    beforeApply: async () => {
      observed = {
        rescues: await store.listRescues({ sessionId: "s" }),
        content: await readFile(path.join(cwd, "a.txt"), "utf8"),
      };
      return { markerSeq: 42, removedCount: 3, tokens: 100 };
    },
  });
  assert.equal(observed.rescues.length, 1);
  assert.equal(observed.content, "v1");
  assert.deepEqual(result.restored, ["a.txt"]);
  const audit = await store.readAudit({ sessionId: "s" });
  assert.equal(audit[0].markerSeq, 42);
  assert.equal(audit[0].removedCount, 3);
  assert.equal(audit[0].tokens, 100);
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: beforeApply 抛错时不写任何文件", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "v0",
    afterContent: "v1",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  await assert.rejects(
    store.applyRestore({
      sessionId: "s",
      cwd,
      plan,
      auditId: "audit-fail",
      beforeApply: async () => {
        throw new Error("marker append failed");
      },
    }),
    /marker append failed/,
  );
  await assertText(path.join(cwd, "a.txt"), "v1");
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: 救援点创建失败 -> 整体失败且一个字节都不动", async () => {
  const failingFs = makeFailingFs((file) => file.includes(`${path.sep}rescues${path.sep}`));
  const { root, cwd, store } = await makeStore({}, { fs: failingFs });
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "v0",
    afterContent: "v1",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  let code = "";
  try {
    await store.applyRestore({ sessionId: "s", cwd, plan, auditId: "audit-rescue" });
  } catch (error) {
    code = /** @type {any} */ (error).code;
  }
  assert.equal(code, FILE_ERROR_CODES.rescueFailed);
  await assertText(path.join(cwd, "a.txt"), "v1");
  assert.deepEqual(await store.listRescues({ sessionId: "s" }), []);
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: 任一文件失败时用救援点回滚已应用的文件", async () => {
  const { root, cwd, store } = await makeStore();
  await mkdir(path.join(cwd, "sub"), { recursive: true });
  await writeFile(path.join(cwd, "a.txt"), "a-v2");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "a-v1",
    afterContent: "a-v2",
  });
  await writeFile(path.join(cwd, "sub", "b.txt"), "b-v2");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c2",
    path: "sub/b.txt",
    beforeContent: "b-v1",
    afterContent: "b-v2",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  assert.equal(plan.actions.length, 2);

  // 计划之后、应用之前外部改动 b.txt -> 该文件在应用阶段失败，触发回滚。
  await writeFile(path.join(cwd, "sub", "b.txt"), "b-external");

  const result = await store.applyRestore({ sessionId: "s", cwd, plan, auditId: "audit-rollback" });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(
    result.failed.map((item) => item.path),
    ["sub/b.txt"],
  );
  assert.deepEqual(result.rolledBack, ["a.txt"]);
  await assertText(path.join(cwd, "a.txt"), "a-v2");
  assert.equal(result.rollbackFailed.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: 回滚失败的文件列在 rollbackFailed 且保留救援点", async () => {
  const failingFs = makeFailingFs(
    (file) =>
      file.includes(`${path.sep}sub${path.sep}`) && !file.includes(`${path.sep}rescues${path.sep}`),
    (file) => file.includes(`${path.sep}rescues${path.sep}`) && file.endsWith(`${path.sep}a.txt`),
  );
  const { root, cwd, store } = await makeStore({}, { fs: failingFs });
  await mkdir(path.join(cwd, "sub"), { recursive: true });
  await writeFile(path.join(cwd, "a.txt"), "a-v2");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "a-v1",
    afterContent: "a-v2",
  });
  await writeFile(path.join(cwd, "sub", "b.txt"), "b-v2");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c2",
    path: "sub/b.txt",
    beforeContent: "b-v1",
    afterContent: "b-v2",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  const result = await store.applyRestore({
    sessionId: "s",
    cwd,
    plan,
    auditId: "audit-rollback-fail",
  });
  assert.deepEqual(result.rolledBack, []);
  assert.deepEqual(
    result.rollbackFailed.map((item) => item.path),
    ["a.txt"],
  );
  assert.deepEqual(
    result.failed.map((item) => item.path),
    ["sub/b.txt"],
  );
  assert.equal(result.rescueId !== null, true);
  assert.equal((await store.listRescues({ sessionId: "s" })).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("applyRestore: 计划有冲突时整体拒绝（不创建救援点）", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "c1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "v1",
  });
  await writeFile(path.join(cwd, "a.txt"), "external");
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  let code = "";
  try {
    await store.applyRestore({ sessionId: "s", cwd, plan, auditId: "audit-conflict" });
  } catch (error) {
    code = /** @type {any} */ (error).code;
  }
  assert.equal(code, FILE_ERROR_CODES.conflict);
  assert.deepEqual(await store.listRescues({ sessionId: "s" }), []);
  await assertText(path.join(cwd, "a.txt"), "external");
  await rm(root, { recursive: true, force: true });
});

test("回收站: listTrash / restoreTrash 往返，且不覆盖已存在文件", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "new.txt"), "x");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "c1",
    path: "new.txt",
    beforeContent: null,
    afterContent: "x",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  await store.applyRestore({ sessionId: "s", cwd, plan, auditId: "audit-trash" });
  await assert.rejects(readFile(path.join(cwd, "new.txt"), "utf8"), /ENOENT/);

  const trash = await store.listTrash({ sessionId: "s" });
  assert.equal(trash.length, 1);
  const restored = await store.restoreTrash({ sessionId: "s", cwd, auditId: "audit-trash" });
  assert.deepEqual(restored.restored, ["new.txt"]);
  await assertText(path.join(cwd, "new.txt"), "x");

  // 再放一次，然后占用目标路径 -> 拒绝覆盖
  await rm(path.join(cwd, "new.txt"));
  await writeFile(path.join(cwd, "new.txt"), "x");
  await store.recordChange({
    sessionId: "s2",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "c2",
    path: "new.txt",
    beforeContent: null,
    afterContent: "x",
  });
  const plan2 = await store.planRestore({ sessionId: "s2", targetSeq: 5, cwd });
  await store.applyRestore({ sessionId: "s2", cwd, plan: plan2, auditId: "audit-trash-2" });
  await writeFile(path.join(cwd, "new.txt"), "occupied");
  const blocked = await store.restoreTrash({ sessionId: "s2", cwd, auditId: "audit-trash-2" });
  assert.deepEqual(blocked.restored, []);
  assert.deepEqual(
    blocked.failed.map((item) => item.path),
    ["new.txt"],
  );
  await assertText(path.join(cwd, "new.txt"), "occupied");
  await rm(root, { recursive: true, force: true });
});

test("救援点: restoreRescue 先存 rescue-of-rescue 再写回", async () => {
  const { root, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "v0",
    afterContent: "v1",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  const applied = await store.applyRestore({
    sessionId: "s",
    cwd,
    plan,
    auditId: "audit-rescue-restore",
  });
  await assertText(path.join(cwd, "a.txt"), "v0");

  // 之后再改一次，然后从救援点恢复
  await writeFile(path.join(cwd, "a.txt"), "v9");
  const rescueId = String(applied.rescueId);
  const restored = await store.restoreRescue({ sessionId: "s", cwd, rescueId });
  assert.deepEqual(restored.restored, ["a.txt"]);
  assert.deepEqual(restored.failed, []);
  assert.notEqual(restored.safetyRescueId, rescueId);
  await assertText(path.join(cwd, "a.txt"), "v1");
  assert.equal((await store.listRescues({ sessionId: "s" })).length, 2);

  const missing = await store.restoreRescue({ sessionId: "s", cwd, rescueId: "nope" }).then(
    () => "resolved",
    (/** @type {any} */ error) => error.code,
  );
  assert.equal(missing, FILE_ERROR_CODES.rescueNotFound);
  await rm(root, { recursive: true, force: true });
});

test("usage: 统计字节数、entry、blob、trash 与 rescues", async () => {
  const { root, cwd, store } = await makeStore();
  const empty = await store.usage();
  assert.equal(empty.entries, 0);
  assert.equal(empty.sessions, 0);
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "write",
    callId: "c1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "v1",
  });
  const usage = await store.usage();
  assert.equal(usage.entries, 1);
  assert.equal(usage.sessions, 1);
  assert.equal(usage.blobs, 1);
  assert.equal(usage.blobBytes, 2);
  assert.ok(usage.bytes > 0);
  assert.equal(usage.overSoftCap, false);
  await rm(root, { recursive: true, force: true });
});

test("prune: 保留最近 anchor / rescue / trash 操作并清理无引用 blob", async () => {
  const { root, cwd, store } = await makeStore({
    maxAnchors: 2,
    maxRescues: 1,
    maxTrashOps: 1,
    pruneEvery: 0,
  });
  for (let anchor = 1; anchor <= 4; anchor++) {
    const content = `v${anchor}`;
    await writeFile(path.join(cwd, `f${anchor}.txt`), content);
    await store.recordChange({
      sessionId: "s",
      cwd,
      anchorSeq: anchor,
      tool: "write",
      callId: `c${anchor}`,
      path: `f${anchor}.txt`,
      beforeContent: null,
      afterContent: content,
    });
  }
  assert.equal((await store.entriesForSession("s")).length, 4);

  // 两次「新建文件 -> 回收站」操作：各生成一个救援点 + 一个回收站操作
  for (let index = 1; index <= 2; index++) {
    const name = `new-${index}.txt`;
    const content = `n${index}`;
    await writeFile(path.join(cwd, name), content);
    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    /** @type {any} */
    const plan = {
      available: true,
      tracked: true,
      sessionId: "s",
      targetSeq: 4,
      cwd,
      restore: [],
      trash: [{ path: name, bytes: content.length }],
      skipped: [],
      conflicts: [],
      warnings: [],
      totalBytes: content.length,
      actions: [
        {
          path: name,
          action: "trash",
          beforeHash: null,
          afterHash: hash,
          currentHash: hash,
          bytes: content.length,
          mode: null,
          anchorSeq: 4,
        },
      ],
    };
    await store.applyRestore({ sessionId: "s", cwd, plan, auditId: `audit-${index}` });
  }
  assert.equal((await store.listRescues({ sessionId: "s" })).length, 2);
  assert.equal((await store.listTrash({ sessionId: "s" })).length, 2);

  const report = await store.prune({ sessionId: "s" });
  assert.ok(report.removedAnchors >= 2);
  const anchors = new Set((await store.entriesForSession("s")).map((entry) => entry.anchorSeq));
  assert.equal(anchors.size, 2);
  assert.equal(anchors.has(3), true);
  assert.equal(anchors.has(4), true);
  assert.equal((await store.listRescues({ sessionId: "s" })).length, 1);
  assert.equal((await store.listTrash({ sessionId: "s" })).length, 1);

  // 被丢弃 anchor 的 blob 不再被引用 -> GC 掉（只剩 f3/f4 两个 blob）
  let blobCount = 0;
  for (const prefix of await readdir(store.paths.blobs).catch(() => [])) {
    blobCount += (await readdir(path.join(store.paths.blobs, prefix))).length;
  }
  assert.equal(blobCount, 2);
  assert.equal(report.captureBlocked, false);
  await rm(root, { recursive: true, force: true });
});

test("prune: 软上限无法满足时暂停新捕获（storage-full）", async () => {
  const { root, cwd, store } = await makeStore({ softCapBytes: 1, pruneEvery: 0 });
  await writeFile(path.join(cwd, "a.txt"), "payload");
  const first = await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 1,
    tool: "write",
    callId: "c1",
    path: "a.txt",
    beforeContent: null,
    afterContent: "payload",
  });
  assert.equal(first.ok, true);
  const report = await store.prune({});
  assert.equal(report.overSoftCap, true);
  assert.equal(report.captureBlocked, true);
  assert.equal(store.isStorageFull(), true);
  const blocked = await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 1,
    tool: "edit",
    callId: "c2",
    path: "a.txt",
    beforeContent: "payload",
    afterContent: "payload2",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, SKIP_REASONS.storageFull);
  await rm(root, { recursive: true, force: true });
});

test("原子写: 恢复后工作区与数据目录里没有残留临时文件", async () => {
  const { root, home, cwd, store } = await makeStore();
  await writeFile(path.join(cwd, "a.txt"), "v1");
  await store.recordChange({
    sessionId: "s",
    cwd,
    anchorSeq: 5,
    tool: "edit",
    callId: "c1",
    path: "a.txt",
    beforeContent: "v0",
    afterContent: "v1",
  });
  const plan = await store.planRestore({ sessionId: "s", targetSeq: 5, cwd });
  await store.applyRestore({ sessionId: "s", cwd, plan, auditId: "audit-atomic" });
  const workspace = await listTree(cwd);
  const data = await listTree(home);
  for (const entry of [...workspace, ...data]) {
    assert.equal(/\.tmp-/.test(entry), false, `unexpected temp file: ${entry}`);
  }
  await assertText(path.join(cwd, "a.txt"), "v0");
  await rm(root, { recursive: true, force: true });
});

test("默认上限与常量导出", () => {
  assert.equal(MAX_FILE_BYTES, 8 * 1024 * 1024);
  const store = createFileStore({ home: path.join(tmpdir(), "session-rewind-constants-unused") });
  assert.equal(store.options.maxFileBytes, MAX_FILE_BYTES);
  assert.equal(store.options.maxAnchors, 20);
  assert.equal(store.options.maxRescues, 5);
  assert.equal(store.options.maxTrashOps, 20);
  assert.equal(store.options.softCapBytes, 1024 * 1024 * 1024);
  assert.equal(store.options.pruneEvery, 50);
});
