#!/usr/bin/env node
// @ts-check
// 用法：DEEPSEEK_API_KEY=<key> pnpm smoke:agent-tool
//
// 真实模型调用验证 agent 工具：
// 1) 临时 DSH_HOME + headless profile，安装当前源码；
// 2) 先用 headless 跑一条任务生成"目标会话"；
// 3) 再跑一条任务，要求模型用 session_delete 分两步（plan → delete）删掉目标；
// 4) 断言回收站/审计里出现 operator=agent 的删除记录。
//
// 没有可用的模型凭据时打印 SKIP 并以 0 退出（不吞掉失败，只是不打真模型）。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const PKG_DIR = join(REPO, "packages", "session-delete");

/** @param {string} message */
const fail = (message) => {
  console.error("FAIL " + message);
  process.exitCode = 1;
};

/** @param {string} cmd @param {string[]} args @param {any} [options] */
async function run(cmd, args, options = {}) {
  const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...options });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** @param {string} command */
async function has(command) {
  try {
    await run("which", [command]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} dir */
async function latestSessionId(dir) {
  const roots = await readdir(dir, { withFileTypes: true }).catch(() => []);
  /** @type {{ id: string, at: number }[]} */
  const found = [];
  for (const root of roots) {
    if (!root.isDirectory()) continue;
    const entries = await readdir(join(dir, root.name), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^(session-)?[0-9a-zA-Z-]{8,}$/.test(entry.name)) continue;
      const info = await stat(join(dir, root.name, entry.name)).catch(() => undefined);
      if (info) found.push({ id: entry.name, at: info.mtimeMs });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.id;
}

const main = async () => {
  if (!(await has("dsh"))) return console.log("SKIP 未找到 dsh");
  const modelEnv = ["DEEPSEEK_API_KEY", "ZHINAO_API_KEY"].find((name) => process.env[name]);
  const patchPath = process.env.DSH_AGENT_TOOL_PATCH;
  if (!modelEnv && !patchPath) {
    return console.log(
      "SKIP 没有可用模型凭据：设置 DEEPSEEK_API_KEY，或用 DSH_AGENT_TOOL_PATCH 指定包含模型配置的补丁文件",
    );
  }

  const work = await mkdtemp(join(tmpdir(), "dsh-agent-tool-"));
  try {
    const home = join(work, "home");
    await mkdir(home, { recursive: true });
    const env = { ...process.env, DSH_HOME: home };
    // 有凭据就复制一份，headless profile 才能解析 provider key
    await run("cp", [
      join(process.env.HOME ?? "", ".dsh", ".credentials.yaml"),
      join(home, ".credentials.yaml"),
    ]).catch(() => {});
    const extraArgs = patchPath ? ["--patch", patchPath] : [];

    // 打包当前源码并装进 headless profile
    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");
    await run("dsh", ["plugin", "--profile", "headless", "add", join(work, tgz)], { env });

    // 1) 生成目标会话
    const seed = await run("dsh", ["--profile", "headless", "Reply with exactly: seed-ok"], {
      env,
      timeout: 180_000,
    });
    if (!/seed-ok/i.test(seed.stdout)) {
      console.log("SKIP 模型调用不可用，输出：" + seed.stdout.slice(-300));
      return;
    }
    const target = await latestSessionId(join(home, "sessions"));
    if (!target) throw new Error("没有找到刚创建的会话");
    console.log("目标会话：" + target);

    // 2) 要求模型两段式删除
    const prompt =
      "Use the session_delete tool with sessionId=" +
      target +
      ". " +
      "First call it with action=plan, then call it again with action=delete and the token from the plan response. " +
      "Report the JSON of both calls verbatim.";
    const result = await run("dsh", ["--profile", "headless", ...extraArgs, prompt], {
      env,
      timeout: 300_000,
    });
    console.log("模型输出尾部：\n" + result.stdout.slice(-1200));

    // 3) 断言：回收站里有条目，且审计记录 operator=agent
    const trashDir = join(home, "session-trash");
    const entries = await readdir(trashDir, { withFileTypes: true }).catch(() => []);
    const hasTrash = entries.some((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    const audit = await readFile(join(trashDir, "audit.log"), "utf8").catch(() => "");
    const agentAudit = audit.includes('"operator":"agent"');
    console.log((hasTrash ? "PASS" : "FAIL") + " 回收站出现条目");
    console.log((agentAudit ? "PASS" : "FAIL") + " 审计记录 operator=agent");
    if (!hasTrash || !agentAudit) {
      fail("真实模型调用没有产生预期的删除记录");
    } else {
      console.log("PASS agent 工具两段式删除通过");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

await main();
