// @ts-check
// gate:all 的纯函数与 CLI 失败分支：
//   - 插件解析、缺脚本检查、dry-run 计划（旧有逻辑，原样锁住）；
//   - `--deep` / `--workspace` 的解析与规划：白名单、互斥、缺参示例（2026-11-28 新增）；
//   - `--workspace` 注册的**只读**检测：未注册/仓库内/坏存储都必须失败，绝不写盘；
//     其中「未注册/目录不存在」给可复制命令，「仓库内目录」不给命令但要说清原因（复审 N1）；
//   - deep 运行语义抽成纯函数（`shouldRunDeep` / `classifyDeepStage` / `failedResults`），
//     把「SKIP 判失败 / 缺计数行判绿 / 未跑判绿 / web 失败仍跑 deep」变成可执行单测（复审 N4）；
//   - 汇总里 deep 阶段的 PASS/SKIP/FAIL 计数、「未跑 vs 无计数行」区分（复审 N3）与
//     「3 SKIP 是宿主 apply_patch 关闭的已知结论」。
// CI 用 `pnpm gate:all --dry-run` 跑结构检查，这里用单测锁住同一个计划；不启动 GUI、不发模型请求。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { desktopGateVerdict } from "../gate.mjs";
import {
  buildPlan,
  checkWorkspaceRegistration,
  classifyDeepStage,
  compareCounts,
  DEEP_GATE_PLUGINS,
  DEEP_MANUAL_ONLY,
  deepSkipNote,
  failedResults,
  formatCounts,
  GateAllUsageError,
  missingScripts,
  normalizePlugins,
  parseGateAllOptions,
  planDeep,
  quoteShellArg,
  RELEASE_PLUGINS,
  registrationHint,
  resolveDshHome,
  shouldRunDeep,
  summaryLines,
} from "../gate-all.mjs";
import { REPO_ROOT } from "../lib/repo.mjs";
import { registerTestWorkspace } from "../lib/workspace-register.mjs";

const CLI = join(REPO_ROOT, "scripts", "gate-all.mjs");
/** @type {string[]} */
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** @param {string} name */
function makeRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `dsh-gate-all-${name}-`));
  roots.push(root);
  return root;
}

/**
 * 跑一次 gate:all CLI（不发模型、不起宿主；最坏情况是参数校验后立即失败）。
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnv]
 */
function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

/** 正则转义，便于断言绝对路径。 @param {string} value */
const re = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// ---------------------------------------------------------------------------
// 旧有逻辑（保持原样）
// ---------------------------------------------------------------------------

test("默认插件列表就是八个发布插件（AUD-XCT-04：旧清单漏了 artifacts / projects）", () => {
  assert.deepEqual(normalizePlugins(undefined), RELEASE_PLUGINS);
  assert.deepEqual(normalizePlugins(""), RELEASE_PLUGINS);
  assert.deepEqual(normalizePlugins("   "), RELEASE_PLUGINS);
  assert.deepEqual(RELEASE_PLUGINS, [
    "advisor",
    "artifacts",
    "btw",
    "casefile",
    "next-step",
    "projects",
    "session-delete",
    "session-rewind",
  ]);
});

test("--plugins 解析：去空白、去空项、去重复、保序", () => {
  assert.deepEqual(normalizePlugins("advisor, btw ,,advisor"), ["advisor", "btw"]);
  assert.deepEqual(normalizePlugins("casefile"), ["casefile"]);
});

test("缺脚本检查：桌面脚本可由 --skip-desktop 豁免", () => {
  const scripts = { "smoke:a": "node a.mjs" };
  assert.deepEqual(missingScripts(["a"], scripts, false), ["smoke:a-desktop"]);
  assert.deepEqual(missingScripts(["a"], scripts, true), []);
  assert.deepEqual(missingScripts(["a", "b"], { "smoke:a": "x", "smoke:a-desktop": "y" }, false), [
    "smoke:b",
    "smoke:b-desktop",
  ]);
});

