// @ts-check
// 可观测（规格 §7.7.3）：从**持久会话事件**推导「这一步花了什么、改了什么」。
// 纯函数、零 I/O；diff 由调用方用 git numstat 拿到后传进来。
// 设计原则：宿主没给的数据一律显示 n/a，不猜、不用估算值冒充测量值。

/** 最近保留多少条命令明细（详情页只展示尾部，太多没意义）。 */
export const RECENT_COMMANDS = 12;

/** @returns {{steps: number, toolCalls: number, commands: {name: string, ok: boolean|null}[], tokens: number, usageSeen: boolean, lastActivityAt: number}} */
export function initialStats() {
  return {
    steps: 0,
    toolCalls: 0,
    commands: [],
    tokens: 0,
    usageSeen: false,
    lastActivityAt: 0,
  };
}

/**
 * 从命令类工具的参数里取命令名（宿主 `tool/call` 的入参形状不保证，取不到就记工具名）。
 * 同时用做 Overview 行副标题（F27/U12）：它必须是「人话、短、可读」，所以取第一行并截断。
 * @param {any} data
 * @returns {string}
 */
export function toolSummaryOf(data) {
  const args = data?.args ?? data?.input ?? data?.call?.args ?? null;
  const raw =
    (typeof args?.command === "string" && args.command) ||
    (typeof args?.cmd === "string" && args.cmd) ||
    (typeof data?.command === "string" && data.command) ||
    "";
  const name = raw !== "" ? raw : String(data?.name ?? data?.toolName ?? data?.tool ?? "tool");
  return name.split("\n")[0].slice(0, 120);
}

/**
 * 把一个事件并进统计。返回新对象（纯函数，便于单测与回放）。
 * @param {ReturnType<typeof initialStats>} stats
 * @param {any} event `session/event` 的事件
 * @returns {ReturnType<typeof initialStats>}
 */
export function observeEvent(stats, event) {
  const base = stats ?? initialStats();
  const type = String(event?.type ?? "");
  const data = event?.data ?? {};
  const at = Number(event?.time ?? data?.time ?? 0);

  if (type === "assistant/attempt") {
    // 一次 attempt ≈ 一个推理步骤
    const usage = data?.usage ?? data?.message?.usage ?? null;
    const tokens = usage ? tokensFrom(usage) : 0;
    return {
      ...base,
      steps: base.steps + 1,
      tokens: base.tokens + tokens,
      usageSeen: base.usageSeen || Boolean(usage),
      lastActivityAt: at > 0 ? at : base.lastActivityAt,
    };
  }

  if (type === "tool/call") {
    const name = toolSummaryOf(data);
    const commands = [...base.commands, { name, ok: null }].slice(-RECENT_COMMANDS);
    return {
      ...base,
      toolCalls: base.toolCalls + 1,
      commands,
      lastActivityAt: at > 0 ? at : base.lastActivityAt,
    };
  }

  if (type === "tool/result") {
    const ok = !(
      data?.ok === false ||
      data?.error !== undefined ||
      String(data?.status ?? "") === "error"
    );
    const commands = [...base.commands];
    for (let i = commands.length - 1; i >= 0; i -= 1) {
      if (commands[i].ok === null) {
        commands[i] = { ...commands[i], ok };
        break;
      }
    }
    return { ...base, commands, lastActivityAt: at > 0 ? at : base.lastActivityAt };
  }

  return base;
}

/**
 * 用量 → token 数。宿主不同版本的字段名不一致，能读到的都试一遍。
 * @param {any} usage
 * @returns {number}
 */
export function tokensFrom(usage) {
  const pick = (/** @type {any} */ value) => (Number.isFinite(value) ? Number(value) : 0);
  return (
    pick(usage?.totalTokens) ||
    pick(usage?.total) ||
    pick(usage?.inputTokens) + pick(usage?.outputTokens) ||
    0
  );
}

/**
 * 把事件数组一次性归约（测试与回放用）。
 * @param {any[]} events
 * @returns {ReturnType<typeof initialStats>}
 */
export function summarizeEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let stats = initialStats();
  for (const item of list) {
    // 兼容两种输入：裸事件，或 {type, event} 包装
    stats = observeEvent(stats, item?.event ?? item);
  }
  return stats;
}

/**
 * diff 摘要。入参就是 `git diff --numstat` 的输出，解析失败返回 null（显示 n/a）。
 * @param {string} numstat
 * @returns {{files: number, added: number, removed: number}|null}
 */
export function parseNumstat(numstat) {
  const text = String(numstat ?? "").trim();
  if (text === "") return { files: 0, added: 0, removed: 0 };
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) return null;
    const a = Number(parts[0]);
    const r = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(r)) return null; // 二进制文件是 `-`，如实算未知
    files += 1;
    added += a;
    removed += r;
  }
  return { files, added, removed };
}

/**
 * 给面板行副标题用的一行**人话**结果摘要：只写真实观测到的量，缺的就不提（不写 n/a）。
 * 例：`2 步 · 3 次工具 · +5/−2`；什么都没观测到就返回空串，让调用方回退到状态文案。
 * 之前这里恒返回 `0 步 · 0 次工具 · diff n/a · tokens n/a`——真机行副标题因此变成调试串。
 * 完整明细仍在展开面板（`data-projects-thread-steps` 等锚点），不丢信息。
 * @param {{stats?: any, diff?: any}} input
 * @returns {string}
 */
export function summarizeForRow(input) {
  const stats = input?.stats ?? initialStats();
  const diff = input?.diff ?? null;
  /** @type {string[]} */
  const parts = [];
  if (Number(stats.steps ?? 0) > 0) parts.push(`${stats.steps} 步`);
  if (Number(stats.toolCalls ?? 0) > 0) parts.push(`${stats.toolCalls} 次工具`);
  if (diff && Number(diff.files ?? 0) > 0) parts.push(`+${diff.added}/−${diff.removed}`);
  if (stats.usageSeen === true && Number(stats.tokens ?? 0) > 0)
    parts.push(`${stats.tokens} tokens`);
  return parts.join(" · ");
}

/**
 * 选出这一轮真的要算 diff 的线程：只算有 worktree 的，按最近活动降序取前 `limit` 条。
 * 目的：200 条线程的 project 一次 progress 不能 spawn 200 个 git；超出的行本轮不显示 diff。
 * @param {any[]} threads
 * @param {number} [limit]
 * @returns {any[]}
 */
export function selectDiffTargets(threads, limit = 24) {
  const cap = Number.isFinite(limit) && Number(limit) > 0 ? Number(limit) : 24;
  const eligible = (Array.isArray(threads) ? threads : []).filter(
    (thread) => String(thread?.worktree ?? "") !== "",
  );
  if (eligible.length <= cap) return eligible;
  return [...eligible]
    .sort(
      (a, b) =>
        Number(b?.lastActivityAt ?? 0) - Number(a?.lastActivityAt ?? 0) ||
        String(a?.sessionId ?? "").localeCompare(String(b?.sessionId ?? "")),
    )
    .slice(0, cap);
}
