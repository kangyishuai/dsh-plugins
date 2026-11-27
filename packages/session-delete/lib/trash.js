// @ts-check
// 回收站：原子移动 + meta.json + 恢复 + 彻底删除。
// 回收站目录固定放在数据根下（同卷，rename 才是 O(1)），陌生条目一律保留并告警。
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isInside, requireInside, requireSessionId, trashRoot } from "./paths.js";

/** meta.json 的格式版本；新版本读旧条目，旧版本忽略新字段。 */
export const TRASH_SCHEMA = 1;
/** 回收站里由本插件创建的条目必须带这个标记，彻底删除前会核对。 */
export const TRASH_PLUGIN = "@kangyishuai/dsh-session-delete";

/**
 * @typedef {object} TrashMetaInput
 * @property {string | null} [title]
 * @property {string | null} [cwd]
 * @property {number} [bytes]
 * @property {boolean} [live]
 * @property {{ id: string, title: string | null }[]} [children]
 * @property {string[]} [workspaceIds]
 * @property {boolean | null} [pinned]
 * @property {string} [trashedAt]
 */

const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * @typedef {object} TrashMeta
 * @property {number} schema
 * @property {string} entryId
 * @property {string} sessionId
 * @property {string | null} title
 * @property {string | null} cwd
 * @property {string} trashedAt
 * @property {number} bytes
 * @property {boolean} live
 * @property {{ id: string, title: string | null }[]} children
 * @property {string[]} workspaceIds
 * @property {boolean | null} pinned
 * @property {string} originPath
 * @property {string} plugin
 */

/** @param {string} sessionId @param {number} [now] @returns {string} */
export function makeEntryId(sessionId, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, "-");
  const salt = randomUUID().slice(0, 4);
  return `${stamp}-${salt}-${sessionId}`;
}

/** @param {string} entryId @returns {string} */
export function requireEntryId(entryId) {
  if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) {
    throw Object.assign(new Error("invalid trash entry id"), {
      code: "session-delete/invalid-entry",
    });
  }
  return entryId;
}

/** @param {string} dataRoot @param {string} entryId @returns {string} */
export function entryDir(dataRoot, entryId) {
  return join(trashRoot(dataRoot), requireEntryId(entryId));
}

/** @param {string} dataRoot @param {string} entryId @returns {string} */
export function entryDataDir(dataRoot, entryId) {
  return join(entryDir(dataRoot, entryId), "data");
}

/** @param {string} dataRoot @param {string} entryId @returns {string} */
export function entryMetaPath(dataRoot, entryId) {
  return join(entryDir(dataRoot, entryId), "meta.json");
}

/**
 * 把一棵目录树读成「相对路径 → 条目指纹」的表，用来逐项比对 cp 的结果。
 * 指纹包含类型与大小；符号链接比对链接文本，不跟随（cp 默认也不跟随）。
 * @param {string} root
 * @returns {Promise<Map<string, string>>}
 */
async function treeFingerprints(root) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @type {{ dir: string, prefix: string }[]} */
  const stack = [{ dir: root, prefix: "" }];
  while (stack.length > 0) {
    const next = /** @type {{ dir: string, prefix: string }} */ (stack.pop());
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch (error) {
      out.set(
        `${next.prefix || "."}/`,
        `unreadable:${/** @type {any} */ (error)?.code ?? "error"}`,
      );
      continue;
    }
    for (const entry of entries) {
      const rel = next.prefix ? `${next.prefix}/${entry.name}` : entry.name;
      const full = join(next.dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(full).catch(() => "?");
        out.set(rel, `link:${target}`);
      } else if (entry.isDirectory()) {
        stack.push({ dir: full, prefix: rel });
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        out.set(rel, `file:${info?.size ?? -1}`);
      } else {
        out.set(rel, "other");
      }
    }
  }
  return out;
}

/**
 * 校验「目标目录是源目录的完整副本」：条目集合、每项类型/大小、总字节数都要一致。
 * 跨卷回退在删源之前必须过这一关——只判断「目标是目录」等于没有校验。
 * @param {string} source
 * @param {string} target
 * @returns {Promise<{ ok: boolean, sourceFiles: number, targetFiles: number, sourceBytes: number,
 *   targetBytes: number, missing: string[], extra: string[], differing: string[] }>}
 */
