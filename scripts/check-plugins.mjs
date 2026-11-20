#!/usr/bin/env node
// @ts-check
// 用法：pnpm check
// 把 docs/plugin-conventions.md 里的硬性规则变成机器检查。error 让命令失败，warn 只提示。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSnapshot } from "./host-tokens.mjs";
import { isMain, listPluginDirs, PREFIX, REPO_ROOT, readJson, toCamel } from "./lib/repo.mjs";

/** @typedef {{ level: "error" | "warn", plugin: string, message: string }} Issue */

const REPO_URL = "git+https://github.com/kangyishuai/dsh-plugins.git";

/**
 * 递归列出目录下的 .js 文件（只用于扫插件源码里的 CSS 字符串）。
 * @param {string} dir
 * @returns {string[]}
 */
function listJsFiles(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * 扫一份源码里用到的主题 token 与「写死白色前景」，把问题追加到 issues。
 *
 * 为什么是 error：CSS 变量写错名字**不会报错**，只会静默落到 `var()` 的第二个参数，
 * 于是那段样式永远不跟随深浅色主题。0.6.1「深色下白底白字的确认按钮」和 0.5.0
 * 「警告色在深浅色下永远同一个暗金」都是这么来的，肉眼发现不了、单测也难覆盖。
 * @param {Issue[]} issues
 * @param {string} plugin 上报用的名字（插件目录名，或 "templates"）
 * @param {string} file 绝对路径
 * @param {string} label 报错里显示的仓库相对路径
 * @param {Set<string>} hostTokens 宿主真实定义的 token
 */
function checkThemeTokens(issues, plugin, file, label, hostTokens) {
  const src = readFileSync(file, "utf8");
  /** @param {Issue["level"]} level @param {string} message */
  const report = (level, message) => issues.push({ level, plugin, message });

  /** @type {Map<string, number>} token -> 首次出现的行号 */
  const used = new Map();
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(/var\((--(?:dsw|ds)-[a-z0-9-]+)/g)) {
      if (!used.has(match[1])) used.set(match[1], i + 1);
    }
  }
  for (const [token, line] of used) {
    if (!hostTokens.has(token)) {
      report(
        "error",
        `${label}:${line} 用了宿主不存在的主题 token「${token}」（会静默落到硬编码兜底色，永远不跟主题）。真名见 scripts/lib/host-theme-tokens.json`,
      );
    }
  }

  // 写死白色前景：`color: "#fff"` / `color: #ffffff`。允许出现在 var() 的兜底参数里。
  for (let i = 0; i < lines.length; i += 1) {
    if (/(?<![\w-])color\s*:\s*["']?(?:#fff{1,2}|#ffffff|white)["']?\s*[,;}]/i.test(lines[i])) {
      report(
        "warn",
        `第 ${i + 1} 行把白写死当前景色：底色一旦是随主题翻转的 token，深色主题下就会糊成一片。改用 --dsw-alias-label-primary-foreground 之类的配对 token`,
      );
    }
  }
}

/**
 * @param {string} [root]
 * @returns {Issue[]}
 */
export function checkRepo(root = REPO_ROOT) {
  /** @type {Issue[]} */
  const issues = [];
  /** @type {Map<string, string>} cordis id -> 插件目录 */
  const cordisIds = new Map();
  // 宿主主题 token 快照（CI 里没有 DSH 可查，所以用提交在仓库里的那份）。
  const hostTokens = new Set(readSnapshot().tokens);

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

    // 冒烟脚本里用到的 data-* 锚点必须真的在 client 半里定义，
    // 否则选择器写错了断言会"空转通过"（拿到 null 也能被写成宽容断言）。
    const clientFile = join(base, "lib", "client.js");
    if (existsSync(clientFile)) {
      const clientSrc = readFileSync(clientFile, "utf8");
      for (const smokeName of [`smoke-${dir}.mjs`, `smoke-${dir}-desktop.mjs`]) {
        const smokePath = join(root, "scripts", smokeName);
        if (!existsSync(smokePath)) continue;
        const smokeSrc = readFileSync(smokePath, "utf8");
        const anchors = new Set(
          [
            ...smokeSrc.matchAll(new RegExp(`data-${dir.replace(/-/g, "\\-")}-[a-z0-9-]+`, "g")),
          ].map((m) => m[0]),
        );
        for (const anchorName of anchors) {
          if (!clientSrc.includes(anchorName)) {
            report("error", `${smokeName} 里的锚点 ${anchorName} 在 lib/client.js 中不存在`);
          }
        }
      }
    }

    // Remote 方法签名必须是裸标识符：typert 的 SRC 生成器会把行内类型注释当成
    // 解构/复杂参数而拒绝注册端点，表现为运行时 404（单测与 verify 都发现不了）。
    const serviceFile = join(base, "lib", "service.js");
    if (existsSync(serviceFile)) {
      const serviceSrc = readFileSync(serviceFile, "utf8");
      const serviceLines = serviceSrc.split("\n");
      const remotes = [...serviceSrc.matchAll(/declareRemote\(\w+,\s*"([\w$]+)"\)/g)].map(
        (m) => m[1],
      );
      for (const name of remotes) {
        const idx = serviceLines.findIndex((line) =>
          new RegExp(`^\\s*(async\\s+)?${name.replace(/\$/g, "\\$")}\\s*\\(`).test(line),
        );
        if (idx < 0) continue;
        const signature = serviceLines[idx];
        if (signature.includes("/**")) {
          report(
            "error",
            `Remote 方法 ${name} 的参数表里不能有行内类型注释（SRC 网关会拒绝注册）；请改用上方 JSDoc @param`,
          );
        }
        if (/\(\s*\{/.test(signature) || /=\s*[^,)]/.test(signature) || /\.\.\./.test(signature)) {
          report("error", `Remote 方法 ${name} 不能有解构/默认值/rest 参数（SRC 网关限制）`);
        }
      }
    }

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

    // 桌面端自动化测试（硬性要求：有 client 半就必须有桌面套件）
    if (pkg.dsh?.client) {
      const rootPkgPath = join(root, "package.json");
      /** @type {Record<string, string>} */
      let rootScripts = {};
      try {
        rootScripts = JSON.parse(readFileSync(rootPkgPath, "utf8")).scripts ?? {};
      } catch {
        rootScripts = {};
      }
      const desktopScript = `smoke:${dir}-desktop`;
      const desktopFile = join(root, "scripts", `smoke-${dir}-desktop.mjs`);
      if (rootScripts[desktopScript] === undefined) {
        report(
          "error",
          `有 client 半，必须提供桌面端自动化测试：根 package.json 缺少 "${desktopScript}" 脚本（约定见 docs/plugin-conventions.md §6）`,
        );
      } else if (!existsSync(desktopFile)) {
        report("error", `${desktopScript} 指向的 scripts/smoke-${dir}-desktop.mjs 不存在`);
      } else {
        const src = readFileSync(desktopFile, "utf8");
        if (!/remote-debugging-port|DSH_CDP_PORT/u.test(src)) {
          report(
            "error",
            `${desktopScript} 没有走 CDP（应支持 --remote-debugging-port / DSH_CDP_PORT）`,
          );
        }
        if (!/--require|require:/u.test(src)) {
          report("error", `${desktopScript} 必须支持 --require（连不上端口时判失败，而不是跳过）`);
        }
      }
    }

    // 主题 token：只能用宿主真实存在的 `--dsw-*` / `--ds-*`（写错名会静默落到硬编码兜底色）
    for (const file of listJsFiles(join(base, "lib"))) {
      checkThemeTokens(issues, dir, file, file.slice(root.length + 1), hostTokens);
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
  // 模板也要守同一条规则：模板里写错的 token 会被每个新插件继承。
  for (const file of listJsFiles(join(root, "templates"))) {
    checkThemeTokens(issues, "templates", file, file.slice(root.length + 1), hostTokens);
  }

  // 仓库级登记：PR 自动打标签、bug 报告下拉（pnpm new 会自动写入，手建的插件容易漏）
  const labeler = join(root, ".github", "labeler.yml");
  const bug = join(root, ".github", "ISSUE_TEMPLATE", "bug_report.yml");
  const readmeEn = join(root, "README.md");
  const readmeZh = join(root, "README.zh-CN.md");
  for (const dir of listPluginDirs(root)) {
    if (existsSync(labeler) && !readFileSync(labeler, "utf8").includes(`"plugin:${dir}"`)) {
      issues.push({
        level: "warn",
        plugin: dir,
        message: `.github/labeler.yml 缺少 "plugin:${dir}" 规则`,
      });
    }
    if (existsSync(bug) && !readFileSync(bug, "utf8").includes(`"${PREFIX}${dir}"`)) {
      issues.push({ level: "warn", plugin: dir, message: "bug_report.yml 的插件下拉缺少本插件" });
    }
    // 根 README 双语的插件清单（AGENTS.md 开发流程第 6 条）。
    // 用 error 而不是 warn：这份清单是用户找插件的唯一入口，漏了等于插件不存在。
    if (
      existsSync(readmeEn) &&
      !readFileSync(readmeEn, "utf8").includes(`packages/${dir}#readme`)
    ) {
      issues.push({
        level: "error",
        plugin: dir,
        message: "根 README.md 的插件清单缺少本插件（AGENTS.md 开发流程第 6 条）",
      });
    }
    if (
      existsSync(readmeZh) &&
      !readFileSync(readmeZh, "utf8").includes(`packages/${dir}/README.zh-CN.md`)
    ) {
      issues.push({
        level: "error",
        plugin: dir,
        message: "根 README.zh-CN.md 的插件清单缺少本插件（AGENTS.md 开发流程第 6 条）",
      });
    }
  }

  // 桌面回归脚本必须打印 `N PASS / M SKIP / K FAIL`：gate.mjs 靠这一行识别「跑过但零断言」
  // 的假绿；2026-11-20 之前有五条脚本漏打，门禁的假绿防线对它们等于不存在。这里做成静态检查，
  // 新脚本漏了会在 `pnpm check` / CI 直接拦住，而不是等下一次升级才发现。
  /** @type {Map<string, string>} name → plugin 目录（用于把问题挂到插件名下） */
  const desktopSmokeOwner = new Map();
  for (const dir of listPluginDirs(root)) desktopSmokeOwner.set(`smoke-${dir}-desktop.mjs`, dir);
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir)) {
      if (!/^smoke-.+-desktop\.mjs$/u.test(name)) continue;
      const src = readFileSync(join(scriptsDir, name), "utf8");
      if (!/PASS\s*\/\s*.*SKIP\s*\/\s*.*FAIL/u.test(src)) {
        issues.push({
          level: "error",
          plugin: desktopSmokeOwner.get(name) ?? "scripts",
          message: `${name} 没有打印 \`N PASS / M SKIP / K FAIL\` 计数行（gate.mjs 靠它判断假绿，见 docs/plugin-conventions.md §6.1）`,
        });
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
