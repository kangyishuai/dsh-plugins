#!/usr/bin/env node
// @ts-check
// 用法：pnpm gate:all [选项]
//
// 一条命令跑完八个发布插件的门禁（`pnpm gate <plugin>` 的批量版）：
//
//   1. pnpm verify            只跑一次（不再每个插件各跑一遍）
//   2. pnpm probe:runtime     只跑一次
//   3. 逐插件 web 冒烟         pnpm smoke:<plugin>（临时 DSH_HOME）
//   4. 逐插件桌面只读回归      pnpm smoke:<plugin>-desktop --require
//   5. 桌面 --deep（白名单）   pnpm smoke:<plugin>-desktop --require --deep --workspace <目录>
//
// 为什么需要它：手工连跑八条 `pnpm gate` 时，每一步桌面回归前都要先把可见会话切到
// **空闲会话**（advisor / next-step 的脚本在可见会话正跑回合时按设计拒绝交互，直接判红），
// 跑完还要切回——六次手工切换最容易漏一次。本脚本把这件事自动化：
//
//   --idle-session <标题>   每个桌面步骤前把可见会话切到侧栏里标题含该字符串的空闲会话，
//                           全部结束后切回开始时的会话。**强烈建议在 agent 会话里跑时带上**。
//
// 其他选项：
//   --plugins a,b           只跑指定插件（默认八个发布插件）
//   --skip-verify           跳过 verify（刚跑过时用；结束时大声提示门禁不完整）
//   --skip-desktop          跳过桌面端（只跑 verify/probe/web；同样提示不完整）
//   --deep                  加深**白名单插件**（当前只有 session-rewind）的桌面阶段：
//                           追加 `--deep --workspace <目录>` 跑文件模式 e2e。必须配 --workspace。
//   --workspace <dir>       deep 用的专用测试目录；必须已注册成桌面工作区、且在仓库外。
//                           本命令只做**只读检测**，绝不替你写宿主 `workspace.json`。
//   --skip-deep             显式关闭 deep（默认就是关）；与 --deep 同时给是用法错误（退出码 2），
//                           包装脚本要复用同一份参数时得自己二选一
//   --port 9222             桌面版 CDP 端口（默认 9222 / DSH_CDP_PORT）
//   --dry-run               只打印计划，不执行（带 --deep 时仍会只读校验工作区注册）
//
// 设计要点：
//   - deep 白名单是**显式**的（DEEP_GATE_PLUGINS），不扫脚本自动发现：next-step / btw 的桌面
//     脚本也支持 `--deep`，但副作用与前置不同（next-step 会真发模型请求并点胶囊；btw 不接
//     --workspace，还会写真实数据根 ~/.dsh/btw），必须人工 opt-in。其余插件不传 --deep，
//     并在计划里打印说明（区分「不支持 --deep」和「支持但没纳入白名单」）。
//   - 不自动写 live 数据根：--deep 缺 --workspace、或目录没注册成桌面工作区时，打印可整行
//     复制的 `register-test-workspace.mjs` 命令后**失败**，不替用户改宿主注册表（AGENTS.md
//     硬性约定 1/2）。
//   - 桌面阶段永远带 `--require`；并用 gate.mjs 的 desktopGateVerdict() 判「缺计数行 / 全 SKIP」
//     的假绿，与单插件门禁同一套标准。deep 阶段同样过这套判定，并按已知宿主结论解释 SKIP。
//   - web 冒烟逐条串行（它们都要打真实模型/起临时宿主），失败也继续跑完其余插件，
//     最后给总表——一次操作看到全部结论，而不是「第一条就停，剩下的不知道」。
//   - 退出码：任一插件门禁失败即 1；参数/前置错误 2（与单插件 gate 一致）。
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { desktopGateVerdict, gateVerdict, parseCounts } from "./gate.mjs";
import { isMain } from "./lib/repo.mjs";
import {
  canonicalPath,
  findWorkspaceByPath,
  isLiveHome,
  normalizeWorkspacePath,
  readWorkspaceStore,
} from "./lib/workspace-register.mjs";

const REPO = resolve(import.meta.dirname, "..");
/**
 * 默认跑全部八个已发布插件（AUD-XCT-04：旧清单漏了 artifacts / projects，
 * 与 AGENTS.md「八个发布插件」不符；两插件的 web/桌面脚本早已存在，`pnpm check` 也在拦）。
 * 顺序按目录名字母序，便于和 `packages/` 对照。
 */
export const RELEASE_PLUGINS = [
  "advisor",
  "artifacts",
  "btw",
  "casefile",
  "next-step",
  "projects",
  "session-delete",
  "session-rewind",
];
/**
 * 支持桌面 `--deep` 且**已人工纳入 `gate:all --deep`** 的插件白名单。
 *
 * 为什么是显式白名单、不去扫 `scripts/smoke-<plugin>-desktop.mjs` 里有没有 `deep` 选项：
 * 目前 `next-step` / `btw` 的桌面脚本**也支持** `--deep`，但它们的副作用与前置和 session-rewind
 * 不同——next-step 会建会话、发真实模型请求并点胶囊发消息（破坏性播种）；btw 不接 `--workspace`，
 * 还会写真实数据根 `~/.dsh/btw`。自动发现会在没人确认的情况下把这类流程加进一条「批量门禁」，
 * 所以新插件必须**显式**加进这里，并单独补前置、额度与测试。
 * @type {readonly string[]}
 */
export const DEEP_GATE_PLUGINS = Object.freeze(["session-rewind"]);

/**
 * 桌面脚本支持 `--deep`、但**故意没纳入** `gate:all --deep` 的插件 → 单独跑的说明。
 * 用它区分「脚本没有 --deep」和「有 --deep 但没进批量门禁」，别把原因写错。
 * @type {Readonly<Record<string, string>>}
 */
