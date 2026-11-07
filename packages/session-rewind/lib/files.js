// @ts-check
// 文件还原引擎（host 侧、可注入、无宿主依赖）。
//
// 契约见 notes/session-rewind/file-restore-design.md §1/§2/§2.5：
//   - 数据根注入：`createFileStore({ home })`，测试用 mkdtemp；模块顶层不写死 ~/.dsh。
//   - 布局：meta.json / blobs/<2位>/<sha256> / sessions/<id>/{meta.json,entries.jsonl}
//           / trash/<session>/<auditId>/{files,manifest.json}
//           / rescues/<session>/<rescueId>/{files,manifest.json} / audit.jsonl
//   - 写入全部原子化（同目录临时文件 + rename）；不执行任何 shell 命令；只 import node:fs/promises。
//   - 硬约束：单文件 8 MiB、跳过符号链接、排除 .git/node_modules、路径必须留在会话 cwd 内、
//     保留权限位、绝不无副本删除数据（恢复/GC 都走救援点或回收站）。
//
// 这个文件是唯一同时掌握「存储布局」和「恢复语义」的地方：service.js 只编排（会话 marker、
// RPC 错误码），file-tracking.js 只负责工具钩子。

import { createHash, randomBytes } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** 单文件大小上限：超过即整条 entry 记为 skipped（设计 §2.2）。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 每会话保留的 anchor 数（设计 §2.5）。 */
export const MAX_ANCHORS = 20;

/** 每会话保留的救援点数（设计 §2.5）。 */
export const MAX_RESCUES = 5;

/** 每会话保留的回收站操作数（设计 §2.5）。 */
export const MAX_TRASH_OPS = 20;

/** 回收站条目的最长保留时间：30 天。 */
export const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** blobs + trash + rescues 的软上限：1 GiB（设计 §2.5）。 */
export const SOFT_CAP_BYTES = 1024 * 1024 * 1024;

/** entry 的 schema 版本。 */
export const ENTRY_VERSION = 1;

/** entry / 计划里出现过的跳过原因。 */
export const SKIP_REASONS = Object.freeze({
  tooLarge: "too-large",
  binary: "binary",
  symlink: "symlink",
  excluded: "excluded",
  outsideCwd: "outside-cwd",
  notFile: "not-a-file",
  unreadable: "unreadable",
  invalidPath: "invalid-path",
  invalidCwd: "invalid-cwd",
  storageFull: "storage-full",
});

/** 冲突原因（设计 §2.3）。 */
export const CONFLICT_REASONS = Object.freeze({
  modifiedExternally: "modified-externally",
  missing: "missing",
  unexpectedFile: "unexpected-file",
});

/** 失败码（design §3 错误码表；service.js 直接搬上 RemoteError）。 */
export const FILE_ERROR_CODES = Object.freeze({
  conflict: "session-rewind/files-conflict",
  unavailable: "session-rewind/files-unavailable",
  rescueFailed: "session-rewind/files-rescue-failed",
  failed: "session-rewind/files-failed",
  rescueNotFound: "session-rewind/rescue-not-found",
  storage: "session-rewind/storage-unavailable",
});

/**
 * 保留/容量参数。
 * @typedef {object} FileStoreOptions
 * @property {number} maxFileBytes 单文件大小上限
 * @property {number} maxAnchors 每会话保留的 anchor 数
 * @property {number} maxRescues 每会话保留的救援点数
 * @property {number} maxTrashOps 每会话保留的回收站操作数
 * @property {number} trashMaxAgeMs 回收站最长保留时间
 * @property {number} softCapBytes blobs + trash + rescues 软上限
 * @property {number} pruneEvery 每 N 次 recordChange 触发一次 prune；0 关闭
 */

/** 默认保留/容量参数；`options` 可整体或逐项覆盖。 */
/** @type {Readonly<FileStoreOptions>} */
export const DEFAULT_OPTIONS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxAnchors: MAX_ANCHORS,
  maxRescues: MAX_RESCUES,
  maxTrashOps: MAX_TRASH_OPS,
  trashMaxAgeMs: TRASH_MAX_AGE_MS,
  softCapBytes: SOFT_CAP_BYTES,
  pruneEvery: 50,
});

/**
 * 文件引擎的结构化失败。`code` 已经是线上的完整 code（`session-rewind/...`）。
 */
export class FileStoreError extends Error {
  /**
   * @param {string} code 完整失败码
   * @param {string} message 兜底诊断文本
   * @param {Record<string, any>} [details] 结构化细节（冲突清单等）
   */
  constructor(code, message, details) {
    super(message);
    this.name = "FileStoreError";
    /** @type {string} */
    this.code = code;
    /** @type {Record<string, any>} */
    this.details = details ?? {};
  }
}

/**
 * 一条文件改动记录（entries.jsonl 一行）。
 * @typedef {object} FileEntry
 * @property {number} v schema 版本
 * @property {string} sessionId 会话 id
 * @property {number} anchorSeq 最近一条真人 user/message 的 seq（没有则 0）
 * @property {string} path 相对会话 cwd 的 POSIX 路径
 * @property {boolean} existedBefore 改动前文件是否存在
 * @property {string|null} beforeHash 改动前内容的 `sha256:<hex>`；不存在时 null
 * @property {string|null} afterHash 改动后内容的 `sha256:<hex>`；被删除时 null
 * @property {number|null} mode 改动前的权限位（不存在时 null）
 * @property {number} bytes 改动后字节数（删除时为改动前字节数）
 * @property {number} beforeBytes 改动前字节数（内部字段，便于预览统计）
 * @property {string} tool 产生改动的工具名
 * @property {string|null} callId 工具调用 id
 * @property {number} time Unix epoch 毫秒
 * @property {string} [skipped] 若该条只是「跳过的告警记录」，这里是原因
 */

/**
 * 恢复计划里的单个文件动作。
 * @typedef {object} RestoreAction
 * @property {string} path 相对 cwd 的 POSIX 路径
 * @property {"restore" | "trash"} action 写回 before 内容 / 移入回收站
 * @property {string|null} beforeHash 恢复目标内容哈希（创建时 null）
 * @property {string|null} afterHash 计划制定时记录的「最新 after」哈希
 * @property {string|null} currentHash 计划制定时读到的当前哈希（apply 前复核用）
 * @property {number} bytes 预估字节数
 * @property {number|null} mode 恢复时使用的权限位
 * @property {number} anchorSeq 该动作最早 entry 的 anchor
 */

/**
 * `planRestore` 的结果。`available === false` 表示文件模式不可用（无 entry / cwd 无效 / 有冲突）。
 * @typedef {object} RestorePlan
 * @property {boolean} available 是否可以做文件模式
 * @property {boolean} tracked 本会话是否有任何 entry（含 skipped）
 * @property {string} sessionId 会话 id
 * @property {number} targetSeq 目标 seq
 * @property {string|null} cwd 会话工作目录
 * @property {Array<{path: string, bytes: number}>} restore 将还原的文件
 * @property {Array<{path: string, bytes: number}>} trash 将移入回收站的文件
 * @property {Array<{path: string, reason: string}>} skipped 未跟踪/不可处理的文件
 * @property {Array<{path: string, reason: string}>} conflicts 冲突文件（有冲突时整体拒绝）
 * @property {Array<{code: string, message: string}>} warnings 预览告警
 * @property {number} totalBytes 影响面字节数
 * @property {RestoreAction[]} actions 执行用动作清单（applyRestore 消费）
 */

/**
 * `applyRestore` 的结果（设计 §2.4 的 receipt）。
 * @typedef {object} ApplyRestoreResult
 * @property {string[]} restored 已写回 before 内容的路径
 * @property {string[]} trashed 已移入回收站的路径
 * @property {Array<{path: string, reason: string}>} skipped 未处理（超限/符号链接等）
 * @property {Array<{path: string, reason: string}>} failed 应用失败的文件
 * @property {string|null} rescueId 救援点 id（没有执行文件写入时 null）
 * @property {string} auditId 审计 id
 * @property {string[]} rolledBack 回滚成功的路径
 * @property {Array<{path: string, reason: string}>} rollbackFailed 回滚失败的路径
 */

/**
 * 救援点 manifest。
 * @typedef {object} RescueManifest
 * @property {number} version
 * @property {string} id
 * @property {string} sessionId
 * @property {number|null} targetSeq
 * @property {string|null} auditId
 * @property {number} createdAt
 * @property {boolean} completed
 * @property {Array<{path: string, existed: boolean, sha256: string | null, mode: number | null, bytes: number}>} paths
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isSeq(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function seqOf(value, fallback = 0) {
  return isSeq(value) ? value : fallback;
}

/**
 * 把会话 id / 审计 id 变成安全的单层目录名（防 `..` 与分隔符逃逸）。
 * @param {string} value
 * @returns {string}
 */
function safeSegment(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

/**
 * 把 `sha256:<hex>` 还原成裸 hex（空白/大小写不敏感地取最后一段）。
 * @param {string} hash
 * @returns {string}
 */
function hexOf(hash) {
  const value = String(hash);
  const index = value.indexOf(":");
  return (index === -1 ? value : value.slice(index + 1)).toLowerCase();
}

/**
 * 纯路径校验：把 `input` 解释成相对 `cwd` 的 POSIX 路径，并拒绝逃逸/排除目录。
 *
 * 不做文件系统访问（符号链接与 canonical 检查在 `resolveWorkspacePath` 里）。
 * @param {string} cwd 会话工作目录（绝对路径）
 * @param {unknown} input 工具传入的路径（相对或绝对）
 * @returns {{ok: true, relPath: string, absPath: string} | {ok: false, reason: string}}
 */
export function safeRelativePath(cwd, input) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { ok: false, reason: SKIP_REASONS.invalidCwd };
  }
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    return { ok: false, reason: SKIP_REASONS.invalidPath };
  }
  const root = path.resolve(cwd);
  const target = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const relative = path.relative(root, target);
  if (relative.length === 0) return { ok: false, reason: SKIP_REASONS.invalidPath };
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, reason: SKIP_REASONS.outsideCwd };
  }
  const relPath = relative.split(path.sep).join("/");
  for (const segment of relPath.split("/")) {
    if (segment === ".git" || segment === "node_modules") {
      return { ok: false, reason: SKIP_REASONS.excluded };
    }
  }
  return { ok: true, relPath, absPath: target };
}

