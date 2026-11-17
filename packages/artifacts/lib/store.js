// @ts-check
// 工件存储：每个 artifact 一个目录，版本按 v1.html / v2.html 递增，元数据在 meta.json。
//
// 设计取舍（docs/artifacts 调研）：
//   - 字节落文件而不是会话事件 / storageDomain：大 HTML 不能进会话日志（token + 磁盘代价）；
//   - 元数据与字节分开：列表只读 meta，预览只读最新版本；
//   - 每次写入先写临时文件再 rename，失败不会留下半个版本；
//   - 数据根可注入（config.dataRoot > $DSH_HOME > ~/.dsh），测试用 mkdtemp。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 单页上限：与 Claude 的 16 MiB 相比刻意收紧，先保证内存与写放大可控。 */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {{ version: number, bytes: number, sha256: string, at: number }} ArtifactVersion
 * @typedef {{ id: string, title: string, latest: number, createdAt: number, updatedAt: number, versions: ArtifactVersion[] }} ArtifactMeta
 */

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
 * @param {{ root: string }} options
 */
export function createArtifactStore({ root }) {
  const dir = join(root, "artifacts");

  /** @param {string} id */
  const artifactDir = (id) => join(dir, id);
  /** @param {string} id */
  const metaPath = (id) => join(artifactDir(id), "meta.json");

  /** @param {string} id @returns {Promise<ArtifactMeta | undefined>} */
  async function readMeta(id) {
    try {
      return /** @type {ArtifactMeta} */ (JSON.parse(await readFile(metaPath(id), "utf8")));
    } catch {
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
   * 追加一个版本。返回更新后的元数据与版本号。
   * @param {string} id
   * @param {{ title?: string, html: string }} input
   * @returns {Promise<ArtifactMeta>}
   */
  async function append(id, input) {
    const html = String(input.html ?? "");
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes === 0) throw new Error("artifact html is empty");
    if (bytes > MAX_BYTES)
      throw new Error(`artifact html is ${bytes} bytes, over the ${MAX_BYTES} limit`);
    const meta = await readMeta(id);
    if (meta === undefined) throw new Error(`unknown artifact: ${id}`);
    const version = meta.latest + 1;
    const file = join(artifactDir(id), `v${version}.html`);
    const tmp = `${file}.tmp`;
    await mkdir(artifactDir(id), { recursive: true });
    await writeFile(tmp, html, "utf8");
    await rename(tmp, file);
    const next = {
      ...meta,
      title:
        typeof input.title === "string" && input.title.trim() !== ""
          ? input.title.trim()
          : meta.title,
      latest: version,
      updatedAt: Date.now(),
      versions: [...meta.versions, { version, bytes, sha256: digest(html), at: Date.now() }],
    };
    await writeMeta(id, next);
    return next;
  }

  /**
   * 新建 artifact（v1）。
   * @param {{ title?: string, html: string }} input
   * @returns {Promise<ArtifactMeta>}
   */
  async function create(input) {
    const title = String(input.title ?? "").trim() || "Artifact";
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
    const meta = { id, title, latest: 0, createdAt: now, updatedAt: now, versions: [] };
    await writeMeta(id, meta);
    return append(id, { title, html: input.html });
  }

  /** @returns {Promise<ArtifactMeta[]>} */
  async function list() {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const metas = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => readMeta(entry.name)),
    );
    return metas.filter((meta) => meta !== undefined).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 读某个版本（默认最新）。
   * @param {string} id
   * @param {number} [version]
   * @returns {Promise<{ meta: ArtifactMeta, version: number, html: string } | undefined>}
   */
  async function read(id, version) {
    const meta = await readMeta(id);
    if (meta === undefined) return undefined;
    const wanted = typeof version === "number" ? version : meta.latest;
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > meta.latest) return undefined;
    try {
      const html = await readFile(join(artifactDir(id), `v${wanted}.html`), "utf8");
      return { meta, version: wanted, html };
    } catch {
      return undefined;
    }
  }

  /**
   * 删除整个 artifact（墓碑语义：id 之后不会复用，因为 id 带随机后缀）。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function remove(id) {
    const meta = await readMeta(id);
    if (meta === undefined) return false;
    await rm(artifactDir(id), { recursive: true, force: true });
    return true;
  }

  return { root: dir, create, append, list, read, remove, readMeta };
}
