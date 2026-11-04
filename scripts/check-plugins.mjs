#!/usr/bin/env node
// @ts-check
// 用法：pnpm check
// 把 docs/plugin-conventions.md 里的硬性规则变成机器检查。error 让命令失败，warn 只提示。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, listPluginDirs, PREFIX, REPO_ROOT, readJson, toCamel } from "./lib/repo.mjs";

/** @typedef {{ level: "error" | "warn", plugin: string, message: string }} Issue */

const REPO_URL = "git+https://github.com/kangyishuai/dsh-plugins.git";

/**
 * @param {string} [root]
 * @returns {Issue[]}
 */
export function checkRepo(root = REPO_ROOT) {
  /** @type {Issue[]} */
  const issues = [];
  /** @type {Map<string, string>} cordis id -> 插件目录 */
  const cordisIds = new Map();

  for (const dir of listPluginDirs(root)) {
    const base = join(root, "packages", dir);
    /** @param {Issue["level"]} level @param {string} message */
    const report = (level, message) => issues.push({ level, plugin: dir, message });
    const has = (/** @type {string} */ rel) => existsSync(join(base, rel));

    if (!has("package.json")) {
      report("error", "缺少 package.json");
      continue;
    }
    const pkg = readJson(join(base, "package.json"));
    const expectedName = `${PREFIX}${dir}`;

    // 命名与元信息
    if (pkg.name !== expectedName) report("error", `包名应为 ${expectedName}，实际 ${pkg.name}`);
    if (pkg.private) report("warn", "package.json 标记了 private，不会被发布");
    if (pkg.type !== "module") report("error", 'type 必须是 "module"');
    if (pkg.license !== "MIT") report("error", "license 必须是 MIT");
    if (!has("LICENSE")) report("error", "缺少 LICENSE（npm pack 不会带上根目录的 LICENSE）");
    if (!has("README.md")) report("error", "缺少 README.md（AGENTS.md 硬性约定 6）");
    if (pkg.publishConfig?.access !== "public") {
      report("error", 'publishConfig.access 必须是 "public"，否则 scoped 包默认按私有发布');
    }
    if (pkg.repository?.url !== REPO_URL || pkg.repository?.directory !== `packages/${dir}`) {
      report(
        "error",
        `repository 必须是 { url: "${REPO_URL}", directory: "packages/${dir}" }（npm provenance 需要）`,
      );
    }

    // 发布文件清单
    for (const entry of pkg.files ?? []) {
      if (!has(entry)) report("error", `files 中的 ${entry} 不存在`);
    }
    if (pkg.main && !has(pkg.main)) report("error", `main 指向的 ${pkg.main} 不存在`);
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      if (typeof target === "string" && !has(target))
        report("error", `exports["${key}"] 指向的 ${target} 不存在`);
    }

    // 不把宿主包当依赖、不写 DSH 版本约束（AGENTS.md 硬性约定 3）
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (dep.startsWith("@deepseek-ai/"))
          report("error", `${field} 里不能声明 ${dep}（运行时由宿主提供）`);
      }
    }
    if (pkg.engines?.dsh)
      report("warn", "声明了 engines.dsh：预发布版本下 semver 不可靠，确认已验证过");

    // host 半接线
    const patch = pkg.dsh?.bundle?.patch;
    if (!patch) {
      report("error", "缺少 dsh.bundle.patch");
    } else if (!has(patch)) {
      report("error", `dsh.bundle.patch 指向的 ${patch} 不存在`);
    } else {
      const yml = readFileSync(join(base, patch), "utf8");
      const ids = [...yml.matchAll(/^\s*-?\s*id:\s*['"]?([^'"\s]+)/gm)].map((m) => m[1]);
      const names = [...yml.matchAll(/^\s*name:\s*['"]?([^'"\s]+)/gm)].map((m) => m[1]);
      if (ids.length === 0) report("error", `${patch} 里没有 id`);
      for (const id of ids) {
        if (!/^[a-z][a-z0-9-]*$/.test(id)) report("error", `cordis id「${id}」必须是 kebab-case`);
        const owner = cordisIds.get(id);
        if (owner) report("error", `cordis id「${id}」与 ${owner} 重复`);
        else cordisIds.set(id, dir);
      }
      if (!names.includes(expectedName)) report("error", `${patch} 的 name 应为 ${expectedName}`);
    }

    // client 半
    if (pkg.dsh?.client) {
      if (!has("lib/client.js")) {
        report("error", "声明了 dsh.client 但缺少 lib/client.js");
      } else {
        const src = readFileSync(join(base, "lib/client.js"), "utf8");
        if (!src.includes("__ModuleLoader__.load"))
          report("error", "lib/client.js 没有调用 window.__ModuleLoader__.load");
        if (!src.includes(`"${expectedName}"`))
          report("error", `lib/client.js 的 load id 应为 "${expectedName}"`);
        if (/^\s*import\s/m.test(src))
          report("error", "lib/client.js 是 classic script，不能使用 import 语句");
      }
    }

    // locale：zh/en 必须同时存在且 key 完全一致
    const zhPath = join(base, "locale/zh.json");
    const enPath = join(base, "locale/en.json");
    if (existsSync(zhPath) || existsSync(enPath)) {
      if (!existsSync(zhPath) || !existsSync(enPath)) {
        report("error", "locale/zh.json 与 locale/en.json 必须同时存在");
      } else {
        const zh = readJson(zhPath);
        const en = readJson(enPath);
        const zhKeys = new Set(flattenKeys(zh));
        const enKeys = new Set(flattenKeys(en));
        for (const k of zhKeys) if (!enKeys.has(k)) report("error", `locale/en.json 缺少 ${k}`);
        for (const k of enKeys) if (!zhKeys.has(k)) report("error", `locale/zh.json 缺少 ${k}`);
        const ns = toCamel(dir);
        if (!(ns in zh)) report("warn", `locale 顶层命名空间建议为 ${ns}`);
      }
    }
  }
  return issues;
}

/**
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {string[]}
 */
function flattenKeys(value, prefix = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => flattenKeys(v, prefix ? `${prefix}.${k}` : k));
}

if (isMain(import.meta.url)) {
  const issues = checkRepo();
  const plugins = listPluginDirs(REPO_ROOT);
  for (const { level, plugin, message } of issues) {
    const tag = level === "error" ? "\x1b[31merror\x1b[0m" : "\x1b[33mwarn \x1b[0m";
    console.log(`${tag} ${plugin}: ${message}`);
  }
  const errors = issues.filter((i) => i.level === "error").length;
  console.log(
    `检查了 ${plugins.length} 个插件：${errors} 个错误，${issues.length - errors} 个警告`,
  );
  process.exit(errors > 0 ? 1 : 0);
}