test("dry-run 计划覆盖顺序与步骤编号", () => {
  const plan = buildPlan({
    plugins: ["advisor", "btw"],
    skipVerify: false,
    skipDesktop: false,
    idleTitle: "空闲会话",
    repeat: 1,
  });
  assert.equal(plan[0], "1. pnpm verify");
  assert.equal(plan[1], "2. pnpm probe:runtime");
  assert.ok(plan.includes("3.1 pnpm smoke:advisor"));
  assert.ok(plan.includes("3.2 pnpm smoke:btw"));
  assert.ok(plan.includes("4.1 pnpm smoke:advisor-desktop --require"));
  assert.ok(plan.includes("4.2 pnpm smoke:btw-desktop --require"));
  assert.ok(plan.some((line) => line.includes("切到空闲会话「空闲会话」")));
  assert.ok(!plan.some((line) => line.includes("连跑")));
});

test("dry-run 计划：跳过项与 --repeat 标注", () => {
  const skipped = buildPlan({
    plugins: ["advisor"],
    skipVerify: true,
    skipDesktop: true,
    idleTitle: null,
    repeat: 1,
  });
  assert.match(skipped[0], /^- verify/);
  assert.ok(skipped.includes("- 桌面端（已按 --skip-desktop 跳过）"));
  assert.ok(!skipped.some((line) => line.startsWith("4.")));

  const repeated = buildPlan({
    plugins: ["advisor"],
    skipVerify: true,
    skipDesktop: false,
    idleTitle: null,
    repeat: 2,
  });
  assert.ok(repeated.includes("4.1 pnpm smoke:advisor-desktop --require（连跑 2 次）"));
});

test("compareCounts：一致返回 null，SKIP 漂移/新增失败都要看得见", () => {
  assert.equal(compareCounts({ pass: 19, skip: 1, fail: 0 }, { pass: 19, skip: 1, fail: 0 }), null);
  assert.equal(
    compareCounts({ pass: 21, skip: 1, fail: 0 }, { pass: 20, skip: 2, fail: 0 }),
    "21/1/0 → 20/2/0",
    "数据相关 SKIP 变化要能打印出来",
  );
  assert.equal(
    compareCounts({ pass: 19, skip: 1, fail: 0 }, { pass: 18, skip: 1, fail: 1 }),
    "19/1/0 → 18/1/1",
    "FAIL 变化同样要看得见（门禁本身还会因退出码判红）",
  );
});

test("仓库里八个发布插件的 web/桌面脚本真的都在（离线结构检查）", () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {};
  assert.deepEqual(missingScripts(RELEASE_PLUGINS, scripts, false), []);
});

// ---------------------------------------------------------------------------
// 选项解析（--deep / --workspace / --skip-deep）
// ---------------------------------------------------------------------------

test("parseGateAllOptions：默认值与旧行为完全一致（不规划任何 deep）", () => {
  const options = parseGateAllOptions([]);
  assert.deepEqual(options.plugins, RELEASE_PLUGINS);
  assert.equal(options.skipVerify, false);
  assert.equal(options.skipDesktop, false);
  assert.equal(options.idleTitle, null);
  assert.equal(options.repeat, 1);
  assert.equal(options.dryRun, false);
  assert.equal(options.deep, false);
  assert.equal(options.skipDeep, false);
  assert.equal(options.workspace, null);
  assert.equal(typeof options.port, "number");
});

test("parseGateAllOptions：--deep / --workspace / --skip-deep / --plugins 解析", () => {
  const options = parseGateAllOptions([
    "--deep",
    "--workspace",
    "/tmp/deep-ws",
    "--plugins",
    "session-rewind,advisor",
    "--repeat",
    "2",
  ]);
  assert.equal(options.deep, true);
  assert.equal(options.workspace, "/tmp/deep-ws");
  assert.deepEqual(options.plugins, ["session-rewind", "advisor"]);
  assert.equal(options.repeat, 2);
  assert.equal(parseGateAllOptions(["--skip-deep"]).skipDeep, true);
  assert.equal(
    parseGateAllOptions(["--workspace", "   "]).workspace,
    null,
    "空白 workspace 归一为 null",
  );
});

test("parseGateAllOptions：未知参数/非法 --repeat 抛 GateAllUsageError（退出码 2 的来源）", () => {
  assert.throws(() => parseGateAllOptions(["--deep", "--bogus"]), GateAllUsageError);
  assert.throws(() => parseGateAllOptions(["--repeat", "0"]), /--repeat/u);
  assert.throws(() => parseGateAllOptions(["--repeat", "4"]), GateAllUsageError);
  assert.throws(() => parseGateAllOptions(["positional"]), GateAllUsageError);
});

