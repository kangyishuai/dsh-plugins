// @ts-check
// 路径解析与安全校验。所有函数都接受显式 dataRoot，方便在 mkdtemp 里测试。
// 目录布局与命名编码来自 DSH 0.2.1-rc.5 的 JSONL 后端，见 docs/runtime/0.2.1-rc.5.md §6.2。
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * 会话 id 的传输安全形态。首字符必须是字母或数字，从而排除 "."、".." 与绝对路径。
 * 与宿主自身生成的 id（`session-<uuid>` / 裸 uuid）一致。
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/u;

/**
 * 解析数据根。优先级：配置 dataRoot → 环境变量 DSH_HOME → ~/.dsh。
 * 永远返回绝对路径；不创建目录（创建由调用方负责）。
 *
 * @param {{ dataRoot?: unknown } | undefined} [config] 插件配置。
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试可注入）。
 * @param {string} [home] 用户主目录（测试可注入）。
 * @returns {string} 绝对路径。
 */
export function resolveDataRoot(config, env = process.env, home = homedir()) {
  const configured = typeof config?.dataRoot === "string" ? config.dataRoot.trim() : "";
  if (configured) return resolve(configured);
  const fromEnv = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(home, ".dsh"));
}

/** @param {string} dataRoot @returns {string} */
export function sessionsRoot(dataRoot) {
  return join(dataRoot, "sessions");
}

/** @param {string} dataRoot @returns {string} */
export function trashRoot(dataRoot) {
  return join(dataRoot, "session-trash");
}

/** @param {string} dataRoot @returns {string} */
export function journalDir(dataRoot) {
  return join(trashRoot(dataRoot), "journal");
}

/** @param {string} dataRoot @returns {string} */
export function auditPath(dataRoot) {
  return join(trashRoot(dataRoot), "audit.log");
}

/**
 * 会话 id 是否安全可用作单段路径。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSafeSessionId(id) {
  return typeof id === "string" && SAFE_ID.test(id);
}

/**
 * 校验并返回会话 id；不合法直接抛出，避免路径穿越。
 * @param {unknown} id
 * @returns {string}
 */
export function requireSessionId(id) {
  if (!isSafeSessionId(id)) {
    throw Object.assign(new Error("session id must be a transport-safe identifier"), {
      code: "session-delete/invalid-id",
    });
  }
  return /** @type {string} */ (id);
}

/**
 * 把任意字符串编码成单段安全文件名（宿主 JSONL 后端同款规则）：
 * 仅 A-Za-z0-9._- 保持原样，其余按 UTF-16 码元写成 ~XXXX（大写十六进制）。
 * 该规则来自宿主行为（见 docs/runtime §6.2），用于在拿不到 locate() 时定位目录。
 *
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/**
 * 项目目录键：把 cwd 的分隔符压成 "-"，其余不安全码元转义，并加 -- 包裹。
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cannot encode an empty project path");
  }
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * 子路径必须严格位于 parent 之下（防目录穿越与符号链接逃逸由调用方 realpath 后校验）。
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * 断言路径位于数据根内。
 * @param {string} dataRoot
 * @param {string} target
 * @returns {string} target
 */
export function requireInside(dataRoot, target) {
  if (!isInside(dataRoot, target)) {
    throw Object.assign(new Error("refusing to touch a path outside the DSH data root"), {
      code: "session-delete/unsafe-path",
    });
  }
  return target;
}
