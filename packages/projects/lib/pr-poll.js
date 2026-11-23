// @ts-check
// F21 auto-fix / PR 状态轮询：纯函数、零 I/O。
// 依据 spec-plan §4「CI 状态」与 scope-confirmed §10.1 方案 A：
//   - 只对「项目内有开放 PR」的仓库轮询（一次 `gh pr list` 覆盖整仓）
//   - 间隔 30–90s，连续失败退避，成功即回落
//   - 应用关闭即停（定时器挂在 service 上，dispose 时清掉）
// 实验档 B（`gh webhook forward`）默认关：它会在仓库上建临时 webhook、需要管理员权限，
// 所以这里只出「开关 + 说明文案」，不偷偷起子进程。

/** 轮询间隔下限（毫秒）。 */
export const POLL_MIN_MS = 30_000;

/** 轮询间隔上限（毫秒）。 */
export const POLL_MAX_MS = 90_000;

/** gh 查询字段：一次拿全，减少子进程次数。 */
export const PR_LIST_FIELDS = "number,headRefOid,statusCheckRollup,state,mergeable";

/**
 * 下一轮轮询间隔（带退避）。
 * @param {{ failures?: number, base?: number }} [input]
 * @returns {number} 毫秒，恒在 [POLL_MIN_MS, POLL_MAX_MS]
 */
export function nextPollDelay(input) {
  const failures = Math.max(0, Number(input?.failures ?? 0));
  const requested = /** @type {any} */ (input)?.base;
  const base = Number.isFinite(requested) ? Number(requested) : POLL_MIN_MS;
  if (failures <= 0) return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(base)));
  // 指数退避，封顶 POLL_MAX_MS：连续失败时不要把 GitHub 打爆
  const backed = base * 2 ** Math.min(failures, 4);
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(backed)));
}

/**
 * 这个项目要不要轮询：先看有没有开放 PR 的线程，再看自动修复档位是否开着。
 * @param {{ prTier?: string, threads?: Array<{ prNumber?: number|null }> }|null|undefined} input
 * @returns {{ poll: boolean, reason: string, openPrs: number }}
 */
export function shouldPollProject(input) {
  const threads = Array.isArray(input?.threads) ? input.threads : [];
  const openPrs = threads.filter(
    (thread) => Number.isInteger(Number(thread?.prNumber)) && Number(thread?.prNumber) > 0,
  ).length;
  const tier = String(input?.prTier ?? "off");
  if (openPrs === 0) return { poll: false, reason: "no-open-pr", openPrs: 0 };
  if (tier === "off") return { poll: false, reason: "tier-off", openPrs };
  return { poll: true, reason: "", openPrs };
}

/**
 * 从 `statusCheckRollup` 归约成三态。没有 checks 时是 `none`（不编成 pending）。
 * @param {Array<{ conclusion?: string|null, status?: string, state?: string }>|null|undefined} rollup
 * @returns {"passing"|"failing"|"pending"|"none"}
 */
export function rollupState(rollup) {
  const items = Array.isArray(rollup) ? rollup : [];
  if (items.length === 0) return "none";
  const states = items.map((item) => {
    const conclusion = String(item?.conclusion ?? "").toUpperCase();
    const status = String(item?.status ?? "").toUpperCase();
    const state = String(item?.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion))
      return "failing";
    if (["FAILURE", "ERROR", "PENDING", "EXPECTED"].includes(state)) return "failing";
    if (["SUCCESS", "NEUTRAL", "SKIPPED", "SUCCESS"].includes(state)) return "passing";
    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED")
      return "passing";
    if (status !== "" && status !== "COMPLETED") return "pending";
    return "pending";
  });
  if (states.includes("failing")) return "failing";
  if (states.includes("pending")) return "pending";
  return "passing";
}

/**
 * 解析 `gh pr list --json …` 的输出。
 * @param {string} stdout
 * @returns {{ ok: boolean, rows: Array<{ number: number, headRefOid: string, ciState: string, state: string, mergeable: any }>, reason: string }}
 */
export function parsePrList(stdout) {
  const text = String(stdout ?? "").trim();
  if (text === "") return { ok: false, rows: [], reason: "empty-output" };
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, rows: [], reason: "bad-json" };
  }
  if (!Array.isArray(parsed)) return { ok: false, rows: [], reason: "not-an-array" };
  /** @type {Array<{ number: number, headRefOid: string, ciState: string, state: string, mergeable: any }>} */
  const rows = [];
  for (const item of parsed) {
    const number = Number(item?.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    rows.push({
      number,
      headRefOid: String(item?.headRefOid ?? ""),
      ciState: rollupState(item?.statusCheckRollup),
      state: String(item?.state ?? "").toUpperCase(),
      mergeable: item?.mergeable ?? null,
    });
  }
  return { ok: true, rows, reason: "" };
}

/**
 * 轮询结果 → 要写回线程的补丁（只写变化，返回空数组表示没变化，避免无意义落盘）。
 * @param {{ threads?: Array<{ sessionId: string, prNumber?: number|null, ciState?: string|null, headRefOid?: string }> }} input
 * @param {Array<{ number: number, headRefOid: string, ciState: string }>} rows
 * @returns {Array<{ sessionId: string, ciState: string, headRefOid: string }>}
 */
export function planThreadPatches(input, rows) {
  const threads = Array.isArray(input?.threads) ? input.threads : [];
  const byNumber = new Map();
  for (const row of Array.isArray(rows) ? rows : []) byNumber.set(Number(row?.number), row);
  /** @type {Array<{ sessionId: string, ciState: string, headRefOid: string }>} */
  const patches = [];
  for (const thread of threads) {
    const prNumber = Number(thread?.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const row = byNumber.get(prNumber);
    if (!row) continue;
    const ciState = String(row.ciState ?? "none");
    const headRefOid = String(row.headRefOid ?? "");
    if (String(thread.ciState ?? "") === ciState && String(thread.headRefOid ?? "") === headRefOid)
      continue;
    patches.push({ sessionId: String(thread.sessionId), ciState, headRefOid });
  }
  return patches;
}

/**
 * 实验档（实时 webhook）开关的说明：开关存在，但这里**只**暴露文案与前置条件，
 * 真起 `gh webhook forward` 需要仓库管理员权限，必须由用户显式确认后才做（B2 不做自动起）。
 * @returns {{ key: string, requires: string[], warning: string }}
 */
export function realtimeCiSpec() {
  return {
    key: "realtimeCi",
    requires: ["仓库管理员权限", "本机 gh ≥ 2.60（需 gh-webhook 扩展）", "同一仓库同时只能一人用"],
    warning:
      "开启后会在该 GitHub 仓库上创建临时 webhook（push/pull_request/check_run），并在本机起 loopback 监听；gh 官方标注仅供测试/开发。默认关闭，轮询已够用。",
  };
}
