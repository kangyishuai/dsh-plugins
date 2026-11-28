#!/usr/bin/env node
// @ts-check
// 用法：pnpm index                     —— 从 npm registry 重建索引（联网）
//       pnpm index --out build/index.json
//       pnpm check:index               —— 离线校验：meta ↔ packages 一致 + 图标内联自检
//                                         + 已有输出结构/图标字节核对
//
// 生成 DSH 的插件索引源（plugin market index format 1）：一个列出本仓库全部插件、
// 全部正式版本的 JSON，用户把它加到「插件 → 发现 → 添加索引源」，就能在发现页里
// 搜索、查看、安装。格式的权威定义是宿主包 `@deepseek-ai/dsh-plugin-market-index`；
// 本仓库不能把宿主包当依赖（AGENTS 硬性约定 3），所以这里按它的规则写了一份
// 独立校验器，规则来源与实测坑位记在 docs/runtime/0.2.2-rc.3.md 与 0.2.2-rc.5.md §23.8。
//
// 发现页卡片上的图标只认索引条目的 `icon` 字段（不读包内 icon.svg），所以每个条目都按
// package.json#icon（默认 icon.svg，也支持 png/jpeg/webp）把图标内联成 base64 data URL；
// 宿主上限是解码后 32 KiB，本仓库 8 个图标都在 1 KiB 以内。`--check` 会反解 data URL 并按
// sha256 与本地文件逐字节核对。
//
// 为什么在发版后重建、而不是每次手写：format 1 是**写死的版本清单**，宿主的
// Discover 只信索引里列出的版本，不会自己去 registry 补全。少更新一次，用户看到
// 的就是旧版本，点安装也会装到旧版本。所以版本列表一律从 registry 现场枚举。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { isMain, listPluginDirs, REPO_ROOT, readJson } from "./lib/repo.mjs";

/** 索引源的对外地址；`icon` 相对路径按它解析，这里只用于文档与校验提示。 */
export const INDEX_URL = "https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json";
/** 数据包名：只含 index.json，没有代码、没有依赖、没有 install 脚本。 */
export const INDEX_PACKAGE = "@kangyishuai/dsh-plugin-index";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_OUT = "build/index.json";

/** npm 包名语法（与宿主 validator 的 PACKAGE_NAME 一致）。 */
export const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
/** 精确 SemVer 2.0.0（与宿主 validator 的 SEMVER 一致）。 */
export const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const MAX_PUBLISH_TIMESTAMP = 1e11;

/**
 * 宿主 `@deepseek-ai/dsh-plugin-market-index` 对内联图标的硬限制：**解码后 32 KiB**
 * （源码 `src/index.ts` 的 `MAX_INLINE_ICON_BYTES`）。本仓库 8 个 `icon.svg` 都在 1 KiB
 * 以内，这里只是兜底，挡住将来把大图 base64 塞进 `build/index.json`。
 */
export const MAX_INDEX_ICON_BYTES = 32 * 1024;
/**
 * 宿主只接受 **base64** 的 SVG/PNG/JPEG/WebP data URL（源码 `DATA_ICON`）；URI 编码的
 * `data:image/svg+xml,%3Csvg…` 会被整份索引拒收（`plugin-market/invalid-index`）。
 */
export const INDEX_ICON_DATA_URL_RE =
  /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** 索引不合规；`path` 是出错值的 JSON 路径，`reason` 是被违反的规则。 */
export class IndexError extends Error {
  /** @param {string} path @param {string} reason */
  constructor(path, reason) {
    super(`${path} ${reason}`);
    this.name = "IndexError";
    this.path = path;
    this.reason = reason;
  }
}

/** @param {string} path @param {string} reason @returns {never} */
function fail(path, reason) {
  throw new IndexError(path, reason);
}

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function objectAt(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "必须是对象");
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} path @returns {string} */
function stringAt(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail(path, "必须是非空字符串");
  return value;
}

/**
 * 本地化文本：字符串，或至少含 `en` 的语言表。
 * @param {unknown} value @param {string} path
 * @returns {string | Record<string, string>}
 */
function localizedText(value, path) {
  if (typeof value === "string") return stringAt(value, path);
  const object = objectAt(value, path);
  /** @type {Record<string, string>} */
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, "语言 id 只能是小写字母");
    text[language] = stringAt(member, `${path}.${language}`);
  }
  if (!Object.hasOwn(text, "en")) fail(path, "必须包含 en");
  return text;
}

/**
 * 文件头像不像一份 SVG 文档：跳过 BOM、空白、XML 声明与注释，然后必须由 `<svg` 开头。
 * 与 `scripts/check-plugins.mjs` 的文件头嗅探同一个判定，避免「已安装能显示、发现页却被
 * 宿主当坏图回退」的两套标准。
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function looksLikeSvg(bytes) {
  let text = bytes
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart();
  for (;;) {
    if (text.startsWith("<?xml")) {
      const end = text.indexOf("?>");
      if (end === -1) return false;
      text = text.slice(end + 2).trimStart();
      continue;
    }
    if (text.startsWith("<!--")) {
      const end = text.indexOf("-->");
      if (end === -1) return false;
      text = text.slice(end + 3).trimStart();
      continue;
    }
    break;
  }
  return /^<svg[\s/>]/iu.test(text);
}

/**
 * 宿主接受的四种图标 MIME；键是文件扩展名，与 `scripts/check-plugins.mjs` 的白名单一致。
 * 发现页与「已安装」页要显示同一个图标，所以文件从 `package.json#icon` 推导（默认
 * `icon.svg`），而不是写死 svg——将来某插件换成 png，两边才不会漂移。
 */
