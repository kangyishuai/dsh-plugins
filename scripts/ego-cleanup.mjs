#!/usr/bin/env node
// @ts-check
// 清理 ego TaskSpace 泄漏（web 冒烟失败/超时没 finish 留下的空间与 Page）。
//
//   node scripts/ego-cleanup.mjs            # 预览（默认 dry-run，只列不删）
//   node scripts/ego-cleanup.mjs --apply    # 真的 finish 掉 agent 拥有的空间
//
// 安全边界（重要）：
// - 只处理 `ownership === "agent"` 的空间——那是冒烟/agent 自己创建的任务空间；
//   `ownership === "user"`（用户自己开的标签页）与 `agentDelegatedToUser`（已交给用户）
//   一律不碰，只在输出里列出。
// - 不要在有别的 agent/冒烟正在跑的时候 `--apply`：会把它正在用的空间一起收掉。
//   页面额度耗尽、连续超时时再用它救场。
//
// 实现：ego 的 taskSpace/listTaskSpaces 只存在于 `ego-browser nodejs` 运行时里，
// 所以由外层 Node 进程把内层脚本通过 stdin 交给 ego-browser 执行，再用标记行取回 JSON。

import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const MARKER = "EGO_CLEANUP ";

/**
 * 生成在 `ego-browser nodejs` 里执行的内层脚本。
 * dry-run 只读 listTaskSpaces()，不调用 taskSpace()，绝不动任何空间。
 * @param {{ apply: boolean }} options
 * @returns {string}
 */
export function buildCleanupScript(options) {
  const apply = options.apply === true;
  // dry-run 与 apply 生成**两份不同**的脚本：dry-run 里连 taskSpace()/finish() 的代码都不存在，
  // 从结构上保证预览模式没有任何副作用（不是靠运行时 if 分支兜底）。
  const handleAgentSpace = apply
    ? `  try {
    const task = await taskSpace(id);
    await task.finish({ keep: [] });
    report.finished.push({ id, name, ok: true });
  } catch (error) {
    report.errors.push({ id, name, error: String((error && error.message) || error).slice(0, 300) });
  }`
    : `  report.finished.push({ id, name, dryRun: true });`;
  return `(async () => {
const report = {
  mode: ${apply ? '"apply"' : '"dry-run"'},
  total: 0,
  agentOwned: 0,
  finished: [],
  skipped: [],
  errors: [],
};
const spaces = await listTaskSpaces();
report.total = spaces.length;
for (const space of spaces) {
  const id = Number(space && space.id);
  const name = String((space && space.name) || "");
  const ownership = String((space && space.ownership) || "");
  if (ownership !== "agent") {
    report.skipped.push({ id, name, ownership });
    continue;
  }
  report.agentOwned += 1;
${handleAgentSpace}
}
console.log(${JSON.stringify(MARKER)} + JSON.stringify(report));
})();`;
}

/** @param {string} name */
async function hasCommand(name) {
  try {
    const probe = await exec("which", [name]);
    return probe.stdout.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * 跑内层脚本，返回解析后的报告。
 * @param {string} source
 * @returns {Promise<any>}
 */
async function runEgoScript(source) {
  const out = await new Promise((resolvePromise) => {
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      text += String(chunk);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolvePromise(text);
    });
    child.stdin.end(source);
  });
  const at = String(out).indexOf(MARKER);
  if (at < 0) {
    throw new Error(`ego 输出里没有清理结果标记：\n${String(out).slice(-2000)}`);
  }
  const line = String(out)
    .slice(at + MARKER.length)
    .split("\n")[0]
    .trim();
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`清理结果不是合法 JSON：${line.slice(0, 500)}（${String(error)}）`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      // dry-run 是默认值：破坏性操作默认不执行（ADR 0002 的同一思路）。
      apply: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (!(await hasCommand("ego-browser"))) {
    console.log("SKIP 未找到 ego-browser");
    console.log("0 PASS / 1 SKIP / 0 FAIL");
    return;
  }

  console.log(
    values.apply
      ? "清理 ego TaskSpace（apply：只 finish ownership=agent 的空间）"
      : "预览 ego TaskSpace（dry-run：只列不删；加 --apply 才真清理）",
  );
  const report = await runEgoScript(buildCleanupScript({ apply: values.apply === true }));
  console.log(`TaskSpace 总数：${report.total}；agent 拥有：${report.agentOwned}`);
  for (const item of report.finished ?? []) {
    const tag = item.dryRun === true ? "待清理" : item.ok === true ? "已清理" : "失败";
    console.log(`  ${tag} #${item.id} ${item.name}`);
  }
  for (const item of report.errors ?? []) {
    console.error(`  失败 #${item.id} ${item.name}：${item.error}`);
  }
  if ((report.skipped ?? []).length > 0) {
    console.log("  未处理（不是 agent 的，保护用户空间）：");
    for (const item of report.skipped) {
      console.log(`    #${item.id} ownership=${item.ownership || "(空)"} ${item.name}`);
    }
  }
  const errors = (report.errors ?? []).length;
  if (errors > 0) {
    console.log(`${report.finished.length} PASS / 0 SKIP / ${errors} FAIL`);
    process.exitCode = 1;
    return;
  }
  if (values.apply !== true && report.agentOwned > 0) {
    console.log(`提示：以上 ${report.agentOwned} 个空间是 agent 遗留的，加 --apply 执行清理。`);
  }
  console.log(`${report.finished.length} PASS / 0 SKIP / 0 FAIL`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
