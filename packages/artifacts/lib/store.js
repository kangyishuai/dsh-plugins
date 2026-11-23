// @ts-check
// 工件存储：每个 artifact 一个目录，版本按 v1.<ext> / v2.<ext> 递增，元数据在 meta.json。
//
// 设计取舍（docs/artifacts 调研 / ADR 0016 / ADR 0017）：
//   - 字节落文件而不是会话事件 / storageDomain：大 HTML 不能进会话日志（token + 磁盘代价）；
//   - 元数据与字节分开：列表只读 meta，预览只读最新版本；
//   - 每次写入先写临时文件再 rename，失败不会留下半个版本；
//   - 数据根可注入（config.dataRoot > $DSH_HOME > ~/.dsh），测试用 mkdtemp；
//   - 0.2 起 meta 带 `kind`（html/markdown/json/csv/image）与归属字段（projectId/sessionId/
//     threadId/source）；旧 meta 缺这些字段时按 html + 无归属读，不迁移、不改名（见 ADR 0020）；
//   - 删除遵循 ADR 0002：默认移入 `<root>/artifacts-trash/`，硬删只发生在 purge（清回收站）。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 单页上限：与 Claude 的 16 MiB 相比刻意收紧，先保证内存与写放大可控。 */
export const MAX_BYTES = 2 * 1024 * 1024;

/** 跨插件契约版本：方法名/参数/返回形状的版本号，**不跟随插件版本**（见 docs/plugin-conventions.md §8）。 */
export const ARTIFACT_CONTRACT = "artifacts/2";

/** 支持的产物类型。`image` 是二进制，其余按 UTF-8 文本存。 */
export const ARTIFACT_KINDS = Object.freeze(
  /** @type {const} */ (["html", "markdown", "json", "csv", "image"]),
);

/**
 * 每种类型的默认扩展名 / MIME / 是否文本。
 * @type {Record<string, { ext: string, mime: string, text: boolean }>}
 */
export const KIND_INFO = Object.freeze({
  html: { ext: "html", mime: "text/html; charset=utf-8", text: true },
  markdown: { ext: "md", mime: "text/markdown; charset=utf-8", text: true },
  json: { ext: "json", mime: "application/json; charset=utf-8", text: true },
  csv: { ext: "csv", mime: "text/csv; charset=utf-8", text: true },
  image: { ext: "bin", mime: "application/octet-stream", text: false },
});

/** 允许的图片 MIME → 落盘扩展名。SVG 也算图片，但路由会额外加沙箱 CSP。 */
const IMAGE_EXT = /** @type {Record<string, string>} */ ({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
});

/**
 * @typedef {{ sessionId?: string, toolCallId?: string, via?: string }} ArtifactSource
 * @typedef {{ version: number, bytes: number, sha256: string, at: number, source?: ArtifactSource }} ArtifactVersion
 * @typedef {{
 *   id: string,
 *   title: string,
 *   kind: string,
 *   mime: string,
 *   ext: string,
 *   latest: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   versions: ArtifactVersion[],
 *   projectId?: string,
 *   sessionId?: string,
 *   threadId?: string,
 *   source?: ArtifactSource,
 *   archived?: boolean,
 *   archivedAt?: number,
 * }} ArtifactMeta
 * @typedef {{
 *   title?: string,
 *   kind?: string,
 *   content?: string,
 *   html?: string,
 *   data?: Buffer,
 *   mime?: string,
 *   projectId?: string,
 *   sessionId?: string,
 *   threadId?: string,
 *   source?: ArtifactSource,
 * }} WriteInput
 * @typedef {{
 *   projectId?: string | null,
 *   sessionId?: string,
 *   threadId?: string,
 *   kind?: string | string[],
 *   title?: string,
 *   since?: number,
 *   until?: number,
 *   includeArchived?: boolean,
 *   onlyArchived?: boolean,
 *   limit?: number,
 * }} ListOptions
 */

/**
 * 带稳定错误码的错误：调用方（工具 / Remote / 路由）按 code 决定文案与降级，不解析 message。
 * 旧版只抛 `Error`，message 里带 "empty" / "over the ... limit"，这些措辞保持不变。
 */