export async function verifyDirectoryCopy(source, target) {
  const [sourceTree, targetTree] = await Promise.all([
    treeFingerprints(source),
    treeFingerprints(target),
  ]);
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const extra = [];
  /** @type {string[]} */
  const differing = [];
  /** @param {string} fingerprint */
  const sizeOf = (fingerprint) => {
    const match = /^file:(\d+)$/u.exec(fingerprint);
    return match ? Number(match[1]) : 0;
  };
  let sourceBytes = 0;
  let sourceFiles = 0;
  let targetBytes = 0;
  let targetFiles = 0;
  for (const [rel, fingerprint] of sourceTree) {
    if (fingerprint.startsWith("file:")) {
      sourceFiles += 1;
      sourceBytes += sizeOf(fingerprint);
    }
    if (!targetTree.has(rel)) missing.push(rel);
    else if (targetTree.get(rel) !== fingerprint) differing.push(rel);
  }
  for (const [rel, fingerprint] of targetTree) {
    if (fingerprint.startsWith("file:")) {
      targetFiles += 1;
      targetBytes += sizeOf(fingerprint);
    }
    if (!sourceTree.has(rel)) extra.push(rel);
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && differing.length === 0,
    sourceFiles,
    targetFiles,
    sourceBytes,
    targetBytes,
    missing,
    extra,
    differing,
  };
}

/**
 * 原子移动目录。同卷 rename；跨卷（EXDEV）退化为 cp → **逐项校验** → 删源。
 * 校验不过就不删源：宁可留下「源还在、目标副本不完整」，也不能制造唯一副本不完整的状态。
 * @param {string} source
 * @param {string} target
 * @param {{ renameImpl?: (source: string, target: string) => Promise<void>,
 *   cpImpl?: (source: string, target: string, options?: any) => Promise<void> }} [deps]
 *   仅供单测注入（跨卷路径无法在本机复现）。
 * @returns {Promise<void>}
 */
export async function moveDirectory(source, target, deps = {}) {
  const renameImpl = deps.renameImpl ?? rename;
  const cpImpl = deps.cpImpl ?? cp;
  try {
    await renameImpl(source, target);
    return;
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "EXDEV") throw error;
  }
  await cpImpl(source, target, { recursive: true, errorOnExist: true, force: false });
  const verified = await verifyDirectoryCopy(source, target);
  if (!verified.ok) {
    // 目标副本是本次调用新造的（调用方都先确认过目标不存在），删掉它只是恢复原状；
    // 源始终是权威副本，任何情况下都不删。清理失败就写进错误里，不当静默成功。
    /** @type {string | null} */
    let cleanupError = null;
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    throw Object.assign(
      new Error(
        `cross-device copy verification failed: ${verified.missing.length} missing, ` +
          `${verified.extra.length} extra, ${verified.differing.length} differing ` +
          `(${verified.sourceFiles} files / ${verified.sourceBytes} B expected, ` +
          `got ${verified.targetFiles} files / ${verified.targetBytes} B)`,
      ),
      {
        code: "session-delete/copy-verify-failed",
        details: { ...verified, cleanupError },
      },
    );
  }
  await rm(source, { recursive: true, force: false });
}

/**
 * 把会话目录移入回收站并写 meta.json。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.sessionId
 * @param {string} options.sourceDir 会话目录（调用方已校验在 sessions 根内）。
 * @param {TrashMetaInput} options.meta
 * @returns {Promise<{ entryId: string, meta: TrashMeta }>}
 */
export async function moveIntoTrash({ dataRoot, sessionId, sourceDir, meta }) {
  requireSessionId(sessionId);
  requireInside(dataRoot, sourceDir);

  const entryId = makeEntryId(sessionId);
  const root = trashRoot(dataRoot);
  const target = join(root, entryId);
  requireInside(dataRoot, target);
  if (!isInside(root, target)) throw new Error("trash entry escaped the trash root");

  await mkdir(root, { recursive: true });
  await mkdir(target, { recursive: false });
  const dataDir = join(target, "data");
  await moveDirectory(sourceDir, dataDir);

  /** @type {TrashMeta} */
  const full = {
    schema: TRASH_SCHEMA,
    entryId,
    sessionId,
    title: meta.title ?? null,
    cwd: meta.cwd ?? null,
    trashedAt: meta.trashedAt ?? new Date().toISOString(),
    bytes: meta.bytes ?? 0,
    live: Boolean(meta.live),
    children: meta.children ?? [],
    workspaceIds: meta.workspaceIds ?? [],
    pinned: meta.pinned ?? null,
    originPath: sourceDir,
    plugin: TRASH_PLUGIN,
  };
  await writeFile(entryMetaPath(dataRoot, entryId), JSON.stringify(full, null, 2), "utf8");
  return { entryId, meta: full };
}