/** @type {Record<string, string>} */
const ICON_MIME_BY_EXT = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * 图标字节的文件头是否与声明的 MIME 一致。宿主把 data URL 交给浏览器解码，坏文件只会
 * 静默回退通用图形，所以生成器要自己拦（与 check-plugins 的嗅探同一套判定）。
 * @param {Buffer} bytes @param {string} mime
 * @returns {boolean}
 */
function hasIconSignature(bytes, mime) {
  switch (mime) {
    case "image/svg+xml":
      return looksLikeSvg(bytes);
    case "image/png":
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    case "image/jpeg":
      return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.toString("latin1", 0, 4) === "RIFF" &&
        bytes.toString("latin1", 8, 12) === "WEBP"
      );
    default:
      return false;
  }
}

/**
 * 本地图标文件的字节 → 宿主接受的**内联 data URL**（base64）。
 *
 * 为什么内联而不是相对 URL：索引包发布到 npm、用户从 jsDelivr 读取，相对 URL 会把
 * 每个图标变成一次额外请求（还会把用户 IP 暴露给 CDN）；data URL 让索引自包含，
 * 宿主 `dsh-plugin-market-index` 的 `types.ts` 明确支持，且解码后 ≤32 KiB。
 * @param {Buffer} bytes 本地图标文件内容
 * @param {string} label 报错里显示的路径（如 `packages/advisor/icon.svg`）
 * @param {string} [mime] 图标 MIME，默认 `image/svg+xml`
 * @returns {string}
 */
