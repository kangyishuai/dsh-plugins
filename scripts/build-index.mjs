#!/usr/bin/env node
// @ts-check
// 用法：pnpm index                     —— 从 npm registry 重建索引（联网）
//       pnpm index --out build/index.json
//       pnpm check:index               —— 离线校验：meta ↔ packages 一致 + 已有输出结构合法
//
// 生成 DSH 的插件索引源（plugin market index format 1）：一个列出本仓库全部插件、
// 全部正式版本的 JSON，用户把它加到「插件 → 发现 → 添加索引源」，就能在发现页里
// 搜索、查看、安装。格式的权威定义是宿主包 `@deepseek-ai/dsh-plugin-market-index`；
// 本仓库不能把宿主包当依赖（AGENTS 硬性约定 3），所以这里按它的规则写了一份
// 独立校验器，规则来源与实测坑位记在 docs/runtime/0.2.2-rc.3.md。
//
// 为什么在发版后重建、而不是每次手写：format 1 是**写死的版本清单**，宿主的
// Discover 只信索引里列出的版本，不会自己去 registry 补全。少更新一次，用户看到
// 的就是旧版本，点安装也会装到旧版本。所以版本列表一律从 registry 现场枚举。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
        return {
          name: manifest.name,
          title: entry.title,
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
 * 读 packages/ 下的插件清单（只需要索引用到的字段）。
 * @param {string} root
 * @returns {{ dir: string, name: string, version: string, description: any, homepage: any, repository: Record<string, any> }[]}
 */
export function collectPackages(root) {
  return listPluginDirs(root).map((dir) => {
    const manifest = readJson(join(root, "packages", dir, "package.json"));
    return {
      dir,
      name: stringAt(manifest.name, `packages/${dir}/package.json#name`),
      version: stringAt(manifest.version, `packages/${dir}/package.json#version`),
      description: manifest.description,
      homepage: manifest.homepage,
      repository: objectAt(manifest.repository, `packages/${dir}/package.json#repository`),
    };
  });
}

/**
 * 拉一个包的 packument。
 * @param {string} name @param {{ registry?: string, attempts?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function fetchPackument(
  name,
  { registry = DEFAULT_REGISTRY, attempts = 3, fetchImpl = fetch } = {},
) {
  const url = `${registry.replace(/\/$/u, "")}/${encodeURIComponent(name)}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "kangyishuai-dsh-plugins-index" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      // 发布后 registry 需要几秒才可见，按 1s / 3s 退避重试。
      if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(
    `取 ${name} 的 registry 数据失败：${/** @type {Error} */ (lastError)?.message ?? "未知错误"}`,
  );
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
  const manifests = collectPackages(REPO_ROOT);

  const drift = checkMeta(manifests, meta);
  if (drift.length > 0) {
    console.error("scripts/index-meta.json 与 packages/ 不一致：");
    for (const line of drift) console.error(`  - ${line}`);
    return 1;
  }

  if (check) {
    // 离线：只验证 meta 一致性与（存在时的）输出文件结构，不联网。
    try {
      const existing = JSON.parse(await readFile(out, "utf8"));
      validateIndex(existing);
      console.log(`check: ${out} 是合法的 format 1 索引（${existing.plugins.length} 个插件）`);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
      console.log(`check: meta 一致；还没有生成 ${out}（发版时由 workflow 生成）`);
    }
    return 0;
  }

  /** @type {Map<string, any>} */
  const packuments = new Map();
  for (const manifest of manifests)
    packuments.set(manifest.name, await fetchPackument(manifest.name, { registry }));
  const index = buildIndex({ manifests, meta, packuments });
  await mkdir(join(out, ".."), { recursive: true });
  // 压缩成一行：宿主读取有 15 秒预算，缩进纯属浪费带宽。
  await writeFile(out, `${JSON.stringify(index)}\n`);
  /** @type {{ name: string, versions: { version: string }[] }[]} */
  const plugins = index.plugins;
  const versionCount = plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0);
  console.log(`wrote ${out}：${plugins.length} 个插件 / ${versionCount} 个版本`);
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
