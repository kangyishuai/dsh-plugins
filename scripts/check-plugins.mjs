#!/usr/bin/env node
// @ts-check
// 用法：pnpm check
// 把 docs/plugin-conventions.md 里的硬性规则变成机器检查。error 让命令失败，warn 只提示。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
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

/** 宿主接受作为插件图标的扩展名（`dsh-app-boot` 的 `ICON_MEDIA_TYPES`）。 */
const ICON_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);
/** 宿主接受的插件图标体积上限（256 KiB）。 */
const MAX_ICON_BYTES = 256 * 1024;
/** 判断文件头时最多读这么多字节（WebP 需要前 12 字节；SVG 只看开头有没有 `<svg`）。 */
const ICON_HEAD_BYTES = 1024;

/**
 * 把 Node exports pattern 转成正则：`*` 在宿主/Node 的 exports 子路径里按前缀后缀匹配，
 * 可以含 `/`，因此等价成 `.*`。
 * @param {string} target
 * @returns {RegExp}
 */
function exportPatternToRegExp(target) {
  const escaped = target
    .split("*")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

/**
 * 列出插件目录内的普通文件（POSIX 相对路径）。跳过 node_modules 与点目录：它们是依赖/缓存，
 * 不是包内容。
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listPackageFiles(dir, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listPackageFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/**
 * 解析一个 exports 目标命中的包内文件。
 * 字面量目标按文件存在判断；含 `*` 的 exports pattern 按包内文件做 glob 匹配（至少命中 1 个），
 * 不能用 `existsSync` 直接查通配字符串。
 * @param {string} base 插件目录绝对路径
 * @param {string} target exports 的字符串值
 * @param {string[]} packageFiles 包内相对文件（POSIX）
 * @returns {string[]} 命中的包内相对路径；空数组表示目标不合法
 */
function matchedExportFiles(base, target, packageFiles) {
  if (!target.includes("*")) {
    const file = join(base, target);
    return existsSync(file) && statSync(file).isFile() ? [target.replace(/^\.\//, "")] : [];
  }
  const pattern = exportPatternToRegExp(target.startsWith("./") ? target : `./${target}`);
  return packageFiles
    .map((file) => `./${file}`)
    .filter((file) => pattern.test(file))
    .map((file) => file.slice(2));
}

/**
 * 图标文件头嗅探：宿主把 `icon` 交给浏览器按图片解码，坏文件会静默回退默认图。
 * @param {Buffer} head 文件前若干字节
 * @param {string} ext 小写扩展名（含点）
 * @returns {boolean}
 */
function hasIconSignature(head, ext) {
  if (ext === ".svg") {
    const text = head
      .toString("utf8")
      .replace(/^\uFEFF/u, "")
      .trimStart();
    return (
      text.startsWith("<svg") ||
      (text.startsWith("<?xml") && text.includes("<svg")) ||
      (text.startsWith("<!--") && text.includes("<svg"))
    );
  }
  if (ext === ".png") {
    return (
      head.length >= 8 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47 &&
      head[4] === 0x0d &&
      head[5] === 0x0a &&
      head[6] === 0x1a &&
      head[7] === 0x0a
    );
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }
  if (ext === ".webp") {
    return (
      head.length >= 12 &&
      head.toString("latin1", 0, 4) === "RIFF" &&
      head.toString("latin1", 8, 12) === "WEBP"
    );
  }
  return false;
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
  /** @type {Map<number, string[]>} settings.section 的 order -> 插件目录（用于查并列） */
  const settingsOrderOwners = new Map();
  // 宿主主题 token 快照（CI 里没有 DSH 可查，所以用提交在仓库里的那份）。
  const hostTokens = new Set(readSnapshot().tokens);
  // 插件身份（meta/icon）只在登记进索引源的正式插件上强制：模板/脚手架生成的临时插件由
  // `build-index --check` 的登记检查兜底，否则 `pnpm new` 刚建好、还没登记时 `pnpm check` 会红。
  const indexMetaPath = join(root, "scripts/index-meta.json");
  const indexMeta = existsSync(indexMetaPath) ? readJson(indexMetaPath) : undefined;

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
    // 插件身份（locale meta / 顶层 icon）只在「登记进索引源的正式版本插件」上强制：
    // 模板/脚手架生成的 0.0.0 临时插件还没登记索引源，身份缺失由 build-index 的登记检查兜底；
    // 首个 changeset 让版本号离开 0.0.0 后开始强制。模板本身已自带身份三件套，
    // 断言见 scripts/test/scaffold-and-check.test.js（不依赖这里的豁免）。
    const registered = indexMeta?.plugins?.[expectedName];
    const identityEnforced = Boolean(registered) && pkg.version !== "0.0.0";

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
    // exports：字面量按文件存在判断；`./locale/*.json` 这类 Node exports pattern 按包内文件
    // 做 glob 匹配。宿主用 Node 的模块解析器读 locale，通配与逐文件显式都能被解析。
    const packageFiles = listPackageFiles(base);
    /** @type {Map<string, string[]>} */
    const exportMatches = new Map();
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      if (typeof target !== "string") continue;
      const matches = matchedExportFiles(base, target, packageFiles);
      exportMatches.set(key, matches);
      if (matches.length === 0) {
        report(
          "error",
          target.includes("*")
            ? `exports["${key}"] 的通配 ${target} 没有匹配到任何文件`
            : `exports["${key}"] 指向的 ${target} 不存在`,
        );
      }
    }
    // locale 目录里的每个 .json 都必须能被某个 exports 子路径解析到：宿主的 dictionariesOf()
    // 会遍历整个目录逐个解析，只要漏掉一个就返回 {error}，连带 title/description/icon 全丢。
    const localeDir = join(base, "locale");
    if (identityEnforced && existsSync(localeDir)) {
      for (const entry of readdirSync(localeDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const rel = `locale/${entry.name}`;
        if (![...exportMatches.values()].some((matches) => matches.includes(rel))) {
          report(
            "error",
            `locale/${entry.name} 未被 exports 覆盖（宿主解析失败会丢整套 meta/icon）`,
          );
        }
      }
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

    // 设置分节 order：每个插件一个分节，order 必须落在约定区间（docs/plugin-conventions.md §7.1）。
    // 并列会让设置页顺序取决于注册时序（用户上次记住的位置会漂），所以下面按仓库级查重。
    if (existsSync(clientFile)) {
      const clientSrc = readFileSync(clientFile, "utf8");
      const orderMatch =
        /name\s*:\s*[`"']settings\.section[`"'][\s\S]{0,240}?order\s*:\s*(\d+)/u.exec(clientSrc);
      if (orderMatch) {
        const order = Number(orderMatch[1]);
        if (order < 90 || order > 96) {
          report(
            "error",
            `settings.section 的 order=${order} 不在约定的 90–96（见 docs/plugin-conventions.md §7.1）`,
          );
        }
        const owners = settingsOrderOwners.get(order) ?? [];
        owners.push(dir);
        settingsOrderOwners.set(order, owners);
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

    // 插件身份：locale 根对象 `meta` 与 package.json 顶层 `icon` 是「插件 → 已安装/详情」的
    // 标题、描述和图标来源（宿主不激活插件就读它们）。只在登记进索引源的正式版本插件上强制
    // （上面的 identityEnforced），模板/脚手架生成的 0.0.0 临时插件由 build-index 兜底。
    if (identityEnforced && registered) {
      for (const lang of ["en", "zh"]) {
        const localeFile = join(base, `locale/${lang}.json`);
        if (!existsSync(localeFile)) continue; // 上面的 locale 配对检查已经报错
        const meta = readJson(localeFile).meta;
        for (const field of ["title", "description"]) {
          const value = meta?.[field];
          if (typeof value !== "string" || value.trim() === "") {
            report(
              "error",
              `locale/${lang}.json 缺少非空的 meta.${field}（宿主直接读它当插件身份）`,
            );
          }
        }
      }
      // 中文身份有 index-meta.json 与 locale/zh.json 两个来源，不一致会让「已安装」与「发现」漂移。
      const zhMeta = existsSync(zhPath) ? readJson(zhPath).meta : undefined;
      const zhTitle = registered.title?.zh;
      const zhDescription = registered.descriptionZh;
      if (zhMeta && typeof zhTitle === "string" && zhMeta.title !== zhTitle) {
        report(
          "error",
          "locale/zh.json 的 meta.title 与 scripts/index-meta.json 的 title.zh 不一致",
        );
      }
      if (zhMeta && typeof zhDescription === "string") {
        const description = zhMeta.description;
        if (zhDescription.length <= 200) {
          if (description !== zhDescription) {
            report(
              "error",
              "locale/zh.json 的 meta.description 与 scripts/index-meta.json 的 descriptionZh 不一致",
            );
          }
        } else if (
          typeof description !== "string" ||
          description.length > 200 ||
          !zhDescription.startsWith(description)
        ) {
          report(
            "error",
            "scripts/index-meta.json 的 descriptionZh 超过 200 字符时必须截断成它的前缀（≤200）",
          );
        }
      }
    }

    // 图标：顶层 `icon` 是宿主「已安装/详情」页的图标来源（宿主读顶层字段、不走 exports），
    // 缺了会静默回退通用图形，和发现页（读索引条目的 `icon`）对不上。已登记索引源且版本
    // 离开 0.0.0 的正式插件**必须**有它；0.0.0 脚手架只告警（模板自带占位 `icon.svg`，
    // 发版前要换成自己的图），未登记插件由 build-index 的登记检查兜底。
    // 有 `icon` 时再校验：包内相对路径、文件存在、进 files 白名单、≤256 KiB、文件头合法。
    // 之前这段整体挂在 `if (pkg.icon !== undefined)` 下，删掉顶层字段就能让身份校验整段跳过
    // （2026-11-28 复审 N2：已登记的正式插件删 icon 仍 0 错），所以缺字段也要单独判。
    if (pkg.icon === undefined) {
      if (identityEnforced) {
        report(
          "error",
          "已登记索引源且版本非 0.0.0，必须有 package.json 顶层 icon（宿主读它当「已安装」图标，缺了会回退通用图形）",
        );
      } else if (registered) {
        report(
          "warn",
          "已登记索引源但缺少 package.json 顶层 icon：版本离开 0.0.0 后会按 error 拦（模板自带 icon.svg）",
        );
      }
    } else {
      const icon = pkg.icon;
      if (typeof icon !== "string" || icon.trim() === "") {
        report("error", "package.json 的 icon 必须是非空相对路径");
      } else if (
        isAbsolute(icon) ||
        /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon) ||
        icon.split("/").includes("..")
      ) {
        report("error", `package.json 的 icon「${icon}」必须是包目录内的相对路径`);
      } else {
        const iconRel = icon.replace(/^\.\//, "");
        const iconPath = join(base, iconRel);
        const ext = extname(iconRel).toLowerCase();
        const iconStat = existsSync(iconPath) ? statSync(iconPath) : undefined;
        if (!ICON_EXTENSIONS.has(ext)) {
          report(
            "error",
            `icon「${iconRel}」的扩展名必须是 ${[...ICON_EXTENSIONS].join("/")}（宿主只接受这四种）`,
          );
        } else if (iconStat === undefined) {
          report("error", `icon 指向的 ${iconRel} 不存在`);
        } else if (!iconStat.isFile()) {
          report("error", `icon 指向的 ${iconRel} 必须是普通文件`);
        } else {
          if (iconStat.size > MAX_ICON_BYTES) {
            report("error", `icon ${iconRel} 超过宿主上限 256 KiB`);
          }
          const head = readFileSync(iconPath).subarray(0, ICON_HEAD_BYTES);
          if (!hasIconSignature(head, ext)) {
            report("error", `icon ${iconRel} 不是合法的 ${ext} 文件头（宿主解码失败会回退默认图）`);
          }
        }
        const listed = /** @type {unknown[]} */ (pkg.files ?? []).some((entry) => {
          if (typeof entry !== "string") return false;
          const clean = entry.replace(/^\.\//, "");
          return (
            clean === "." || clean === "" || clean === iconRel || iconRel.startsWith(`${clean}/`)
          );
        });
        if (!listed) report("error", `icon ${iconRel} 不在 files 白名单里（npm pack 不会带上它）`);
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

  // settings.section 的 order 必须唯一（docs/plugin-conventions.md §7.1：90–96 唯一）。
  // 2026-11-28 Wave 2 八个插件都改成唯一值（90/91/92/93/94/95/96），原先的
  // PENDING_ORDER_PLUGINS 临时豁免已删除：任何并列都按 error 处理。
  for (const [order, plugins] of settingsOrderOwners) {
    if (plugins.length < 2) continue;
    issues.push({
      level: "error",
      plugin: plugins.join(" / "),
      message: `settings.section 的 order=${order} 被 ${plugins.join(" / ")} 并列使用（§7.1 要求 90–96 唯一，顺序会取决于注册时序）`,
    });
  }

  // 所有冒烟脚本（web + 桌面）都必须打印 `N PASS / M SKIP / K FAIL`：gate/gate:all 靠这一行
  // 识别「跑过但零断言」的假绿。2026-11-20 之前桌面五条脚本漏打、web 只有 btw 打了——门禁的
  // 假绿防线对它们等于不存在。这里做成静态检查，新脚本漏了会在 `pnpm check` / CI 直接拦住。
  // 例外：`smoke-agent-tool.mjs` 需要真实模型凭据、不在 gate/gate:all 里，按诊断脚本处理。
  /** @type {Map<string, string>} name → plugin 目录（用于把问题挂到插件名下） */
  const smokeOwner = new Map();
  for (const dir of listPluginDirs(root)) {
    smokeOwner.set(`smoke-${dir}.mjs`, dir);
    smokeOwner.set(`smoke-${dir}-desktop.mjs`, dir);
  }
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir)) {
      if (!/^smoke-[a-z0-9][a-z0-9-]*\.mjs$/u.test(name) || name === "smoke-agent-tool.mjs")
        continue;
      const src = readFileSync(join(scriptsDir, name), "utf8");
      if (!/PASS\s*\/\s*.*SKIP\s*\/\s*.*FAIL/u.test(src)) {
        issues.push({
          level: "error",
          plugin: smokeOwner.get(name) ?? "scripts",
          message: `${name} 没有打印 \`N PASS / M SKIP / K FAIL\` 计数行（gate/gate:all 靠它判断假绿，见 docs/plugin-conventions.md §6.1）`,
        });
      }
      // 缺 dsh / ego-browser 时的**早退路径**同样要打印计数行（2026-11-28，AUD-XCT-05）：
      // 早退不打印 = 门禁拿到 undefined，旧版只判退出码于是显示 ✓。现在 gate.mjs 的 web 阶段
      // 用 gateVerdict() 判 vacuous，但前提是早退分支真的留下 `0 PASS / N SKIP / 0 FAIL`。
      if (/hasCommand\("dsh"\)|hasCommand\("ego-browser"\)|SKIP 缺少依赖/u.test(src)) {
        if (!/0 PASS\s*\/\s*\d+\s+SKIP\s*\/\s*0 FAIL/u.test(src)) {
          issues.push({
            level: "error",
            plugin: smokeOwner.get(name) ?? "scripts",
            message: `${name} 缺环境时会早退，但早退分支没有打印 \`0 PASS / N SKIP / 0 FAIL\`（门禁会因此判不了假绿，见 §6.1 / AUD-XCT-05）`,
          });
        }
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