/**
 * @param {string} dataRoot
 * @param {string} entryId
 * @returns {Promise<TrashMeta>}
 */
export async function readEntry(dataRoot, entryId) {
  const raw = await readFile(entryMetaPath(dataRoot, entryId), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed?.plugin !== TRASH_PLUGIN || typeof parsed?.sessionId !== "string") {
    throw Object.assign(new Error("trash entry was not created by this plugin"), {
      code: "session-delete/foreign-entry",
    });
  }
  return /** @type {TrashMeta} */ (parsed);
}

/**
 * 列出回收站条目。没有 meta.json 的陌生目录原样保留并单独返回，绝不删除。
 * @param {string} dataRoot
 * @returns {Promise<{ entries: TrashMeta[], unknown: string[] }>}
 */
export async function listEntries(dataRoot) {
  const root = trashRoot(dataRoot);
  /** @type {string[]} */
  let names = [];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name !== "journal" &&
          entry.name !== "receipts",
      )
      .map((entry) => entry.name);
  } catch {
    return { entries: [], unknown: [] };
  }
  /** @type {TrashMeta[]} */
  const entries = [];
  /** @type {string[]} */
  const unknown = [];
  for (const name of names) {
    try {
      entries.push(await readEntry(dataRoot, name));
    } catch {
      unknown.push(name);
    }
  }
  entries.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  return { entries, unknown };
}

/**
 * 从回收站恢复：把 data/ 移回原路径，成功后再清理条目目录。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.entryId
 * @param {string} [options.destinationDir] 覆盖默认的原路径（测试/迁移用）。
 * @returns {Promise<{ meta: TrashMeta, restoredTo: string }>}
 */
export async function restoreEntry({ dataRoot, entryId, destinationDir }) {
  const meta = await readEntry(dataRoot, entryId);
  const destination = destinationDir ?? meta.originPath;
  requireInside(dataRoot, destination);
  const dataDir = entryDataDir(dataRoot, entryId);
  requireInside(dataRoot, dataDir);

  try {
    await stat(destination);
    throw Object.assign(new Error("the original session directory already exists"), {
      code: "session-delete/restore-conflict",
    });
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "session-delete/restore-conflict") throw error;
  }

  await mkdir(dirname(destination), { recursive: true });
  await moveDirectory(dataDir, destination);
  await finalizeRestoreEntry({ dataRoot, entryId, meta, restoredTo: destination });
  return { meta, restoredTo: destination };
}

/**
 * 恢复的收尾：写一份历史记录（条目被清掉后仍可查），再删除回收站条目目录。
 * 单独抽出来是因为「数据已搬回、条目还没删」正是崩溃后需要补做的那一步。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.entryId
 * @param {TrashMeta} options.meta
 * @param {string} options.restoredTo
 * @returns {Promise<void>}
 */
export async function finalizeRestoreEntry({ dataRoot, entryId, meta, restoredTo }) {
  const historyDir = join(trashRoot(dataRoot), ".history");
  await mkdir(historyDir, { recursive: true });
  await writeFile(
    join(historyDir, `${entryId}.json`),
    JSON.stringify({ ...meta, restoredAt: new Date().toISOString(), restoredTo }, null, 2),
    "utf8",
  );
  await rm(entryDir(dataRoot, entryId), { recursive: true, force: true });
}

/**
 * 彻底删除一个回收站条目（不可恢复）。
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.entryId
 * @returns {Promise<{ bytes: number }>}
 */
export async function purgeEntry({ dataRoot, entryId }) {
  const meta = await readEntry(dataRoot, entryId);
  const dir = entryDir(dataRoot, entryId);
  requireInside(dataRoot, dir);
  await rm(dir, { recursive: true, force: false });
  return { bytes: meta.bytes ?? 0 };
}