/**
 * 判断 `target` 是否在 `root` 内（含相等）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 默认哈希：sha256 裸 hex（blob 路径用）。
 * @param {Buffer} buffer
 * @returns {string}
 */
function defaultDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * @param {number} [bytes]
 * @returns {string}
 */
function defaultRandomHex(bytes = 6) {
  return randomBytes(bytes).toString("hex");
}

/**
 * @typedef {object} CreateFileStoreOptions
 * @property {string} [home] DSH 数据根（插件目录为其下 `session-rewind/`）；`dataRoot` 的别名
 * @property {string} [dataRoot] DSH 数据根；插件目录为其下 `session-rewind/`
 * @property {string} [pluginDir] 直接指定插件数据目录（覆盖 `<dataRoot>/session-rewind`）
 * @property {typeof defaultFs} [fs] 注入的 fs/promises 实现（测试用）
 * @property {() => number} [now] 注入的时钟
 * @property {(buffer: Buffer) => string} [hash] 注入的哈希函数，返回裸 hex
 * @property {(bytes?: number) => string} [randomHex] 注入的随机串
 * @property {{warn?: (message: string) => void}} [logger] 日志（自动维护失败时告警）
 * @property {Partial<FileStoreOptions> & {rescueKeep?: number}} [options] 保留/容量参数
 */

/**
 * 创建文件引擎实例。
 *
 * 所有方法都通过闭包而不是 `this`，因此可以安全解构；数据根在创建时固定。
 * @param {CreateFileStoreOptions} [input]
 */