export function iconDataUrl(bytes, label, mime = "image/svg+xml") {
  if (bytes.length === 0) throw new Error(`${label} 是空文件`);
  if (bytes.length > MAX_INDEX_ICON_BYTES) {
    throw new Error(
      `${label} ${bytes.length} 字节，超过宿主内联图标上限 ${MAX_INDEX_ICON_BYTES} 字节`,
    );
  }
  if (!hasIconSignature(bytes, mime)) {
    throw new Error(`${label} 的文件头不是 ${mime}（与扩展名 / package.json#icon 不符）`);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * 把索引条目里的 `icon` 解回字节，按宿主 `dsh-plugin-market-index` 的 `icon()` 规则校验。
 * 校验失败一律抛 `IndexError`（`path` 是 JSON 路径），与其它字段的报错方式一致。
 * @param {unknown} value
 * @param {string} path
 * @returns {Buffer}
 */
export function decodeIconDataUrl(value, path) {
  const text = stringAt(value, path);
  const payload = INDEX_ICON_DATA_URL_RE.exec(text)?.[1];
  if (payload === undefined || payload === "" || !BASE64_RE.test(payload)) {
    fail(path, "必须是 base64 的 SVG/PNG/JPEG/WebP data URL（URI 编码的内联 SVG 宿主不收）");
  }
  // 先按长度挡一次，避免为了报「超限」去解码一个超大 payload。
  if (payload.length > Math.ceil(MAX_INDEX_ICON_BYTES / 3) * 4) {
    fail(path, `解码后超过宿主上限 ${MAX_INDEX_ICON_BYTES} 字节`);
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > MAX_INDEX_ICON_BYTES) {
    fail(path, `解码后 ${bytes.length} 字节，超过宿主上限 ${MAX_INDEX_ICON_BYTES} 字节`);
  }
  return bytes;
}

/** @param {Buffer | string} value @returns {string} */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 把 package.json 的 repository.url 转成索引要求的 https 仓库地址。
 * 例：`git+https://github.com/kangyishuai/dsh-plugins.git` → `https://github.com/kangyishuai/dsh-plugins`
 * @param {string} url
 * @returns {string}
 */
export function normalizeRepositoryUrl(url) {
  const trimmed = url.replace(/^git\+/u, "").replace(/\.git$/u, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") throw new Error(`repository 必须是 https：${url}`);
  // 宿主只接受 canonical 形式（url.href === 原值），去掉查询、片段与结尾斜杠。
  parsed.search = "";
  parsed.hash = "";
  const href = parsed.href.replace(/\/$/u, "");
  return href;
}

/**
 * 版本比较（只比大小），返回值 <0 / 0 / >0。
 * @param {string} left @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  const parse = (/** @type {string} */ value) => {
    const [core, build] = value.split("+");
    const [plain, prerelease] = /** @type {string} */ (core).split("-");
    const numbers = /** @type {string} */ (plain).split(".").map(Number);
    return { numbers, prerelease: prerelease ?? "", build: build ?? "" };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * 从 packument 里挑出可列出的版本：精确 semver、非预发布、有发布时间、
 * 有 tarball（排除 npm 的 stub 占位版本）。
 * @param {any} packument
 * @returns {{ version: string, publishTimestamp: number }[]} 按版本降序
 */
export function stableVersions(packument) {
  const versions = objectAt(packument?.versions, "$.versions");
  const times = objectAt(packument?.time, "$.time");
  /** @type {{ version: string, publishTimestamp: number }[]} */
  const out = [];
  for (const [version, manifest] of Object.entries(versions)) {
    if (!SEMVER_RE.test(version) || version.includes("-")) continue;
    const entry = /** @type {Record<string, any>} */ (manifest ?? {});
    if (entry.stub === true) continue;
    if (typeof entry.dist?.tarball !== "string") continue;
    const iso = times[version];
    const seconds = typeof iso === "string" ? Math.floor(Date.parse(iso) / 1000) : Number.NaN;
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds >= MAX_PUBLISH_TIMESTAMP) continue;
    out.push({ version, publishTimestamp: seconds });
  }
  return out.sort((left, right) => compareVersions(right.version, left.version));
}

/**
 * meta 与 packages 的双向一致性：每个包都要有条目，每个条目都要有包。
 * 离线可跑，接在 `pnpm check` 上。
 * @param {{ name: string }[]} manifests @param {any} meta
 * @returns {string[]} 人话错误列表（空数组表示通过）
 */
export function checkMeta(manifests, meta) {
  /** @type {string[]} */
  const errors = [];
  const plugins = objectAt(meta?.plugins, "$.meta.plugins");
  const categories = objectAt(meta?.categories, "$.meta.categories");
  for (const manifest of manifests) {
    const entry = plugins[manifest.name];
    if (!entry) {
      errors.push(
        `scripts/index-meta.json 缺少 ${manifest.name}（新插件要在那里补分类与中文文案）`,
      );
      continue;
    }
    if (typeof entry.descriptionZh !== "string" || entry.descriptionZh.trim() === "") {
      errors.push(`${manifest.name} 缺少 descriptionZh`);
    }
    if (typeof entry.category !== "string" || !Object.hasOwn(categories, entry.category)) {
      errors.push(
        `${manifest.name} 的 category「${String(entry.category)}」没有在 categories 里声明`,
      );
    }
    try {
      localizedText(entry.title, `${manifest.name}.title`);
    } catch (error) {
      errors.push(`${manifest.name} 的 title 不合法：${/** @type {Error} */ (error).message}`);
    }
  }
  const names = new Set(manifests.map((manifest) => manifest.name));
  for (const name of Object.keys(plugins)) {
    if (!names.has(name)) errors.push(`scripts/index-meta.json 里的 ${name} 找不到对应插件目录`);
  }
  return errors;
}

/**
 * 用已经取到的 manifests + packuments 组装索引（不联网，便于单测）。
 * @param {{ manifests: any[], meta: any, packuments: Map<string, any> }} input
 * @returns {any} 校验过的索引对象
 */
export function buildIndex({ manifests, meta, packuments }) {
  const errors = checkMeta(manifests, meta);
  if (errors.length > 0)
    throw new Error(`meta 与 packages 不一致：\n${errors.map((line) => `  - ${line}`).join("\n")}`);

  /** @type {Record<string, { title: unknown }>} */
  const categories = {};
  for (const [id, declaration] of Object.entries(objectAt(meta.categories, "$.meta.categories"))) {
    categories[id] = {
      title: localizedText(/** @type {any} */ (declaration).title, `categories.${id}.title`),
    };
  }

  const plugins = manifests
    .map((manifest) => {
      const entry = meta.plugins[manifest.name];
      const packument = packuments.get(manifest.name);
      if (!packument) throw new Error(`没有取到 ${manifest.name} 的 registry 数据`);
      if (packument.time?.unpublished)
        throw new Error(`${manifest.name} 在 registry 上已被整体撤回`);
      const versions = stableVersions(packument);
      if (versions.length === 0)
        throw new Error(`${manifest.name} 在 registry 上没有可列出的正式版本`);
      if (!versions.some((item) => item.version === manifest.version)) {
        throw new Error(
          `${manifest.name}@${manifest.version} 还没有发布到 npm（registry 上是 ${versions[0].version}）`,
        );
      }
      try {
        // 发现页卡片只认索引条目的 `icon`，不读包内 icon.svg（宿主实测，见
        // docs/runtime/0.2.2-rc.5.md §23.8）；缺图标就直接失败，不生成只有默认图的索引。
        if (typeof manifest.icon !== "string" || manifest.icon === "") {
          throw new Error(
            `缺少可内联的图标（packages/${manifest.dir}/icon.svg）${
              manifest.iconError === undefined ? "" : `：${manifest.iconError}`
            }`,
          );
        }
        return {
          name: manifest.name,
          title: entry.title,
          icon: manifest.icon,
          description: {
            en: stringAt(manifest.description, `${manifest.name}.description`),
            zh: entry.descriptionZh,
          },
          ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
          repository: {
            url: normalizeRepositoryUrl(manifest.repository.url),
            directory: manifest.repository.directory,
          },
          metadata: { category: entry.category },
          versions: versions.map((item) => ({
            version: item.version,
            publishTimestamp: item.publishTimestamp,
            source: { type: "npm" },
          })),
        };
      } catch (error) {
        throw new Error(
          `${manifest.name} 的字段无法写进索引：${/** @type {Error} */ (error).message}`,
        );
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return validateIndex({
    format: 1,
    title: localizedText(meta.title, "$.meta.title"),
    ...(meta.description === undefined
      ? {}
      : { description: localizedText(meta.description, "$.meta.description") }),
    metadata: { categories },
    plugins,
  });
}

/**
 * 按宿主的 format 1 规则校验一份索引。规则与宿主不同时以宿主为准，
 * 真机验收见 `pnpm smoke:index`。
 * @param {any} value
 * @returns {any}
 */
export function validateIndex(value) {
  const index = objectAt(value, "$");
  if (index.format !== 1) fail("$.format", "必须是 1");
  const title = localizedText(index.title, "$.title");
  const description =
    index.description === undefined ? undefined : localizedText(index.description, "$.description");
  const categories = objectAt(index.metadata?.categories ?? {}, "$.metadata.categories");
  const declared = new Set(Object.keys(categories));
  if (!Array.isArray(index.plugins) || index.plugins.length === 0)
    fail("$.plugins", "必须是非空数组");
  const names = new Set();
  for (const [position, entry] of index.plugins.entries()) {
    const at = `$.plugins[${position}]`;
    const plugin = objectAt(entry, at);
    const name = stringAt(plugin.name, `${at}.name`);
    if (!PACKAGE_NAME_RE.test(name) || name.length > 214)
      fail(`${at}.name`, "必须是合法的 npm 包名");
    if (names.has(name)) fail(`${at}.name`, `重复了 ${name}`);
    names.add(name);
    if (plugin.title !== undefined) localizedText(plugin.title, `${at}.title`);
    if (plugin.description !== undefined) {
      const text = localizedText(plugin.description, `${at}.description`);
      if (typeof text === "object" && !Object.hasOwn(text, "en"))
        fail(`${at}.description`, "必须包含 en");
    }
    if (plugin.homepage !== undefined) {
      const url = new URL(stringAt(plugin.homepage, `${at}.homepage`));
      if (url.protocol !== "https:" && url.protocol !== "http:")
        fail(`${at}.homepage`, "必须是 http(s)");
    }
    // 与宿主 `parseMarketIndex` 一致：icon 可省略，存在就必须是合法 base64 data URL 或 URL 引用。
    // 本仓库只产出 data URL（自包含），所以这里对远程 URL 形态只做「能解析成 URL」的宽校验。
    if (plugin.icon !== undefined) {
      const text = stringAt(plugin.icon, `${at}.icon`);
      if (text.startsWith("data:")) decodeIconDataUrl(text, `${at}.icon`);
      else {
        let resolved;
        try {
          resolved = new URL(text, INDEX_URL);
        } catch {
          fail(`${at}.icon`, "必须是 base64 data URL 或 URL 引用");
        }
        if (resolved.protocol !== "https:" && resolved.origin !== new URL(INDEX_URL).origin) {
          fail(`${at}.icon`, "URL 引用必须解析到 https 或索引源同源地址");
        }
      }
    }
    const category = plugin.metadata?.category;
    if (category !== undefined && !declared.has(stringAt(category, `${at}.metadata.category`))) {
      fail(`${at}.metadata.category`, `引用了未声明的分类 ${String(category)}`);
    }
    if (plugin.repository !== undefined) {
      const repo = objectAt(plugin.repository, `${at}.repository`);
      const url = new URL(stringAt(repo.url, `${at}.repository.url`));
      if (url.protocol !== "https:") fail(`${at}.repository.url`, "必须是 https");
      if (url.href !== repo.url) fail(`${at}.repository.url`, "必须是 canonical 形式");
      if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(`${at}.repository.url`, "至少要两段路径");
      if (repo.directory !== undefined) {
        const directory = stringAt(repo.directory, `${at}.repository.directory`);
        if (
          directory
            .split("/")
            .some((segment) => segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))
        ) {
          fail(`${at}.repository.directory`, "必须是安全相对目录");
        }
      }
    }
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0)
      fail(`${at}.versions`, "必须是非空数组");
    const seen = new Set();
    for (const [offset, item] of plugin.versions.entries()) {
      const versionAt = `${at}.versions[${offset}]`;
      const version = objectAt(item, versionAt);
      const text = stringAt(version.version, `${versionAt}.version`);
      if (!SEMVER_RE.test(text)) fail(`${versionAt}.version`, "必须是精确 SemVer");
      if (seen.has(text)) fail(`${versionAt}.version`, `重复了 ${text}`);
      seen.add(text);
      const timestamp = version.publishTimestamp;
      if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= MAX_PUBLISH_TIMESTAMP) {
        fail(`${versionAt}.publishTimestamp`, "必须是 [0, 10^11) 的 Unix 秒整数");
      }
      const source = objectAt(version.source, `${versionAt}.source`);
      if (source.type !== "npm") fail(`${versionAt}.source.type`, "目前只支持 npm");
      if (source.registry !== undefined) {
        const url = new URL(stringAt(source.registry, `${versionAt}.source.registry`));
        if (url.protocol !== "https:" && url.protocol !== "http:")
          fail(`${versionAt}.source.registry`, "必须是 http(s)");
      }
    }
  }
  return {
    format: 1,
    title,
    ...(description === undefined ? {} : { description }),
    metadata: { categories },
    plugins: index.plugins,
  };
}

/**
 * 从 `package.json#icon` 推导图标相对包目录的路径（默认 `icon.svg`），并拒绝逃出包目录
 * 或带协议的值。宿主的「已安装」页读同一个字段，生成器跟着它走，不写死 svg。
 * @param {string} dir @param {Record<string, any>} manifest
 * @returns {{ relative: string } | { iconError: string }}
 */
function iconRelativePath(dir, manifest) {
  const declared = manifest.icon;
  if (declared !== undefined && (typeof declared !== "string" || declared.trim() === "")) {
    return { iconError: "package.json 的 icon 必须是非空相对路径" };
  }
  const value = typeof declared === "string" ? declared.trim().replace(/^\.\//u, "") : "icon.svg";
  if (
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) ||
    value.split("/").includes("..")
  ) {
    return { iconError: `package.json 的 icon「${value}」必须是包目录内的相对路径` };
  }
  return { relative: `packages/${dir}/${value}` };
}

/**
 * 读包内图标并转成宿主接受的 data URL。**不抛错**：返回 `{ icon }` 或 `{ iconError }`，
 * 由调用方决定算错误还是跳过——`pnpm new` 的模板自带占位 `icon.svg`，0.0.0 脚手架还没
 * 换成自己的图时只告警；正式插件缺图标才算错。
 * @param {string} root @param {string} dir @param {Record<string, any>} manifest
 * @param {string | undefined} placeholderSha256 模板占位图标的 sha256（用于提醒替换）
 * @returns {{
 *   icon?: string, iconSha256?: string, iconPath?: string,
 *   iconIsTemplatePlaceholder?: boolean, iconError?: string,
 * }}
 */
function readPackageIcon(root, dir, manifest, placeholderSha256) {
  const derived = iconRelativePath(dir, manifest);
  if ("iconError" in derived) return { iconError: derived.iconError };
  const relative = derived.relative;
  const mime = ICON_MIME_BY_EXT[extname(relative).toLowerCase()];
  if (mime === undefined) {
    return {
      iconPath: relative,
      iconError: `${relative} 的扩展名必须是 svg/png/jpg/jpeg/webp（宿主只接受这四种图标）`,
    };
  }
  let bytes;
  try {
    bytes = readFileSync(join(root, relative));
  } catch (error) {
    return {
      iconPath: relative,
      iconError:
        /** @type {any} */ (error)?.code === "ENOENT"
          ? `${relative} 不存在`
          : `${relative} 读取失败：${/** @type {Error} */ (error).message}`,
    };
  }
  try {
    const iconSha256 = sha256(bytes);
    return {
      icon: iconDataUrl(bytes, relative, mime),
      iconSha256,
      iconPath: relative,
      iconIsTemplatePlaceholder:
        placeholderSha256 !== undefined && iconSha256 === placeholderSha256,
    };
  } catch (error) {
    return { iconPath: relative, iconError: /** @type {Error} */ (error).message };
  }
}

/**
 * 模板占位图标的 sha256；没有模板目录（单测 fixture / 老分支）时返回 undefined。
 * @param {string} root @returns {string | undefined}
 */
function templateIconSha256(root) {
  try {
    return sha256(readFileSync(join(root, "templates", "plugin", "icon.svg")));
  } catch {
    return undefined;
  }
}

/**
 * 读 packages/ 下的插件清单（只需要索引用到的字段），并把各包图标内联成索引条目要的
 * data URL（文件从 `package.json#icon` 推导，默认 `icon.svg`）。
 * @param {string} root
 * @returns {{
 *   dir: string, name: string, version: string, description: any, homepage: any,
 *   repository: Record<string, any>, icon?: string, iconSha256?: string, iconPath?: string,
 *   iconIsTemplatePlaceholder?: boolean, iconError?: string,
 * }[]}
 */
export function collectPackages(root) {
  const placeholderSha256 = templateIconSha256(root);
  return listPluginDirs(root).map((dir) => {
    const manifest = readJson(join(root, "packages", dir, "package.json"));
    return {
      dir,
      name: stringAt(manifest.name, `packages/${dir}/package.json#name`),
      version: stringAt(manifest.version, `packages/${dir}/package.json#version`),
      description: manifest.description,
      homepage: manifest.homepage,
      repository: objectAt(manifest.repository, `packages/${dir}/package.json#repository`),
      ...readPackageIcon(root, dir, manifest, placeholderSha256),
    };
  });
}

/**
 * 「正式插件」= 已登记进索引源且版本不是 0.0.0；与 `scripts/check-plugins.mjs` 的
 * identityEnforced 判定一致。0.0.0 脚手架从模板继承的占位图标不强制替换（只告警），
 * 离开 0.0.0 后 `pnpm check` 才按正式插件要求。
 * @param {{ name: string, version: string }} manifest @param {any} meta
 * @returns {boolean}
 */
export function isFormalPlugin(manifest, meta) {
  const registered = objectAt(meta?.plugins ?? {}, "$.meta.plugins");
  return Object.hasOwn(registered, manifest.name) && manifest.version !== "0.0.0";
}

/**
 * 离线审计「索引该带上的图标」：正式插件缺图标是错误（发现页会退回通用图形），
 * 0.0.0 脚手架只告警；仍在用模板占位图标时，正式/脚手架都提醒替换。
 * @param {{
 *   dir: string, name: string, version: string, icon?: string, iconPath?: string,
 *   iconIsTemplatePlaceholder?: boolean, iconError?: string,
 * }[]} manifests
 * @param {any} meta
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkIcons(manifests, meta) {
  /** @type {{ errors: string[], warnings: string[] }} */
  const result = { errors: [], warnings: [] };
  for (const manifest of manifests) {
    const formal = isFormalPlugin(manifest, meta);
    const iconPath = manifest.iconPath ?? `packages/${manifest.dir}/icon.svg`;
    if (manifest.icon === undefined) {
      const detail = manifest.iconError ?? `${iconPath} 不存在`;
      if (formal) {
        result.errors.push(
          `${manifest.name} 没有可用的图标：${detail}（每个正式插件都要有 36×36 的图标，否则发现页退回通用图形）`,
        );
      } else {
        result.warnings.push(
          `${manifest.name} 没有可用的图标：${detail}（0.0.0 脚手架暂不强制；模板自带占位 icon.svg，发版前替换成这个插件自己的图标）`,
        );
      }
      continue;
    }
    if (manifest.iconIsTemplatePlaceholder === true) {
      result.warnings.push(
        `${manifest.name} 仍在使用模板占位图标 templates/plugin/icon.svg，发版前替换成这个插件自己的 36×36 图标`,
      );
    }
  }
  return result;
}

/**
 * 对比「已生成的索引」与本地图标：双向核对 name 集合（索引里多出的 ghost 条目也点名），
 * 必需插件（默认全部 manifests；`--check` 传正式插件集合）要有条目、有 icon，且解码后
 * 的 sha256 与本地文件一致。未进索引的 0.0.0 脚手架不算错，若已在索引里也照样核对。
 * @param {any} index 已通过 `validateIndex` 的索引对象
 * @param {{ dir: string, name: string, iconPath?: string, iconSha256?: string }[]} manifests
 * @param {Set<string>} [requiredNames] 默认要求 manifests 里全部插件
 * @returns {{ errors: string[], icons: { name: string, bytes: number, sha256: string }[], totalBytes: number }}
 */
export function iconDrift(
  index,
  manifests,
  requiredNames = new Set(manifests.map((manifest) => manifest.name)),
) {
  /** @type {string[]} */
  const errors = [];
  /** @type {{ name: string, bytes: number, sha256: string }[]} */
  const icons = [];
  const plugins = /** @type {any[]} */ (index.plugins);
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  for (const manifest of manifests) {
    const required = requiredNames.has(manifest.name);
    const iconPath = manifest.iconPath ?? `packages/${manifest.dir}/icon.svg`;
    const entry = byName.get(manifest.name);
    if (!entry) {
      if (required) errors.push(`索引里没有 ${manifest.name}（重建索引）`);
      continue;
    }
    if (entry.icon === undefined) {
      if (required) {
        errors.push(
          `${manifest.name} 的索引条目没有 icon（发现页会退回通用图形；重建索引：pnpm index）`,
        );
      }
      continue;
    }
    if (manifest.iconSha256 === undefined) {
      if (required) errors.push(`${manifest.name} 本地没有可用的 ${iconPath}，无法核对索引图标`);
      continue;
    }
    let bytes;
    try {
      bytes = decodeIconDataUrl(entry.icon, `${manifest.name}.icon`);
    } catch (error) {
      errors.push(`${manifest.name} 的索引 icon 不合法：${/** @type {Error} */ (error).message}`);
      continue;
    }
    if (sha256(bytes) !== manifest.iconSha256) {
      errors.push(
        `${manifest.name} 的索引 icon 与 ${iconPath} 不一致（sha256 ${sha256(bytes)} ≠ ${manifest.iconSha256}）`,
      );
      continue;
    }
    icons.push({ name: manifest.name, bytes: bytes.length, sha256: manifest.iconSha256 });
  }
  const localNames = new Set(manifests.map((manifest) => manifest.name));
  for (const plugin of plugins) {
    if (!localNames.has(plugin.name)) {
      errors.push(`${plugin.name} 在索引里但 packages/ 下没有对应插件（ghost 条目；重建索引）`);
    }
  }
  return {
    errors,
    icons,
    totalBytes: icons.reduce((sum, icon) => sum + icon.bytes, 0),
  };
}

/**
 * 离线自检「将要写进索引的内联结果与本地图标文件一致」：把 collectPackages 产出的
 * data URL 解回来，按 sha256 与本地文件比对。不联网、不依赖 build/index.json 存在，
 * 所以 `pnpm check` 在裸检出上也能拦住「图标转换写坏」。
 * @param {{ name: string, icon?: string, iconPath?: string, iconSha256?: string }[]} manifests
 * @returns {{ errors: string[], icons: { name: string, bytes: number, sha256: string }[], totalBytes: number }}
 */
export function localIconAudit(manifests) {
  /** @type {string[]} */
  const errors = [];
  /** @type {{ name: string, bytes: number, sha256: string }[]} */
  const icons = [];
  for (const manifest of manifests) {
    if (manifest.icon === undefined || manifest.iconSha256 === undefined) continue;
    const iconPath = manifest.iconPath ?? "icon.svg";
    let bytes;
    try {
      bytes = decodeIconDataUrl(manifest.icon, `${manifest.name}.icon`);
    } catch (error) {
      errors.push(`${manifest.name} 的内联图标不合法：${/** @type {Error} */ (error).message}`);
      continue;
    }
    if (sha256(bytes) !== manifest.iconSha256) {
      errors.push(
        `${manifest.name} 的内联图标与本地 ${iconPath} 不一致（sha256 ${sha256(bytes)} ≠ ${manifest.iconSha256}）`,
      );
      continue;
    }
    icons.push({ name: manifest.name, bytes: bytes.length, sha256: manifest.iconSha256 });
  }
  return {
    errors,
    icons,
    totalBytes: icons.reduce((sum, icon) => sum + icon.bytes, 0),
  };
}

/**
 * 拉一个包的 packument。
 * @param {string} name @param {{ registry?: string, attempts?: number, fetchImpl?: typeof fetch }} [options]
 */
/**
 * 重试节奏：**404 与其它错误分开**。
 *
 * 404 通常意味着「包刚发布、registry 还没传播完」——npm 对新包会提示
 * "Your package is being processed and may take a few minutes"，实测约 8 分钟才可查。
 * 2026-11-17 首次发版时索引工作流在 release 后 22 秒启动，只用 4 秒的重试窗口直接失败。
 * 所以 404 走**长退避**（默认 12 次、间隔 20s 起、封顶 60s，合计约 10 分钟），
 * 其它错误（网络抖动、5xx）仍快速失败，避免把真问题拖成十分钟。
 *
 * 两者都可用环境变量覆盖，便于 CI 调参或本地快速失败：
 *   INDEX_404_ATTEMPTS / INDEX_404_DELAY_MS / INDEX_ATTEMPTS
 * @param {number} attempt 第几次重试（1 起）
 * @param {number} baseMs
 * @returns {number}
 */
export function retryDelayMs(attempt, baseMs = 20_000) {
  return Math.min(attempt * baseMs, 60_000);
}

/**
 * 从 registry 取 packument，带分级重试。
 * @param {string} name
 * @param {{
 *   registry?: string,
 *   attempts?: number,
 *   notFoundAttempts?: number,
 *   notFoundDelayMs?: number,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 * }} [options]
 * @returns {Promise<any>}
 */
export async function fetchPackument(
  name,
  {
    registry = DEFAULT_REGISTRY,
    attempts = Number(process.env.INDEX_ATTEMPTS ?? 3),
    notFoundAttempts = Number(process.env.INDEX_404_ATTEMPTS ?? 12),
    notFoundDelayMs = Number(process.env.INDEX_404_DELAY_MS ?? 20_000),
    fetchImpl = fetch,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const url = `${registry.replace(/\/$/u, "")}/${encodeURIComponent(name)}`;
  let lastError;
  let notFoundSeen = 0;
  let otherAttempts = 0;
  for (;;) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "kangyishuai-dsh-plugins-index" },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 404) {
        notFoundSeen += 1;
        if (notFoundSeen >= notFoundAttempts) throw new Error(`HTTP 404 ${url}`);
        await sleepImpl(retryDelayMs(notFoundSeen, notFoundDelayMs));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      // 404 已在上面单独处理（含长退避），这里只处理其它错误。
      if (String(/** @type {Error} */ (error)?.message ?? "").startsWith("HTTP 404")) break;
      otherAttempts += 1;
      if (otherAttempts >= attempts) break;
      await sleepImpl(otherAttempts * 1000);
    }
  }
  throw new Error(
    `取 ${name} 的 registry 数据失败：${/** @type {Error} */ (lastError)?.message ?? "未知错误"}`,
  );
}

