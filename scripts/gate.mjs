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
//   - web 与桌面脚本**都要看计数行**（2026-11-28 起）：退出码 0 不代表验证过任何东西。
//     web 冒烟缺 `dsh` / `ego-browser` 时会早退，早退也必须打印 `0 PASS / N SKIP / 0 FAIL`
//     （见 scripts/smoke-*.mjs 的早退分支），门禁据此判 `vacuous` 假绿；不打印计数行则判
//     `missing-counts` 失败。桌面同理（可见会话有运行中的回合时脚本按设计 SKIP 也算失败）。
//   - 只有显式 --skip-desktop 才跳过桌面端，且结束时会大声提示「门禁不完整」。
//   - 每个插件缺哪个脚本就跳过哪一步（并在输出里说明），不假装跑过。
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isMain } from "./lib/repo.mjs";

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
    /** @type {Array<{title: string, status: "pass"|"fail"|"skipped"|"missing", ms: number, counts: any, outputTail: string}>} */
    const structureRecords = stages.map((stage) => ({
      title: stage.title,
      status: stage.args.length > 0 ? "pass" : "skipped",
      ms: 0,
      counts: null,
      outputTail: "",
    }));
    const reportPath = await writeGateReport(plugin, "structure-pass", structureRecords, {
      startedAt: new Date().toISOString(),
      durationMs: 0,
    });
    console.log(
      `PASS ${plugin}: 门禁结构完整${client ? "（含桌面端）" : "（无 client 半，桌面端不适用）"}`,
    );
    console.log(`报告：${reportPath}`);
    return;
  }

  const started = Date.now();
  /** @type {Array<{title: string, status: "pass"|"fail"|"skipped"|"missing", ms: number, counts: any, outputTail: string}>} */
  const records = [];
  const startedAt = new Date().toISOString();
  const finish = async (/** @type {"pass"|"fail"} */ verdict) => {
    const path = await writeGateReport(plugin, verdict, records, {
      startedAt,
      durationMs: Date.now() - started,
      skipDesktop: values["skip-desktop"] === true,
      deep: values.deep === true,
    });
    console.log(`报告：${path}`);
  };
  let index = 0;
  let skipped = 0;
  for (const stage of stages) {
    index += 1;
    if (stage.args.length === 0) {
      if (stage.missing === true) {
        records.push({
          title: stage.title,
          status: "missing",
          ms: 0,
          counts: null,
          outputTail: "",
        });
        await finish("fail");
        console.error(`\nFAIL ${plugin}: ${stage.title}`);
        console.error(
          "      有 client 半的插件必须提供桌面端自动化测试（docs/plugin-conventions.md §6）。",
        );
        process.exitCode = 1;
        return;
      }
      console.log(`- [${index}/${stages.length}] ${stage.title}`);
      records.push({ title: stage.title, status: "skipped", ms: 0, counts: null, outputTail: "" });
      skipped += 1;
      continue;
    }
    console.log("");
    console.log(`▶ [${index}/${stages.length}] ${stage.title}`);
    const stageStart = Date.now();
    const { code, output } = await run(stage.args);
    const countsForStage = parseCounts(output);
    if (code !== 0) {
      records.push({
        title: stage.title,
        status: "fail",
        ms: Date.now() - stageStart,
        counts: countsForStage,
        outputTail: String(output).split("\n").slice(-40).join("\n"),
      });
      await finish("fail");
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
    // web / 桌面阶段：退出码 0 不够，还要看计数行（web 与桌面共用同一套判定）。
    // 跑过但一条断言都没执行 = 假绿；脚本不打印计数行则门禁无从判断，同样判失败。
    const verdict = countedStageVerdict(stage.args[0], countsForStage);
    if (verdict !== "ok") {
      const isDesktopStage = String(stage.args[0] ?? "").endsWith("-desktop");
      console.error("");
      if (verdict === "missing-counts") {
        console.error(
          `FAIL 门禁中止：「${stage.title}」没有打印 \`N PASS / M SKIP / K FAIL\` 计数行`,
        );
        console.error("      门禁靠这一行识别「跑过但零断言」的假绿；缺了它就没有任何判据。");
        console.error(
          "      按 docs/plugin-conventions.md §6.1 在脚本收尾补上这一行（pnpm check 也会拦）。",
        );
      } else {
        console.error(`FAIL 门禁中止：「${stage.title}」跑完了但**一条断言都没执行**`);
        console.error(
          `      计数：${countsForStage?.pass ?? 0} PASS / ${countsForStage?.skip ?? 0} SKIP / ${countsForStage?.fail ?? 0} FAIL`,
        );
        console.error("      退出码 0 不代表验证过任何东西。");
        if (isDesktopStage) {
          console.error("      常见原因：可见会话有运行中的回合（agent 在自己会话里跑回归时），");
          console.error("      把可见会话切到空闲会话再跑。");
        } else {
          console.error("      常见原因：本机缺 `dsh` / `ego-browser`，web 冒烟打印 SKIP 后早退；");
          console.error("      早退会打印 `0 PASS / N SKIP / 0 FAIL`，门禁据此判假绿。");
          console.error(
            "      装好宿主与浏览器后重跑，或按 docs/plugin-conventions.md §6.1 排查。",
          );
        }
      }
      records.push({
        title: stage.title,
        status: "fail",
        ms: Date.now() - stageStart,
        counts: countsForStage,
        outputTail: String(output).split("\n").slice(-40).join("\n"),
      });
      await finish("fail");
      process.exitCode = 1;
      return;
    }
    records.push({
      title: stage.title,
      status: "pass",
      ms: Date.now() - stageStart,
      counts: countsForStage,
      outputTail: "",
    });
    console.log(`✓ ${stage.title}`);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log("");
  console.log(`PASS ${plugin} 门禁全绿（${stages.length - skipped} 步，${seconds}s）`);
  await finish("pass");
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
 * 门禁结果落盘：`build/gates/latest-<plugin>.json` + 带时间戳的副本。
 * 以前结果只活在 commit message/终端里，事后无法机器核对「哪次 gate 真的绿了」。
 * `build/` 已被 gitignore，不污染仓库。
 * @param {string} plugin
 * @param {"pass"|"fail"|"structure-pass"} verdict
 * @param {Array<{title: string, status: "pass"|"fail"|"skipped"|"missing", ms: number, counts: any, outputTail: string}>} records
 * @param {Record<string, any>} meta
 * @returns {Promise<string>}
 */
async function writeGateReport(plugin, verdict, records, meta) {
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    commit = "";
  }
  const dir = join(REPO, "build", "gates");
  await mkdir(dir, { recursive: true });
  const report = {
    format: 1,
    plugin,
    verdict,
    commit,
    startedAt: meta.startedAt ?? null,
    durationMs: meta.durationMs ?? null,
    skipDesktop: meta.skipDesktop === true,
    deep: meta.deep === true,
    stages: records,
  };
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const latest = join(dir, `latest-${plugin}.json`);
  await writeFile(latest, body, "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  await writeFile(join(dir, `${plugin}-${stamp}.json`), body, "utf8");
  return latest;
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
/**
 * 从冒烟输出里取最后一条 `N PASS / M SKIP / K FAIL` 计数行。
 * 冒烟脚本的约定输出格式见各 `scripts/smoke-*.mjs` 的收尾行。
 * @param {string} output
 * @returns {{ pass: number, skip: number, fail: number } | undefined}
 */
export function parseCounts(output) {
  // 用 String.fromCharCode(27) 构造 ESC，避免在正则字面量里出现控制字符
  // （biome 的 noControlCharactersInRegex 会拦）。
  const esc = String.fromCharCode(27);
  const plain = String(output ?? "")
    .split(`${esc}[`)
    .reduce((acc, part, at) => {
      if (at === 0) return part;
      // 去掉 `[0;32m` 这类 ANSI 参数与结尾的 m
      return acc + part.replace(/^[0-9;]*m/u, "");
    }, "");
  /** @type {{ pass: number, skip: number, fail: number } | undefined} */
  let last;
  for (const match of plain.matchAll(/(\d+)\s+PASS\s*\/\s*(\d+)\s+SKIP\s*\/\s*(\d+)\s+FAIL/gu)) {
    last = { pass: Number(match[1]), skip: Number(match[2]), fail: Number(match[3]) };
  }
  return last;
}

/**
 * 桌面端阶段是否「跑过但什么都没断言」——用于识别假绿。
 * @param {{ pass: number, skip: number, fail: number } | undefined} counts
 * @returns {boolean}
 */
export function isVacuousPass(counts) {
  return counts !== undefined && counts.pass === 0 && counts.fail === 0;
}

/**
 * 桌面阶段的放行判定（2026-11-20 起）。
 *
 * - `missing-counts`：脚本没打印 `N PASS / M SKIP / K FAIL`。没有计数行就无法区分
 *   「全绿」与「一条断言都没跑」——按假绿处理，判失败并提示补计数行。
 * - `vacuous`：有计数行，但 0 PASS / 0 FAIL（全 SKIP 或根本没断言），同样是假绿。
 * - `ok`：确实执行过断言。
 * @param {{ pass: number, skip: number, fail: number } | undefined} counts
 * @returns {"ok" | "missing-counts" | "vacuous"}
 */
export function desktopGateVerdict(counts) {
  if (counts === undefined) return "missing-counts";
  return isVacuousPass(counts) ? "vacuous" : "ok";
}

/**
 * web 与桌面阶段共用的放行判定（2026-11-20 起 web 冒烟也要打印计数行）。
 * @param {{ pass: number, skip: number, fail: number } | undefined} counts
 * @returns {"ok" | "missing-counts" | "vacuous"}
 */
export const gateVerdict = desktopGateVerdict;

/**
 * 需要计数的阶段（web 冒烟 / 桌面回归）的判定；其它阶段（verify/probe）只认退出码。
 *
 * 2026-11-28 之前只有桌面阶段走 `desktopGateVerdict()`，web 阶段只看退出码——于是
 * 「缺 dsh / ego-browser 时打印 SKIP 就 return」的早退路径被显示成 ✓（AUD-XCT-05）。
 * 现在 web 冒烟早退也打印 `0 PASS / N SKIP / 0 FAIL`，这里把它接进同一套判定。
 * @param {string | undefined} scriptName pnpm 脚本名（`smoke:<plugin>` / `smoke:<plugin>-desktop`）
 * @param {{ pass: number, skip: number, fail: number } | undefined} counts
 * @returns {"ok" | "missing-counts" | "vacuous"}
 */
export function countedStageVerdict(scriptName, counts) {
  if (typeof scriptName !== "string" || !scriptName.startsWith("smoke:")) return "ok";
  return gateVerdict(counts);
}

/**
 * 跑一个 pnpm 脚本：输出照常透传，同时缓存下来供断言计数解析。
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
function run(args) {
  return new Promise((done) => {
    const child = spawn("pnpm", args, {
      cwd: REPO,
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    /** @type {string[]} */
    const chunks = [];
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      chunks.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      chunks.push(String(chunk));
    });
    child.on("close", (code) => done({ code: code ?? 1, output: chunks.join("") }));
    child.on("error", () => done({ code: 1, output: chunks.join("") }));
  });
}

if (isMain(import.meta.url)) await main();
