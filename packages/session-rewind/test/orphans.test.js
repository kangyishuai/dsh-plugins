// @ts-check
// 孤儿清理的单测：用真实宿主 slug 形态（`--Users-…--`）覆盖分类与安全护栏。
//
// 背景（AUD-REW-01）：宿主把工作区目录名编码成 `--Users-someone-Workspace-project--`，
// 首字符是 `-`。旧实现的 SAFE_ID 正则要求首字符是字母数字，于是 46/46 个工作区目录都
// 被滤掉、`existing` 恒为空，每次插件加载都把 `sessions/ trash/ rescues/` 全删。
import assert from "node:assert/strict";
import * as defaultFs from "node:fs/promises";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findOrphans, pruneOrphans } from "../lib/orphans.js";

/** 真实宿主形态的工作区目录名（路径编码，首字符是 `-`）。 */
const REAL_SLUG = "--Users-someone-Workspace-project--";
/** 另一个真实形态的工作区目录名（/private/tmp 路径编码）。 */
const REAL_SLUG_TMP = "--private-tmp-project--";

/**
 * 写一个占位文件（自动建父目录）。
 * @param {string} root
 * @param {string[]} parts
 */
async function touch(root, parts) {
  const file = join(root, ...parts);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "x");
  return file;
}

/**
 * 造一个「某个路径 readdir 抛 EACCES」的 fs 替身（模拟数据根局部不可读）。
 * @param {(dir: string) => boolean} isDenied
 * @returns {any}
 */
function makeDeniedFs(isDenied) {
  return {
    ...defaultFs,
    /**
     * @param {string} dir
     * @param {any} [options]
     * @returns {Promise<any>}
     */
    async readdir(dir, options) {
      if (isDenied(String(dir))) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), {
          code: "EACCES",
        });
      }
      return defaultFs.readdir(dir, options);
    },
  };
}

/**
 * 造一个「某个路径 lstat 抛 EACCES」的 fs 替身（模拟目录条目可列出、但 stat 不可读）。
 * @param {(path: string) => boolean} isDenied
 * @returns {any}
 */