/**
 * 找出「manifest 声明了、但 registry 上还看不到」的版本。
 *
 * 为什么需要单独一个函数：`fetchPackument` 的重试只在 **404**（包完全不存在）时生效；
 * 而发版后更常见的情况是 packument **返回 200、内容还是旧版本**。
 * 2026-11-17 实测：release 工作流发布 0.1.1 / 0.2.0 / 0.3.0 后，index.yml 各失败一次，
 * 全部是这个原因（`@kangyishuai/dsh-btw@0.3.0 还没有发布到 npm（registry 上是 0.2.0）`），
 * 导致线上索引从 btw 0.1.0 起就没再更新过。
 * @param {{ name: string, version: string }[]} manifests
 * @param {Map<string, any>} packuments
 * @returns {{ name: string, version: string, latest: string }[]}
 */
export function missingPublishedVersions(manifests, packuments) {
  /** @type {{ name: string, version: string, latest: string }[]} */
  const missing = [];
  for (const manifest of manifests) {
    const packument = packuments.get(manifest.name);
    if (!packument) {
      missing.push({ name: manifest.name, version: manifest.version, latest: "(无数据)" });
      continue;
    }
    const versions = stableVersions(packument);
    if (!versions.some((item) => item.version === manifest.version)) {
      missing.push({
        name: manifest.name,
        version: manifest.version,
        latest: versions[0]?.version ?? "(无正式版本)",
      });
    }
  }
  return missing;
}

