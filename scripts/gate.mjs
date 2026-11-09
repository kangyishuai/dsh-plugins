#!/usr/bin/env node
// @ts-check
// 用法：pnpm gate <plugin> [选项]
//   或：pnpm gate:session-rewind / pnpm gate:session-delete（等价写法）
//
// 一条命令跑完某个插件的发版门禁，按「便宜的先跑」排序，任何一步失败立刻停：
//
//   1. pnpm verify               lint + typecheck + 规范 + 公开边界 + 全部单测
//   2. pnpm probe:runtime         宿主包/API/slot/私有 seam 体检
//   3. pnpm smoke:<plugin>        web 组合端到端（临时 DSH_HOME）
//   4. 桌面只读回归               需要 --remote-debugging-port=9222；没开就**失败**而不是跳过
//   5. 桌面 --deep（可选）        需要 --workspace；写文件类端到端
//
// 设计要点：
//   - 第 4 步永远带 `--require`。门禁存在的意义就是「不能没跑还说通过」。
//   - 只有显式 --skip-desktop 才跳过桌面端，且结束时会大声提示「门禁不完整」。
//   - 每个插件缺哪个脚本就跳过哪一步（并在输出里说明），不假装跑过。
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(import.meta.dirname, "..");

/**
 * @typedef {object} Stage
 * @property {string} title
 * @property {string[]} args
 * @property {boolean} [optional] 没有对应脚本时跳过而不是失败
 * @property {boolean} [missing] 本应有脚本却缺失（跳过也算失败）
 */

/**
 * 读取根 package.json 的 scripts（用于判断某个插件有没有对应冒烟/桌面脚本）。
 * @returns {Promise<Record<string, string>>}
 */
async function readScripts() {
  const raw = await readFile(join(REPO, "package.json"), "utf8");
  return JSON.parse(raw).scripts ?? {};
}

/**
 * 插件是否有 client 半（有的话桌面端套件是**必需**的，见 docs/plugin-conventions.md §6）。
 * @param {string} plugin
 * @returns {Promise<boolean>}
 */
async function hasClientHalf(plugin) {
  try {
    const raw = await readFile(join(REPO, "packages", plugin, "package.json"), "utf8");
    return Boolean(JSON.parse(raw).dsh?.client);
  } catch {
    return false;
  }
}

