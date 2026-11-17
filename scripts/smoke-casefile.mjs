#!/usr/bin/env node
// @ts-check
// 用法：pnpm smoke:casefile
//       SMOKE_KEEP=1 pnpm smoke:casefile   —— 保留临时 DSH_HOME（排障用）
//       SMOKE_DEBUG=1 pnpm smoke:casefile  —— 打印每一步的响应
//
// web 端到端冒烟（**API 级**，不是浏览器级）：在 `mkdtemp` 出来的临时 DSH_HOME 里启动真实宿主，
// 装当前源码打出的包，然后直接打宿主的 Remote 端点，验证 casefile 的 M0 闭环。
//
// 为什么不用 ego-browser：M0 只有 Host 半，没有页面可点。这里验证的是「插件激活 + Remote 端点 +
// 数据落盘 + 脱敏」，全部是 M0 的验收面；M1 加 client 半时再补浏览器级与桌面级冒烟。
//
// 边界（有意为之）：
// - 不发起任何模型调用：不跑工具、不点发送，因此不花 token、不需要模型凭据。
// - 每个断言都留下响应/文件证据；失败时保留临时目录并打印路径（conventions §6.4）。

import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, "..");
const PKG_DIR = join(REPO, "packages", "casefile");
const PACKAGE = "@kangyishuai/dsh-casefile";
// 必须用内置 web profile：`dsh web` 启动的就是它，装到别的 profile 不会生效。
const PROFILE = "web";
const DEBUG = process.env.SMOKE_DEBUG === "1";
const KEEP = process.env.SMOKE_KEEP === "1";
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [opts]
 */
async function run(cmd, args, opts = {}) {
  try {
    return await exec(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch (error) {
    const anyError = /** @type {any} */ (error);
    return { stdout: String(anyError?.stdout ?? ""), stderr: String(anyError?.stderr ?? "") };
  }
}

/** @param {string} path */
async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} logPath
 * @param {number} timeoutMs
 */
async function waitForBoot(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readIfExists(logPath);
    const line = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/u);
    if (line) return { port: Number(line[1]), token: line[2], text };
    if (/did not activate|^error:/mu.test(text)) return { port: 0, token: "", text };
    await sleep(500);
  }
  return { port: 0, token: "", text: await readIfExists(logPath) };
}

/**
 * 用页面 URL 换到宿主的鉴权 cookie（宿主 303 到 / 并种 cookie）。
 * @param {number} port
 * @param {string} token
 * @returns {Promise<string[]>}
 */
async function authenticate(port, token) {
  const res = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: "manual" });
  const cookie = res.headers.getSetCookie?.() ?? [];
  if (res.status !== 303 && res.status !== 200) {
    throw new Error(`认证跳转返回 ${res.status}`);
  }
  if (cookie.length === 0) throw new Error("没有拿到 dsh-auth cookie");
  return cookie.map((item) => item.split(";")[0]);
}

/**
 * 调一个 casefile Remote 方法。
 * @param {{ port: number, cookies: string[], rpcSeq: { n: number } }} session
 * @param {string} method
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<{ ok: boolean, value?: any, error?: any, status: number, raw: string }>}
 */
async function remote(session, method, args = {}) {
  session.rpcSeq.n += 1;
  const rpcId = `smoke-${session.rpcSeq.n}`;
  const res = await fetch(`http://127.0.0.1:${session.port}/api/casefile/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${session.port}`,
      cookie: session.cookies.join("; "),
    },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: `casefile/${method}`,
      payload: { args },
    }),
  });
  const raw = await res.text();
  if (DEBUG) console.log(`  ${method} ${res.status} ${raw.slice(0, 500)}`);
  /** @type {any} */
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* 保持 {} */
  }
  const result = parsed?.result ?? {};
  return {
    ok: result.ok === true,
    value: result.value,
    error: result.error,
    status: res.status,
    raw,
  };
}