function makeUnreadableLstatFs(isDenied) {
  return {
    ...defaultFs,
    /**
     * @param {string} file
     * @param {any} [options]
     * @returns {Promise<any>}
     */
    async lstat(file, options) {
      if (isDenied(String(file))) {
        throw Object.assign(new Error(`EACCES: permission denied, lstat '${file}'`), {
          code: "EACCES",
        });
      }
      return defaultFs.lstat(file, options);
    },
  };
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test("findOrphans: 真实 slug 形态下的存活会话不算孤儿", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    // 宿主布局：sessions/<路径编码 workspace>/<sessionId>/
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    await mkdir(join(dataRoot, "sessions", REAL_SLUG_TMP, "session-other"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-other", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    await touch(plugin, ["trash", "session-alive", "op", "files", "a.txt"]);
    await touch(plugin, ["trash", "session-dead", "op", "files", "a.txt"]);
    await touch(plugin, ["rescues", "session-alive", "r1", "manifest.json"]);
    await touch(plugin, ["rescues", "session-dead", "r1", "manifest.json"]);

    const report = await findOrphans({ dataRoot });
    assert.deepEqual(report.sessionIds, ["session-dead"]);
    assert.deepEqual(report.trashIds, ["session-dead"]);
    assert.deepEqual(report.rescueIds, ["session-dead"]);
    assert.equal(report.liveSessionCount, 2);
    assert.equal(report.enumerationFailed, false);
    assert.ok(report.bytes > 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 只删真实孤儿，真实 slug 下的存活会话数据原样保留", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    const liveEntries = await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    const liveTrash = await touch(plugin, ["trash", "session-alive", "op", "files", "a.txt"]);
    const liveRescue = await touch(plugin, ["rescues", "session-alive", "r1", "manifest.json"]);
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    await touch(plugin, ["trash", "session-dead", "op", "files", "a.txt"]);
    await touch(plugin, ["rescues", "session-dead", "r1", "manifest.json"]);
    await writeFile(join(plugin, "audit.jsonl"), '{"id":"old"}\n');

    /** @type {string[]} */
    const order = [];
    /** @type {any} */
    let planSeen = null;
    const result = await pruneOrphans({
      dataRoot,
      onPlan: async (/** @type {any} */ report) => {
        order.push("plan");
        planSeen = report;
        // 审计计划必须发生在任何删除之前：此时存活会话与孤儿都还在。
        assert.equal(await exists(liveEntries), true);
        assert.equal(await exists(join(plugin, "sessions", "session-dead", "entries.jsonl")), true);
      },
    });
    order.push("after");
    assert.deepEqual(order, ["plan", "after"]);
    assert.equal(planSeen.sessionIds.length, 1);
    assert.deepEqual(planSeen.sessionIds, ["session-dead"]);
    assert.equal(result.executed, true);
    assert.equal(result.reason, null);
    assert.deepEqual(result.removed.sessions, ["session-dead"]);
    assert.deepEqual(result.removed.trash, ["session-dead"]);
    assert.deepEqual(result.removed.rescues, ["session-dead"]);
    assert.equal(result.failed.length, 0);

    // 孤儿没了，存活会话的三份数据都在，audit 不动。
    assert.equal(await exists(join(plugin, "sessions", "session-dead", "entries.jsonl")), false);
    assert.equal(await exists(liveEntries), true);
    assert.equal(await exists(liveTrash), true);
    assert.equal(await exists(liveRescue), true);
    assert.equal(await readFile(join(plugin, "audit.jsonl"), "utf8"), '{"id":"old"}\n');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 枚举为空视为失败，不删任何东西（不得当作全部孤儿）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    // 一个存活会话都没枚举到（sessions/ 不存在）。
    const plugin = join(dataRoot, "session-rewind");
    const entries = await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    const trash = await touch(plugin, ["trash", "session-dead", "op", "files", "a.txt"]);
    const rescue = await touch(plugin, ["rescues", "session-dead", "r1", "manifest.json"]);

    const report = await findOrphans({ dataRoot });
    assert.equal(report.enumerationFailed, true);
    assert.deepEqual(report.sessionIds, []);
    assert.deepEqual(report.trashIds, []);
    assert.deepEqual(report.rescueIds, []);

    /** @type {any} */
    let planSeen = null;
    const result = await pruneOrphans({
      dataRoot,
      onPlan: (/** @type {any} */ reportArg) => {
        planSeen = reportArg;
      },
    });
    // 枚举失败也要留审计（调用方写 warning/审计），但不执行删除。
    assert.notEqual(planSeen, null);
    assert.equal(planSeen.enumerationFailed, true);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "enumeration-failed");
    assert.deepEqual(result.removed, { sessions: [], trash: [], rescues: [] });
    assert.equal(await exists(entries), true);
    assert.equal(await exists(trash), true);
    assert.equal(await exists(rescue), true);

    // dryRun 同样不删，并给出 enumerationFailed。
    const dry = await pruneOrphans({ dataRoot, dryRun: true });
    assert.equal(dry.executed, false);
    assert.equal(dry.report.enumerationFailed, true);
    assert.equal(await exists(entries), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 无法识别的插件数据条目保留不删", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    // 不匹配安全字符集的条目：无从判断归属 -> 保留（AGENTS 硬性约定 1）。
    const unknown = await touch(plugin, ["sessions", "not a session id", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    const result = await pruneOrphans({ dataRoot });
    assert.deepEqual(result.removed.sessions, ["session-dead"]);
    assert.equal(await exists(unknown), true);
    assert.equal(await exists(join(plugin, "sessions", "session-dead", "entries.jsonl")), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 计划审计失败时不执行删除（审计先行）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    const dead = await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    const result = await pruneOrphans({
      dataRoot,
      onPlan: () => {
        throw new Error("audit disk is full");
      },
    });
    assert.equal(result.executed, false);
    assert.equal(result.reason, "plan-audit-failed");
    assert.deepEqual(result.removed, { sessions: [], trash: [], rescues: [] });
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /audit disk is full/);
    assert.equal(await exists(dead), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 没有孤儿时不写空计划、不删任何东西", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    const live = await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    /** @type {any[]} */
    const plans = [];
    const result = await pruneOrphans({
      dataRoot,
      onPlan: (/** @type {any} */ reportArg) => {
        plans.push(reportArg);
      },
    });
    assert.equal(result.executed, true);
    assert.equal(result.reason, null);
    assert.deepEqual(plans, []);
    assert.equal(await exists(live), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: dryRun 只报告不删除", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);
    const result = await pruneOrphans({ dataRoot, dryRun: true });
    assert.deepEqual(result.report.sessionIds, ["session-dead"]);
    assert.equal(result.report.enumerationFailed, false);
    assert.equal(result.executed, false);
    assert.deepEqual(result.removed.sessions, []);
    await readFile(join(plugin, "sessions", "session-dead", "entries.jsonl"));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 扁平宿主布局（sessions/<id>/session.v4…）视为枚举失败、不删", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    // 未知布局：会话目录的直接子项是会话文件而不是下一层会话目录。
    await mkdir(join(dataRoot, "sessions", "session-flat"), { recursive: true });
    await writeFile(
      join(dataRoot, "sessions", "session-flat", "session.v4.jsonl.zstd"),
      Buffer.from("not-really-zstd"),
    );
    const plugin = join(dataRoot, "session-rewind");
    const entries = await touch(plugin, ["sessions", "session-flat", "entries.jsonl"]);

    const report = await findOrphans({ dataRoot });
    assert.equal(report.enumerationFailed, true);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.sessionIds, []);

    const result = await pruneOrphans({ dataRoot });
    assert.equal(result.executed, false);
    assert.equal(result.reason, "enumeration-failed");
    assert.equal(await exists(entries), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: workspace 内多一层 --project-- 嵌套视为枚举失败、不删", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    // 未知布局：sessions/<workspace>/<projectKey>/<sessionId>/（projectKey 首字符是 `-`）。
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "--project-alpha--", "session-nested"), {
      recursive: true,
    });
    const plugin = join(dataRoot, "session-rewind");
    const entries = await touch(plugin, ["sessions", "session-nested", "entries.jsonl"]);
    const trash = await touch(plugin, ["trash", "session-nested", "op", "files", "a.txt"]);

    const report = await findOrphans({ dataRoot });
    assert.equal(report.enumerationFailed, true);
    assert.deepEqual(report.sessionIds, []);

    const result = await pruneOrphans({ dataRoot });
    assert.equal(result.executed, false);
    assert.equal(result.reason, "enumeration-failed");
    assert.equal(await exists(entries), true);
    assert.equal(await exists(trash), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 部分 workspace 不可读（EACCES）视为 incomplete，不删并留审计计划", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", "--ws-locked--", "session-hidden"), { recursive: true });
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    const hiddenEntries = await touch(plugin, ["sessions", "session-hidden", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    const fs = makeDeniedFs((dir) => dir.endsWith("--ws-locked--"));

    const report = await findOrphans({ dataRoot, fs });
    assert.equal(report.incomplete, true);
    assert.equal(report.enumerationFailed, true);
    assert.equal(report.liveSessionCount, 1);
    assert.deepEqual(report.sessionIds, []);

    /** @type {any[]} */
    const plans = [];
    const result = await pruneOrphans({
      dataRoot,
      fs,
      onPlan: (/** @type {any} */ reportArg) => {
        plans.push(reportArg);
      },
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].incomplete, true);
    assert.equal(result.executed, false);
    assert.equal(result.reason, "enumeration-failed");
    assert.equal(await exists(hiddenEntries), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pruneOrphans: 某个 workspace 为空不影响清理真实孤儿（不过度保守）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", "--ws-empty--"), { recursive: true });
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    const live = await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    await touch(plugin, ["sessions", "session-dead", "entries.jsonl"]);

    const report = await findOrphans({ dataRoot });
    assert.equal(report.enumerationFailed, false);
    assert.equal(report.incomplete, false);
    assert.equal(report.liveSessionCount, 1);
    assert.deepEqual(report.sessionIds, ["session-dead"]);

    const result = await pruneOrphans({ dataRoot });
    assert.equal(result.executed, true);
    assert.deepEqual(result.removed.sessions, ["session-dead"]);
    assert.equal(await exists(live), true);
    assert.equal(await exists(join(plugin, "sessions", "session-dead", "entries.jsonl")), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("findOrphans: 不认识的插件数据条目进 unknownIds（保留并告警）", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "srw-orphans-"));
  try {
    await mkdir(join(dataRoot, "sessions", REAL_SLUG, "session-alive"), { recursive: true });
    const plugin = join(dataRoot, "session-rewind");
    await touch(plugin, ["sessions", "session-alive", "entries.jsonl"]);
    const unknown = await touch(plugin, ["sessions", "not a session id", "entries.jsonl"]);
    const unreadable = await touch(plugin, ["trash", "session-locked", "op", "files", "a.txt"]);
    const fs = makeUnreadableLstatFs((dir) => dir.endsWith(`${join("trash", "session-locked")}`));

    const report = await findOrphans({ dataRoot, fs });
    assert.equal(report.enumerationFailed, false);
    assert.deepEqual(
      report.unknownIds.map((/** @type {any} */ item) => [item.root, item.id, item.reason]).sort(),
      [
        ["sessions", "not a session id", "unsafe-id"],
        ["trash", "session-locked", "unreadable"],
      ],
    );
    const result = await pruneOrphans({ dataRoot, fs });
    assert.deepEqual(result.removed, { sessions: [], trash: [], rescues: [] });
    assert.equal(await exists(unknown), true);
    assert.equal(await exists(unreadable), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