test("resolveDshHome：DSH_HOME 优先，否则 ~/.dsh（可注入，不读真实 home）", () => {
  assert.equal(resolveDshHome({ DSH_HOME: "/tmp/dsh-home" }, "/home/me"), resolve("/tmp/dsh-home"));
  assert.equal(resolveDshHome({}, "/home/me"), resolve("/home/me/.dsh"));
  assert.equal(resolveDshHome({ DSH_HOME: "   " }, "/home/me"), resolve("/home/me/.dsh"));
});

// ---------------------------------------------------------------------------
// deep 规划（白名单 / 互斥 / 缺参示例）
// ---------------------------------------------------------------------------

test("planDeep：不带 --deep 时完全不改变现有门禁", () => {
  const plan = planDeep({
    plugins: RELEASE_PLUGINS,
    deep: false,
    skipDeep: false,
    skipDesktop: false,
    workspace: null,
  });
  assert.deepEqual(plan, { enabled: false, targets: [], workspace: null, notes: [], error: null });
});

test("planDeep：--deep 缺 --workspace → 明确失败并给可整行复制的示例", () => {
  const plan = planDeep({
    plugins: RELEASE_PLUGINS,
    deep: true,
    skipDeep: false,
    skipDesktop: false,
    workspace: null,
  });
  assert.equal(plan.enabled, false);
  assert.deepEqual(plan.targets, []);
  assert.match(plan.error, /--deep 需要 --workspace/u);
  assert.match(
    plan.error,
    /--home ~\/\.dsh --path ~\/Workspace\/dsh-rewind-ui-smoke --allow-live/u,
  );
  assert.match(plan.error, /pnpm gate:all --deep --workspace ~\/Workspace\/dsh-rewind-ui-smoke/u);
});

test("planDeep：--deep 与 --skip-deep / --skip-desktop 互斥", () => {
  const mix = {
    plugins: RELEASE_PLUGINS,
    deep: true,
    workspace: "/tmp/deep-ws",
    skipDesktop: false,
  };
  assert.match(planDeep({ ...mix, skipDeep: true }).error, /--deep 与 --skip-deep 互斥/u);
  assert.match(
    planDeep({ ...mix, skipDeep: false, skipDesktop: true }).error,
    /和 --skip-desktop 冲突/u,
  );
});