export class ArtifactError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

/**
 * 合法 artifact id：单段目录名。
 * 拒绝路径分隔符、控制字符、`.`/`..` 和一切以点开头的名字——这是防「`%2F` 解码成 `/` 后
 * `join(dir, id)` 逃出数据根」的第一道闸（第二道在 `assertSafeArtifactId` 里核对解析结果）。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSafeArtifactId(id) {
  if (typeof id !== "string" || id === "" || id === "." || id === "..") return false;
  if (id.startsWith(".")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  for (const char of id) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * 校验并返回 id；不合法就抛 `artifacts/invalid`（调用方按 §8.4 的信封处理）。
 * `base` 给了就再核对一次 `dirname(join(base, id)) === base`（纵深防御，防未来有人把
 * 单段校验放宽后留下 `..` 口子）。
 * @param {unknown} id
 * @param {string} [base]
 * @returns {string}
 */
export function assertSafeArtifactId(id, base) {
  const text = typeof id === "string" ? id : "";
  if (!isSafeArtifactId(text))
    throw new ArtifactError(
      "artifacts/invalid",
      `unsafe artifact id: ${text === "" ? "(empty)" : text}`,
    );
  if (base !== undefined && dirname(join(base, text)) !== base)
    throw new ArtifactError("artifacts/invalid", `artifact id escapes the store root: ${text}`);
  return text;
}

