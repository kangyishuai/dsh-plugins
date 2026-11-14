#!/usr/bin/env node
// @ts-check
// 把**已安装的 DSH** 里定义的主题 token 抽成快照，供 scripts/check-plugins.mjs 校验插件 CSS。
//
// 为什么需要快照：插件只能用宿主真实存在的 `--dsw-*` / `--ds-*` token。写错名字时 CSS 不会报错，
// 只会静默落到 `var()` 的第二个参数（硬编码兜底色），于是那段样式永远不跟随深浅色主题——
// 0.6.1 的「深色下白底白字确认按钮」、0.5.0 的「警告色永远是同一个暗金」都是这么来的。
// 但 CI 里没有安装 DSH，所以把「宿主有哪些 token」这件事固化成仓库里的 JSON。
//
// 用法（只在装了 DSH 的机器上跑，DSH 升级后重新生成并提交）：
//   pnpm tokens:host                # 自动找 macOS 的 DeepSeek Harness 安装位置
//   pnpm tokens:host --app <app.asar 路径>
//   pnpm tokens:host --check        # 只比对，不写：宿主有新增/移除时提示重新生成
//
// asar 是归档不是文本，这里直接按字节扫 `--dsw-*:` 定义（不解析包结构），
// 因此对新版本布局不敏感：抽不到就报错要你确认，而不是静默生成一份空快照。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMain, REPO_ROOT } from "./lib/repo.mjs";

/** 快照文件：由 check-plugins.mjs 读取。 */
export const SNAPSHOT_PATH = join(REPO_ROOT, "scripts", "lib", "host-theme-tokens.json");

/** macOS 上 Electron 应用里 asar 的默认位置。 */
const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";

/** 只认这两类前缀：`--dsw-*`（design system）与 `--ds-*`（字体等）。 */
const TOKEN_RE = /(--(?:dsw|ds)-[a-z0-9-]+)\s*:/g;

/**
 * 从 asar 里抽出所有被定义的主题 token 名。
 * @param {string} asarPath
 * @returns {string[]} 排序去重后的 token 名
 */
export function extractTokens(asarPath) {
  if (!existsSync(asarPath)) {
    throw new Error(`找不到 ${asarPath}。请在装了 DSH 的机器上运行，或显式传 --app <app.asar>。`);
  }
  const bytes = readFileSync(asarPath);
  // asar 是二进制归档：用 latin1 逐字节映射，保证不因非法 UTF-8 截断匹配。
  const text = bytes.toString("latin1");
  const tokens = new Set();
  for (const match of text.matchAll(TOKEN_RE)) tokens.add(match[1]);
  if (tokens.size < 100) {
    throw new Error(
      `只抽到 ${tokens.size} 个 token，明显不对（正常 400+）。宿主可能换了打包方式，先人工确认再更新脚本。`,
    );
  }
  return [...tokens].sort();
}

/**
 * 读取仓库里的快照。
 * @param {string} [path]
 * @returns {{ meta: Record<string, unknown>, tokens: string[] }}
 */
export function readSnapshot(path = SNAPSHOT_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  return { meta: raw._meta ?? {}, tokens };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      check: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const asar = resolve(values.app ?? DEFAULT_ASAR);
  const tokens = extractTokens(asar);
  const next = {
    _meta: {
      source: "DeepSeek Harness 桌面版（Electron）内置的 design-platform / base 样式表",
      // 版本号是给升级时人工核对用的，脚本不解析它。
      dshVersion: process.env.DSH_APP_VERSION ?? "0.2.2-rc.3",
      extractedAt: new Date().toISOString().slice(0, 10),
      note: "由 scripts/host-tokens.mjs 生成；DSH 升级后重跑 pnpm tokens:host 并提交。",
    },
    tokens,
  };

  if (values.check === true) {
    const current = readSnapshot();
    const added = tokens.filter((t) => !current.tokens.includes(t));
    const removed = current.tokens.filter((t) => !tokens.includes(t));
    console.log(
      `快照 ${current.tokens.length} 个 token，宿主 ${tokens.length} 个；新增 ${added.length}，移除 ${removed.length}`,
    );
    for (const t of added.slice(0, 20)) console.log(`  + ${t}`);
    for (const t of removed.slice(0, 20)) console.log(`  - ${t}`);
    process.exit(added.length > 0 || removed.length > 0 ? 1 : 0);
  }

  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`已写入 ${SNAPSHOT_PATH}：${tokens.length} 个 token`);
}