test("planDeep：deep 只传给白名单插件（当前 session-rewind），其余插件逐个说明", () => {
  assert.deepEqual(DEEP_GATE_PLUGINS, ["session-rewind"], "白名单是显式的");
  const plan = planDeep({
    plugins: RELEASE_PLUGINS,
    deep: true,
    skipDeep: false,
    skipDesktop: false,
    workspace: "/tmp/deep-ws",
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.workspace, "/tmp/deep-ws");
  assert.deepEqual(plan.targets, ["session-rewind"], "只有 session-rewind 拿到 --deep");
  const notes = plan.notes.join("\n");
  for (const plugin of RELEASE_PLUGINS.filter((name) => name !== "session-rewind")) {
    assert.match(notes, new RegExp(`${plugin}：`, "u"), `每个非白名单插件都要有说明：${plugin}`);
  }
  assert.match(notes, /next-step：.*支持 --deep.*没纳入批量门禁/u, "别把「未纳入」写成「不支持」");
  assert.match(notes, /btw：.*支持 --deep.*真实数据根/u);
  assert.match(notes, /advisor：桌面脚本没有 --deep/u);
  assert.doesNotMatch(notes, /advisor：.*支持 --deep/u);
});

test("planDeep：脚本声明了 --deep 的 next-step / btw 也不会自动纳入白名单", () => {
  // 反向锁死「别去扫脚本自动发现」：这两个桌面脚本确实有 deep 选项，
  // 但副作用与前置不同，必须人工 opt-in（见 DEEP_MANUAL_ONLY 的注释）。
  for (const plugin of ["next-step", "btw"]) {
    const source = readFileSync(join(REPO_ROOT, "scripts", `smoke-${plugin}-desktop.mjs`), "utf8");
    assert.match(source, /deep:\s*\{\s*type:\s*"boolean"/u, `${plugin} 桌面脚本确实支持 --deep`);
    assert.ok(
      Object.hasOwn(DEEP_MANUAL_ONLY, plugin),
      `${plugin} 必须在 DEEP_MANUAL_ONLY 里说明原因`,
    );
  }
  const onlyManual = planDeep({
    plugins: ["next-step", "btw"],
    deep: true,
    skipDeep: false,
    skipDesktop: false,
    workspace: "/tmp/deep-ws",
  });
  assert.equal(onlyManual.enabled, false);
  assert.match(onlyManual.error, /都不在 deep 白名单里/u);

  const mixed = planDeep({
    plugins: ["btw", "session-rewind", "next-step"],
    deep: true,
    skipDeep: false,
    skipDesktop: false,
    workspace: "/tmp/deep-ws",
  });
  assert.deepEqual(mixed.targets, ["session-rewind"]);
  assert.equal(mixed.notes.length, 2);
});

test("deep 能力清单覆盖所有桌面脚本：带 --deep 的必须在白名单或 DEEP_MANUAL_ONLY 里有交代", () => {
  // 复审 N4：不要只硬编码 next-step / btw。将来新插件加 `--deep` 时，这里必须亮，
  // 否则计划会把它误写成「桌面脚本没有 --deep」，白名单也会悄悄漏掉它。
  const scriptsDir = join(REPO_ROOT, "scripts");
  const desktopScripts = readdirSync(scriptsDir).filter((file) =>
    /^smoke-.+-desktop\.mjs$/u.test(file),
  );
  assert.ok(
    desktopScripts.length >= RELEASE_PLUGINS.length,
    `八个发布插件都应有桌面脚本，实际 ${desktopScripts.length} 个`,
  );
  /** @type {string[]} */
  const declaredDeep = [];
  for (const file of desktopScripts) {
    const source = readFileSync(join(scriptsDir, file), "utf8");
    if (!/deep:\s*\{\s*type:\s*"boolean"/u.test(source)) continue;
    const plugin = file.replace(/^smoke-/u, "").replace(/-desktop\.mjs$/u, "");
    declaredDeep.push(plugin);
    assert.ok(
      DEEP_GATE_PLUGINS.includes(plugin) || Object.hasOwn(DEEP_MANUAL_ONLY, plugin),
      `${plugin} 的桌面脚本声明了 --deep，但既不在 DEEP_GATE_PLUGINS 也没在 DEEP_MANUAL_ONLY 交代`,
    );
  }
  // 当前实测的三个能力（session-rewind 纳入白名单；next-step / btw 手动）。
  for (const plugin of ["session-rewind", "next-step", "btw"]) {
    assert.ok(
      declaredDeep.includes(plugin),
      `${plugin} 的桌面脚本应声明 --deep（能力清单漂移了？）`,
    );
  }
  // 计划文案：支持 --deep 的插件不能被写成「没有 --deep」
  const notes = planDeep({
    plugins: ["btw", "next-step", "session-rewind", "advisor"],
    deep: true,
    skipDeep: false,
    skipDesktop: false,
    workspace: "/tmp/deep-ws",
  }).notes.join("\n");
  assert.doesNotMatch(notes, /(btw|next-step)：桌面脚本没有 --deep/u);
  assert.doesNotMatch(notes, /session-rewind：/u, "白名单插件不该出现在「没加深」说明里");
  assert.match(notes, /advisor：桌面脚本没有 --deep/u);
});

test("dry-run 计划：--deep 只给白名单插件的桌面阶段追加 deep 行", () => {
  const plan = buildPlan({
    plugins: ["advisor", "session-rewind"],
    skipVerify: false,
    skipDesktop: false,
    idleTitle: null,
    repeat: 1,
    deep: true,
    deepTargets: ["session-rewind"],
    workspace: "/tmp/deep-ws",
  });
  assert.ok(plan.includes("4.1 pnpm smoke:advisor-desktop --require"));
  assert.ok(!plan.some((line) => line.startsWith("4.1-deep")));
  assert.ok(plan.includes("4.2 pnpm smoke:session-rewind-desktop --require"));
  assert.ok(
    plan.includes(
      "4.2-deep pnpm smoke:session-rewind-desktop --require --deep --workspace /tmp/deep-ws",
    ),
  );

  const repeated = buildPlan({
    plugins: ["session-rewind"],
    skipVerify: true,
    skipDesktop: false,
    idleTitle: null,
    repeat: 2,
    deep: true,
    deepTargets: ["session-rewind"],
    workspace: "/tmp/deep-ws",
  });
  assert.ok(
    repeated.includes(
      "4.1-deep pnpm smoke:session-rewind-desktop --require --deep --workspace /tmp/deep-ws（deep 只跑一次，不随 --repeat 重复）",
    ),
    "deep 不做幂等重复（真实模型调用）",
  );
});

// ---------------------------------------------------------------------------
// --workspace 注册的只读检测（mkdtemp 临时 home，不碰真实 ~/.dsh）
// ---------------------------------------------------------------------------

test("checkWorkspaceRegistration：未注册 → 失败 + 可复制命令，且只读（不写 workspace.json）", async () => {
  const root = makeRoot("unregistered");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  const result = await checkWorkspaceRegistration({ workspace, home, repoRoot: REPO_ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.workspaceReal, realpathSync(workspace));
  assert.match(result.detail, /工作区未注册/u);
  assert.match(result.hint ?? "", /node scripts\/register-test-workspace\.mjs --home/u);
  assert.match(result.hint ?? "", new RegExp(`--path ${re(realpathSync(workspace))}`, "u"));
  assert.doesNotMatch(
    result.hint ?? "",
    /--allow-live/u,
    "临时 home 不是 live 数据根，不该出现 --allow-live",
  );
  assert.equal(
    existsSync(join(realpathSync(home), "storages", "workspace.json")),
    false,
    "门禁只做只读检测，不许替用户写宿主注册表",
  );
});

test("checkWorkspaceRegistration：已注册 → ok（读的是 helper 写的同一份存储）", async () => {
  const root = makeRoot("registered");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  registerTestWorkspace({ home, path: workspace, envHome: root });
  const result = await checkWorkspaceRegistration({ workspace, home, repoRoot: REPO_ROOT });
  assert.equal(result.ok, true);
  assert.equal(result.detail, "");
  assert.equal(result.workspaceReal, realpathSync(workspace));
  assert.ok(result.storeFile.endsWith("workspace.json"));
  // 软链写法也能认出来（helper 按 realpath 存储）
  assert.equal(
    (
      await checkWorkspaceRegistration({
        workspace: realpathSync(workspace),
        home,
        repoRoot: REPO_ROOT,
      })
    ).ok,
    true,
  );
});

test("checkWorkspaceRegistration：仓库内目录 / 目录不存在 / 坏 workspace.json 都失败并给提示", async () => {
  const root = makeRoot("bad");
  const home = join(root, "home");
  mkdirSync(home);

  const insideRepo = await checkWorkspaceRegistration({
    workspace: join(REPO_ROOT, "scripts"),
    home,
    repoRoot: REPO_ROOT,
  });
  assert.equal(insideRepo.ok, false);
  assert.match(insideRepo.detail, /位于本仓库内/u);
  // 复审 N1：仓库内目录**不打印**注册命令（注册了也不会过），detail 里要说清原因，
  // 文档不再声称「仓库内目录也会打印可复制命令」。
  assert.equal(insideRepo.hint, null);
  assert.match(insideRepo.detail, /不打印注册命令/u);

  const missing = await checkWorkspaceRegistration({
    workspace: join(root, "does-not-exist"),
    home,
    repoRoot: REPO_ROOT,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /--workspace 不可用/u);
  assert.match(missing.hint ?? "", /mkdir -p /u);
  assert.match(missing.hint ?? "", /register-test-workspace\.mjs/u);

  // 坏存储：拒绝改写、也不假装「已注册」
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(home, "storages"), { recursive: true });
  writeFileSync(join(home, "storages", "workspace.json"), "{not json", "utf8");
  const broken = await checkWorkspaceRegistration({ workspace, home, repoRoot: REPO_ROOT });
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /读不了/u);
  assert.match(broken.hint ?? "", /不改写宿主注册表/u);
});

test("checkWorkspaceRegistration：DSH 数据根不存在时 hint 先给 mkdir（复审 N6：命令要能直接跑通）", async () => {
  const root = makeRoot("no-home");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const missingHome = join(root, "home-not-created");
  const result = await checkWorkspaceRegistration({
    workspace,
    home: missingHome,
    repoRoot: REPO_ROOT,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /DSH 数据根不存在/u);
  const hint = result.hint ?? "";
  assert.match(
    hint,
    new RegExp(`mkdir -p ${re(resolve(missingHome))}`, "u"),
    "先建 home，否则 helper 会拒绝",
  );
  const mkdirAt = hint.indexOf("mkdir -p");
  const registerAt = hint.indexOf("register-test-workspace.mjs");
  assert.ok(mkdirAt >= 0 && registerAt > mkdirAt, "mkdir 必须排在注册命令之前");
});

test("registrationHint / quoteShellArg：命令可整行复制，live 根带 --allow-live", () => {
  const live = registrationHint({
    home: join("/home/me", ".dsh"),
    workspaceReal: "/tmp/dsh-rewind-ui-smoke",
    allowLive: true,
  });
  assert.match(live, /--allow-live/u);
  assert.match(live, /先退出桌面版 → 注册 → 再启动/u);
  assert.match(live, /不会替你写宿主注册表/u);

  const isolated = registrationHint({
    home: "/tmp/dsh-test-home",
    workspaceReal: "/tmp/dsh-rewind-ui-smoke",
    allowLive: false,
  });
  assert.doesNotMatch(isolated, /--allow-live/u);
  assert.match(isolated, /重启该实例/u);

  assert.equal(quoteShellArg("/tmp/a-b_c.d:e"), "/tmp/a-b_c.d:e");
  assert.equal(quoteShellArg("/tmp/has space/ws"), "'/tmp/has space/ws'");
  assert.equal(quoteShellArg("/tmp/it's"), "'/tmp/it'\\''s'");
});

// ---------------------------------------------------------------------------
// 汇总：deep 计数 + 已知 SKIP 结论
// ---------------------------------------------------------------------------

test("formatCounts：与冒烟收尾行同格式；解析不到时说明白", () => {
  assert.equal(formatCounts({ pass: 59, skip: 3, fail: 0 }), "59 PASS / 3 SKIP / 0 FAIL");
  assert.equal(formatCounts(undefined), "无计数行");
});

test("汇总：deep 列显示 PASS/SKIP/FAIL，非白名单插件显示 deep -", () => {
  const lines = summaryLines(
    [
      { plugin: "advisor", webOk: true, desktopOk: true },
      {
        plugin: "session-rewind",
        webOk: true,
        desktopOk: true,
        deepOk: true,
        deepCounts: { pass: 59, skip: 3, fail: 0 },
      },
    ],
    { desktopEnabled: true, deepEnabled: true, deepTargets: ["session-rewind"] },
  );
  assert.match(lines[0], /^ {2}advisor\s+web ✓ {2}desktop ✓ {2}deep -$/u);
  assert.match(
    lines[1],
    /^ {2}session-rewind\s+web ✓ {2}desktop ✓ {2}deep 59 PASS \/ 3 SKIP \/ 0 FAIL$/u,
  );
});

test("汇总：deep 的 3 SKIP 按宿主 apply_patch 关闭的已知结论解释，不算失败", () => {
  const results = [
    {
      plugin: "session-rewind",
      webOk: true,
      desktopOk: true,
      deepOk: true,
      deepCounts: { pass: 59, skip: 3, fail: 0 },
    },
  ];
  const note = deepSkipNote(results);
  assert.match(note ?? "", /apply_patch/u);
  assert.match(note ?? "", /3 条 SKIP/u);
  assert.match(note ?? "", /不算失败/u);
  assert.equal(deepSkipNote([{ plugin: "advisor", webOk: true, desktopOk: true }]), null);
  assert.equal(deepSkipNote([]), null);
});

test("汇总：deep 判定复用 desktopGateVerdict；未跑不显示假绿", () => {
  assert.equal(
    desktopGateVerdict({ pass: 59, skip: 3, fail: 0 }),
    "ok",
    "3 SKIP 但有 59 PASS → ok",
  );
  assert.equal(desktopGateVerdict(undefined), "missing-counts");
  assert.equal(desktopGateVerdict({ pass: 0, skip: 3, fail: 0 }), "vacuous");

  const lines = summaryLines(
    [
      {
        plugin: "session-rewind",
        webOk: true,
        desktopOk: false,
        deepOk: false,
        detail: "桌面回归失败",
      },
    ],
    { desktopEnabled: true, deepEnabled: true, deepTargets: ["session-rewind"] },
  );
  assert.match(lines[0], /deep ✗（未跑）/u);
  assert.match(lines[0], /桌面回归失败/u);
});

test("failedResults：deep FAIL / deep 未跑都算失败，不能被 web+desktop 的绿盖住", () => {
  const ok = { plugin: "advisor", webOk: true, desktopOk: true };
  assert.deepEqual(failedResults([ok]), []);
  const deepFail = {
    plugin: "session-rewind",
    webOk: true,
    desktopOk: true,
    deepRan: true,
    deepOk: false,
    deepCounts: { pass: 59, skip: 3, fail: 1 },
  };
  const deepNotRun = { plugin: "session-rewind", webOk: true, desktopOk: false, deepOk: false };
  const targets = ["session-rewind"];
  assert.deepEqual(failedResults([ok, deepFail], targets), [deepFail], "deep FAIL 必须计入总失败");
  assert.deepEqual(
    failedResults([ok, deepNotRun], targets),
    [deepNotRun],
    "deep 未跑同样计入总失败",
  );
  const deepPass = {
    plugin: "session-rewind",
    webOk: true,
    desktopOk: true,
    deepRan: true,
    deepOk: true,
    deepCounts: { pass: 59, skip: 3, fail: 0 },
  };
  assert.deepEqual(failedResults([ok, deepPass], targets), [], "3 SKIP 的 deep 全绿不算失败");
  // 复审 N4 的 N mutation：白名单插件的 deep 根本没跑、却被误标成 deepOk=true ——
  // 总失败必须仍然抓到（否则「未跑」会悄无声息地变绿）。
  const mislabelled = { plugin: "session-rewind", webOk: true, desktopOk: true, deepOk: true };
  assert.deepEqual(
    failedResults([ok, mislabelled], targets),
    [mislabelled],
    "deepRan 缺失的白名单插件不能算绿",
  );
  assert.deepEqual(
    failedResults([ok, mislabelled], []),
    [],
    "没有 deep 目标时（deep 关闭）与旧行为等价",
  );
});

test("shouldRunDeep：web/桌面任一失败就不跑 deep（复审 N4 的 O mutation）", () => {
  assert.equal(shouldRunDeep({ webOk: true, desktopOk: true }), true);
  assert.equal(shouldRunDeep({ webOk: false, desktopOk: true }), false, "web 失败不再花模型额度");
  assert.equal(
    shouldRunDeep({ webOk: true, desktopOk: false }),
    false,
    "桌面只读失败不再花模型额度",
  );
  assert.equal(shouldRunDeep({ webOk: false, desktopOk: false }), false);
});

test("classifyDeepStage：与其它桌面阶段同一套判定（复审 N4 的 C/M/N mutation）", () => {
  // C：SKIP 本身绝不能判失败（59 PASS / 3 SKIP / 0 FAIL 是绿的）
  assert.deepEqual(classifyDeepStage({ code: 0, counts: { pass: 59, skip: 3, fail: 0 } }), {
    ok: true,
    verdict: "ok",
    detail: null,
  });
  // M/N：退出码 0 但没计数行 / 全 SKIP 都是假绿，必须判失败（不能因为退出码 0 就放行）
  const noCounts = classifyDeepStage({ code: 0, counts: undefined });
  assert.equal(noCounts.ok, false);
  assert.equal(noCounts.verdict, "missing-counts");
  assert.match(noCounts.detail ?? "", /missing-counts/u);
  const vacuous = classifyDeepStage({ code: 0, counts: { pass: 0, skip: 3, fail: 0 } });
  assert.equal(vacuous.ok, false);
  assert.equal(vacuous.verdict, "vacuous");
  // 退出码非 0：即使计数行看起来全绿也判失败
  const exitFail = classifyDeepStage({ code: 1, counts: { pass: 59, skip: 3, fail: 0 } });
  assert.equal(exitFail.ok, false);
  assert.match(exitFail.detail ?? "", /deep 桌面 e2e 失败/u);
});

test("汇总：deep「跑了但没计数行」显示『无计数行』，不再误报『未跑』（复审 N3）", () => {
  const lines = summaryLines(
    [
      // 跑了、退出码 0、但脚本没打印计数行 → detail 是「无计数行」，列文本必须一致
      { plugin: "session-rewind", webOk: true, desktopOk: true, deepRan: true, deepOk: false },
    ],
    { desktopEnabled: true, deepEnabled: true, deepTargets: ["session-rewind"] },
  );
  assert.match(lines[0], /deep ✗（无计数行）/u);
  assert.doesNotMatch(lines[0], /未跑/u);
  const notRun = summaryLines(
    [{ plugin: "session-rewind", webOk: true, desktopOk: false, deepOk: false }],
    { desktopEnabled: true, deepEnabled: true, deepTargets: ["session-rewind"] },
  );
  assert.match(notRun[0], /deep ✗（未跑）/u);
  assert.doesNotMatch(notRun[0], /无计数行/u);
});

// ---------------------------------------------------------------------------
// CLI 失败分支（真跑 argv 解析 + 只读检测；不启动 GUI）
// ---------------------------------------------------------------------------

test("CLI：--deep 缺 --workspace → 退出码 2 + 示例命令（默认行为不变）", () => {
  const run = runCli(["--deep"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--deep 需要 --workspace/u);
  assert.match(run.stderr, /register-test-workspace\.mjs/u);
});

test("CLI：--deep 与 --skip-desktop/--skip-deep 冲突 → 退出码 2", () => {
  const skipDesktop = runCli(["--deep", "--workspace", "/tmp/x", "--skip-desktop"]);
  assert.equal(skipDesktop.status, 2);
  assert.match(skipDesktop.stderr, /和 --skip-desktop 冲突/u);
  const skipDeep = runCli(["--deep", "--skip-deep", "--workspace", "/tmp/x"]);
  assert.equal(skipDeep.status, 2);
  assert.match(skipDeep.stderr, /互斥/u);
});

test("CLI：未注册工作区 → 打印可复制的注册命令并以 2 失败，不写盘", () => {
  const root = makeRoot("cli-unregistered");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  const homeReal = realpathSync(home);
  const workspaceReal = realpathSync(workspace);

  const run = runCli(["--deep", "--workspace", workspace], { DSH_HOME: home });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /工作区未注册/u);
  assert.match(
    run.stderr,
    new RegExp(
      `node scripts/register-test-workspace\\.mjs --home ${re(homeReal)} --path ${re(workspaceReal)}`,
      "u",
    ),
  );
  assert.doesNotMatch(run.stderr, /--allow-live/u);
  assert.equal(
    existsSync(join(homeReal, "storages", "workspace.json")),
    false,
    "门禁不许自动写 live/隔离 home 的注册表",
  );
});

test("CLI：默认 --dry-run 与旧行为一致（没有 deep 行/说明）", () => {
  const run = runCli(["--dry-run"], { DSH_HOME: join(tmpdir(), "dsh-gate-all-unused-home") });
  assert.equal(run.status, 0);
  assert.doesNotMatch(run.stdout, /--deep/u);
  assert.doesNotMatch(run.stdout, /deep 白名单/u);
  assert.match(run.stdout, /4\.8 pnpm smoke:session-rewind-desktop --require/u);
});

test("CLI：工作区已注册时 --deep --dry-run 只把 --deep 加给 session-rewind", () => {
  const root = makeRoot("cli-deep-plan");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  registerTestWorkspace({ home, path: workspace, envHome: root });
  const workspaceReal = realpathSync(workspace);

  const run = runCli(["--deep", "--workspace", workspace, "--dry-run"], { DSH_HOME: home });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /deep 工作区：.+（已注册/u);
  const desktopLines = run.stdout.split("\n").filter((line) => line.includes("-desktop --require"));
  assert.equal(desktopLines.length, 9, "8 条只读 + 1 条 deep");
  const deepLines = desktopLines.filter((line) => line.includes("--deep"));
  assert.equal(deepLines.length, 1, "deep 只传给白名单插件");
  assert.match(deepLines[0], /smoke:session-rewind-desktop/u);
  assert.match(deepLines[0], new RegExp(`--workspace ${re(workspaceReal)}`, "u"));
  assert.match(run.stdout, /next-step：桌面脚本支持 --deep，但/u);
  assert.match(run.stdout, /deep 白名单：session-rewind/u);
});