export const DEEP_MANUAL_ONLY = Object.freeze({
  "next-step":
    "桌面脚本支持 --deep，但会真建会话/发模型请求并点胶囊（破坏性播种），没纳入批量门禁；" +
    "需要时单独跑 pnpm gate next-step --deep --workspace <目录>",
  btw:
    "桌面脚本支持 --deep，但不接 --workspace，且会写真实数据根 ~/.dsh/btw，没纳入批量门禁；" +
    "需要时单独跑 pnpm gate btw --deep",
});

/** `--repeat` 的取值范围（深链只跑一次，不随它重复）。 */
const MIN_REPEAT = 1;
const MAX_REPEAT = 3;

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 参数/前置用法错误（退出码 2）：与「门禁跑红」（退出码 1）区分开。
 */
export class GateAllUsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GateAllUsageError";
  }
}

/**
 * 解析 `pnpm gate:all` 的参数（纯函数，便于单测）。
 * 不合法时抛 {@link GateAllUsageError}，由调用方打印并按退出码 2 结束。
 * @param {string[]} argv
 * @returns {{
 *   plugins: string[],
 *   skipVerify: boolean,
 *   skipDesktop: boolean,
 *   idleTitle: string | null,
 *   repeat: number,
 *   port: number,
 *   dryRun: boolean,
 *   deep: boolean,
 *   skipDeep: boolean,
 *   workspace: string | null,
 * }}
 */
export function parseGateAllOptions(argv) {
  const parsed = (() => {
    try {
      // 内联 options 让 parseArgs 的泛型推导出每个选项的类型（提到变量上会退化成联合类型）。
      return parseArgs({
        args: argv,
        options: {
          plugins: { type: "string" },
          "skip-verify": { type: "boolean", default: false },
          "skip-desktop": { type: "boolean", default: false },
          deep: { type: "boolean", default: false },
          "skip-deep": { type: "boolean", default: false },
          workspace: { type: "string" },
          "idle-session": { type: "string" },
          repeat: { type: "string" },
          port: { type: "string" },
          "dry-run": { type: "boolean", default: false },
        },
        allowPositionals: false,
      });
    } catch (error) {
      throw new GateAllUsageError(
        `参数不合法：${error instanceof Error ? error.message : String(error)}（用法见 scripts/gate-all.mjs 头部注释）`,
      );
    }
  })();
  const values = parsed.values;
  const repeat = Number(values.repeat ?? "1");
  if (!Number.isInteger(repeat) || repeat < MIN_REPEAT || repeat > MAX_REPEAT) {
    throw new GateAllUsageError(
      `--repeat 只接受 ${MIN_REPEAT}–${MAX_REPEAT} 的整数（默认 1；幂等自检用 2）`,
    );
  }
  const rawWorkspace = typeof values.workspace === "string" ? values.workspace.trim() : "";
  return {
    plugins: normalizePlugins(typeof values.plugins === "string" ? values.plugins : undefined),
    skipVerify: values["skip-verify"] === true,
    skipDesktop: values["skip-desktop"] === true,
    idleTitle: typeof values["idle-session"] === "string" ? values["idle-session"] : null,
    repeat,
    port: Number(values.port ?? process.env.DSH_CDP_PORT ?? 9222),
    dryRun: values["dry-run"] === true,
    deep: values.deep === true,
    skipDeep: values["skip-deep"] === true,
    workspace: rawWorkspace === "" ? null : rawWorkspace,
  };
}

/**
 * 解析 DSH 数据根（桌面 `workspace.json` 所在目录）：`DSH_HOME` 优先，否则 `~/.dsh`。
 * 只用于**只读**检测与打印可复制命令；测试可注入。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [userHome]
 * @returns {string}
 */
export function resolveDshHome(env = process.env, userHome = homedir()) {
  const raw = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return resolve(raw === "" ? join(userHome, ".dsh") : raw);
}

/**
 * shell 参数按需加单引号（路径带空格/特殊字符时整条命令仍可复制执行）。
 * 只处理常见的「整段单引号包裹 + 转义内部单引号」，不做完整 shell 解析。
 * @param {string} value
 * @returns {string}
 */