/** @param {string} path */
async function readMetaFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * CLI 入口。
 * @param {string[]} argv
 */
export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const outAt = argv.indexOf("--out");
  const out = resolve(
    REPO_ROOT,
    outAt === -1 ? DEFAULT_OUT : /** @type {string} */ (argv[outAt + 1]),
  );
  const registryAt = argv.indexOf("--registry");
  const registry =
    registryAt === -1 ? DEFAULT_REGISTRY : /** @type {string} */ (argv[registryAt + 1]);
  const meta = await readMetaFile(join(REPO_ROOT, "scripts", "index-meta.json"));
  /** @type {ReturnType<typeof collectPackages>} */
  let manifests;
  try {
    manifests = collectPackages(REPO_ROOT);
  } catch (error) {
    console.error(`读取 packages/ 失败：${/** @type {Error} */ (error).message}`);
    return 1;
  }

  const drift = checkMeta(manifests, meta);
  if (drift.length > 0) {
    console.error("scripts/index-meta.json 与 packages/ 不一致：");
    for (const line of drift) console.error(`  - ${line}`);
    return 1;
  }

  // 图标审计放在联网之前：正式插件缺图标/转换写坏时直接失败，不浪费几分钟去拉 registry。
  const iconIssues = checkIcons(manifests, meta);
  for (const warning of iconIssues.warnings) console.warn(`warn: ${warning}`);
  const localIcons = localIconAudit(manifests);
  const iconErrors = [...iconIssues.errors, ...localIcons.errors];
  if (iconErrors.length > 0) {
    console.error("插件图标不能写进索引：");
    for (const line of iconErrors) console.error(`  - ${line}`);
    return 1;
  }
  const iconSummary = `${localIcons.icons.length} 个图标（源文件合计 ${localIcons.totalBytes} B）`;

  if (check) {
    // 离线：meta 一致性 + 图标内联自检 +（存在时的）输出文件结构与图标字节核对，不联网。
    try {
      const existing = JSON.parse(await readFile(out, "utf8"));
      validateIndex(existing);
      // 只有正式插件（登记且非 0.0.0）必须出现在索引里；0.0.0 脚手架还没发版不硬报错。
      const formalNames = new Set(
        manifests
          .filter((manifest) => isFormalPlugin(manifest, meta))
          .map((manifest) => manifest.name),
      );
      const comparison = iconDrift(existing, manifests, formalNames);
      if (comparison.errors.length > 0) {
        console.error(`${out} 与本地包不一致：`);
        for (const line of comparison.errors) console.error(`  - ${line}`);
        return 1;
      }
      console.log(
        `check: ${out} 是合法的 format 1 索引（${existing.plugins.length} 个插件）；${comparison.icons.length} 个图标与本地图标文件逐字节一致（合计 ${comparison.totalBytes} B）`,
      );
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
      console.log(
        `check: meta 一致；${iconSummary}可内联；还没有生成 ${out}（发版时由 workflow 生成）`,
      );
    }
    return 0;
  }

  /** @type {Map<string, any>} */
  const packuments = new Map();
  for (const manifest of manifests)
    packuments.set(manifest.name, await fetchPackument(manifest.name, { registry }));

  // 等每个包声明的版本都出现在 registry 上。
  //
  // 为什么不用固定次数：npm 的**元数据**与 **tarball/CDN** 分开传播，实测能差好几分钟。
  // 0.9.0 发版时固定 12 次 × 20s（共 4 分钟）就用完了，工作流报"等不到版本"而失败，
  // 只能人工重跑。改成指数退避 + 总预算（默认 15 分钟），并在每次重试时打印已等时长。
  const waitBudgetMs = Number(process.env.INDEX_VERSION_WAIT_MS ?? 15 * 60_000);
  const waitStartMs = Date.now();
  let delayMs = Number(process.env.INDEX_VERSION_DELAY_MS ?? 5_000);
  const maxDelayMs = 60_000;
  for (;;) {
    const missing = missingPublishedVersions(manifests, packuments);
    if (missing.length === 0) break;
    const waitedMs = Date.now() - waitStartMs;
    if (waitedMs + delayMs > waitBudgetMs) {
      throw new Error(
        `等不到这些版本出现在 npm（已等 ${Math.round(waitedMs / 1000)}s，预算 ${Math.round(
          waitBudgetMs / 1000,
        )}s）：${missing
          .map((item) => `${item.name}@${item.version}（registry 上是 ${item.latest}）`)
          .join("、")}`,
      );
    }
    console.log(
      `等待 registry 传播（已等 ${Math.round(waitedMs / 1000)}s，下次再等 ${Math.round(
        delayMs / 1000,
      )}s）：${missing.map((item) => `${item.name}@${item.version}`).join("、")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(maxDelayMs, Math.round(delayMs * 2));
    for (const item of missing) {
      packuments.set(item.name, await fetchPackument(item.name, { registry }));
    }
  }

  const index = buildIndex({ manifests, meta, packuments });
  await mkdir(join(out, ".."), { recursive: true });
  // 压缩成一行：宿主读取有 15 秒预算，缩进纯属浪费带宽。
  const body = `${JSON.stringify(index)}\n`;
  await writeFile(out, body);
  /** @type {{ name: string, icon?: string, versions: { version: string }[] }[]} */
  const plugins = index.plugins;
  const versionCount = plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0);
  console.log(
    `wrote ${out}：${plugins.length} 个插件 / ${versionCount} 个版本 / ${iconSummary}；内联图标的索引共 ${Buffer.byteLength(body)} B`,
  );
  for (const plugin of plugins) {
    console.log(
      `  ${plugin.name.padEnd(42)} ${plugin.versions[0].version}（${plugin.versions.length} 个版本）`,
    );
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