/**
 * 把标题变成可用作目录名的 slug；中文标题保留（文件系统支持），只去掉分隔符与危险字符。
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const base = String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base === "" ? "artifact" : base;
}

/** @param {Buffer | string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 路径是否存在（不区分文件/目录；权限错误按"不存在"处理，交给后续操作报错）。
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value @returns {string | undefined} */
function optionalText(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** @param {unknown} value @returns {number | undefined} */
function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 规范化类型名：大小写不敏感；不认识返回 undefined（由调用方决定是报错还是回退 html）。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeKind(value) {
  const text = optionalText(value)?.toLowerCase();
  return text !== undefined && ARTIFACT_KINDS.includes(/** @type {any} */ (text))
    ? text
    : undefined;
}

/**
 * 类型 → 默认 MIME；image 的 MIME 由具体格式决定，这里只给兜底。
 * @param {string} kind
 * @returns {string}
 */
export function defaultMime(kind) {
  return KIND_INFO[kind]?.mime ?? KIND_INFO.html.mime;
}

/**
 * 类型（+ 具体 MIME）→ 落盘扩展名。
 * @param {string} kind
 * @param {string} [mime]
 * @returns {string}
 */
export function extFor(kind, mime) {
  if (kind === "image") {
    const image = mime === undefined ? undefined : IMAGE_EXT[mime];
    if (image !== undefined) return image;
    return KIND_INFO.image.ext;
  }
  return KIND_INFO[kind]?.ext ?? KIND_INFO.html.ext;
}

/**
 * 该类型是否按 UTF-8 文本读写（图片必须走 Buffer，否则会被转码破坏）。
 * @param {string} kind
 * @returns {boolean}
 */
export function isTextKind(kind) {
  return (KIND_INFO[kind] ?? KIND_INFO.html).text;
}

/**
 * 从二进制头部认图片格式：`data:` URL 前缀缺失时靠它兜底。
 * @param {Buffer} data
 * @returns {string | undefined}
 */
export function sniffImageMime(data) {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  const head = data.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return undefined;
}

/**
 * 把磁盘上的 meta 规范成当前形状：旧 meta（无 kind / 无归属 / 无 ext）照样能读。
 * 不写回磁盘，只影响读出来的对象；下一次写入时会自然升级。
 * @param {unknown} raw
 * @returns {ArtifactMeta | undefined}
 */
export function normalizeMeta(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  const input = /** @type {any} */ (raw);
  const id = optionalText(input.id);
  if (id === undefined) return undefined;
  const kind = normalizeKind(input.kind) ?? "html";
  const mime = optionalText(input.mime) ?? defaultMime(kind);
  const ext =
    optionalText(input.ext) !== undefined && /^[a-z0-9]{1,8}$/u.test(String(input.ext))
      ? String(input.ext)
      : extFor(kind, mime);
  /** @type {ArtifactVersion[]} */
  const versions = [];
  if (Array.isArray(input.versions)) {
    for (const item of input.versions) {
      if (item === null || typeof item !== "object") continue;
      const version = optionalNumber(item.version);
      if (version === undefined || !Number.isInteger(version) || version < 1) continue;
      versions.push({
        version,
        bytes: optionalNumber(item.bytes) ?? 0,
        sha256: typeof item.sha256 === "string" ? item.sha256 : "",
        at: optionalNumber(item.at) ?? 0,
        ...(item.source === undefined ? {} : { source: normalizeSource(item.source) }),
      });
    }
  }
  versions.sort((a, b) => a.version - b.version);
  const declared = optionalNumber(input.latest);
  const latest =
    declared !== undefined && Number.isInteger(declared) && declared >= 0
      ? declared
      : (versions[versions.length - 1]?.version ?? 0);
  const now = Date.now();
  const meta = {
    ...input,
    id,
    title: optionalText(input.title) ?? "Artifact",
    kind,
    mime,
    ext,
    latest,
    createdAt: optionalNumber(input.createdAt) ?? versions[0]?.at ?? now,
    updatedAt: optionalNumber(input.updatedAt) ?? versions[versions.length - 1]?.at ?? now,
    versions,
    projectId: optionalText(input.projectId),
    sessionId: optionalText(input.sessionId),
    threadId: optionalText(input.threadId),
    source: normalizeSource(input.source),
    archived: input.archived === true ? true : undefined,
    archivedAt: optionalNumber(input.archivedAt),
  };
  return /** @type {ArtifactMeta} */ (meta);
}

/**
 * @param {unknown} raw
 * @returns {ArtifactSource | undefined}
 */
function normalizeSource(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  const input = /** @type {any} */ (raw);
  const source = {
    sessionId: optionalText(input.sessionId),
    toolCallId: optionalText(input.toolCallId),
    via: optionalText(input.via),
  };
  if (source.sessionId === undefined && source.toolCallId === undefined && source.via === undefined)
    return undefined;
  return /** @type {ArtifactSource} */ (source);
}

/**
 * 最新版本的字节数（列表里的 `bytes` 一直是这个含义，0.1.0 就是这么算的）。
 * @param {ArtifactMeta} meta
 * @returns {number}
 */
export function latestBytes(meta) {
  const version = meta.versions.find((item) => item.version === meta.latest);
  return version?.bytes ?? meta.versions[meta.versions.length - 1]?.bytes ?? 0;
}

/**
 * 所有版本字节数之和（"这个工件占了多少盘"）。
 * @param {ArtifactMeta} meta
 * @returns {number}
 */
export function totalBytes(meta) {
  return meta.versions.reduce(
    (sum, item) => sum + (Number.isFinite(item.bytes) ? item.bytes : 0),
    0,
  );
}

/**
 * 项目级/全局汇总：条数与体积。
 * `bytes` 一律是各工件**最新版本**字节数之和，与行里的 `bytes` 同一口径。
 * @param {ArtifactMeta[]} rows
 * @returns {{ count: number, bytes: number, byProject: Array<{ projectId: string | null, count: number, bytes: number }> }}
 */
export function summarizeArtifacts(rows) {
  /** @type {Map<string, { projectId: string | null, count: number, bytes: number }>} */
  const buckets = new Map();
  let bytes = 0;
  for (const meta of rows) {
    const size = latestBytes(meta);
    bytes += size;
    const projectId = optionalText(meta.projectId) ?? null;
    const key = projectId ?? "";
    const bucket = buckets.get(key) ?? { projectId, count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += size;
    buckets.set(key, bucket);
  }
  const byProject = [...buckets.values()].sort((a, b) => b.bytes - a.bytes);
  return { count: rows.length, bytes, byProject };
}

/**
 * 数据根：config.dataRoot > $DSH_HOME > ~/.dsh。与 advisor / session-delete 同一约定。
 * @param {Record<string, unknown> | undefined} config
 * @returns {string}
 */
export function resolveDataRoot(config) {
  const configured = config?.dataRoot;
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home === "" ? ".dsh" : `${home}/.dsh`;
}

/**
 * 把写入输入解析成「类型 + MIME + 扩展名 + 真实字节」。
 * 2 MiB 上限按**解码后的真实字节**算（base64 字符数不算数）。
 * @param {WriteInput} input
 * @param {string} [fallbackKind] 追加时继承已有工件的类型（调用方不必重复传 kind）
 * @returns {{ kind: string, mime: string, ext: string, data: Buffer }}
 */
function resolvePayload(input, fallbackKind) {
  const kind =
    normalizeKind(input.kind) ??
    (Buffer.isBuffer(input.data) ? "image" : (normalizeKind(fallbackKind) ?? "html"));
  if (kind === "image") {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.alloc(0);
    const declared = optionalText(input.mime);
    const mime =
      (declared !== undefined && IMAGE_EXT[declared] !== undefined
        ? declared
        : sniffImageMime(data)) ?? undefined;
    if (mime === undefined)
      throw new ArtifactError(
        "artifacts/unsupported-kind",
        `unsupported image type: ${declared ?? "unknown"}`,
      );
    if (data.length === 0) throw new ArtifactError("artifacts/invalid", "artifact image is empty");
    if (data.length > MAX_BYTES)
      throw new ArtifactError(
        "artifacts/too-large",
        `artifact image is ${data.length} bytes, over the ${MAX_BYTES} limit`,
      );
    return { kind, mime, ext: extFor(kind, mime), data };
  }
  const text = typeof input.content === "string" ? input.content : (input.html ?? "");
  const data = Buffer.from(String(text), "utf8");
  if (data.length === 0)
    throw new ArtifactError(
      "artifacts/invalid",
      kind === "html" ? "artifact html is empty" : `artifact ${kind} is empty`,
    );
  if (data.length > MAX_BYTES)
    throw new ArtifactError(
      "artifacts/too-large",
      `artifact ${kind === "html" ? "html" : kind} is ${data.length} bytes, over the ${MAX_BYTES} limit`,
    );
  return { kind, mime: defaultMime(kind), ext: extFor(kind), data };
}

/**
 * @param {WriteInput} input
 * @returns {Partial<ArtifactMeta>}
 */
function attributionOf(input) {
  /** @type {Partial<ArtifactMeta>} */
  const patch = {};
  const projectId = optionalText(input.projectId);
  const sessionId = optionalText(input.sessionId);
  const threadId = optionalText(input.threadId);
  const source = normalizeSource(input.source);
  if (projectId !== undefined) patch.projectId = projectId;
  if (sessionId !== undefined) patch.sessionId = sessionId;
  if (threadId !== undefined) patch.threadId = threadId;
  if (source !== undefined) patch.source = source;
  return patch;
}

/**
 * 只补 meta 上**缺失**的归属字段：append 不覆盖首次产生的项目/会话/来源。
 * @param {ArtifactMeta} meta
 * @param {Partial<ArtifactMeta>} patch
 * @returns {Partial<ArtifactMeta>}
 */
function fillAttribution(meta, patch) {
  /** @type {any} */
  const out = {};
  for (const key of ["projectId", "sessionId", "threadId", "source"]) {
    const value = /** @type {any} */ (patch)[key];
    if (value !== undefined && /** @type {any} */ (meta)[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * 过滤：条件之间是 AND；`kind` 可给单个或多个。
 * 导出是给测试直接用，生产路径走 `store.list`。
 * @param {ArtifactMeta[]} rows
 * @param {ListOptions} [options]
 * @returns {ArtifactMeta[]}
 */
export function filterArtifacts(rows, options = {}) {
  const wantsArchived = options.onlyArchived === true;
  const includeArchived = wantsArchived || options.includeArchived === true;
  const title = optionalText(options.title)?.toLowerCase();
  /** @type {string[] | undefined} */
  let kinds;
  if (options.kind !== undefined) {
    const raw = Array.isArray(options.kind) ? options.kind : [options.kind];
    kinds = raw.map((value) => {
      const kind = normalizeKind(value);
      if (kind === undefined)
        throw new ArtifactError("artifacts/invalid", `unknown artifact kind: ${String(value)}`);
      return kind;
    });
  }
  const since = optionalNumber(options.since);
  const until = optionalNumber(options.until);
  const filtersProject = Object.hasOwn(options, "projectId");
  const projectId =
    options.projectId === null ? null : (optionalText(options.projectId ?? undefined) ?? null);
  const sessionId = optionalText(options.sessionId);
  const threadId = optionalText(options.threadId);

  /** @type {ArtifactMeta[]} */
  const matched = [];
  for (const meta of rows) {
    if (wantsArchived) {
      if (meta.archived !== true) continue;
    } else if (meta.archived === true && !includeArchived) continue;
    if (filtersProject) {
      const actual = optionalText(meta.projectId) ?? null;
      if (actual !== projectId) continue;
    }
    if (sessionId !== undefined && optionalText(meta.sessionId) !== sessionId) continue;
    if (threadId !== undefined && optionalText(meta.threadId) !== threadId) continue;
    if (kinds !== undefined && !kinds.includes(meta.kind)) continue;
    if (title !== undefined && !meta.title.toLowerCase().includes(title)) continue;
    if (since !== undefined && meta.updatedAt < since) continue;
    if (until !== undefined && meta.updatedAt > until) continue;
    matched.push(meta);
  }
  matched.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = optionalNumber(options.limit);
  if (limit !== undefined && limit > 0 && Number.isInteger(limit)) return matched.slice(0, limit);
  return matched;
}

/**
 * @param {{ root: string }} options
 */
export function createArtifactStore({ root }) {
  const dir = join(root, "artifacts");
  const trashDir = join(root, "artifacts-trash");

  /** @param {string} id */
  const artifactDir = (id) => join(dir, assertSafeArtifactId(id, dir));
  /** @param {string} id */
  const metaPath = (id) => join(artifactDir(id), "meta.json");

  /** @param {string} id @returns {Promise<ArtifactMeta | undefined>} */
  async function readMeta(id) {
    try {
      return normalizeMeta(JSON.parse(await readFile(metaPath(id), "utf8")));
    } catch (error) {
      // 不安全的 id 必须原样抛出去（`artifacts/invalid`），不能伪装成"没有这个工件"。
      if (error instanceof ArtifactError) throw error;
      return undefined;
    }
  }

  /** @param {string} id @param {ArtifactMeta} meta */
  async function writeMeta(id, meta) {
    await mkdir(artifactDir(id), { recursive: true });
    const tmp = `${metaPath(id)}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
    await rename(tmp, metaPath(id));
  }

  /**
   * 落一个版本文件（tmp + rename），并更新 meta。
   * @param {string} id
   * @param {ArtifactMeta} meta
   * @param {{ kind: string, mime: string, ext: string, data: Buffer }} payload
   * @param {WriteInput} input
   * @returns {Promise<ArtifactMeta>}
   */
  async function writeVersion(id, meta, payload, input) {
    const version = meta.latest + 1;
    const file = join(artifactDir(id), `v${version}.${meta.ext}`);
    const tmp = `${file}.tmp`;
    await mkdir(artifactDir(id), { recursive: true });
    await writeFile(tmp, payload.data);
    await rename(tmp, file);
    const at = Date.now();
    const source = normalizeSource(input.source);
    /** @type {ArtifactVersion} */
    const record = { version, bytes: payload.data.length, sha256: digest(payload.data), at };
    if (source !== undefined) record.source = source;
    const title = optionalText(input.title) ?? meta.title;
    /** @type {ArtifactMeta} */
    const next = {
      ...meta,
      // 归属只在"还没有"时补：meta 记的是**首次产生**它的会话/调用，
      // 每个版本自己的来源另存 versions[].source（能反查"这一版是哪次跑出来的"）。
      ...fillAttribution(meta, attributionOf(input)),
      title,
      latest: version,
      updatedAt: at,
      versions: [...meta.versions, record],
    };
    await writeMeta(id, next);
    return next;
  }

  /**
   * 新建 artifact（v1）。`kind` 省略时按 html（给了 `data` 则按 image）。
   * @param {WriteInput} input
   * @returns {Promise<ArtifactMeta>}
   */
  async function create(input) {
    const payload = resolvePayload(input);
    const title = optionalText(input.title) ?? "Artifact";
    let id = `${slugify(title)}-${randomBytes(3).toString("hex")}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await readFile(metaPath(id));
        id = `${slugify(title)}-${randomBytes(3).toString("hex")}`;
      } catch {
        break;
      }
    }
    const now = Date.now();
    /** @type {ArtifactMeta} */
    const meta = {
      id,
      title,
      kind: payload.kind,
      mime: payload.mime,
      ext: payload.ext,
      latest: 0,
      createdAt: now,
      updatedAt: now,
      versions: [],
      ...attributionOf(input),
    };
    await writeMeta(id, meta);
    return writeVersion(id, meta, payload, input);
  }

  /**
   * 追加一个版本。归档后是只读的（ADR 0002 的"保留只读"语义）。
   * @param {string} id
   * @param {WriteInput} input
   * @returns {Promise<ArtifactMeta>}
   */
  async function append(id, input) {
    const meta = await readMeta(id);
    if (meta === undefined)
      throw new ArtifactError("artifacts/not-found", `unknown artifact: ${id}`);
    if (meta.archived === true)
      throw new ArtifactError("artifacts/archived", `artifact ${id} is archived (read-only)`);
    const payload = resolvePayload(input, meta.kind);
    if (payload.kind !== meta.kind)
      throw new ArtifactError(
        "artifacts/kind-mismatch",
        `artifact ${id} is ${meta.kind}, cannot append ${payload.kind}`,
      );
    return writeVersion(id, meta, payload, input);
  }

  /**
   * 扫描一个根目录下的 artifact 目录；不认识的条目跳过并告警（ADR 0002 §5）。
   * @param {string} base
   * @returns {Promise<ArtifactMeta[]>}
   */
  async function scan(base) {
    /** @type {import("node:fs").Dirent[]} */
    let entries = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return [];
    }
    /** @type {ArtifactMeta[]} */
    const metas = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const meta = await readMetaFrom(base, entry.name);
      if (meta === undefined) {
        console.warn(`[artifacts] skipping unknown entry: ${join(base, entry.name)}`);
        continue;
      }
      metas.push(meta);
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 从任意根目录（回收站也用）读 meta。
   * @param {string} base
   * @param {string} id
   * @returns {Promise<ArtifactMeta | undefined>}
   */
  async function readMetaFrom(base, id) {
    const safe = assertSafeArtifactId(id, base);
    try {
      return normalizeMeta(JSON.parse(await readFile(join(base, safe, "meta.json"), "utf8")));
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      return undefined;
    }
  }

  /**
   * 列表：默认全量（不含已归档），`options` 逐条过滤。
   * @param {ListOptions} [options]
   * @returns {Promise<ArtifactMeta[]>}
   */
  async function list(options = {}) {
    return filterArtifacts(await scan(dir), options);
  }

  /**
   * 读某个版本（默认最新）。文本类型给 `text`（`html` 是 0.1.0 的旧名，继续给），
   * 图片给 `data`；`data` 在任何类型上都是权威字节。
   * @param {string} id
   * @param {number} [version]
   * @returns {Promise<{
   *   meta: ArtifactMeta,
   *   version: number,
   *   kind: string,
   *   mime: string,
   *   ext: string,
   *   bytes: number,
   *   data: Buffer,
   *   text: string,
   *   html: string,
   * } | undefined>}
   */
  async function read(id, version) {
    const meta = await readMeta(id);
    if (meta === undefined) return undefined;
    const wanted = typeof version === "number" ? version : meta.latest;
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > meta.latest) return undefined;
    try {
      const data = await readFile(join(artifactDir(id), `v${wanted}.${meta.ext}`));
      const text = isTextKind(meta.kind) ? data.toString("utf8") : "";
      return {
        meta,
        version: wanted,
        kind: meta.kind,
        mime: meta.mime,
        ext: meta.ext,
        bytes: data.length,
        data,
        text,
        html: text,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 归档 / 取消归档。归档后 `append` 被拒绝，列表默认不显示。
   * @param {string} id
   * @param {boolean} [archived]
   * @returns {Promise<ArtifactMeta | undefined>}
   */
  async function archive(id, archived = true) {
    const meta = await readMeta(id);
    if (meta === undefined) return undefined;
    /** @type {ArtifactMeta} */
    const next = { ...meta };
    if (archived) {
      next.archived = true;
      next.archivedAt = Date.now();
    } else {
      next.archived = undefined;
      next.archivedAt = undefined;
    }
    await writeMeta(id, next);
    return next;
  }

  /**
   * 移入回收站（ADR 0002：默认不是硬删）。返回是否真的移动。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function remove(id) {
    const safe = assertSafeArtifactId(id, dir);
    const meta = await readMeta(safe);
    if (meta === undefined) return false;
    await mkdir(trashDir, { recursive: true });
    // 回收站目录名（trashKey）是权威键：同名已存在时加时间后缀，绝不覆盖上一条。
    let key = safe;
    if (await exists(join(trashDir, key))) key = `${safe}.${Date.now().toString(36)}`;
    await rename(artifactDir(safe), join(trashDir, assertSafeArtifactId(key, trashDir)));
    return true;
  }

  /**
   * 回收站条目：`trashKey`（目录名，权威键）→ meta。
   * 目录名与 `meta.id` 可能不同（同名 id 二次进回收站时会加时间后缀），所以调用方要用 trashKey。
   * @returns {Promise<Array<ArtifactMeta & { trashKey: string, trashedAt: number }>>}
   */
  async function listTrash() {
    /** @type {import("node:fs").Dirent[]} */
    let entries = [];
    try {
      entries = await readdir(trashDir, { withFileTypes: true });
    } catch {
      return [];
    }
    /** @type {Array<ArtifactMeta & { trashKey: string, trashedAt: number }>} */
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const meta = await readMetaFrom(trashDir, entry.name);
      if (meta === undefined) {
        console.warn(`[artifacts] skipping unknown trash entry: ${join(trashDir, entry.name)}`);
        continue;
      }
      let trashedAt = meta.updatedAt;
      try {
        trashedAt = (await stat(join(trashDir, entry.name))).mtimeMs;
      } catch {
        // 目录刚消失：用 meta 时间兜底。
      }
      rows.push({ ...meta, trashKey: entry.name, trashedAt });
    }
    return rows.sort((a, b) => b.trashedAt - a.trashedAt);
  }

  /**
   * 从回收站恢复到它原本的 id。目标 id 已存在时返回 false（不覆盖活工件）。
   * @param {string} trashKey 回收站目录名（`listTrash()` 的 `trashKey`）
   * @returns {Promise<boolean>}
   */
  async function restore(trashKey) {
    const key = assertSafeArtifactId(trashKey, trashDir);
    const meta = await readMetaFrom(trashDir, key);
    if (meta === undefined) return false;
    const target = /** @type {string} */ (meta.id);
    // 旧数据里可能有 id 不安全的 meta：留在回收站（不猜、不动），由调用方记为 unknown。
    if (!isSafeArtifactId(target)) return false;
    if ((await readMeta(target)) !== undefined) return false;
    await mkdir(dir, { recursive: true });
    await rename(join(trashDir, key), artifactDir(target));
    return true;
  }

  /**
   * 硬删回收站里的某个条目（清回收站）。只动 `artifacts-trash/<trashKey>` 这一层。
   * @param {string} trashKey
   * @returns {Promise<boolean>}
   */
  async function purge(trashKey) {
    const key = assertSafeArtifactId(trashKey, trashDir);
    if ((await readMetaFrom(trashDir, key)) === undefined) return false;
    await rm(join(trashDir, key), { recursive: true, force: true });
    return true;
  }

  return {
    root: dir,
    trashRoot: trashDir,
    create,
    append,
    list,
    read,
    readMeta,
    archive,
    remove,
    restore,
    listTrash,
    purge,
  };
}