export function quoteShellArg(value) {
  if (/^[0-9A-Z_a-z./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 「工作区未注册」时打印的**可整行复制**的注册命令（本门禁只打印、不执行）。
 * @param {{ home: string, workspaceReal: string, allowLive: boolean }} options
 * @returns {string}
 */
export function registrationHint({ home, workspaceReal, allowLive }) {
  const command = [
    "node",
    "scripts/register-test-workspace.mjs",
    "--home",
    quoteShellArg(home),
    "--path",
    quoteShellArg(workspaceReal),
    ...(allowLive ? ["--allow-live"] : []),
  ].join(" ");
  /** @type {string[]} */
  const lines = [
    "  先把这个目录注册成桌面工作区（一次性；本命令只做只读检测，不会替你写宿主注册表）：",
    `    ${command}`,
  ];
  if (allowLive) {
    lines.push(
      "  # 真实桌面版（数据根 ~/.dsh）：先退出桌面版 → 注册 → 再启动（运行中注册可能被宿主内存态写回）",
    );
  } else {
    lines.push("  # 隔离实例：注册后重启该实例，让它重新读取 storages/workspace.json");
  }
  lines.push("  # 也可以走桌面 UI：「工作区 → 添加工作区」选一次该目录");
  return lines.join("\n");
}

/**
 * 只读检查 `--workspace` 能否作为 deep 前置：目录存在、在仓库外、且已注册成桌面工作区。
 * **不建目录、不写 `workspace.json`、不备份**——缺什么就返回 hint 让用户自己执行。
 * @param {{ workspace: string, home: string, repoRoot?: string }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   workspaceReal: string | null,
 *   home: string,
 *   storeFile: string,
 *   detail: string,
 *   hint: string | null,
 * }>}
 */
export async function checkWorkspaceRegistration({ workspace, home, repoRoot = REPO }) {
  const homeReal = canonicalPath(home);
  const storeFile = join(homeReal, "storages", "workspace.json");
  /** @type {string | null} */
  let workspaceReal = null;
  try {
    workspaceReal = normalizeWorkspacePath(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      workspaceReal: null,
      home: homeReal,
      storeFile,
      detail: `--workspace 不可用：${message}`,
      hint: [
        "  先建出目录，再注册成桌面工作区（本命令不会替你建/写）：",
        `    mkdir -p ${quoteShellArg(resolve(workspace))}`,
        registrationHint({
          home: homeReal,
          workspaceReal: resolve(workspace),
          allowLive: isLiveHome(homeReal),
        }),
      ].join("\n"),
    };
  }

  // 仓库内的目录不能用：deep 会话没绑对工作区时，模型的 write 会落到仓库 cwd（§6.1 硬约定）。
  // 这里**不给**注册命令：把仓库内目录注册成桌面工作区也不会通过——冒烟脚本自己也拒绝仓库内
  // workspace，打印一条注定失败的注册命令只会误导（复审 N1）。
  const repoReal = canonicalPath(repoRoot);
  if (workspaceReal === repoReal || workspaceReal.startsWith(`${repoReal}${sep}`)) {
    return {
      ok: false,
      workspaceReal,
      home: homeReal,
      storeFile,
      detail:
        `--workspace 位于本仓库内（${workspaceReal}）：deep 的写文件断言会污染仓库。` +
        "换一个仓库外的专用目录（例如 ~/Workspace/dsh-rewind-ui-smoke）后重跑；" +
        "把仓库内目录注册成工作区也没用（冒烟脚本同样拒绝仓库内 workspace），所以这里不打印注册命令",
      hint: null,
    };
  }

  try {
    const info = await stat(homeReal);
    if (!info.isDirectory()) throw new Error("不是目录");
  } catch {
    return {
      ok: false,
      workspaceReal,
      home: homeReal,
      storeFile,
      detail: `DSH 数据根不存在：${homeReal}（先启动一次桌面版，或用 DSH_HOME 指向隔离实例的数据根）`,
      // helper 要求 --home 已存在：先给 mkdir，再给注册命令，保证两行都能直接复制执行（复审 N6）。
      hint: [
        "  先把数据根建出来（隔离实例；live 桌面版直接启动一次即可）：",
        `    mkdir -p ${quoteShellArg(homeReal)}`,
        registrationHint({ home: homeReal, workspaceReal, allowLive: isLiveHome(homeReal) }),
      ].join("\n"),
    };
  }

  /** @type {boolean} */
  let registered;
  try {
    const store = readWorkspaceStore(storeFile);
    registered = findWorkspaceByPath(store, workspaceReal) !== undefined;
  } catch (error) {
    return {
      ok: false,
      workspaceReal,
      home: homeReal,
      storeFile,
      detail: `读不了 ${storeFile}：${error instanceof Error ? error.message : String(error)}`,
      hint: "  门禁不改写宿主注册表：先修好这个文件，或用桌面 UI「工作区 → 添加工作区」注册。",
    };
  }
  if (registered) {
    return { ok: true, workspaceReal, home: homeReal, storeFile, detail: "", hint: null };
  }
  return {
    ok: false,
    workspaceReal,
    home: homeReal,
    storeFile,
    detail: `工作区未注册：${workspaceReal} 不在 ${storeFile} 里（桌面侧栏里没有它）`,
    hint: registrationHint({ home: homeReal, workspaceReal, allowLive: isLiveHome(homeReal) }),
  };
}

/**
 * 规划 deep 阶段（纯函数）：哪些插件追加 `--deep --workspace`，其余插件为什么没传。
 * @param {{
 *   plugins: string[],
 *   deep: boolean,
 *   skipDeep: boolean,
 *   skipDesktop: boolean,
 *   workspace: string | null,
 * }} options
 * @returns {{
 *   enabled: boolean,
 *   targets: string[],
 *   workspace: string | null,
 *   notes: string[],
 *   error: string | null,
 * }}
 */
export function planDeep({ plugins, deep, skipDeep, skipDesktop, workspace }) {
  /** @type {string[]} */
  const notes = [];
  if (skipDeep && deep) {
    return {
      enabled: false,
      targets: [],
      workspace: null,
      notes,
      error: "--deep 与 --skip-deep 互斥：一个要求加深桌面阶段，一个要求关掉它，只能二选一",
    };
  }
  if (!deep) {
    if (workspace !== null) {
      notes.push("本次没带 --deep，--workspace 被忽略（只有 deep 阶段需要工作区）");
    }
    return { enabled: false, targets: [], workspace: null, notes, error: null };
  }
  if (skipDesktop) {
    return {
      enabled: false,
      targets: [],
      workspace: null,
      notes,
      error: "--deep 是桌面阶段的加深，和 --skip-desktop 冲突；要么去掉 --deep，要么别跳过桌面端",
    };
  }
  if (workspace === null) {
    return {
      enabled: false,
      targets: [],
      workspace: null,
      notes,
      error: [
        "--deep 需要 --workspace <专用测试目录>（该目录必须已注册成桌面工作区，且在仓库外）",
        "本命令不会替你注册/写宿主数据根。先建目录并注册（一次性）：",
        "  mkdir -p ~/Workspace/dsh-rewind-ui-smoke",
        "  node scripts/register-test-workspace.mjs --home ~/.dsh --path ~/Workspace/dsh-rewind-ui-smoke --allow-live",
        "然后：",
        "  pnpm gate:all --deep --workspace ~/Workspace/dsh-rewind-ui-smoke --idle-session <空闲会话标题>",
        "隔离实例（推荐）：把 --home 换成该实例的 DSH_HOME、并去掉 --allow-live。",
      ].join("\n"),
    };
  }
  const targets = plugins.filter((plugin) => DEEP_GATE_PLUGINS.includes(plugin));
  if (targets.length === 0) {
    return {
      enabled: false,
      targets,
      workspace: null,
      notes,
      error: [
        `所选插件（${plugins.join(", ")}）都不在 deep 白名单里，--deep 无处可加`,
        `  纳入批量 deep 的插件：${DEEP_GATE_PLUGINS.join(", ")}`,
        `  支持 --deep 但需单独跑：${Object.keys(DEEP_MANUAL_ONLY).join(", ")}（见 pnpm gate <plugin> --deep）`,
      ].join("\n"),
    };
  }
  for (const plugin of plugins) {
    if (targets.includes(plugin)) continue;
    const manual = DEEP_MANUAL_ONLY[plugin];
    notes.push(
      manual === undefined
        ? `${plugin}：桌面脚本没有 --deep，桌面阶段仍按只读跑（不传 --deep）`
        : `${plugin}：${manual}`,
    );
  }
  return { enabled: true, targets, workspace, notes, error: null };
}

/**
 * 把计数格式化成冒烟脚本的收尾行格式；解析不到计数行时返回「无计数行」。
 * @param {{ pass: number, skip: number, fail: number } | undefined} counts
 * @returns {string}
 */
export function formatCounts(counts) {
  return counts === undefined
    ? "无计数行"
    : `${counts.pass} PASS / ${counts.skip} SKIP / ${counts.fail} FAIL`;
}

/**
 * 汇总表里 deep 阶段那一列的文本（含 PASS/SKIP/FAIL 计数）。
 *
 * 「未跑」与「跑了但没有计数行」必须分开（复审 N3）：前者是 web/桌面只读已失败、脚本根本没跑；
 * 后者是 deep 脚本跑了但没打印 `N PASS / M SKIP / K FAIL`（判红原因不同，排障路径也不同）。
 * @param {PluginResult} result
 * @param {string[]} deepTargets
 * @returns {string}
 */
function deepColumn(result, deepTargets) {
  if (!deepTargets.includes(result.plugin)) return "deep -";
  if (result.deepCounts !== undefined) {
    return `deep ${formatCounts(result.deepCounts)}${result.deepOk === false ? " ✗" : ""}`;
  }
  if (result.deepRan === true) return "deep ✗（无计数行）";
  return "deep ✗（未跑）";
}

/**
 * 汇总表行（表头在各调用处打印）。
 * @param {PluginResult[]} results
 * @param {{ desktopEnabled: boolean, deepEnabled: boolean, deepTargets: string[] }} options
 * @returns {string[]}
 */
export function summaryLines(results, { desktopEnabled, deepEnabled, deepTargets }) {
  return results.map((result) => {
    const web = result.webOk ? "web ✓" : "web ✗";
    const desktop = !desktopEnabled ? "desktop -" : result.desktopOk ? "desktop ✓" : "desktop ✗";
    const deep = deepEnabled ? `  ${deepColumn(result, deepTargets)}` : "";
    const detail = result.detail === undefined ? "" : `  ${result.detail}`;
    return `  ${result.plugin.padEnd(16)} ${web}  ${desktop}${deep}${detail}`;
  });
}

/**
 * deep 阶段是否该跑：web 与桌面只读都过了才跑（省真实模型额度）。
 * web/桌面任一失败时 deep 按「未跑」计入总失败，不能显示成绿（复审 N4 的 O mutation 锁在这里）。
 * @param {{ webOk: boolean, desktopOk: boolean }} result
 * @returns {boolean}
 */
export function shouldRunDeep(result) {
  return result.webOk && result.desktopOk;
}

/**
 * deep 阶段结果判定（纯函数；与 web / 桌面只读阶段**同一套**语义，复审 N4：
 * 把主循环里「SKIP>0 判失败 / 缺计数行判绿 / 未跑判绿」这几类 mutation 变成可执行单测）。
 *
 * - 退出码非 0 → 失败（脚本自己判红，哪怕计数行看着全绿）；
 * - 退出码 0 但判定不是 `ok` → 失败：`missing-counts`（没打印计数行）与 `vacuous`（0 PASS / 0 FAIL）
 *   都是假绿，不能放行；
 * - 只有 `desktopGateVerdict() === "ok"` 才放行。**SKIP 本身不判红**：3 条 apply_patch SKIP 是
 *   已知宿主环境分支（`59 PASS / 3 SKIP / 0 FAIL` 是绿的），与其它桌面阶段口径一致。
 * @param {{ code: number, counts: { pass: number, skip: number, fail: number } | undefined }} stage
 * @returns {{
 *   ok: boolean,
 *   verdict: "ok" | "missing-counts" | "vacuous",
 *   detail: string | null,
 * }}
 */
export function classifyDeepStage({ code, counts }) {
  const verdict = desktopGateVerdict(counts);
  const countsText = formatCounts(counts);
  if (code !== 0) {
    return { ok: false, verdict, detail: `deep 桌面 e2e 失败（${countsText}）` };
  }
  if (verdict !== "ok") {
    return {
      ok: false,
      verdict,
      detail: `deep 桌面 e2e 判定失败（${verdict}，${countsText}）`,
    };
  }
  return { ok: true, verdict, detail: null };
}

/**
 * deep 阶段 SKIP 的解释：宿主关闭 `apply_patch` 是已知环境事实，不是失败。
 * 没有 deep 结果或没有 SKIP 时返回 null（不打印噪音）。
 * 注意措辞只保证「这几条 SKIP 不算失败」，其它 FAIL 仍按 `failedResults()` 照计（复审 N7）。
 * @param {PluginResult[]} results
 * @returns {string | null}
 */
export function deepSkipNote(results) {
  const skipped = results.filter(
    (result) => result.deepCounts !== undefined && result.deepCounts.skip > 0,
  );
  if (skipped.length === 0) return null;
  const total = skipped.reduce((sum, result) => sum + (result.deepCounts?.skip ?? 0), 0);
  return (
    `提示：deep 阶段共 ${total} 条 SKIP，来自宿主关闭 apply_patch 的已知环境分支` +
    "（2026-11-28 单插件校准为 59 PASS / 3 SKIP / 0 FAIL）；" +
    "**这几条 SKIP 本身不算失败**（其它 FAIL 照计），宿主开启 apply_patch 后会变成 PASS。"
  );
}

/**
 * 哪些插件门禁算失败：web / 桌面只读 / deep 任一失败都算。
 *
 * deep 的口径（复审 N4）：`deepOk === false`（FAIL 或前置阶段失败而跳过）算失败；
 * 另外，**白名单插件的 deep 阶段没真的跑过**（`deepRan !== true`）也算失败——这样即使有人
 * 把「未跑」误标成 `deepOk = true`，总退出码仍然判红（锁住「未跑不能算绿」）。
 * @param {PluginResult[]} results
 * @param {string[]} [deepTargets] deep 白名单（默认空：没有 deep 时与旧行为等价）
 * @returns {PluginResult[]}
 */
export function failedResults(results, deepTargets = []) {
  return results.filter(
    (result) =>
      !result.webOk ||
      !result.desktopOk ||
      result.deepOk === false ||
      (deepTargets.includes(result.plugin) && result.deepRan !== true),
  );
}

/**
 * 解析 `--plugins a,b`：逗号分隔、去空白、去空项与重复；缺省返回六个发布插件。
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function normalizePlugins(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [...RELEASE_PLUGINS];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const plugins = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    plugins.push(name);
  }
  return plugins;
}

/**
 * 所选插件缺哪些冒烟脚本（`--skip-desktop` 时不检查桌面脚本）。
 * @param {string[]} plugins
 * @param {Record<string, string>} scripts
 * @param {boolean} skipDesktop
 * @returns {string[]}
 */
export function missingScripts(plugins, scripts, skipDesktop) {
  /** @type {string[]} */
  const missing = [];
  for (const plugin of plugins) {
    if (typeof scripts[`smoke:${plugin}`] !== "string") missing.push(`smoke:${plugin}`);
    if (!skipDesktop && typeof scripts[`smoke:${plugin}-desktop`] !== "string") {
      missing.push(`smoke:${plugin}-desktop`);
    }
  }
  return missing;
}

/**
 * 比较两次计数的 PASS/SKIP/FAIL。数据相关 SKIP 漂移允许（只提示），但 FAIL 变化要看得见。
 * @param {{ pass: number, skip: number, fail: number }} first
 * @param {{ pass: number, skip: number, fail: number }} next
 * @returns {string | null} 有漂移时返回 `first → next` 描述，完全一致返回 null
 */
export function compareCounts(first, next) {
  if (first.pass === next.pass && first.skip === next.skip && first.fail === next.fail) return null;
  return `${first.pass}/${first.skip}/${first.fail} → ${next.pass}/${next.skip}/${next.fail}`;
}

/**
 * 生成 dry-run / 日志用的执行计划（纯文本行；不执行任何命令）。
 * @param {{
 *   plugins: string[],
 *   skipVerify: boolean,
 *   skipDesktop: boolean,
 *   idleTitle: string | null,
 *   repeat: number,
 *   deep?: boolean,
 *   deepTargets?: string[],
 *   workspace?: string | null,
 * }} options
 * @returns {string[]}
 */
export function buildPlan(options) {
  const {
    plugins,
    skipVerify,
    skipDesktop,
    idleTitle,
    repeat,
    deep = false,
    deepTargets = [],
    workspace = null,
  } = options;
  /** @type {string[]} */
  const plan = [
    skipVerify ? "- verify（已按 --skip-verify 跳过）" : "1. pnpm verify",
    "2. pnpm probe:runtime",
    ...plugins.map((plugin, index) => `3.${index + 1} pnpm smoke:${plugin}`),
  ];
  if (skipDesktop) {
    plan.push("- 桌面端（已按 --skip-desktop 跳过）");
  } else {
    for (const [index, plugin] of plugins.entries()) {
      plan.push(
        `4.${index + 1} pnpm smoke:${plugin}-desktop --require${repeat > 1 ? `（连跑 ${repeat} 次）` : ""}`,
      );
      if (deep && deepTargets.includes(plugin)) {
        plan.push(
          `4.${index + 1}-deep pnpm smoke:${plugin}-desktop --require --deep --workspace ${workspace ?? "<目录>"}` +
            (repeat > 1 ? "（deep 只跑一次，不随 --repeat 重复）" : ""),
        );
      }
    }
    if (idleTitle !== null) {
      plan.push(`   桌面步骤前切到空闲会话「${idleTitle}」，结束后切回`);
    }
  }
  return plan;
}

/**
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

/** @param {number} port */
async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((/** @type {any} */ item) => item.type === "page");
  if (!page) throw new Error(`no page target on 127.0.0.1:${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    ws.onopen = resolveOpen;
    ws.onerror = reject;
  });
  let seq = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  ws.onmessage = (/** @type {any} */ event) => {
    const msg = JSON.parse(String(event.data));
    const record = msg.id === undefined ? undefined : pending.get(msg.id);
    if (record === undefined) return;
    pending.delete(msg.id);
    if (msg.error) {
      record.reject(new Error(JSON.stringify(msg.error)));
      return;
    }
    // Runtime.evaluate 的协议返回是 { result: { type, value } }；返回整个信封会让
    // `typeof id === "string"` 之类的判断永远失败（2026-11-20 实测：切换/恢复全部静默失效）。
    const evaluated = msg.result;
    if (evaluated?.exceptionDetails !== undefined) {
      record.resolve(undefined);
      return;
    }
    record.resolve(evaluated?.result?.value);
  };
  /**
   * @param {string} expression
   * @returns {Promise<any>}
   */
  const evaluate = (expression) =>
    new Promise((resolveCall) => {
      const id = ++seq;
      pending.set(id, { resolve: resolveCall, reject: () => resolveCall(undefined) });
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  return { ws, evaluate };
}

/** @typedef {Awaited<ReturnType<typeof connect>>} Cdp */

/**
 * 侧栏里的会话行可能被收起的「工作区」分组或「展开其余 N 个会话」遮住：先展开再找。
 * @param {Cdp} cdp
 */
const revealSidebarGroups = (cdp) =>
  cdp.evaluate(`(() => {
    let clicked = 0;
    for (const row of document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]')) {
      row.click(); clicked += 1;
    }
    for (const btn of document.querySelectorAll('[data-row-key^="overflow:"][aria-expanded="false"]')) {
      btn.click(); clicked += 1;
    }
    return clicked;
  })()`);

/**
 * @param {Cdp} cdp
 * @returns {Promise<string | null>}
 */
const currentSession = async (cdp) => {
  const id = await cdp.evaluate(
    `(() => { const root = document.querySelector('[data-conversation-session]'); return root ? root.getAttribute('data-conversation-session') : null; })()`,
  );
  return typeof id === "string" && id !== "" ? id : null;
};

/**
 * 等到「会话视图」就绪：读到 `data-conversation-session` 才算，最多 20s。
 *
 * **不要在这里替用户点侧栏行**（2026-11-20 实测踩坑）：应用切换会话时会短暂没有这个属性，
 * 若此时去点「第一行会话」，会和用户/上一步的切换抢导航，最后停在一个**随机会话**上，
 * 既记错原会话、又会让后面的空闲会话查找扑空。这里只等待；真的停在插件页/设置页时由调用者
 * 得到 null 并报一条可操作的错误（`--skip-desktop` 可只跑 web 部分）。
 * @param {Cdp} cdp
 * @returns {Promise<string | null>}
 */
const ensureConversation = async (cdp) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const id = await currentSession(cdp).catch(() => null);
    if (id !== null) return id;
    await sleep(500);
  }
  return null;
};

/**
 * 切到标题含 `title` 的会话；点完要**回读 `data-conversation-session` 确认真的切过去了**
 * （行可能被遮挡、点击不生效；2026-11-20 实测「恢复原会话」就栽在只看 click 返回值）。
 * 找不到 / 没切过去就展开分组重试，最多 12s。
 * @param {Cdp} cdp @param {string} title
 */
const switchToTitle = async (cdp, title) => {
  if ((await ensureConversation(cdp)) === null) return false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const targetId = await cdp.evaluate(
      `(() => {
        const row = [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => (r.innerText || '').includes(${JSON.stringify(title)}));
        if (!row) return null;
        row.scrollIntoView({ block: 'center' });
        row.click();
        return (row.getAttribute('data-row-key') || '').replace('session:', '');
      })()`,
    );
    if (typeof targetId === "string" && targetId !== "") {
      await sleep(1200);
      if ((await currentSession(cdp)) === targetId) return true;
    }
    await revealSidebarGroups(cdp).catch(() => 0);
    await sleep(600);
  }
  return false;
};

/**
 * 切回指定会话 id。
 * @param {Cdp} cdp @param {string} id
 */
const switchToId = async (cdp, id) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(
      `(() => {
        const row = document.querySelector('[data-row-key="session:' + ${JSON.stringify(id)} + '"]');
        if (!row) return false;
        row.scrollIntoView({ block: 'center' });
        row.click();
        return true;
      })()`,
    );
    if (found === true) {
      await sleep(1200);
      if ((await currentSession(cdp)) === id) return true;
    }
    await revealSidebarGroups(cdp).catch(() => 0);
    await sleep(600);
  }
  return false;
};

/**
 * @typedef {object} PluginResult
 * @property {string} plugin
 * @property {boolean} webOk
 * @property {boolean} desktopOk
 * @property {{ pass: number, skip: number, fail: number }} [webCounts]
 * @property {{ pass: number, skip: number, fail: number }} [desktopCounts]
 * @property {{ pass: number, skip: number, fail: number }} [deepCounts] deep 阶段计数（只有白名单插件有）
 * @property {boolean} [deepRan] deep 阶段是否真的跑过（区分「未跑」与「跑了但没计数行」，复审 N3）
 * @property {boolean} [deepOk] deep 阶段结果；未跑时 undefined
 * @property {string} [detail]
 */

const main = async () => {
  /** @type {ReturnType<typeof parseGateAllOptions>} */
  let options;
  try {
    options = parseGateAllOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof GateAllUsageError) {
      console.error(`FAIL ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const { plugins, port, idleTitle, repeat } = options;

  const scripts = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")).scripts ?? {};
  const missing = missingScripts(plugins, scripts, options.skipDesktop);
  if (missing.length > 0) {
    console.error(`FAIL 这些脚本缺失：${missing.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const deepPlan = planDeep({
    plugins,
    deep: options.deep,
    skipDeep: options.skipDeep,
    skipDesktop: options.skipDesktop,
    workspace: options.workspace,
  });
  if (deepPlan.error !== null) {
    console.error(`FAIL ${deepPlan.error}`);
    process.exitCode = 2;
    return;
  }
  // deep 的工作区前置只做只读检测：未注册时打印可复制的注册命令后失败，绝不替用户写宿主数据根。
  if (deepPlan.enabled && deepPlan.workspace !== null) {
    const registration = await checkWorkspaceRegistration({
      workspace: deepPlan.workspace,
      home: resolveDshHome(),
    });
    if (!registration.ok) {
      console.error(`FAIL --deep 的前置不满足：${registration.detail}`);
      if (registration.hint !== null) console.error(registration.hint);
      process.exitCode = 2;
      return;
    }
    deepPlan.workspace = registration.workspaceReal;
    console.log(`deep 工作区：${registration.workspaceReal}（已注册；${registration.storeFile}）`);
  }

  const plan = buildPlan({
    plugins,
    skipVerify: options.skipVerify,
    skipDesktop: options.skipDesktop,
    idleTitle,
    repeat,
    deep: deepPlan.enabled,
    deepTargets: deepPlan.targets,
    workspace: deepPlan.workspace,
  });
  console.log(`gate:all 计划：${plugins.length} 个插件（${plugins.join(", ")}）`);
  for (const line of plan) console.log(`  ${line}`);
  for (const note of deepPlan.notes) console.log(`  ${note}`);
  if (deepPlan.enabled) {
    console.log(
      `deep 白名单：${deepPlan.targets.join(", ")}（其余插件不传 --deep，逐条说明见上）；` +
        "deep 阶段只跑一次，不随 --repeat 重复。",
    );
  }
  if (options.dryRun) return;
  if (options.skipVerify || options.skipDesktop) {
    console.log("注意：带了 --skip-verify / --skip-desktop，门禁不完整。");
  }

  const started = Date.now();
  if (!options.skipVerify) {
    console.log("\n▶ [1] pnpm verify");
    const verify = await run(["verify"]);
    if (verify.code !== 0) {
      console.error("\nFAIL 门禁中止：pnpm verify 失败");
      process.exitCode = 1;
      return;
    }
    console.log("✓ pnpm verify");
  }
  console.log("\n▶ [2] pnpm probe:runtime");
  const probe = await run(["probe:runtime"]);
  if (probe.code !== 0) {
    console.error("\nFAIL 门禁中止：pnpm probe:runtime 失败");
    process.exitCode = 1;
    return;
  }
  console.log("✓ pnpm probe:runtime");

  /** @type {PluginResult[]} */
  const results = [];
  let cdp;
  /** @type {string | null} */
  let originalSession = null;
  const desktopEnabled = !options.skipDesktop;
  if (desktopEnabled && idleTitle !== null) {
    try {
      cdp = await connect(port);
      originalSession = await ensureConversation(cdp);
      if (originalSession === null) {
        console.error("FAIL 桌面版不在会话视图（可能停在插件页 / 设置页，或还在渲染）");
        console.error("      先点回任一会话再跑；只想跑 web 部分可加 --skip-desktop。");
        cdp.ws.close();
        process.exitCode = 1;
        return;
      }
      console.log(`可见会话：session:${originalSession}`);
      const switched = await switchToTitle(cdp, idleTitle);
      if (!switched) {
        console.warn(`WARN 侧栏里没找到标题含「${idleTitle}」的会话；桌面步骤将按当前会话跑`);
      }
    } catch (error) {
      console.error(
        `FAIL 连不上桌面版 CDP（127.0.0.1:${port}）：${error instanceof Error ? error.message : String(error)}`,
      );
      console.error('提示：open -a "DeepSeek Harness" --args --remote-debugging-port=9222');
      process.exitCode = 1;
      return;
    }
  }

  let index = 0;
  for (const plugin of plugins) {
    index += 1;
    console.log(`\n▶ [3.${index}] pnpm smoke:${plugin}`);
    const web = await run([`smoke:${plugin}`]);
    const webOk = web.code === 0;
    const webCounts = parseCounts(web.output);
    const webVerdict = gateVerdict(webCounts);
    const webCountsText =
      webCounts === undefined
        ? "无计数行"
        : `${webCounts.pass} PASS / ${webCounts.skip} SKIP / ${webCounts.fail} FAIL`;
    /** @type {PluginResult} */
    const result = { plugin, webOk, desktopOk: true };
    if (webCounts !== undefined) result.webCounts = webCounts;
    if (!webOk) {
      console.error(`FAIL web 冒烟失败：${plugin}（继续跑其余插件）`);
      result.detail = "web 冒烟失败";
    } else if (webVerdict !== "ok") {
      // 与桌面同一套标准：web 冒烟不打印计数行、或一条断言都没跑（全 SKIP）都算假绿。
      console.error(
        `FAIL web 冒烟判定：${plugin} → ${webVerdict === "missing-counts" ? "脚本没打印计数行" : "全 SKIP/零断言"}（${webCountsText}）`,
      );
      result.webOk = false;
      result.detail = `web 冒烟判定失败（${webVerdict}，${webCountsText}）`;
    } else {
      console.log(`✓ web 冒烟：${plugin}（${webCountsText}）`);
    }

    if (desktopEnabled) {
      if (cdp !== undefined && idleTitle !== null) {
        await switchToTitle(cdp, idleTitle).catch(() => false);
      }
      /** @type {{ pass: number, skip: number, fail: number } | undefined} */
      let firstCounts;
      for (let runIndex = 1; runIndex <= repeat; runIndex += 1) {
        const suffix = repeat > 1 ? `（第 ${runIndex}/${repeat} 次）` : "";
        console.log(`\n▶ [4.${index}] pnpm smoke:${plugin}-desktop --require${suffix}`);
        const desktop = await run([`smoke:${plugin}-desktop`, "--require"]);
        const counts = parseCounts(desktop.output);
        const verdict = desktopGateVerdict(counts);
        const countsText =
          counts === undefined
            ? "无计数行"
            : `${counts.pass} PASS / ${counts.skip} SKIP / ${counts.fail} FAIL`;
        if (desktop.code !== 0) {
          console.error(`FAIL 桌面回归失败：${plugin}${suffix}（${countsText}）`);
          result.desktopOk = false;
          result.detail = `桌面回归失败（${countsText}）`;
          break;
        }
        if (verdict !== "ok") {
          console.error(
            `FAIL 桌面回归判定：${plugin}${suffix} → ${verdict === "missing-counts" ? "脚本没打印计数行" : "全 SKIP/零断言"}（${countsText}）`,
          );
          result.desktopOk = false;
          result.detail = `桌面回归判定失败（${verdict}，${countsText}）`;
          break;
        }
        if (firstCounts === undefined) {
          firstCounts = counts;
          if (counts !== undefined) result.desktopCounts = counts;
        } else if (counts !== undefined) {
          // 数据相关分支（SKIP）几次之间可以不同；但任何一次 FAIL 都已经在上面中断。
          const drift = compareCounts(firstCounts, counts);
          if (drift !== null) {
            console.log(
              `  注意：第 ${runIndex} 次计数与第 1 次不同（${drift}）——数据相关分支允许不同，不允许失败`,
            );
          }
        }
        console.log(`✓ 桌面回归：${plugin}${suffix}（${countsText}）`);
      }
    }

    // deep 阶段：只对白名单插件追加 `--deep --workspace`，只跑一次（真实模型调用不做幂等自检）。
    // web / 桌面只读阶段已经失败时不再跑——省模型额度，汇总里会显示「未跑」而不是假绿；
    // 「跑不跑」与「跑完怎么判」分别由 shouldRunDeep() / classifyDeepStage() 决定（纯函数，有单测）。
    if (deepPlan.enabled && deepPlan.targets.includes(plugin)) {
      if (!shouldRunDeep(result)) {
        result.deepOk = false;
        console.error(`- deep 阶段未跑：${plugin} 的 web/桌面只读阶段已经失败（不再花模型额度）`);
      } else {
        console.log(
          `\n▶ [4.${index}-deep] pnpm smoke:${plugin}-desktop --require --deep --workspace ${deepPlan.workspace}`,
        );
        const deep = await run([
          `smoke:${plugin}-desktop`,
          "--require",
          "--deep",
          "--workspace",
          String(deepPlan.workspace),
        ]);
        const counts = parseCounts(deep.output);
        const countsText = formatCounts(counts);
        const verdict = classifyDeepStage({ code: deep.code, counts });
        result.deepRan = true;
        result.deepCounts = counts;
        if (verdict.ok) {
          result.deepOk = true;
          console.log(`✓ deep 桌面 e2e：${plugin}（${countsText}）`);
        } else {
          if (deep.code !== 0) {
            console.error(`FAIL deep 桌面 e2e 失败：${plugin}（${countsText}）`);
          } else {
            console.error(
              `FAIL deep 桌面 e2e 判定：${plugin} → ${verdict.verdict === "missing-counts" ? "脚本没打印计数行" : "全 SKIP/零断言"}（${countsText}）`,
            );
          }
          result.deepOk = false;
          result.detail = verdict.detail ?? `deep 桌面 e2e 失败（${countsText}）`;
        }
      }
    }
    results.push(result);
  }

  if (cdp !== undefined) {
    if (originalSession !== null) {
      let restored = await switchToId(cdp, originalSession).catch(() => false);
      for (let attempt = 0; attempt < 2 && !restored; attempt += 1) {
        await sleep(800);
        restored = await switchToId(cdp, originalSession).catch(() => false);
      }
      const now = await currentSession(cdp).catch(() => null);
      if (!restored || now !== originalSession) {
        console.warn(
          `WARN 没能切回原会话 session:${originalSession}（当前 ${now ?? "未知"}）；请手动点一下侧栏`,
        );
      } else {
        console.log(`✓ 已切回原会话（session:${originalSession}）`);
      }
    }
    cdp.ws.close();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log("\n===== gate:all 汇总 =====");
  for (const line of summaryLines(results, {
    desktopEnabled,
    deepEnabled: deepPlan.enabled,
    deepTargets: deepPlan.targets,
  })) {
    console.log(line);
  }
  const skipNote = deepSkipNote(results);
  if (skipNote !== null) console.log(`\n${skipNote}`);
  const failed = failedResults(results, deepPlan.targets);
  if (failed.length > 0) {
    console.error(`\nFAIL ${failed.length}/${results.length} 个插件门禁失败（${seconds}s）`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS 全部插件门禁全绿（${results.length}/${RELEASE_PLUGINS.length} 个发布插件，${seconds}s` +
      `${repeat > 1 ? `，桌面每步跑 ${repeat} 次` : ""}` +
      `${deepPlan.enabled ? `，deep：${deepPlan.targets.join(", ")}` : ""}）`,
  );
};

if (isMain(import.meta.url)) await main();
