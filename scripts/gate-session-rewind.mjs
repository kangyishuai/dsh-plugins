#!/usr/bin/env node
// @ts-check
// 用法：pnpm gate:session-rewind [--deep --workspace <测试目录>] [--skip-desktop]
//
// 一条命令跑完 session-rewind 的发版门禁，按「便宜的先跑」排序，任何一步失败立刻停：
//
//   1. pnpm verify                   lint + typecheck + 规范 + 公开边界 + 185 单测
//   2. pnpm probe:runtime            宿主包/API/slot/私有 seam（43 项）
//   3. pnpm smoke:session-rewind     web 组合端到端（临时 DSH_HOME，34 项）
//   4. 桌面只读回归（--require）      需要 --remote-debugging-port=9222；没开则**失败**而非跳过
//   5. 桌面 --deep（可选）            文件模式 e2e（36 项），必须给 --workspace
//
// 设计要点：第 4 步永远带 --require —— 这个脚本存在的意义就是「不能没跑还说通过」。
// 只有显式 --skip-desktop 才允许跳过桌面端（并在最后大声提示「门禁不完整」）。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(import.meta.dirname, "..");

/**
 * @typedef {object} Stage
 * @property {string} title
 * @property {string[]} args
 * @property {"required" | "optional"} kind
 */

const main = async () => {
  const { values } = parseArgs({
    options: {
      deep: { type: "boolean", default: false },
      workspace: { type: "string" },
      "skip-desktop": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  /** @type {Stage[]} */
  const stages = [
    { title: "单测 + lint + 类型 + 规范（pnpm verify）", args: ["verify"], kind: "required" },
    { title: "宿主能力体检（pnpm probe:runtime）", args: ["probe:runtime"], kind: "required" },
    { title: "web 端到端冒烟（34 项）", args: ["smoke:session-rewind"], kind: "required" },
  ];
  if (values["skip-desktop"] !== true) {
    stages.push({
      title: "桌面只读回归（21 项，需要调试端口）",
      args: ["smoke:session-rewind-desktop", "--", "--require"],
      kind: "required",
    });
    if (values.deep === true) {
      /** @type {string[]} */
      const extra = ["smoke:session-rewind-desktop", "--", "--require", "--deep"];
      if (typeof values.workspace === "string") extra.push("--workspace", values.workspace);
      stages.push({ title: "桌面文件模式 e2e（36 项）", args: extra, kind: "required" });
    }
  }

  const started = Date.now();
  let index = 0;
  for (const stage of stages) {
    index += 1;
    console.log("");
    console.log(`▶ [${index}/${stages.length}] ${stage.title}`);
    const code = await run(stage.args);
    if (code !== 0) {
      console.error("");
      console.error(`FAIL 门禁中止：「${stage.title}」退出码 ${code}`);
      if (stage.args[0] === "smoke:session-rewind-desktop") {
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
  console.log(`PASS 门禁全绿（${stages.length} 步，${seconds}s）`);
  if (values["skip-desktop"] === true) {
    console.log("注意：本次用了 --skip-desktop，**没有**验证桌面端，门禁不完整。");
  }
  if (values.deep !== true) {
    console.log("提示：没跑 --deep 就不包含桌面文件模式 e2e（目录需用 --workspace 指定）。");
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