/**
 * @param {string} path
 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), "dsh-casefile-smoke-home-"));
  const work = await mkdtemp(join(tmpdir(), "dsh-casefile-smoke-work-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let host;
  /** @type {import("node:fs").WriteStream | undefined} */
  let hostLog;
  const shots = join(work, "evidence");

  try {
    await mkdir(shots, { recursive: true });

    // 1) 打包并装进临时 profile
    await run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
    const tgz = (await readdir(work)).find((name) => name.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack 没有产出 tgz");
    const env = { ...process.env, DSH_HOME: home };
    const install = await run("dsh", ["plugin", "--profile", PROFILE, "add", join(work, tgz)], {
      env,
    });
    check(
      "插件安装进临时 profile",
      (await readFile(join(home, "profiles", PROFILE, "package.json"), "utf8")).includes(PACKAGE),
      install.stderr.slice(-400),
    );

    // 2) 启动真实宿主
    const logPath = join(work, "host.log");
    host = spawn("dsh", ["web", "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    hostLog = createWriteStream(logPath, { flags: "w" });
    host.stdout?.on("data", (/** @type {any} */ chunk) => hostLog?.write(String(chunk)));
    host.stderr?.on("data", (/** @type {any} */ chunk) => hostLog?.write(String(chunk)));

    const boot = await waitForBoot(logPath, 120_000);
    check("宿主启动并打印访问地址", boot.port > 0, boot.text.slice(-1500));
    if (boot.port === 0) {
      await writeFile(join(shots, "host.log"), boot.text);
      return;
    }
    check("没有未激活的插件", !/did not activate/u.test(boot.text), boot.text.slice(-800));

    // 3) 插件激活的实证：构造期创建数据根
    check(
      "插件激活并创建数据根 <DSH_HOME>/casefile/projects",
      await exists(join(home, "casefile", "projects")),
      home,
    );

    const cookies = await authenticate(boot.port, boot.token);
    check("拿到宿主鉴权 cookie", cookies.length > 0);
    /** @type {{ port: number, cookies: string[], rpcSeq: { n: number } }} */
    const session = { port: boot.port, cookies, rpcSeq: { n: 0 } };

    // 4) 空列表（插件可能在启动后晚一拍才 claim 端点，轮询到就绪为止）
    let empty = await remote(session, "listProjects");
    for (let attempt = 0; attempt < 30 && empty.status === 404; attempt += 1) {
      await sleep(500);
      empty = await remote(session, "listProjects");
    }
    check(
      "listProjects 端点可用且初始为空",
      empty.ok && Array.isArray(empty.value) && empty.value.length === 0,
      empty.raw.slice(0, 300),
    );

    // 5) 建项目
    // Remote 参数按「命名位置参数」序列化：createProject(input) → args.input
    const created = await remote(session, "createProject", {
      input: {
        title: "Todo App Smoke",
        target: { kind: "web", ref: "http://127.0.0.1:9/todo" },
        authTier: "research",
        scope: "selected",
      },
    });
    check(
      "createProject 返回项目",
      created.ok && created.value?.id === "todo-app-smoke",
      created.raw.slice(0, 400),
    );

    // 6) 非法输入被拒（不是 500）
    const bad = await remote(session, "createProject", {
      input: { title: "Bad", authTier: "commercial" },
    });
    // 网关用 200 + result.ok=false 表达业务错误（不是 HTTP 400）。
    check(
      "非法授权档返回 gateway/bad-request（不是 500，也不是静默通过）",
      bad.ok === false && bad.error?.code === "gateway/bad-request",
      `${bad.status} ${bad.raw.slice(0, 240)}`,
    );

    // 7) 记证据（故意带本机路径，后面验脱敏）
    const evidence = await remote(session, "addEvidence", {
      projectId: "todo-app-smoke",
      input: {
        kind: "har",
        sourceTool: "inspect_web_network_capture",
        summary: `POST /api/todos 返回 201；样本路径 ${home}/samples/todo.bin`,
        confidence: "observed",
        authority: "live-observation",
        limitations: ["只覆盖登录后的 3 个请求"],
        refs: [`${home}/captures/todo.har`],
      },
    });
    check(
      "addEvidence 写入证据",
      evidence.ok && typeof evidence.value?.id === "string",
      evidence.raw.slice(0, 300),
    );

    // 8) 写结论并勾选
    const claim = await remote(session, "addClaim", {
      projectId: "todo-app-smoke",
      input: {
        text: "新增待办走 POST /api/todos",
        kind: "har",
        evidenceIds: [evidence.value?.id],
      },
    });
    check(
      "addClaim 写入结论且默认未选中",
      claim.ok && claim.value?.selected === false,
      claim.raw.slice(0, 300),
    );
    const selected = await remote(session, "selectClaims", {
      projectId: "todo-app-smoke",
      claimIds: [claim.value?.id],
      selected: true,
    });
    check(
      "selectClaims 勾选结论",
      selected.ok && selected.value?.[0]?.selected === true,
      selected.raw.slice(0, 300),
    );

    // 9) 功能 + 未知项
    const feature = await remote(session, "addFeature", {
      projectId: "todo-app-smoke",
      input: { name: "新增待办", boundaries: ["只做新增"], nonGoals: ["不做批量"] },
    });
    check(
      "addFeature 建功能",
      feature.ok && typeof feature.value?.id === "string",
      feature.raw.slice(0, 300),
    );
    const unknown = await remote(session, "addUnknown", {
      projectId: "todo-app-smoke",
      input: { text: "并发上限未知", severity: "high" },
    });
    check(
      "addUnknown 记未知项",
      unknown.ok && unknown.value?.status === "open",
      unknown.raw.slice(0, 300),
    );

    // 9.5) 义务：新增 + 无检查时拒绝关闭（硬门）
    const obligation = await remote(session, "addObligation", {
      projectId: "todo-app-smoke",
      input: {
        statement: "新增待办在 390px 下不横向滚动",
        kind: "behavior",
        authorityRequired: "controlled-replay",
      },
    });
    check(
      "addObligation 加义务且状态 open",
      obligation.ok && obligation.value?.status === "open",
      obligation.raw.slice(0, 300),
    );
    const blockedClose = await remote(session, "closeObligation", {
      projectId: "todo-app-smoke",
      obligationId: obligation.value?.id,
    });
    check(
      "没有新鲜 PASS 检查时拒绝关闭义务（obligationTooTall）",
      blockedClose.ok === false &&
        /obligationTooTall/u.test(String(blockedClose.error?.message ?? "")),
      blockedClose.raw.slice(0, 300),
    );
    // 新鲜 PASS + digest 一致 → 可以关闭
    const check1 = await remote(session, "addCheck", {
      projectId: "todo-app-smoke",
      input: {
        obligationId: obligation.value?.id,
        checker: "manual",
        verdict: "pass",
        implementationDigest: "impl-smoke",
        originalDigest: "orig-smoke",
      },
    });
    check(
      "addCheck 记录检查结果",
      check1.ok && check1.value?.verdict === "pass",
      check1.raw.slice(0, 300),
    );
    const closed = await remote(session, "closeObligation", {
      projectId: "todo-app-smoke",
      obligationId: obligation.value?.id,
      input: { note: "冒烟：新鲜 PASS" },
    });
    check(
      "新鲜 PASS 且 digest 一致时允许关闭",
      closed.ok && closed.value?.status === "pass",
      closed.raw.slice(0, 300),
    );

    // 9.6) 构建/验收闭环（真跑命令：Node 自身当被测目标，不联网）
    const implDir = join(work, "impl");
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, "app.mjs"), "console.log('Usage: smoke');\n", "utf8");
    const build1 = await remote(session, "startBuild", {
      projectId: "todo-app-smoke",
      input: { command: `node ${join(implDir, "app.mjs")}`, cwd: implDir },
    });
    check(
      "startBuild 落 BuildRun 并算出实现 digest",
      build1.ok &&
        build1.value?.build?.status === "pass" &&
        /^[0-9a-f]{64}$/u.test(String(build1.value?.build?.implementationDigest)),
      build1.raw.slice(0, 400),
    );
    const obligation2 = await remote(session, "addObligation", {
      projectId: "todo-app-smoke",
      input: { statement: "CLI 输出包含 Usage", kind: "behavior" },
    });
    const check2 = await remote(session, "runCheck", {
      projectId: "todo-app-smoke",
      input: {
        obligationId: obligation2.value?.id,
        checker: "cli",
        command: `node ${join(implDir, "app.mjs")}`,
        expect: { exitCode: 0, stdoutIncludes: ["Usage"] },
      },
    });
    check(
      "runCheck 绑定当前实现 digest 且判 pass",
      check2.ok &&
        check2.value?.check?.verdict === "pass" &&
        check2.value?.check?.implementationDigest === build1.value?.build?.implementationDigest,
      check2.raw.slice(0, 400),
    );
    const closed2 = await remote(session, "closeObligation", {
      projectId: "todo-app-smoke",
      obligationId: obligation2.value?.id,
    });
    check(
      "有新鲜 PASS 检查时可关闭第二条义务",
      closed2.ok && closed2.value?.status === "pass",
      closed2.raw.slice(0, 300),
    );

    // 改实现 → 再构建 → 已关闭义务应被 stale 重开
    await writeFile(join(implDir, "app.mjs"), "console.log('Usage: smoke v2');\n", "utf8");
    const build2 = await remote(session, "startBuild", {
      projectId: "todo-app-smoke",
      input: { command: `node ${join(implDir, "app.mjs")}`, cwd: implDir },
    });
    check(
      "实现变化后第二轮构建把已关闭义务标 stale 并重开",
      build2.ok && Array.isArray(build2.value?.stale) && build2.value.stale.length >= 1,
      build2.raw.slice(0, 400),
    );
    const obligationsAfter = await remote(session, "listObligations", {
      projectId: "todo-app-smoke",
    });
    const reopened = (obligationsAfter.value || []).find(
      (/** @type {any} */ item) => item.id === obligation2.value?.id,
    );
    check(
      "stale 之后该义务状态回到 open",
      reopened?.status === "open" && /stale/u.test(String(reopened?.note)),
      JSON.stringify(reopened ?? null).slice(0, 300),
    );

    // 10) 详情统计
    const detail = await remote(session, "projectDetail", { projectId: "todo-app-smoke" });
    check(
      "projectDetail 统计正确（1 证据 / 1 结论 / 1 功能 / 1 未知项）",
      detail.ok &&
        detail.value?.stats?.evidence === 1 &&
        detail.value?.stats?.claims === 1 &&
        detail.value?.stats?.features === 1 &&
        detail.value?.stats?.openUnknowns === 1 &&
        detail.value?.stats?.obligations === 2 &&
        // 两次构建后实现 digest 变化，两条已关闭义务都被 stale 重开
        detail.value?.stats?.openObligations === 2 &&
        detail.value?.stats?.passedObligations === 0,
      JSON.stringify(detail.value?.stats ?? null).slice(0, 300),
    );

    // 11) 规格包导出
    const exported = await remote(session, "exportSpecPack", {
      projectId: "todo-app-smoke",
      options: { redact: true },
    });
    const specDir = exported.value?.data?.path ?? "";
    check(
      "exportSpecPack 写出 spec.json + brief.md",
      exported.ok &&
        (await exists(join(specDir, "spec.json"))) &&
        (await exists(join(specDir, "brief.md"))),
      `${specDir} ${exported.raw.slice(0, 300)}`,
    );

    const specRaw = await readIfExists(join(specDir, "spec.json"));
    const spec = specRaw === "" ? {} : JSON.parse(specRaw);
    check(
      "规格包只含选中结论、带上证据与未知项",
      spec.claims?.length === 1 && spec.evidence?.length === 1 && spec.unknowns?.length === 1,
      JSON.stringify({
        claims: spec.claims?.length,
        evidence: spec.evidence?.length,
        unknowns: spec.unknowns?.length,
      }),
    );
    check(
      "规格包已脱敏（本机路径不落盘）",
      specRaw !== "" && !specRaw.includes(home) && specRaw.includes("<path>"),
      specRaw.slice(0, 300),
    );
    const brief = await readIfExists(join(specDir, "brief.md"));
    check(
      "brief.md 带出处、局限与未知项",
      brief.includes("# 规格包") &&
        brief.includes("只覆盖登录后的 3 个请求") &&
        brief.includes("并发上限未知"),
    );
    await writeFile(join(shots, "brief.md"), brief);
    await writeFile(join(shots, "spec.json"), specRaw);

    // 12) 审计与只追加记录落盘
    const audit = await readIfExists(
      join(home, "casefile", "projects", "todo-app-smoke", "audit.jsonl"),
    );
    check(
      "审计日志记录了项目/证据/结论/导出",
      ["project/create", "evidence/add", "claim/add", "spec/export"].every((action) =>
        audit.includes(action),
      ),
      audit.slice(0, 400),
    );

    // 13) 能力探测：临时 home 里没有 REA，应报 missing 而不是假装正常
    const diagnosis = await remote(session, "diagnose");
    check(
      "diagnose 在无 REA 时报 missing（不假装正常）",
      diagnosis.ok &&
        diagnosis.value?.grade?.ok === false &&
        diagnosis.value?.rea?.availableTools === 0,
      diagnosis.raw.slice(0, 400),
    );

    // 14) 仓库 cwd 不被污染
    const stray = (await readdir(REPO)).filter(
      (name) => name.startsWith("casefile-") || name === "spec",
    );
    check("没有写进仓库工作目录", stray.length === 0, stray.join(","));
  } catch (error) {
    failed += 1;
    console.error(`FAIL 冒烟异常：${String(error)}`);
  } finally {
    host?.kill("SIGTERM");
    await sleep(800);
    host?.kill("SIGKILL");
    const failedNow = failed > 0;
    if (failedNow || KEEP) {
      const logPath = join(work, "host.log");
      const tail = (await readIfExists(logPath)).slice(-4000);
      const kept = { home, work, shots };
      await writeFile(join(work, "host.tail.log"), tail);
      console.error(`\n现场已保留（${failedNow ? "因为失败" : "SMOKE_KEEP=1"}）：`);
      console.error(`  home: ${kept.home}`);
      console.error(`  work: ${kept.work}`);
      console.error(`  evidence: ${kept.shots}`);
      if (tail !== "") console.error(`\n宿主日志尾部：\n${tail}`);
    } else {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
    console.log(`\n结果：${passed} PASS / ${failed} FAIL`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