export function createFileStore(input = {}) {
  const fs = input.fs ?? defaultFs;
  const dataRoot = path.resolve(
    input.dataRoot ?? input.home ?? process.env.DSH_HOME ?? path.join(homedir(), ".dsh"),
  );
  const home = path.resolve(input.pluginDir ?? path.join(dataRoot, "session-rewind"));
  /** @type {FileStoreOptions} */
  const options = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) };
  // `rescueKeep` 是早期配置名，等价于 maxRescues（保持兼容）。
  if (typeof input.options?.rescueKeep === "number" && input.options?.maxRescues === undefined) {
    options.maxRescues = input.options.rescueKeep;
  }
  const logger = input.logger;
  const now = typeof input.now === "function" ? input.now : () => Date.now();
  const digest = typeof input.hash === "function" ? input.hash : defaultDigest;
  const randomHex = typeof input.randomHex === "function" ? input.randomHex : defaultRandomHex;

  /** 捕获是否因软上限被暂停（prune 后仍然超限时为 true）。 */
  const state = { captureBlocked: false, lastPruneAt: 0, writesSincePrune: 0 };

  /** @type {Promise<void> | null} */
  let readyPromise = null;
  let tmpCounter = 0;

  // ---------------------------------------------------------------- 路径

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  function sessionDirOf(sessionId) {
    return path.join(home, "sessions", safeSegment(sessionId));
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  function entriesFileOf(sessionId) {
    return path.join(sessionDirOf(sessionId), "entries.jsonl");
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  function sessionMetaFileOf(sessionId) {
    return path.join(sessionDirOf(sessionId), "meta.json");
  }

  /**
   * @param {string} sessionId
   * @param {string} auditId
   * @returns {string}
   */
  function trashDirOf(sessionId, auditId) {
    return path.join(home, "trash", safeSegment(sessionId), safeSegment(auditId));
  }

  /**
   * @param {string} sessionId
   * @param {string} rescueId
   * @returns {string}
   */
  function rescueDirOf(sessionId, rescueId) {
    return path.join(home, "rescues", safeSegment(sessionId), safeSegment(rescueId));
  }

  /**
   * @param {string} hash
   * @returns {string}
   */
  function blobPathOf(hash) {
    const hex = hexOf(hash);
    if (hex.length < 2) {
      throw new FileStoreError(FILE_ERROR_CODES.storage, `invalid blob hash "${String(hash)}"`);
    }
    return path.join(home, "blobs", hex.slice(0, 2), hex);
  }

  /**
   * POSIX 相对路径 -> 绝对路径。
   * @param {string} root
   * @param {string} relPath
   * @returns {string}
   */
  function joinRelative(root, relPath) {
    return path.join(root, ...relPath.split("/"));
  }

  // ---------------------------------------------------------------- 低层 IO

  /**
   * 原子写：同目录临时文件 + rename。`mode` 会先 chmod 临时文件再改名字。
   * @param {string} filePath
   * @param {string | Uint8Array} data
   * @param {number} [mode]
   * @returns {Promise<void>}
   */
  async function writeFileAtomic(filePath, data, mode) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    tmpCounter += 1;
    const tmp = path.join(dir, `.tmp-${process.pid}-${tmpCounter}-${randomHex(4)}`);
    try {
      await fs.writeFile(tmp, data);
      if (typeof mode === "number") await fs.chmod(tmp, mode);
      await fs.rename(tmp, filePath);
    } catch (error) {
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        // 清理失败不影响原始错误
      }
      throw error;
    }
  }

  /**
   * @param {string} filePath
   * @param {unknown} value
   * @returns {Promise<void>}
   */
  async function writeJsonAtomic(filePath, value) {
    await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * @param {string} filePath
   * @returns {Promise<any | null>}
   */
  async function readJson(filePath) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} dir
   * @returns {Promise<string[]>} 排序后的直接子目录名
   */
  async function listSubdirs(dir) {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return items
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort();
  }

  /**
   * 递归统计目录的字节数与文件数（跳过符号链接与非普通文件）。
   * @param {string} dir
   * @returns {Promise<{bytes: number, files: number}>}
   */
  async function dirStats(dir) {
    /** @type {string[]} */
    const stack = [dir];
    let bytes = 0;
    let files = 0;
    while (stack.length > 0) {
      const current = /** @type {string} */ (stack.pop());
      let items;
      try {
        items = await fs.readdir(current, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      for (const item of items) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!item.isFile()) continue;
        try {
          const info = await fs.stat(full);
          bytes += info.size;
          files += 1;
        } catch {
          // 并发删除等情况忽略
        }
      }
    }
    return { bytes, files };
  }

  /**
   * @param {string} target
   * @returns {Promise<number>}
   */
  async function sizeOf(target) {
    let info;
    try {
      info = await fs.lstat(target);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    }
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    return (await dirStats(target)).bytes;
  }

  /**
   * 递归删除（仅用于回收站/救援点里我们自己的副本；调用方保证数据有副本）。
   * @param {string} target
   * @returns {Promise<void>}
   */
  async function removeTree(target) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2 });
  }

  /**
   * 移动文件；跨设备时退化为「读 + 原子写 + 删源」。
   * @param {string} source
   * @param {string} destination
   * @param {number} [mode]
   * @returns {Promise<void>}
   */
  async function moveFile(source, destination, mode) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      if (errorCode(error) !== "EXDEV") throw error;
    }
    const buffer = await fs.readFile(source);
    await writeFileAtomic(destination, buffer, mode);
    await fs.rm(source, { force: true });
  }

  // ---------------------------------------------------------------- 哈希/文本

  /**
   * @param {Uint8Array} buffer
   * @returns {string} `sha256:<hex>`
   */
  function hashOf(buffer) {
    return `sha256:${digest(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))}`;
  }

  /**
   * 严格解码 UTF-8；含 NUL 或非法编码返回 null（设计 §2.2：二进制不追踪）。
   * @param {Buffer} buffer
   * @returns {string | null}
   */
  function decodeText(buffer) {
    if (buffer.includes(0)) return null;
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) return null;
    return text;
  }

  /**
   * @param {string} text
   * @returns {Buffer}
   */
  function bufferOf(text) {
    return Buffer.from(text, "utf8");
  }

  // ---------------------------------------------------------------- 初始化

  async function ensureReady() {
    if (readyPromise === null) {
      readyPromise = (async () => {
        await fs.mkdir(home, { recursive: true });
        if ((await readJson(path.join(home, "meta.json"))) === null) {
          await writeJsonAtomic(path.join(home, "meta.json"), { version: 1, createdAt: now() });
        }
        for (const dir of ["blobs", "sessions", "trash", "rescues"]) {
          await fs.mkdir(path.join(home, dir), { recursive: true });
        }
      })();
      readyPromise = readyPromise.catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  /**
   * 记录/更新会话 meta（cwd 首次写入后不改，避免会话目录被移动时误覆盖）。
   * @param {string} sessionId
   * @param {string | undefined} cwd
   * @returns {Promise<void>}
   */
  async function ensureSessionMeta(sessionId, cwd) {
    const file = sessionMetaFileOf(sessionId);
    const existing = await readJson(file);
    if (isRecord(existing)) {
      if (cwd !== undefined && typeof existing.cwd !== "string") {
        await writeJsonAtomic(file, { ...existing, cwd });
      }
      return;
    }
    await writeJsonAtomic(file, {
      version: 1,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      createdAt: now(),
    });
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<string | null>}
   */
  async function sessionCwdOf(sessionId) {
    const meta = await readJson(sessionMetaFileOf(sessionId));
    return isRecord(meta) && typeof meta.cwd === "string" && meta.cwd.length > 0 ? meta.cwd : null;
  }

  // ---------------------------------------------------------------- blob

  /**
   * @param {Buffer} buffer
   * @returns {Promise<{hash: string, bytes: number}>}
   */
  async function putBlob(buffer) {
    await ensureReady();
    const hash = hashOf(buffer);
    const file = blobPathOf(hash);
    let exists = true;
    try {
      await fs.stat(file);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) await writeFileAtomic(file, buffer);
    return { hash, bytes: buffer.length };
  }

  /**
   * @param {string | null} hash
   * @returns {Promise<Buffer | null>}
   */
  async function readBlob(hash) {
    if (typeof hash !== "string" || hash.length === 0) return null;
    try {
      return await fs.readFile(blobPathOf(hash));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------- entry 日志

  /** @type {Map<string, {size: number, entries: FileEntry[]}>} */
  const entryCache = new Map();

  /**
   * @param {unknown} value
   * @returns {value is FileEntry}
   */
  function isFileEntry(value) {
    return (
      isRecord(value) &&
      isSeq(value.anchorSeq) &&
      typeof value.path === "string" &&
      value.path.length > 0
    );
  }

  /**
   * 读取并解析会话 entries（带按文件大小的增量缓存）。
   * 坏行跳过但保留原文件内容（下次重写时才丢弃）。
   * @param {string} sessionId
   * @returns {Promise<FileEntry[]>}
   */
  async function readEntries(sessionId) {
    const file = entriesFileOf(sessionId);
    let size;
    try {
      const info = await fs.stat(file);
      size = info.size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        entryCache.delete(sessionId);
        return [];
      }
      throw error;
    }
    const cached = entryCache.get(sessionId);
    if (cached !== undefined && cached.size === size) return cached.entries;
    const text = await fs.readFile(file, "utf8");
    /** @type {FileEntry[]} */
    const entries = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isFileEntry(parsed)) entries.push(parsed);
    }
    entryCache.set(sessionId, { size, entries });
    return entries;
  }

  /**
   * 原子重写会话 entries。
   * @param {string} sessionId
   * @param {FileEntry[]} entries
   * @returns {Promise<void>}
   */
  async function writeEntries(sessionId, entries) {
    const file = entriesFileOf(sessionId);
    const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await writeFileAtomic(file, body);
    const info = await fs.stat(file);
    entryCache.set(sessionId, { size: info.size, entries: [...entries] });
  }

  /**
   * 追加一条 entry（O_APPEND，单行 JSON）。
   * @param {string} sessionId
   * @param {FileEntry} entry
   * @returns {Promise<void>}
   */
  async function appendEntry(sessionId, entry) {
    await ensureReady();
    await fs.mkdir(sessionDirOf(sessionId), { recursive: true });
    const file = entriesFileOf(sessionId);
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
    const info = await fs.stat(file);
    const cached = entryCache.get(sessionId);
    if (cached !== undefined)
      entryCache.set(sessionId, { size: info.size, entries: [...cached.entries, entry] });
  }

  /**
   * `entriesForSession`：解析后的 entry 数组（含 skipped 告警记录），供 service 层复用。
   * @param {string} sessionId
   * @returns {Promise<FileEntry[]>}
   */
  async function entriesForSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return [];
    return [...(await readEntries(sessionId))];
  }

  /**
   * 归一化「对象或位置参数」两种调用形式。
   * @param {any} query
   * @param {unknown} [targetSeq]
   * @returns {{sessionId: string, targetSeq: number, cwd: string | undefined}}
   */
  function normalizeQuery(query, targetSeq) {
    if (typeof query === "string") {
      return { sessionId: query, targetSeq: seqOf(targetSeq), cwd: undefined };
    }
    const record = isRecord(query) ? query : {};
    return {
      sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
      targetSeq: seqOf(record.targetSeq ?? targetSeq),
      cwd: typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined,
    };
  }

  // ---------------------------------------------------------------- 路径解析

  /**
   * @typedef {object} ResolvedWorkspacePath
   * @property {true} ok
   * @property {string} relPath
   * @property {string} absPath
   * @property {boolean} existed
   * @property {number | null} mode
   * @property {number} bytes
   * @property {boolean} symlink
   */

  /**
   * @typedef {object} PathSkip
   * @property {false} ok
   * @property {string} reason
   * @property {number} [bytes]
   */

  /**
   * 找到从 `target` 往上第一个存在的路径并 realpath（用于 canonical 校验）。
   * @param {string} target
   * @returns {Promise<string>}
   */
  async function realpathDeepest(target) {
    let current = target;
    for (let depth = 0; depth < 64; depth++) {
      try {
        return await fs.realpath(current);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
    return current;
  }

  /**
   * 解析工具传入的路径：纯校验 + canonical（realpath 已存在部分）+ 文件类型检查。
   *
   * 拒绝：逃逸 cwd、`.git`/`node_modules`、符号链接、非普通文件、插件自己的数据目录。
   * @param {string} cwd 会话工作目录
   * @param {unknown} input 工具传入的路径
   * @returns {Promise<ResolvedWorkspacePath | PathSkip>}
   */
  async function resolveWorkspacePath(cwd, input) {
    const base = safeRelativePath(cwd, input);
    if (!base.ok) return base;
    if (isInside(home, base.absPath)) return { ok: false, reason: SKIP_REASONS.excluded };
    let realRoot;
    let realDir;
    try {
      realRoot = await fs.realpath(path.resolve(cwd));
      realDir = await realpathDeepest(path.dirname(base.absPath));
    } catch (error) {
      return {
        ok: false,
        reason: errorCode(error) === "ENOENT" ? SKIP_REASONS.invalidCwd : SKIP_REASONS.unreadable,
      };
    }
    if (!isInside(realRoot, realDir)) return { ok: false, reason: SKIP_REASONS.outsideCwd };
    let info;
    try {
      info = await fs.lstat(base.absPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { ok: false, reason: SKIP_REASONS.unreadable };
      info = null;
    }
    if (info?.isSymbolicLink()) return { ok: false, reason: SKIP_REASONS.symlink };
    if (info !== null && !info.isFile()) return { ok: false, reason: SKIP_REASONS.notFile };
    return {
      ok: true,
      relPath: base.relPath,
      absPath: base.absPath,
      existed: info !== null,
      mode: info === null ? null : info.mode & 0o777,
      bytes: info === null ? 0 : info.size,
      symlink: false,
    };
  }

  // ---------------------------------------------------------------- before 捕获

  /**
   * @typedef {object} CapturedFile
   * @property {true} ok
   * @property {string} path 相对 cwd 的 POSIX 路径
   * @property {string} absPath 绝对路径
   * @property {boolean} existedBefore
   * @property {Buffer | null} content
   * @property {string | null} text
   * @property {number | null} mode
   * @property {number} bytes
   */

  /**
   * @typedef {object} CaptureSkipResult
   * @property {false} ok
   * @property {string} path 原始/相对路径（尽力给出）
   * @property {string} reason 跳过原因
   * @property {number} [bytes]
   */

  /**
   * 读取 before 状态（不写任何东西）。超限/二进制/符号链接/排除目录都返回结构化 skip。
   * @param {string} cwd
   * @param {unknown} input
   * @returns {Promise<CapturedFile | CaptureSkipResult>}
   */
  async function captureBefore(cwd, input) {
    const resolved = await resolveWorkspacePath(cwd, input);
    if (!resolved.ok) {
      return {
        ok: false,
        path: typeof input === "string" ? input : "",
        reason: resolved.reason,
        ...(typeof resolved.bytes === "number" ? { bytes: resolved.bytes } : {}),
      };
    }
    if (!resolved.existed) {
      return {
        ok: true,
        path: resolved.relPath,
        absPath: resolved.absPath,
        existedBefore: false,
        content: null,
        text: null,
        mode: null,
        bytes: 0,
      };
    }
    let buffer;
    try {
      buffer = await fs.readFile(resolved.absPath);
    } catch {
      return {
        ok: false,
        path: resolved.relPath,
        reason: SKIP_REASONS.unreadable,
        bytes: resolved.bytes,
      };
    }
    if (buffer.length > options.maxFileBytes) {
      return {
        ok: false,
        path: resolved.relPath,
        reason: SKIP_REASONS.tooLarge,
        bytes: buffer.length,
      };
    }
    const text = decodeText(buffer);
    if (text === null) {
      return {
        ok: false,
        path: resolved.relPath,
        reason: SKIP_REASONS.binary,
        bytes: buffer.length,
      };
    }
    return {
      ok: true,
      path: resolved.relPath,
      absPath: resolved.absPath,
      existedBefore: true,
      content: buffer,
      text,
      mode: resolved.mode,
      bytes: buffer.length,
    };
  }

  // ---------------------------------------------------------------- 写入 entry

  /**
   * 规范化改动内容：string -> Buffer；null 表示「不存在」；undefined 表示「未知」。
   * @param {string | Buffer | Uint8Array | null | undefined} content
   * @returns {Buffer | null | undefined}
   */
  function contentBuffer(content) {
    if (content === null || content === undefined) return content;
    if (typeof content === "string") return bufferOf(content);
    if (Buffer.isBuffer(content)) return content;
    return Buffer.from(content);
  }

  /**
   * @typedef {object} RecordChangeInput
   * @property {string} sessionId 会话 id
   * @property {string} [cwd] 会话工作目录（写入会话 meta 用）
   * @property {number} [anchorSeq] 最近的真人 user/message seq
   * @property {string} [tool] 工具名
   * @property {string | null} [callId] 调用 id
   * @property {unknown} path 改动路径（相对或绝对）
   * @property {boolean} [existedBefore] 显式覆盖「改动前是否存在」
   * @property {string | Buffer | Uint8Array | null} [beforeContent] 改动前内容
   * @property {string | Buffer | Uint8Array | null} [afterContent] 改动后内容
   * @property {number | null} [mode] 改动前权限位
   */

  /**
   * 记录一次成功的文件改动：存 before/after blob + 追加 entry。
   *
   * 超限/二进制/路径不合法都会落一条 `skipped` 告警 entry（不阻断工具），
   * 返回 `{ok:false, reason}`。软上限暂停捕获时返回 `storage-full` 且不写盘。
   * @param {RecordChangeInput} change
   * @returns {Promise<{ok: true, entry: FileEntry} | {ok: false, path: string, reason: string, entry?: FileEntry}>}
   */
  async function recordChange(change) {
    const sessionId = typeof change.sessionId === "string" ? change.sessionId : "";
    if (sessionId.length === 0) return { ok: false, path: "", reason: SKIP_REASONS.invalidPath };
    if (state.captureBlocked) {
      return { ok: false, path: String(change.path ?? ""), reason: SKIP_REASONS.storageFull };
    }
    const resolved = await resolveWorkspacePath(
      change.cwd ?? (await sessionCwdOf(sessionId)) ?? "",
      change.path,
    );
    if (!resolved.ok) {
      return {
        ok: false,
        path: typeof change.path === "string" ? change.path : "",
        reason: resolved.reason,
      };
    }
    const before = contentBuffer(change.beforeContent);
    const after = contentBuffer(change.afterContent);
    if (before === undefined || after === undefined) {
      return { ok: false, path: resolved.relPath, reason: SKIP_REASONS.unreadable };
    }
    const existedBefore =
      typeof change.existedBefore === "boolean" ? change.existedBefore : before !== null;
    const beforeBytes = before === null ? 0 : before.length;
    const afterBytes = after === null ? 0 : after.length;
    const tooLarge = Math.max(beforeBytes, afterBytes) > options.maxFileBytes;
    const binary =
      (before !== null && decodeText(before) === null) ||
      (after !== null && decodeText(after) === null);

    /**
     * @param {string} reason
     * @returns {Promise<{ok: false, path: string, reason: string, entry: FileEntry}>}
     */
    async function skip(reason) {
      /** @type {FileEntry} */
      const entry = {
        v: ENTRY_VERSION,
        sessionId,
        anchorSeq: seqOf(change.anchorSeq),
        path: resolved.ok ? resolved.relPath : String(change.path ?? ""),
        existedBefore: false,
        beforeHash: null,
        afterHash: null,
        mode: null,
        bytes: Math.max(beforeBytes, afterBytes),
        beforeBytes: 0,
        tool: typeof change.tool === "string" ? change.tool : "unknown",
        callId: typeof change.callId === "string" ? change.callId : null,
        time: now(),
        skipped: reason,
      };
      await ensureSessionMeta(sessionId, change.cwd);
      await appendEntry(sessionId, entry);
      return { ok: false, path: entry.path, reason, entry };
    }

    if (tooLarge) return skip(SKIP_REASONS.tooLarge);
    if (binary) return skip(SKIP_REASONS.binary);

    await ensureSessionMeta(sessionId, change.cwd);
    const beforeBlob = before === null ? null : await putBlob(before);
    const afterBlob = after === null ? null : await putBlob(after);
    if (before === null && after === null) {
      return { ok: false, path: resolved.relPath, reason: SKIP_REASONS.unreadable };
    }
    /** @type {FileEntry} */
    const entry = {
      v: ENTRY_VERSION,
      sessionId,
      anchorSeq: seqOf(change.anchorSeq),
      path: resolved.relPath,
      existedBefore,
      beforeHash: beforeBlob === null ? null : beforeBlob.hash,
      afterHash: afterBlob === null ? null : afterBlob.hash,
      mode: existedBefore ? (change.mode ?? resolved.mode ?? null) : null,
      bytes: afterBytes,
      beforeBytes,
      tool: typeof change.tool === "string" ? change.tool : "unknown",
      callId: typeof change.callId === "string" ? change.callId : null,
      time: now(),
    };
    await appendEntry(sessionId, entry);
    state.writesSincePrune += 1;
    if (options.pruneEvery > 0 && state.writesSincePrune >= options.pruneEvery) {
      state.writesSincePrune = 0;
      try {
        await prune({});
      } catch (error) {
        try {
          logger?.warn?.(`session-rewind/files: automatic prune failed: ${messageOf(error)}`);
        } catch {
          // 日志失败也不影响捕获
        }
      }
    }
    return { ok: true, entry };
  }

  // ---------------------------------------------------------------- 计划

  /**
   * @typedef {object} CurrentState
   * @property {boolean} exists
   * @property {string | null} hash
   * @property {number} bytes
   * @property {number | null} mode
   * @property {boolean} symlink
   */

  /**
   * 读当前文件状态（存在性 + sha256）。
   * @param {string} cwd
   * @param {string} relPath
   * @returns {Promise<CurrentState>}
   */
  async function currentStateOf(cwd, relPath) {
    const absPath = joinRelative(cwd, relPath);
    let info;
    try {
      info = await fs.lstat(absPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { exists: false, hash: null, bytes: 0, mode: null, symlink: false };
      }
      throw error;
    }
    if (info.isSymbolicLink())
      return { exists: false, hash: null, bytes: 0, mode: null, symlink: true };
    if (!info.isFile()) return { exists: false, hash: null, bytes: 0, mode: null, symlink: false };
    try {
      const buffer = await fs.readFile(absPath);
      return {
        exists: true,
        hash: hashOf(buffer),
        bytes: buffer.length,
        mode: info.mode & 0o777,
        symlink: false,
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { exists: false, hash: null, bytes: 0, mode: null, symlink: false };
      }
      return {
        exists: true,
        hash: null,
        bytes: info.size,
        mode: info.mode & 0o777,
        symlink: false,
      };
    }
  }

  /**
   * 计算恢复计划（**只读，不写任何东西**）。
   *
   * 选中 `anchorSeq >= targetSeq` 的 entry；每个 path 取最早一条的 before 作为恢复目标，
   * 最后一条的 after 作为「当前应该是什么样」；不一致即冲突（设计 §2.3）。
   * @param {any} query `{sessionId, targetSeq, cwd?}` 或 `(sessionId, targetSeq)`
   * @param {unknown} [targetSeqArg]
   * @returns {Promise<RestorePlan>}
   */
  async function planRestore(query, targetSeqArg) {
    const { sessionId, targetSeq, cwd: requestCwd } = normalizeQuery(query, targetSeqArg);
    /** @type {RestorePlan} */
    const plan = {
      available: false,
      tracked: false,
      sessionId,
      targetSeq,
      cwd: null,
      restore: [],
      trash: [],
      skipped: [],
      conflicts: [],
      warnings: [],
      totalBytes: 0,
      actions: [],
    };
    /** @type {FileEntry[]} */
    let entries;
    try {
      entries = await readEntries(sessionId);
    } catch (error) {
      plan.warnings.push({ code: "files-unreadable", message: messageOf(error) });
      return plan;
    }
    plan.tracked = entries.length > 0;
    const selected = entries.filter(
      (entry) =>
        entry.skipped === undefined && isSeq(entry.anchorSeq) && entry.anchorSeq >= targetSeq,
    );
    const skippedSelected = entries.filter(
      (entry) =>
        entry.skipped !== undefined && isSeq(entry.anchorSeq) && entry.anchorSeq >= targetSeq,
    );
    const cwd = requestCwd ?? (await sessionCwdOf(sessionId));
    if (cwd === null) {
      plan.warnings.push({
        code: "files-unavailable",
        message: "session working directory is unknown",
      });
      return plan;
    }
    try {
      const info = await fs.stat(cwd);
      if (!info.isDirectory()) throw new Error(`${cwd} is not a directory`);
    } catch (error) {
      plan.warnings.push({
        code: "files-unavailable",
        message: `session working directory is unavailable: ${messageOf(error)}`,
      });
      return plan;
    }
    plan.cwd = cwd;

    /** @type {Map<string, {path: string, first: FileEntry, latest: FileEntry}>} */
    const groups = new Map();
    for (const entry of selected) {
      const group = groups.get(entry.path);
      if (group === undefined) {
        groups.set(entry.path, { path: entry.path, first: entry, latest: entry });
      } else {
        group.latest = entry;
      }
    }

    for (const group of groups.values()) {
      const beforeHash = group.first.existedBefore ? group.first.beforeHash : null;
      const afterHash = group.latest.afterHash ?? null;
      const current = await currentStateOf(cwd, group.path);
      if (current.symlink) {
        plan.skipped.push({ path: group.path, reason: SKIP_REASONS.symlink });
        continue;
      }
      if (!current.exists) {
        if (afterHash !== null) {
          plan.conflicts.push({ path: group.path, reason: CONFLICT_REASONS.missing });
        }
        continue;
      }
      if (afterHash === null) {
        plan.conflicts.push({ path: group.path, reason: CONFLICT_REASONS.unexpectedFile });
        continue;
      }
      if (current.hash === null || current.hash !== afterHash) {
        plan.conflicts.push({ path: group.path, reason: CONFLICT_REASONS.modifiedExternally });
        continue;
      }
      if (beforeHash === afterHash) continue;
      plan.actions.push({
        path: group.path,
        action: beforeHash === null ? "trash" : "restore",
        beforeHash,
        afterHash,
        currentHash: current.hash,
        bytes: beforeHash === null ? current.bytes : Math.max(group.first.beforeBytes ?? 0, 0),
        mode: group.first.mode ?? null,
        anchorSeq: group.first.anchorSeq,
      });
    }

    /** @type {Map<string, string>} */
    const skippedByPath = new Map();
    for (const entry of skippedSelected) {
      if (entry.skipped === undefined) continue;
      if (!skippedByPath.has(entry.path)) skippedByPath.set(entry.path, entry.skipped);
    }
    for (const [skippedPath, reason] of skippedByPath) {
      if (!groups.has(skippedPath)) plan.skipped.push({ path: skippedPath, reason });
    }

    for (const action of plan.actions) {
      if (action.action === "restore")
        plan.restore.push({ path: action.path, bytes: action.bytes });
      else plan.trash.push({ path: action.path, bytes: action.bytes });
      plan.totalBytes += action.bytes;
    }
    if (plan.skipped.length > 0) {
      plan.warnings.push({
        code: "files-skipped",
        message: `${plan.skipped.length} file(s) were not tracked (over 8 MiB, unreadable, or symbolic link)`,
      });
    }
    plan.available = plan.conflicts.length === 0 && plan.actions.length > 0;
    return plan;
  }

  /**
   * 轻量汇总（candidates 的 hasFiles/fileCount 用）。
   * @param {any} query `{sessionId, targetSeq}` 或 `(sessionId, targetSeq)`
   * @param {unknown} [targetSeqArg]
   * @returns {Promise<{tracked: boolean, anchorCount: number, fileCount: number, totalBytes: number, available: boolean}>}
   */
  async function summarize(query, targetSeqArg) {
    const { sessionId, targetSeq } = normalizeQuery(query, targetSeqArg);
    /** @type {FileEntry[]} */
    let entries;
    try {
      entries = await readEntries(sessionId);
    } catch {
      entries = [];
    }
    const selected = entries.filter(
      (entry) =>
        entry.skipped === undefined && isSeq(entry.anchorSeq) && entry.anchorSeq >= targetSeq,
    );
    /** @type {Map<string, number>} */
    const bytesByPath = new Map();
    /** @type {Set<number>} */
    const anchors = new Set();
    for (const entry of selected) {
      anchors.add(entry.anchorSeq);
      const bytes = Math.max(entry.beforeBytes ?? 0, entry.bytes ?? 0);
      bytesByPath.set(entry.path, Math.max(bytesByPath.get(entry.path) ?? 0, bytes));
    }
    let totalBytes = 0;
    for (const bytes of bytesByPath.values()) totalBytes += bytes;
    return {
      tracked: entries.length > 0,
      anchorCount: anchors.size,
      fileCount: bytesByPath.size,
      totalBytes,
      available: bytesByPath.size > 0,
    };
  }

  // ---------------------------------------------------------------- 救援点

  /**
   * @returns {string}
   */
  function newId() {
    return `${String(now()).padStart(13, "0")}-${randomHex(4)}`;
  }

  /**
   * 救援点里的文件路径。
   * @param {string} rescueDir
   * @param {string} relPath
   * @returns {string}
   */
  function rescueFileOf(rescueDir, relPath) {
    return joinRelative(path.join(rescueDir, "files"), relPath);
  }

  /**
   * @param {string} sessionId
   * @param {string} rescueId
   * @returns {Promise<{rescueId: string, dir: string, manifest: RescueManifest} | null>}
   */
  async function loadRescue(sessionId, rescueId) {
    const dir = rescueDirOf(sessionId, rescueId);
    const manifest = await readJson(path.join(dir, "manifest.json"));
    if (!isRecord(manifest)) return null;
    return { rescueId, dir, manifest: /** @type {RescueManifest} */ (manifest) };
  }

  /**
   * 创建救援点：把计划影响到的、当前存在的文件各复制一份（设计 §2.4 步骤 2）。
   *
   * 任一复制失败 -> 抛 `files-rescue-failed`，并清掉这次写出来的半成品目录。
   * @param {{sessionId: string, cwd?: string, plan: RestorePlan, auditId?: string | null}} request
   * @returns {Promise<{rescueId: string, manifest: RescueManifest, dir: string}>}
   */
  async function createRescue(request) {
    const sessionId = typeof request?.sessionId === "string" ? request.sessionId : "";
    const plan = request?.plan;
    const cwd = request?.cwd ?? plan?.cwd ?? (await sessionCwdOf(sessionId));
    if (sessionId.length === 0 || cwd === null || cwd === undefined) {
      throw new FileStoreError(
        FILE_ERROR_CODES.rescueFailed,
        "cannot create a rescue without session cwd",
      );
    }
    const rescueId = newId();
    const dir = rescueDirOf(sessionId, rescueId);
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];
    /** @type {RescueManifest["paths"]} */
    const manifestPaths = [];
    try {
      await ensureReady();
      for (const action of actions) {
        const safe = safeRelativePath(cwd, action.path);
        if (!safe.ok) throw new Error(`refusing to rescue ${action.path}: ${safe.reason}`);
        const absPath = safe.absPath;
        let info;
        try {
          info = await fs.lstat(absPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
          info = null;
        }
        if (info === null) {
          manifestPaths.push({
            path: safe.relPath,
            existed: false,
            sha256: null,
            mode: null,
            bytes: 0,
          });
          continue;
        }
        if (!info.isFile()) throw new Error(`cannot rescue ${safe.relPath}: not a regular file`);
        const buffer = await fs.readFile(absPath);
        const mode = info.mode & 0o777;
        await writeFileAtomic(rescueFileOf(dir, safe.relPath), buffer, mode);
        manifestPaths.push({
          path: safe.relPath,
          existed: true,
          sha256: hashOf(buffer),
          mode,
          bytes: buffer.length,
        });
      }
      /** @type {RescueManifest} */
      const manifest = {
        version: 1,
        id: rescueId,
        sessionId,
        targetSeq: isSeq(plan?.targetSeq) ? plan.targetSeq : null,
        auditId: typeof request?.auditId === "string" ? request.auditId : null,
        createdAt: now(),
        completed: true,
        paths: manifestPaths,
      };
      await writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
      return { rescueId, manifest, dir };
    } catch (error) {
      try {
        await removeTree(dir);
      } catch {
        // 半成品清理失败保留现场即可
      }
      throw new FileStoreError(
        FILE_ERROR_CODES.rescueFailed,
        `cannot create rescue point: ${messageOf(error)}`,
      );
    }
  }

  /**
   * 丢弃一个救援点（例如 marker 追加失败后回滚用；设计 §2.4 步骤 3）。
   * @param {{sessionId: string, rescueId: string}} request
   * @returns {Promise<boolean>}
   */
  async function discardRescue(request) {
    const loaded = await loadRescue(request?.sessionId ?? "", request?.rescueId ?? "");
    if (loaded === null) return false;
    await removeTree(loaded.dir);
    return true;
  }

  /**
   * 列出会话的救援点（最新在前）。`request` 既可以是 `{sessionId}`，也可以是裸 sessionId。
   * @param {{sessionId: string} | string} request
   * @returns {Promise<Array<{id: string, time: number, targetSeq: number | null, auditId: string | null, completed: boolean, paths: Array<{path: string, existed: boolean, bytes: number}>}>>}
   */
  async function listRescues(request) {
    const sessionId = typeof request === "string" ? request : (request?.sessionId ?? "");
    const sessionDir = path.join(home, "rescues", safeSegment(sessionId));
    const ids = await listSubdirs(sessionDir);
    /** @type {Array<{id: string, time: number, targetSeq: number | null, auditId: string | null, completed: boolean, paths: Array<{path: string, existed: boolean, bytes: number}>}>} */
    const rescues = [];
    for (const id of ids) {
      const manifest = await readJson(path.join(sessionDir, id, "manifest.json"));
      if (!isRecord(manifest)) continue;
      const paths = Array.isArray(manifest.paths) ? manifest.paths : [];
      rescues.push({
        id,
        time: seqOf(manifest.createdAt),
        targetSeq: isSeq(manifest.targetSeq) ? manifest.targetSeq : null,
        auditId: typeof manifest.auditId === "string" ? manifest.auditId : null,
        completed: manifest.completed === true,
        paths: paths
          .filter((entry) => isRecord(entry) && typeof entry.path === "string")
          .map((entry) => ({
            path: entry.path,
            existed: entry.existed === true,
            bytes: seqOf(entry.bytes),
          })),
      });
    }
    rescues.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    return rescues;
  }

  /**
   * 从救援点写回文件。
   *
   * 安全：先对当前受影响文件再存一份「rescue-of-rescue」，再写回；被恢复文件当前不存在就创建，
   * 多余文件不动（设计 §3 restoreRescue）。
   * @param {{sessionId: string, cwd?: string, rescueId: string}} request
   * @returns {Promise<{rescueId: string, safetyRescueId: string, restored: string[], failed: Array<{path: string, reason: string}>}>}
   */
  async function restoreRescue(request) {
    const sessionId = request?.sessionId ?? "";
    const rescueId = request?.rescueId ?? "";
    const loaded = await loadRescue(sessionId, rescueId);
    if (loaded === null) {
      throw new FileStoreError(
        FILE_ERROR_CODES.rescueNotFound,
        `rescue "${rescueId}" was not found`,
      );
    }
    const cwd = request?.cwd ?? (await sessionCwdOf(sessionId));
    if (cwd === null || cwd === undefined) {
      throw new FileStoreError(
        FILE_ERROR_CODES.unavailable,
        "session working directory is unknown",
      );
    }
    const savedPaths = Array.isArray(loaded.manifest.paths) ? loaded.manifest.paths : [];
    const safetyPlan = {
      ...planRestoreShell(),
      cwd,
      actions: savedPaths.map((entry) => ({
        path: entry.path,
        action: /** @type {"restore"} */ ("restore"),
        beforeHash: null,
        afterHash: null,
        currentHash: null,
        bytes: seqOf(entry.bytes),
        mode: entry.mode ?? null,
        anchorSeq: 0,
      })),
    };
    const safety = await createRescue({ sessionId, cwd, plan: safetyPlan });
    /** @type {string[]} */
    const restored = [];
    /** @type {Array<{path: string, reason: string}>} */
    const failed = [];
    for (const saved of savedPaths) {
      if (saved.existed !== true) continue;
      try {
        const safe = safeRelativePath(cwd, saved.path);
        if (!safe.ok) throw new Error(safe.reason);
        const buffer = await fs.readFile(rescueFileOf(loaded.dir, safe.relPath));
        if (typeof saved.sha256 === "string" && hashOf(buffer) !== saved.sha256) {
          throw new Error("rescue content hash mismatch");
        }
        await writeFileAtomic(safe.absPath, buffer, saved.mode ?? undefined);
        restored.push(safe.relPath);
      } catch (error) {
        failed.push({ path: String(saved.path), reason: messageOf(error) });
      }
    }
    return { rescueId, safetyRescueId: safety.rescueId, restored, failed };
  }

  /**
   * 空计划外壳（内部复用）。
   * @returns {RestorePlan}
   */
  function planRestoreShell() {
    return {
      available: false,
      tracked: false,
      sessionId: "",
      targetSeq: 0,
      cwd: null,
      restore: [],
      trash: [],
      skipped: [],
      conflicts: [],
      warnings: [],
      totalBytes: 0,
      actions: [],
    };
  }

  // ---------------------------------------------------------------- 执行

  /**
   * @typedef {object} ApplyRestoreRequest
   * @property {string} sessionId
   * @property {string} [cwd]
   * @property {RestorePlan} plan planRestore 的结果
   * @property {string} [auditId] 审计 id（缺省自动生成；回收站目录也用它）
   * @property {string} [rescueId] 复用已创建的救援点（缺省自动创建）
   * @property {() => any} [beforeApply] 救援点创建之后、写文件之前调用（service 在这里追加会话 marker）
   * @property {boolean | Record<string, any>} [audit] 是否由本模块追加 audit.jsonl 记录：
   *   `true` 写默认记录，对象则与默认字段合并，`false`/缺省不写（service 自己写审计，避免重复行）
   */

  /**
   * 执行文件恢复：救援点 -> （调用方追加 marker）-> 逐文件应用 -> 校验 -> 失败回滚。
   * @param {ApplyRestoreRequest} request
   * @returns {Promise<ApplyRestoreResult>}
   */
  async function applyRestore(request) {
    const sessionId = request?.sessionId ?? "";
    const plan = request?.plan ?? planRestoreShell();
    const auditId =
      typeof request?.auditId === "string" && request.auditId.length > 0
        ? request.auditId
        : newId();
    const cwd = request?.cwd ?? plan.cwd ?? (await sessionCwdOf(sessionId));
    /** @type {ApplyRestoreResult} */
    const result = {
      restored: [],
      trashed: [],
      skipped: [...(plan.skipped ?? [])],
      failed: [],
      rescueId: null,
      auditId,
      rolledBack: [],
      rollbackFailed: [],
    };
    if (Array.isArray(plan.conflicts) && plan.conflicts.length > 0) {
      throw new FileStoreError(
        FILE_ERROR_CODES.conflict,
        `refusing to restore files: ${plan.conflicts.length} conflict(s)`,
        { conflicts: plan.conflicts },
      );
    }
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (actions.length === 0) {
      return result;
    }
    if (cwd === null || cwd === undefined) {
      throw new FileStoreError(
        FILE_ERROR_CODES.unavailable,
        "session working directory is unknown",
      );
    }

    // 1) 救援点必须成功，否则一个字节都不动（设计 §2.4 步骤 2）。
    let rescue;
    if (typeof request?.rescueId === "string" && request.rescueId.length > 0) {
      const loaded = await loadRescue(sessionId, request.rescueId);
      if (loaded === null) {
        throw new FileStoreError(
          FILE_ERROR_CODES.rescueNotFound,
          `rescue "${request.rescueId}" was not found`,
        );
      }
      rescue = loaded;
    } else {
      rescue = await createRescue({ sessionId, cwd, plan, auditId });
    }
    result.rescueId = rescue.rescueId;
    /** @type {Map<string, number>} */
    const rescueModes = new Map();
    for (const saved of Array.isArray(rescue.manifest.paths) ? rescue.manifest.paths : []) {
      if (typeof saved.path === "string" && typeof saved.mode === "number") {
        rescueModes.set(saved.path, saved.mode);
      }
    }

    // 2) 调用方在这里追加会话 marker；失败则由调用方决定是否丢弃救援点。
    /** @type {Record<string, any>} */
    let extras = {};
    if (typeof request?.beforeApply === "function") {
      const value = await request.beforeApply();
      if (isRecord(value)) extras = value;
    }

    /** @type {Array<{action: RestoreAction, trashPath?: string}>} */
    const applied = [];
    /** @type {Array<{path: string, bytes: number, sha256: string, mode: number | null}>} */
    const trashRecords = [];

    for (const action of actions) {
      const safe = safeRelativePath(cwd, action.path);
      if (!safe.ok) {
        result.failed.push({ path: String(action.path), reason: safe.reason });
        continue;
      }
      const relPath = safe.relPath;
      try {
        const current = await currentStateOf(cwd, relPath);
        if (!current.exists) {
          result.failed.push({ path: relPath, reason: CONFLICT_REASONS.missing });
          continue;
        }
        if (current.hash === null || current.hash !== action.currentHash) {
          result.failed.push({ path: relPath, reason: "modified-during-apply" });
          continue;
        }
        if (action.action === "restore") {
          const buffer = await readBlob(action.beforeHash);
          if (buffer === null) {
            result.failed.push({ path: relPath, reason: "missing-blob" });
            continue;
          }
          const mode = action.mode ?? rescueModes.get(relPath) ?? undefined;
          await writeFileAtomic(safe.absPath, buffer, mode);
          applied.push({ action });
          const written = await fs.readFile(safe.absPath);
          if (hashOf(written) !== action.beforeHash) {
            result.failed.push({ path: relPath, reason: "verify-failed" });
            continue;
          }
          result.restored.push(relPath);
          continue;
        }
        // 新建文件 -> 移入回收站（不硬删）。
        const destination = joinRelative(
          path.join(trashDirOf(sessionId, auditId), "files"),
          relPath,
        );
        await moveFile(safe.absPath, destination, current.mode ?? undefined);
        applied.push({ action, trashPath: destination });
        const moved = await fs.readFile(destination);
        if (hashOf(moved) !== current.hash) {
          result.failed.push({ path: relPath, reason: "verify-failed" });
          continue;
        }
        trashRecords.push({
          path: relPath,
          bytes: moved.length,
          sha256: current.hash,
          mode: current.mode ?? null,
        });
        result.trashed.push(relPath);
      } catch (error) {
        result.failed.push({ path: relPath, reason: messageOf(error) });
      }
    }

    // 3) 任一文件失败 -> 用救援点回滚已应用的文件（设计 §2.4 步骤 5）。
    if (result.failed.length > 0 && applied.length > 0) {
      const rollback = await rollbackApplied(applied, rescue, cwd);
      result.rolledBack = rollback.rolledBack;
      result.rollbackFailed = rollback.rollbackFailed;
      const rolledBackSet = new Set(rollback.rolledBack);
      result.restored = result.restored.filter((item) => !rolledBackSet.has(item));
      result.trashed = result.trashed.filter((item) => !rolledBackSet.has(item));
      const keptTrash = trashRecords.filter((record) => !rolledBackSet.has(record.path));
      trashRecords.length = 0;
      trashRecords.push(...keptTrash);
    }

    // 4) 回收站 manifest（记录被移走的当前内容）。
    if (trashRecords.length > 0) {
      await writeJsonAtomic(path.join(trashDirOf(sessionId, auditId), "manifest.json"), {
        version: 1,
        id: auditId,
        sessionId,
        targetSeq: isSeq(plan.targetSeq) ? plan.targetSeq : null,
        rescueId: rescue.rescueId,
        createdAt: now(),
        paths: trashRecords,
      });
    }

    // 5) 审计（设计 §2.4 步骤 6）。默认由调用方（service.js）写，避免 audit.jsonl 出现
    //    两条同一 auditId 的记录；显式 `audit: true` / 字段对象时才由本模块追加。
    //    审计失败不回滚已完成的文件操作。
    const auditRequest = request?.audit;
    try {
      if (auditRequest !== undefined && auditRequest !== false) {
        await appendAudit({
          version: 1,
          id: auditId,
          time: now(),
          sessionId,
          targetSeq: isSeq(plan.targetSeq) ? plan.targetSeq : null,
          markerSeq: isSeq(extras.markerSeq) ? extras.markerSeq : null,
          mode: typeof extras.mode === "string" ? extras.mode : "both",
          removedCount: isSeq(extras.removedCount) ? extras.removedCount : null,
          tokens: typeof extras.tokens === "number" ? extras.tokens : null,
          rescueId: rescue.rescueId,
          files: {
            restored: result.restored,
            trashed: result.trashed,
            skipped: result.skipped,
            failed: result.failed,
          },
          ...(isRecord(auditRequest) ? auditRequest : {}),
        });
      }
    } catch (error) {
      try {
        logger?.warn?.(`session-rewind/files: cannot append audit record: ${messageOf(error)}`);
      } catch {
        // 日志失败不影响结果
      }
    }
    return result;
  }

  /**
   * 用救援点回滚已应用的动作（逆序）。
   * @param {Array<{action: RestoreAction, trashPath?: string}>} applied
   * @param {{rescueId: string, dir: string, manifest: RescueManifest}} rescue
   * @param {string} cwd
   * @returns {Promise<{rolledBack: string[], rollbackFailed: Array<{path: string, reason: string}>}>}
   */
  async function rollbackApplied(applied, rescue, cwd) {
    /** @type {Map<string, RescueManifest["paths"][number]>} */
    const savedByPath = new Map();
    for (const entry of Array.isArray(rescue.manifest.paths) ? rescue.manifest.paths : []) {
      if (typeof entry?.path === "string") savedByPath.set(entry.path, entry);
    }
    /** @type {string[]} */
    const rolledBack = [];
    /** @type {Array<{path: string, reason: string}>} */
    const rollbackFailed = [];
    for (const item of [...applied].reverse()) {
      const saved = savedByPath.get(item.action.path);
      try {
        if (saved === undefined) throw new Error("path is not in the rescue manifest");
        const absPath = joinRelative(cwd, item.action.path);
        if (saved.existed) {
          const buffer = await fs.readFile(rescueFileOf(rescue.dir, item.action.path));
          if (typeof saved.sha256 === "string" && hashOf(buffer) !== saved.sha256) {
            throw new Error("rescue content hash mismatch");
          }
          await writeFileAtomic(absPath, buffer, saved.mode ?? undefined);
        } else {
          await fs.rm(absPath, { force: true });
        }
        if (item.trashPath !== undefined) await fs.rm(item.trashPath, { force: true });
        rolledBack.push(item.action.path);
      } catch (error) {
        rollbackFailed.push({ path: item.action.path, reason: messageOf(error) });
      }
    }
    return { rolledBack, rollbackFailed };
  }

  // ---------------------------------------------------------------- 回收站

  /**
   * 列出会话的回收站操作（最新在前）。`request` 既可以是 `{sessionId}`，也可以是裸 sessionId。
   * @param {{sessionId: string} | string} request
   * @returns {Promise<Array<{id: string, time: number, targetSeq: number | null, paths: Array<{path: string, bytes: number}>}>>}
   */
  async function listTrash(request) {
    const sessionId = typeof request === "string" ? request : (request?.sessionId ?? "");
    const sessionDir = path.join(home, "trash", safeSegment(sessionId));
    const ids = await listSubdirs(sessionDir);
    /** @type {Array<{id: string, time: number, targetSeq: number | null, paths: Array<{path: string, bytes: number}>}>} */
    const ops = [];
    for (const id of ids) {
      const manifest = await readJson(path.join(sessionDir, id, "manifest.json"));
      if (!isRecord(manifest)) continue;
      const paths = Array.isArray(manifest.paths) ? manifest.paths : [];
      ops.push({
        id,
        time: seqOf(manifest.createdAt),
        targetSeq: isSeq(manifest.targetSeq) ? manifest.targetSeq : null,
        paths: paths
          .filter((entry) => isRecord(entry) && typeof entry.path === "string")
          .map((entry) => ({ path: entry.path, bytes: seqOf(entry.bytes) })),
      });
    }
    ops.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    return ops;
  }

  /**
   * 从回收站恢复一次操作的产物（目标已存在则拒绝覆盖）。
   * @param {{sessionId: string, cwd?: string, auditId: string}} request
   * @returns {Promise<{restored: string[], failed: Array<{path: string, reason: string}>}>}
   */
  async function restoreTrash(request) {
    const sessionId = request?.sessionId ?? "";
    const auditId = request?.auditId ?? "";
    const cwd = request?.cwd ?? (await sessionCwdOf(sessionId));
    if (cwd === null || cwd === undefined) {
      throw new FileStoreError(
        FILE_ERROR_CODES.unavailable,
        "session working directory is unknown",
      );
    }
    const dir = trashDirOf(sessionId, auditId);
    const manifest = await readJson(path.join(dir, "manifest.json"));
    if (!isRecord(manifest)) {
      throw new FileStoreError(
        FILE_ERROR_CODES.failed,
        `trash operation "${auditId}" was not found`,
      );
    }
    const paths = Array.isArray(manifest.paths) ? manifest.paths : [];
    /** @type {string[]} */
    const restored = [];
    /** @type {Array<{path: string, reason: string}>} */
    const failed = [];
    /** @type {Array<{path: string, bytes: number, sha256: string, mode: number | null}>} */
    const remaining = [];
    for (const entry of paths) {
      const relPath = isRecord(entry) && typeof entry.path === "string" ? entry.path : "";
      const safe = safeRelativePath(cwd, relPath);
      if (!safe.ok) {
        failed.push({ path: relPath, reason: safe.reason });
        continue;
      }
      const source = joinRelative(path.join(dir, "files"), safe.relPath);
      try {
        let exists = true;
        try {
          await fs.lstat(safe.absPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
          exists = false;
        }
        if (exists) throw new Error("destination already exists");
        await moveFile(source, safe.absPath, entry.mode ?? undefined);
        restored.push(safe.relPath);
      } catch (error) {
        failed.push({ path: relPath, reason: messageOf(error) });
        remaining.push({
          path: relPath,
          bytes: seqOf(entry.bytes),
          sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
          mode: typeof entry.mode === "number" ? entry.mode : null,
        });
      }
    }
    if (remaining.length === 0) await removeTree(dir);
    else await writeJsonAtomic(path.join(dir, "manifest.json"), { ...manifest, paths: remaining });
    return { restored, failed };
  }

  // ---------------------------------------------------------------- 审计

  /**
   * 追加审计记录（`audit.jsonl`，append-only）。
   * @param {Record<string, any>} record
   * @returns {Promise<void>}
   */
  async function appendAudit(record) {
    await ensureReady();
    await fs.appendFile(path.join(home, "audit.jsonl"), `${JSON.stringify(record)}\n`);
  }

  /**
   * 读取审计记录（按会话过滤，最新在前）。
   * @param {{sessionId?: string, limit?: number}} [request]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function readAudit(request = {}) {
    const limit =
      Number.isSafeInteger(request.limit) && (request.limit ?? 0) > 0 ? request.limit : 100;
    let text;
    try {
      text = await fs.readFile(path.join(home, "audit.jsonl"), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    /** @type {Array<Record<string, any>>} */
    const records = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (typeof request.sessionId === "string" && parsed.sessionId !== request.sessionId) continue;
      records.push(parsed);
    }
    return records.reverse().slice(0, limit);
  }

  // ---------------------------------------------------------------- 用量

  /**
   * 数据根用量（health/doctor 用）。
   * @returns {Promise<{bytes: number, entries: number, sessions: number, blobs: number, blobBytes: number, trash: {bytes: number, files: number}, rescues: {bytes: number, files: number}, overSoftCap: boolean, captureBlocked: boolean}>}
   */
  async function usage() {
    const sessionIds = await listSubdirs(path.join(home, "sessions"));
    let entries = 0;
    for (const sessionId of sessionIds) {
      try {
        entries += (await readEntries(sessionId)).length;
      } catch {
        // 单个会话读失败不影响总量统计
      }
    }
    const blobs = await dirStats(path.join(home, "blobs"));
    const trash = await dirStats(path.join(home, "trash"));
    const rescues = await dirStats(path.join(home, "rescues"));
    const total = await dirStats(home);
    return {
      bytes: total.bytes,
      entries,
      sessions: sessionIds.length,
      blobs: blobs.files,
      blobBytes: blobs.bytes,
      trash,
      rescues,
      overSoftCap: total.bytes > options.softCapBytes,
      captureBlocked: state.captureBlocked,
    };
  }

  // ---------------------------------------------------------------- 保留/GC

  /**
   * 按 anchor 整组裁掉旧 entry（设计 §2.5：保留最近 N 个 anchorSeq）。
   * @param {string} sessionId
   * @param {number} keep
   * @returns {Promise<{removedAnchors: number, removedEntries: number}>}
   */
  async function trimSessionEntries(sessionId, keep) {
    if (keep <= 0) return { removedAnchors: 0, removedEntries: 0 };
    const entries = await readEntries(sessionId);
    const anchors = [...new Set(entries.map((entry) => entry.anchorSeq))].sort(
      (left, right) => left - right,
    );
    if (anchors.length <= keep) return { removedAnchors: 0, removedEntries: 0 };
    const keepFrom = anchors[anchors.length - keep];
    const kept = entries.filter((entry) => entry.anchorSeq >= keepFrom);
    await writeEntries(sessionId, kept);
    return {
      removedAnchors: anchors.filter((anchor) => anchor < keepFrom).length,
      removedEntries: entries.length - kept.length,
    };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Array<{id: string, dir: string, createdAt: number}>>} 旧 -> 新
   */
  async function rescueEntriesOf(sessionId) {
    const sessionDir = path.join(home, "rescues", safeSegment(sessionId));
    const ids = await listSubdirs(sessionDir);
    /** @type {Array<{id: string, dir: string, createdAt: number}>} */
    const rescues = [];
    for (const id of ids) {
      const dir = path.join(sessionDir, id);
      const manifest = await readJson(path.join(dir, "manifest.json"));
      rescues.push({ id, dir, createdAt: isRecord(manifest) ? seqOf(manifest.createdAt) : 0 });
    }
    rescues.sort((left, right) => left.id.localeCompare(right.id));
    return rescues;
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<Array<{id: string, dir: string, createdAt: number}>>} 旧 -> 新
   */
  async function trashEntriesOf(sessionId) {
    const sessionDir = path.join(home, "trash", safeSegment(sessionId));
    const ids = await listSubdirs(sessionDir);
    /** @type {Array<{id: string, dir: string, createdAt: number}>} */
    const ops = [];
    for (const id of ids) {
      const dir = path.join(sessionDir, id);
      const manifest = await readJson(path.join(dir, "manifest.json"));
      ops.push({ id, dir, createdAt: isRecord(manifest) ? seqOf(manifest.createdAt) : 0 });
    }
    ops.sort((left, right) => left.id.localeCompare(right.id));
    return ops;
  }

  /**
   * @param {string} sessionId
   * @param {number} keep
   * @returns {Promise<number>} 删除的救援点数
   */
  async function trimRescuesOf(sessionId, keep) {
    const rescues = await rescueEntriesOf(sessionId);
    let removed = 0;
    while (rescues.length > Math.max(keep, 0)) {
      const victim = rescues.shift();
      if (victim === undefined) break;
      await removeTree(victim.dir);
      removed += 1;
    }
    return removed;
  }

  /**
   * @param {string} sessionId
   * @param {number} keep
   * @param {number} nowMs
   * @returns {Promise<number>} 删除的回收站操作数
   */
  async function trimTrashOf(sessionId, keep, nowMs = now()) {
    const ops = await trashEntriesOf(sessionId);
    let removed = 0;
    const expired = ops.filter(
      (op) => op.createdAt > 0 && nowMs - op.createdAt > options.trashMaxAgeMs,
    );
    for (const op of expired) {
      await removeTree(op.dir);
      removed += 1;
    }
    const survivors = ops.filter((op) => !expired.includes(op));
    while (survivors.length > Math.max(keep, 0)) {
      const victim = survivors.shift();
      if (victim === undefined) break;
      await removeTree(victim.dir);
      removed += 1;
    }
    return removed;
  }

  /**
   * 未被任何 entry / rescue manifest / trash manifest 引用的 blob 清掉。
   * @returns {Promise<{removedBlobs: number, bytesFreed: number}>}
   */
  async function collectGarbage() {
    /** @type {Set<string>} */
    const referenced = new Set();
    for (const sessionId of await listSubdirs(path.join(home, "sessions"))) {
      /** @type {FileEntry[]} */
      let entries = [];
      try {
        entries = await readEntries(sessionId);
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (typeof entry.beforeHash === "string") referenced.add(hexOf(entry.beforeHash));
        if (typeof entry.afterHash === "string") referenced.add(hexOf(entry.afterHash));
      }
    }
    /** @type {Array<{root: string, kind: string}>} */
    const manifestRoots = [
      { root: path.join(home, "rescues"), kind: "rescue" },
      { root: path.join(home, "trash"), kind: "trash" },
    ];
    for (const { root } of manifestRoots) {
      for (const sessionId of await listSubdirs(root)) {
        for (const id of await listSubdirs(path.join(root, sessionId))) {
          const manifest = await readJson(path.join(root, sessionId, id, "manifest.json"));
          const paths = isRecord(manifest) && Array.isArray(manifest.paths) ? manifest.paths : [];
          for (const entry of paths) {
            if (isRecord(entry) && typeof entry.sha256 === "string" && entry.sha256.length > 0) {
              referenced.add(hexOf(entry.sha256));
            }
          }
        }
      }
    }
    let removedBlobs = 0;
    let bytesFreed = 0;
    for (const prefix of await listSubdirs(path.join(home, "blobs"))) {
      const dir = path.join(home, "blobs", prefix);
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      for (const item of items) {
        if (!item.isFile()) continue;
        if (referenced.has(item.name)) continue;
        const full = path.join(dir, item.name);
        try {
          const info = await fs.stat(full);
          await fs.rm(full, { force: true });
          removedBlobs += 1;
          bytesFreed += info.size;
        } catch {
          // 并发删除忽略
        }
      }
    }
    return { removedBlobs, bytesFreed };
  }

  /**
   * 软上限执行顺序：旧 trash -> 旧 rescue -> 无引用 blob -> 最旧 anchor 组（设计 §2.5）。
   *
   * 只删除「有副本/可重算」的数据；仍超限时留给 `prune` 把捕获暂停。
   * @param {number} cap
   * @returns {Promise<number>} 释放的字节数
   */
  async function enforceSoftCap(cap) {
    let freed = 0;
    for (let round = 0; round < 200; round++) {
      const current = await dirStats(home);
      if (current.bytes <= cap) break;
      const oldestTrash = await oldestTrashDir();
      if (oldestTrash !== null) {
        freed += await removeAndMeasure(oldestTrash);
        continue;
      }
      const oldestRescue = await oldestRescueDir();
      if (oldestRescue !== null) {
        freed += await removeAndMeasure(oldestRescue);
        continue;
      }
      const gc = await collectGarbage();
      freed += gc.bytesFreed;
      if (gc.removedBlobs > 0) continue;
      const removed = await oldestAnchorGroup();
      if (!removed) break;
    }
    return freed;
  }

  /**
   * @param {string} target
   * @returns {Promise<number>} 删除前的字节数
   */
  async function removeAndMeasure(target) {
    const size = await sizeOf(target);
    await removeTree(target);
    return size;
  }

  /**
   * 全局最旧的一次回收站操作目录。
   * @returns {Promise<string | null>}
   */
  async function oldestTrashDir() {
    /** @type {Array<{id: string, dir: string}>} */
    const ops = [];
    for (const sessionId of await listSubdirs(path.join(home, "trash"))) {
      ops.push(...(await trashEntriesOf(sessionId)));
    }
    if (ops.length === 0) return null;
    ops.sort((left, right) => left.id.localeCompare(right.id));
    return ops[0].dir;
  }

  /**
   * 全局最旧的一个救援点目录。
   * @returns {Promise<string | null>}
   */
  async function oldestRescueDir() {
    /** @type {Array<{id: string, dir: string}>} */
    const rescues = [];
    for (const sessionId of await listSubdirs(path.join(home, "rescues"))) {
      rescues.push(...(await rescueEntriesOf(sessionId)));
    }
    if (rescues.length === 0) return null;
    rescues.sort((left, right) => left.id.localeCompare(right.id));
    return rescues[0].dir;
  }

  /**
   * 找全局最旧的一个 anchor 组并整组删除（最后手段）。
   * @returns {Promise<boolean>} 是否删掉了东西
   */
  async function oldestAnchorGroup() {
    /** @type {{sessionId: string, anchorSeq: number} | null} */
    let best = null;
    for (const sessionId of await listSubdirs(path.join(home, "sessions"))) {
      const entries = await readEntries(sessionId);
      if (entries.length === 0) continue;
      const anchorSeq = Math.min(...entries.map((entry) => entry.anchorSeq));
      if (best === null || anchorSeq < best.anchorSeq) best = { sessionId, anchorSeq };
    }
    if (best === null) return false;
    const entries = await readEntries(best.sessionId);
    const kept = entries.filter((entry) => entry.anchorSeq !== best.anchorSeq);
    await writeEntries(best.sessionId, kept);
    await collectGarbage();
    return true;
  }

  /**
   * 保留策略 + GC + 软上限。返回可打印的报告；仍超限时把 `state.captureBlocked` 置 true
   * （新捕获返回 `storage-full`，但绝不删有引用的数据）。
   * @param {{sessionId?: string}} [query] 只处理某个会话；缺省处理全部
   * @returns {Promise<Record<string, any>>}
   */
  async function prune(query = {}) {
    const request = isRecord(query) ? query : {};
    const only =
      typeof request.sessionId === "string" && request.sessionId.length > 0
        ? request.sessionId
        : undefined;
    const report = {
      sessions: 0,
      removedAnchors: 0,
      removedEntries: 0,
      removedRescues: 0,
      removedTrashOps: 0,
      removedBlobs: 0,
      bytesFreed: 0,
      overSoftCap: false,
      captureBlocked: false,
      bytes: 0,
    };
    await ensureReady();
    const sessionIds = only === undefined ? await listSubdirs(path.join(home, "sessions")) : [only];
    report.sessions = sessionIds.length;
    for (const sessionId of sessionIds) {
      const trimmed = await trimSessionEntries(sessionId, options.maxAnchors);
      report.removedAnchors += trimmed.removedAnchors;
      report.removedEntries += trimmed.removedEntries;
      report.removedRescues += await trimRescuesOf(sessionId, options.maxRescues);
      report.removedTrashOps += await trimTrashOf(sessionId, options.maxTrashOps);
    }
    const gc = await collectGarbage();
    report.removedBlobs += gc.removedBlobs;
    report.bytesFreed += gc.bytesFreed;
    const beforeCap = await dirStats(home);
    if (beforeCap.bytes > options.softCapBytes) {
      report.bytesFreed += await enforceSoftCap(options.softCapBytes);
      const afterCap = await collectGarbage();
      report.removedBlobs += afterCap.removedBlobs;
      report.bytesFreed += afterCap.bytesFreed;
    }
    const finalUsage = await dirStats(home);
    report.bytes = finalUsage.bytes;
    report.overSoftCap = finalUsage.bytes > options.softCapBytes;
    report.captureBlocked = report.overSoftCap;
    state.captureBlocked = report.overSoftCap;
    state.lastPruneAt = now();
    return report;
  }

  // ---------------------------------------------------------------- 对外 API

  const store = {
    /** DSH 数据根（注入的 `home`/`dataRoot`）。 */
    dataRoot,
    /** 插件数据目录（`<dataRoot>/session-rewind`，或注入的 `pluginDir`）。 */
    home,
    /** 生效的保留/容量参数。 */
    options,
    /** 可观察的运行时状态；`captureBlocked` 为 true 时新捕获会返回 storage-full。 */
    state,
    /** 固定路径。 */
    paths: {
      home,
      meta: path.join(home, "meta.json"),
      audit: path.join(home, "audit.jsonl"),
      blobs: path.join(home, "blobs"),
      sessions: path.join(home, "sessions"),
      trash: path.join(home, "trash"),
      rescues: path.join(home, "rescues"),
    },
    init: ensureReady,
    safeRelativePath,
    resolveWorkspacePath,
    captureBefore,
    recordChange,
    entriesForSession,
    summarize,
    planRestore,
    createRescue,
    discardRescue,
    applyRestore,
    listRescues,
    restoreRescue,
    listTrash,
    restoreTrash,
    appendAudit,
    readAudit,
    usage,
    prune,
    blobPathOf,
    readBlob,
    /** 当前是否因软上限暂停捕获。 */
    isStorageFull: () => state.captureBlocked,
    /** 会话 meta 里的 cwd（service 解析 cwd 兜底用）。 */
    sessionCwd: sessionCwdOf,
    /** 内部 id 生成器（service 需要 auditId 时复用同一格式）。 */
    newAuditId: newId,
  };

  return store;
}
