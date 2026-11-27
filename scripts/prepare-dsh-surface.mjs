#!/usr/bin/env node
// @ts-check
// 用法：node scripts/prepare-dsh-surface.mjs --output <目录> [--json]
//
// 按 `AGENTS.md` 里写的**目标运行时版本**，从 npm 装一份宿主面（`@deepseek-ai/dsh@<版本>`
// 的依赖树），供 CI 跑 `node scripts/probe-runtime.mjs --surface <目录>/node_modules`。
//
// 为什么这么做：GitHub runner 上没有 DSH 桌面版，旧 CI 里 `probe:runtime` 找不到 app.asar
// 就打印 SKIP 并 exit 0——分支保护上的 `runtime probe (DSH surface)` 于是恒绿，等于空转
// （AUD-XCT-02）。npm 上的 `@deepseek-ai/dsh` 与桌面版是同一套 0.2.2-rc.5 包（client 半
// bundle 的内容哈希都能对上），装出来跑同一份探针清单，CI 就真的在验宿主面。
//
// 目录已就绪（版本对得上）时直接跳过，所以 CI 可以把它套在 actions/cache 后面：
// 缓存命中时这个脚本 1 秒返回，未命中时 npm 冷装约 2–4 分钟。
// 失败一律非零退出——CI 里「装不出宿主面」必须红，不能退回 SKIP。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

import { isMain, REPO_ROOT } from "./lib/repo.mjs";

const exec = promisify(execFile);
const AGENTS_MD = join(REPO_ROOT, "AGENTS.md");

/** 探针依赖的宿主包：装完至少抽一个文件确认树是完整的。 */
const PROBE_SMOKE_FILE = "dsh-client-ui-chat/lib/client.js";

/**
 * 从 AGENTS.md 的「目标运行时」一行读出版本号。
 * 这是仓库里唯一同时被 `check:docs` 校验「等于 docs/runtime 最新版」的版本指针，
 * 所以 CI 用它来决定装哪个版本的宿主面，不会单独漂移。
 * @param {string} [file]
 * @returns {Promise<string>}
 */
export async function readTargetVersion(file = AGENTS_MD) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`读不到 ${file}；无法确定要装哪个版本的 DSH 宿主面`);
  }
  const match = /目标运行时：\*\*DSH 桌面版 (\d+\.\d+\.\d+-rc\.\d+)\*\*/u.exec(text);
  if (!match) throw new Error(`${file} 里没找到「目标运行时：**DSH 桌面版 <版本>**」`);
  return match[1];
}

/**
 * 判断输出目录里的宿主面状态：`ok`（版本对、文件齐）/ `stale`（版本不对）/ `missing`。
 * @param {string} outputDir
 * @param {string} version
 * @returns {Promise<"ok" | "stale" | "missing">}
 */
export async function surfaceState(outputDir, version) {
  const pkgPath = join(outputDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
  if (!existsSync(pkgPath)) return "missing";
  try {
    const parsed = JSON.parse(await readFile(pkgPath, "utf8"));
    if (parsed.version !== version) return "stale";
  } catch {
    return "stale";
  }
  const smokeFile = join(outputDir, "node_modules", "@deepseek-ai", PROBE_SMOKE_FILE);
  return existsSync(smokeFile) ? "ok" : "stale";
}

/**
 * 装宿主面。先在输出目录写一个只含一条依赖的 package.json（固定版本、`private`，
 * 不会被误发布），再 `npm install`。`--omit=optional` 跳过平台二进制
 * （libreoffice / sherpa / node-pty），探针只用 JS 源码，不需要它们。
 * @param {string} outputDir
 * @param {string} version
 */
export async function installSurface(outputDir, version) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-plugins-dsh-surface",
        private: true,
        description: "Host surface for scripts/probe-runtime.mjs (npm-installed, not published)",
        dependencies: { "@deepseek-ai/dsh": version },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await exec(
    "npm",
    [
      "install",
      "--omit=optional",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: outputDir, maxBuffer: 32 * 1024 * 1024 },
  );
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (typeof values.output !== "string" || values.output === "") {
    console.error("用法：node scripts/prepare-dsh-surface.mjs --output <目录> [--json]");
    process.exitCode = 2;
    return;
  }
  const outputDir = resolve(values.output);
  let version;
  try {
    version = await readTargetVersion();
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const state = await surfaceState(outputDir, version);
  const surfacePath = join(outputDir, "node_modules");
  if (state === "ok") {
    if (values.json) {
      console.log(JSON.stringify({ status: "ready", version, surface: surfacePath }, null, 2));
    } else {
      console.log(`SKIP 宿主面已就绪（@deepseek-ai/dsh@${version} → ${surfacePath}）`);
      console.log(`用 \`node scripts/probe-runtime.mjs --surface ${surfacePath}\` 跑探针。`);
    }
    return;
  }
  console.log(`安装 DSH 宿主面：@deepseek-ai/dsh@${version} → ${surfacePath}（状态：${state}）`);
  try {
    await installSurface(outputDir, version);
  } catch (error) {
    console.error(`FAIL 宿主面安装失败（@deepseek-ai/dsh@${version}）`);
    const detail = error instanceof Error ? error.message : String(error);
    console.error(detail.slice(-4000));
    process.exitCode = 1;
    return;
  }
  if ((await surfaceState(outputDir, version)) !== "ok") {
    console.error(`FAIL 装完了但宿主面不完整（缺 ${PROBE_SMOKE_FILE} 或版本不符）`);
    process.exitCode = 1;
    return;
  }
  if (values.json) {
    console.log(JSON.stringify({ status: "installed", version, surface: surfacePath }, null, 2));
  } else {
    console.log(`DONE 宿主面就绪：${surfacePath}（@deepseek-ai/dsh@${version}）`);
    console.log(`用 \`node scripts/probe-runtime.mjs --surface ${surfacePath}\` 跑探针。`);
  }
};

if (isMain(import.meta.url)) await main();