const main = async () => {
  const { values, positionals } = parseArgs({
    options: {
      deep: { type: "boolean", default: false },
      workspace: { type: "string" },
      "skip-desktop": { type: "boolean", default: false },
      // 只打印门禁步骤不执行：CI 用它检查「每个插件都有完整门禁」。
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const plugin = positionals[0];
  if (typeof plugin !== "string" || plugin === "") {
    console.error("用法：pnpm gate <plugin>（例如 pnpm gate session-rewind）");
    process.exitCode = 2;
    return;
  }
  const scripts = await readScripts();
  const webSmoke = `smoke:${plugin}`;
  const desktopSmoke = `smoke:${plugin}-desktop`;

  /** @type {Stage[]} */
  const stages = [
    { title: "单测 + lint + 类型 + 规范（pnpm verify）", args: ["verify"] },
    { title: "宿主能力体检（pnpm probe:runtime）", args: ["probe:runtime"] },
  ];
  if (scripts[webSmoke] !== undefined) {
    stages.push({ title: `web 端到端冒烟（pnpm ${webSmoke}）`, args: [webSmoke] });
  } else {
    stages.push({
      title: `web 端到端冒烟（pnpm ${webSmoke}）—— 未定义，跳过`,
      args: [],
      optional: true,
    });
  }
  const hasDesktop = scripts[desktopSmoke] !== undefined;
  if (values["skip-desktop"] !== true) {
    if (hasDesktop) {
      stages.push({
        title: "桌面只读回归（需要调试端口）",
        args: [desktopSmoke, "--require"],
      });
      if (values.deep === true) {
        /** @type {string[]} */
        const extra = [desktopSmoke, "--require", "--deep"];
        if (typeof values.workspace === "string") extra.push("--workspace", values.workspace);
        stages.push({ title: "桌面 --deep 端到端", args: extra });
      }
    } else if (await hasClientHalf(plugin)) {
      stages.push({
        title: `桌面回归（pnpm ${desktopSmoke}）—— 有 client 半但脚本缺失`,
        args: [],
        optional: true,
        missing: true,
      });
    } else {
      stages.push({
        title: `桌面回归（pnpm ${desktopSmoke}）—— 无 client 半，跳过`,
        args: [],
        optional: true,
      });
    }
  }

  if (values["dry-run"] === true) {
    // 结构校验：必需步骤没有对应脚本就算失败。
    // 桌面端对「有 client 半」的插件是必需的（见 docs/plugin-conventions.md §6）。
    const client = await hasClientHalf(plugin);
    let missing = 0;
    let index = 0;
    for (const stage of stages) {
      index += 1;
      const hasScript = stage.args.length > 0;
      const isDesktop = String(stage.args[0] ?? "").endsWith("-desktop");
      const mark = hasScript ? "ok  " : isDesktop && !client ? "n/a " : "MISS";
      if (!hasScript && !(isDesktop && !client)) missing += 1;
      console.log(`${mark} [${index}/${stages.length}] ${stage.title}`);
    }
    if (missing > 0) {
      console.error(`FAIL ${plugin}: 有 ${missing} 个必需门禁步骤没有对应脚本（见 MISS）`);
      if (client) {
        console.error(
          "      有 client 半的插件必须提供桌面端自动化测试（docs/plugin-conventions.md §6）。",
        );
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `PASS ${plugin}: 门禁结构完整${client ? "（含桌面端）" : "（无 client 半，桌面端不适用）"}`,
    );
    return;
  }

  const started = Date.now();
  let index = 0;
  let skipped = 0;
  for (const stage of stages) {
    index += 1;
    if (stage.args.length === 0) {
      if (stage.missing === true) {
        console.error(`\nFAIL ${plugin}: ${stage.title}`);
        console.error(
          "      有 client 半的插件必须提供桌面端自动化测试（docs/plugin-conventions.md §6）。",
        );
        process.exitCode = 1;
        return;
      }
      console.log(`- [${index}/${stages.length}] ${stage.title}`);
      skipped += 1;
      continue;
    }
    console.log("");
    console.log(`▶ [${index}/${stages.length}] ${stage.title}`);
    const code = await run(stage.args);
    if (code !== 0) {
      console.error("");
      console.error(`FAIL 门禁中止：「${stage.title}」退出码 ${code}`);
      if (String(stage.args[0]).startsWith("smoke:") && stage.args.includes("--require")) {
        console.error("提示：桌面端需要先带调试端口重启：");
        console.error(
          '  open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1',
        );
        console.error("确认不再需要桌面端时，可加 --skip-desktop（但门禁不完整）。");
      }
      process.exitCode = 1;
      return;
    }
    console.log(`✓ ${stage.title}`);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log("");
  console.log(`PASS ${plugin} 门禁全绿（${stages.length - skipped} 步，${seconds}s）`);
  if (values["skip-desktop"] === true) {
    console.log("注意：本次用了 --skip-desktop，**没有**验证桌面端，门禁不完整。");
  }
  if (skipped > 0) {
    console.log(`注意：有 ${skipped} 步因为脚本未定义被跳过（见上面的 "- " 行）。`);
  }
  if (values.deep !== true && hasDesktop) {
    console.log("提示：没跑 --deep 就不包含桌面写文件类 e2e（需要 --workspace 指定测试目录）。");
  }
};

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function run(args) {
  return new Promise((done) => {
    const child = spawn("pnpm", args, { cwd: REPO, stdio: "inherit", env: process.env });
    child.on("close", (code) => done(code ?? 1));
    child.on("error", () => done(1));
  });
}

await main();
