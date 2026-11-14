// @ts-check
// 复盘报表：把 events.jsonl 折叠成指标 + 判读句 + 一份 Markdown。
//
// 设计要点（见 docs/adr/0013）：
// - **纯函数在前**：解析、汇总、判读都只吃数组/数字，`node --test` 直接覆盖；
//   写文件只有一个薄封装（`writeReport`）。
// - **样本门禁**：`turns < 80` 或 `shown < 25` 时只输出计数，不给任何判读——
//   一两天几十条数据得出的"结论"只会把噪声当信号。
// - **比例给 Wilson 95% 区间**：两组比较只在区间不重叠时才说"有差别"，否则明写"看不出差别"。
// - **每个指标都印分母**：避免"忽略率 86%"这种没有分母、无法复核的数字。
// - 判读句写成「现象 + 该动什么（只动一类）」：复盘要能落成一个具体改动。

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eventsDirOf } from "./events.js";

/** 判读的最小样本：少于这个数只列计数。 */
export const MIN_TURNS = 80;
/** 判读的最小出卡数（点击率/忽略率的分母）。 */
export const MIN_SHOWN = 25;
/** 报表文件保留份数（更早的自动删除，只在插件自己的目录内）。 */
export const REPORT_KEEP = 20;
/** Wilson 区间的 z 值（95%）。 */
export const WILSON_Z = 1.96;

/**
 * 逐行解析事件文件（坏行跳过并计数，绝不抛错）。
 * @param {string} text
 * @returns {{ events: any[], badLines: number }}
 */
export function parseEvents(text) {
  const events = [];
  let badLines = 0;
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.t === "string") {
        events.push(parsed);
      } else {
        badLines += 1;
      }
    } catch (_error) {
      badLines += 1;
    }
  }
  return { events, badLines };
}

/**
 * Wilson 比例区间（比正态近似在小样本/极端比例下更可靠）。
 * @param {number} k 命中数
 * @param {number} n 样本数
 * @param {number} [z]
 * @returns {{ p: number, low: number, high: number, n: number } | null} n=0 时返回 null
 */
export function wilson(k, n, z = WILSON_Z) {
  const hits = Number.isFinite(k) ? Math.max(0, k) : 0;
  const total = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (total === 0) return null;
  const p = hits / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return {
    p,
    low: Math.max(0, center - spread),
    high: Math.min(1, center + spread),
    n: total,
  };
}

/**
 * 两个区间是否重叠（重叠 = 看不出版本/分组之间有差别）。
 * @param {{ low: number, high: number } | null} left
 * @param {{ low: number, high: number } | null} right
 * @returns {boolean}
 */
export function intervalsOverlap(left, right) {
  if (left === null || right === null) return true;
  return Math.max(left.low, right.low) <= Math.min(left.high, right.high);
}

/**
 * label 长度分桶（复盘按钮文案用）。
 * @param {number} length
 * @returns {string}
 */
export function labelBucketOf(length) {
  const n = Number.isFinite(length) ? length : 0;
  if (n <= 8) return "≤8";
  if (n <= 12) return "9–12";
  if (n <= 16) return "13–16";
  return "17–20";
}

/**
 * 会话 id + 回合号 → join 键。
 * @param {any} event
 * @returns {string}
 */
function keyOf(event) {
  return `${String(event.sid)}:${String(event.turn)}`;
}

/**
 * @param {number} k @param {number} n
 * @returns {{ n: number, clicked: number, ctr: number | null, ci: any }}
 */
function rateCell(k, n) {
  return { n, clicked: k, ctr: n === 0 ? null : k / n, ci: wilson(k, n) };
}

/**
 * 汇总指标。所有比例都能从返回的计数复算（报表里也把计数一起印出来）。
 * @param {any[]} events
 * @returns {any}
 */
export function summarize(events) {
  /** @type {Map<string, any>} */
  const turns = new Map();
  /** @type {Map<string, any>} */
  const actions = new Map();
  /** @type {Map<string, any>} */
  const followups = new Map();
  /** @type {Map<string, any>} */
  const impressions = new Map();
  /** @type {Set<string>} */
  const promoted = new Set();
  /** @type {any[]} */
  const errors = [];
  let meta = null;
  let lastAt = 0;
  /** @type {Set<string>} */
  const sessions = new Set();

  for (const event of Array.isArray(events) ? events : []) {
    if (typeof event.at === "number" && event.at > lastAt) lastAt = event.at;
    if (typeof event.sid === "string") sessions.add(event.sid);
    if (event.t === "meta") {
      if (meta === null) meta = event;
      continue;
    }
    if (event.t === "turn") {
      const key = keyOf(event);
      if (!turns.has(key)) turns.set(key, event);
      continue;
    }
    if (event.t === "action") {
      const key = keyOf(event);
      if (!actions.has(key)) actions.set(key, event);
      continue;
    }
    if (event.t === "followup") {
      const key = keyOf(event);
      if (!followups.has(key)) followups.set(key, event);
      continue;
    }
    if (event.t === "impression") {
      const key = keyOf(event);
      const previous = impressions.get(key);
      // 同一张卡可能上报多次（重新挂载）：保留可见时长最大的那条
      if (previous === undefined || Number(event.visibleMs) > Number(previous.visibleMs)) {
        impressions.set(key, event);
      }
      continue;
    }
    if (event.t === "promote") {
      if (event.found === true) promoted.add(keyOf(event));
      continue;
    }
    if (event.t === "error") errors.push(event);
  }

  const gateCounts = /** @type {Record<string, number>} */ ({});
  let shown = 0;
  let suppressed = 0;
  let seen = 0;
  let unseen = 0;
  let unseenUnknown = 0;
  let clicked = 0;
  let dismissed = 0;
  let missedByOverlap = 0;
  /** @type {Record<string, { n: number, clicked: number, ctr: number | null, ci: any }>} */
  const byValue = {};
  /** @type {Record<string, { n: number, clicked: number, ctr: number | null, ci: any }>} */
  const byTier = {};
  /** @type {Record<string, { n: number, clicked: number, ctr: number | null, ci: any }>} */
  const byIndex = {};
  /** @type {Record<string, { n: number, clicked: number, ctr: number | null, ci: any }>} */
  const byOptionCount = {};
  /** @type {Record<string, { n: number, clicked: number, ctr: number | null, ci: any }>} */
  const byLabelBucket = {};
  /** @type {Record<string, { n: number, clicked: number, ctr: number | null, ci: any }>} */
  const byPromptVersion = {};

  /**
   * @param {Record<string, any>} bucket
   * @param {string} name
   * @param {boolean} hit
   * @returns {void}
   */
  function bump(bucket, name, hit) {
    const cell = bucket[name] ?? { n: 0, clicked: 0 };
    cell.n += 1;
    if (hit) cell.clicked += 1;
    bucket[name] = cell;
  }

  for (const [key, turn] of turns) {
    gateCounts[turn.gate] = (gateCounts[turn.gate] ?? 0) + 1;
    const cand = turn.cand;
    if (turn.gate !== "ok" || cand === undefined || cand === null) continue;
    const action = actions.get(key);
    const isClicked = action !== undefined && action.kind === "clicked";
    if (cand.shown === true) {
      shown += 1;
      const impression = impressions.get(key);
      if (impression !== undefined) {
        if (Number(impression.ratio) < 0) unseenUnknown += 1;
        else if (Number(impression.visibleMs) > 0) seen += 1;
        else unseen += 1;
      }
      if (action !== undefined && action.kind === "clicked") clicked += 1;
      if (action !== undefined && action.kind === "dismissed") dismissed += 1;
      bump(byValue, String(cand.value ?? "unknown"), isClicked);
      bump(byTier, String(turn.tier ?? "unknown"), isClicked);
      bump(byOptionCount, String(Array.isArray(cand.opts) ? cand.opts.length : 0), isClicked);
      bump(byPromptVersion, String(turn.pv ?? 0), isClicked);
      if (action !== undefined && action.kind === "clicked" && Number.isInteger(action.index)) {
        bump(byIndex, String(action.index), isClicked);
      }
      const opts = Array.isArray(cand.opts) ? cand.opts : [];
      const clickIndex = action !== undefined && Number.isInteger(action.index) ? action.index : -1;
      for (let index = 0; index < opts.length; index += 1) {
        const labelLen = Number(opts[index]?.len ?? 0);
        bump(byLabelBucket, labelBucketOf(labelLen), isClicked && clickIndex === index);
      }
    } else {
      suppressed += 1;
      const followup = followups.get(key);
      if (followup !== undefined && followup.typed === true && Number(followup.overlap) > 0) {
        missedByOverlap += 1;
      }
    }
  }

  // 桶内补齐点击率与区间
  for (const bucket of [byValue, byTier, byIndex, byOptionCount, byLabelBucket, byPromptVersion]) {
    for (const name of Object.keys(bucket)) {
      const cell = bucket[name];
      Object.assign(cell, rateCell(cell.clicked, cell.n));
    }
  }

  const ignored = Math.max(0, shown - clicked - dismissed);
  const misses = promoted.size + missedByOverlap;
  const errorKinds = /** @type {Record<string, number>} */ ({});
  for (const error of errors)
    errorKinds[String(error.kind ?? "unknown")] =
      (errorKinds[String(error.kind ?? "unknown")] ?? 0) + 1;

  const gateOkTurns = (gateCounts.ok ?? 0) + errors.length;
  return {
    scheme: typeof meta?.scheme === "string" ? meta.scheme : "v0.4",
    since: typeof meta?.at === "number" ? meta.at : 0,
    lastAt,
    days:
      typeof meta?.at === "number" && lastAt > meta.at
        ? Math.max(1, Math.round((lastAt - meta.at) / 86400000))
        : 0,
    sessions: sessions.size,
    turns: turns.size,
    shown,
    suppressed,
    seen,
    unseen,
    unseenUnknown,
    clicked,
    dismissed,
    ignored,
    promoted: promoted.size,
    missedByOverlap,
    misses,
    rates: {
      cardRate: turns.size === 0 ? null : shown / turns.size,
      seenRate: shown === 0 ? null : seen / shown,
      ctr: shown === 0 ? null : clicked / shown,
      ignoreRate: shown === 0 ? null : ignored / shown,
      missRate: suppressed === 0 ? null : misses / suppressed,
    },
    ci: {
      ctr: wilson(clicked, shown),
      missRate: wilson(misses, suppressed),
    },
    byValue,
    byTier,
    byIndex,
    byOptionCount,
    byLabelBucket,
    byPromptVersion,
    gates: gateCounts,
    errors: { total: errors.length, byKind: errorKinds },
    schemaShare: gateOkTurns === 0 ? 0 : (errorKinds.schema ?? 0) / gateOkTurns,
    insufficient: turns.size < MIN_TURNS || shown < MIN_SHOWN,
  };
}

/**
 * 判读：把指标变成「现象 + 该动什么」。样本不足时返回空数组（只列计数）。
 * @param {any} metrics summarize() 的结果
 * @returns {{ code: string, text: string, action: string }[]}
 */
export function verdicts(metrics) {
  /** @type {{ code: string, text: string, action: string }[]} */
  const out = [];
  if (metrics.insufficient === true) return out;
  const rates = metrics.rates;

  if (rates.seenRate !== null && rates.seenRate < 0.6) {
    out.push({
      code: "low-exposure",
      text: `出过的卡里只有 ${Math.round(rates.seenRate * 100)}% 真的进过视口（${metrics.seen}/${metrics.shown}）。`,
      action: "先修渲染位置或出现时机，不要动提示词——现在还不知道内容好不好。",
    });
  }
  if (rates.ignoreRate !== null && rates.ignoreRate > 0.7 && (rates.seenRate ?? 0) >= 0.6) {
    out.push({
      code: "ignored-but-seen",
      text: `卡片多数被看见却没被点（忽略 ${metrics.ignored}/${metrics.shown}）。`,
      action: "改内容：摘要是否写了可核查事实、label 是否带具体对象。一次只改一类。",
    });
  }
  if (rates.missRate !== null && rates.missRate > 0.2) {
    out.push({
      code: "too-strict",
      text: `被抑制的候选里有 ${Math.round(rates.missRate * 100)}% 事后看是想要的（${metrics.misses}/${metrics.suppressed}）。`,
      action: "把出卡频率从「平衡」往「积极」调一档；先别改提示词。",
    });
  }
  if (rates.ctr !== null && metrics.ci.ctr !== null && metrics.ci.ctr.high < 0.1) {
    out.push({
      code: "low-ctr",
      text: `点击率只有 ${Math.round(rates.ctr * 100)}%（${metrics.clicked}/${metrics.shown}，95% 区间上限 ${Math.round(metrics.ci.ctr.high * 100)}%）。`,
      action: "内容或位置问题，不是门控问题：先看曝光与摘要具体性。",
    });
  }

  const must = metrics.byValue.must;
  const could = metrics.byValue.could;
  if (must !== undefined && could !== undefined && intervalsOverlap(must.ci, could.ci)) {
    out.push({
      code: "tiers-indistinct",
      text: `must（${must.clicked}/${must.n}）与 could（${could.clicked}/${could.n}）的点击率区间重叠。`,
      action: "三档目前没有区分力：先改提示词里 could 的判据，或把档位固定成「严格」。",
    });
  }

  const second = metrics.byIndex["1"];
  // 用 Wilson 区间上界判"几乎没人点"：0/40 的点估计是 0，但区间上界约 9%，
  // 直接比点估计会得出"绝对没人点"这种小样本不敢下的结论。
  if (second !== undefined && second.n >= 20 && second.ci !== null && second.ci.high < 0.1) {
    out.push({
      code: "second-option-useless",
      text: `第二条建议几乎没人点（${second.clicked}/${second.n}）。`,
      action: "让提示词默认只给 1 条；第二条只在两个方向都明确时才要。",
    });
  }

  if (metrics.schemaShare > 0.15) {
    out.push({
      code: "schema-failures",
      text: `有 ${Math.round(metrics.schemaShare * 100)}% 的生成是格式失败（${metrics.errors.byKind.schema ?? 0}/${metrics.turns + metrics.errors.total}）。`,
      action: "解析还需要放宽，或修复调用没有生效——先看 error.detail 的前缀分布。",
    });
  }

  if ((metrics.gates.budget ?? 0) > 0) {
    out.push({
      code: "budget-hit",
      text: `有 ${metrics.gates.budget} 个回合撞上会话上限而没有出卡。`,
      action: "上调「每会话最多 N 张卡」，或把它当成一次性的观察上限。",
    });
  }
  return out;
}

/**
 * 百分比显示（null → "—"）。
 * @param {number | null} value
 * @returns {string}
 */
function pct(value) {
  return value === null || !Number.isFinite(value) ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * 区间显示。
 * @param {{ low: number, high: number } | null} ci
 * @returns {string}
 */
function ciText(ci) {
  return ci === null ? "—" : `[${Math.round(ci.low * 100)}–${Math.round(ci.high * 100)}%]`;
}

/**
 * 渲染 Markdown 报告（五段固定结构）。
 * @param {any} metrics
 * @param {{ code: string, text: string, action: string }[]} list
 * @returns {string}
 */
export function renderMarkdown(metrics, list) {
  const lines = [];
  const iso = (/** @type {number} */ at) =>
    at > 0 ? new Date(at).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—";
  lines.push("# next-step 复盘报告");
  lines.push("");
  lines.push(`- 生成时间：${iso(metrics.lastAt)}`);
  lines.push(
    `- 数据起算：${iso(metrics.since)}（共 ${metrics.days} 天，${metrics.sessions} 个会话）`,
  );
  lines.push("");
  lines.push("## 1. 样本量");
  lines.push("");
  lines.push(`- 合格回合：**${metrics.turns}**（判读门槛 ${MIN_TURNS}）`);
  lines.push(
    `- 出过的卡：**${metrics.shown}**（判读门槛 ${MIN_SHOWN}），被抑制的候选：${metrics.suppressed}`,
  );
  lines.push(
    metrics.insufficient
      ? `- **样本不足，本次只列计数，不给判读。** 继续用 2–3 天再来。`
      : `- 样本量已够，下面的判读可以采信；改动请一次只改一类，改完 ` + `promptVersion +1 再比。`,
  );
  lines.push("");
  lines.push("## 2. 频率");
  lines.push("");
  lines.push(`- 出卡率：${pct(metrics.rates.cardRate)}（${metrics.shown}/${metrics.turns}）`);
  lines.push(
    `- 曝光率：${pct(metrics.rates.seenRate)}（${metrics.seen}/${metrics.shown}；未进视口 ${metrics.unseen}，未知 ${metrics.unseenUnknown}）`,
  );
  lines.push(
    `- 点击率：${pct(metrics.rates.ctr)}（${metrics.clicked}/${metrics.shown}）${ciText(metrics.ci.ctr)}`,
  );
  lines.push(`- 忽略率：${pct(metrics.rates.ignoreRate)}（${metrics.ignored}/${metrics.shown}）`);
  lines.push(`- 主动关闭：${metrics.dismissed}`);
  lines.push("");
  lines.push("## 3. 归因：漏判与噪音");
  lines.push("");
  lines.push(
    `- 漏判率：${pct(metrics.rates.missRate)}（${metrics.misses}/${metrics.suppressed}）${ciText(metrics.ci.missRate)}`,
  );
  lines.push(`  - 用户点「生成下一步建议」揭示候选：${metrics.promoted}`);
  lines.push(`  - 抑制后用户自己打了相关的一句：${metrics.missedByOverlap}`);
  lines.push(
    `- 闸门分布：${
      Object.entries(metrics.gates)
        .map(([k, v]) => `${k}=${v}`)
        .join(" · ") || "—"
    }`,
  );
  lines.push(
    `- 生成失败：${metrics.errors.total}（${
      Object.entries(metrics.errors.byKind)
        .map(([k, v]) => `${k}=${v}`)
        .join(" · ") || "无"
    }）`,
  );
  lines.push("");
  lines.push("## 4. 内容与按钮");
  lines.push("");
  lines.push("| 分组 | 出卡 | 点击 | 点击率 | 95% 区间 |");
  lines.push("|---|---|---|---|---|");
  /**
   * @param {string} name
   * @param {Record<string, any>} bucket
   * @returns {void}
   */
  const table = (name, bucket) => {
    for (const key of Object.keys(bucket).sort()) {
      const cell = bucket[key];
      if (cell.n === 0) continue;
      lines.push(
        `| ${name} ${key} | ${cell.n} | ${cell.clicked} | ${pct(cell.ctr)} | ${ciText(cell.ci)} |`,
      );
    }
  };
  table("判定", metrics.byValue);
  table("档位", metrics.byTier);
  table("第几条", metrics.byIndex);
  table("选项数", metrics.byOptionCount);
  table("label 长度", metrics.byLabelBucket);
  table("提示词版本", metrics.byPromptVersion);
  lines.push("");
  lines.push("## 5. 建议动作");
  lines.push("");
  if (list.length === 0) {
    lines.push(
      metrics.insufficient
        ? "- 样本不足，暂无建议。"
        : "- 没有命中任何判读规则：当前设置与内容都在合理区间，保持不动，继续积累。",
    );
  } else {
    for (const item of list) {
      lines.push(`- **${item.code}**：${item.text}`);
      lines.push(`  - 动作：${item.action}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("口径说明：忽略 = 出过的卡 − 点击 − 主动关闭（左连接，不写状态机）；");
  lines.push("曝光 = 卡片真正进入视口（IntersectionObserver 相交 ≥0.5 且持续 ≥300ms）；");
  lines.push("比例区间为 Wilson 95%，两组比较只在区间不重叠时才算有差别。");
  return `${lines.join("\n")}\n`;
}

/**
 * 报表文件名（UTC 时间戳，同日多次生成不覆盖）。
 * @param {number} at
 * @returns {string}
 */
export function reportFileName(at) {
  const iso = new Date(at).toISOString(); // 2026-11-14T10:20:30.000Z
  const stamp = `${iso.slice(0, 10).replace(/-/gu, "")}-${iso.slice(11, 19).replace(/:/gu, "")}`;
  return `report-${stamp}.md`;
}

/**
 * 写入报表并清理旧文件（保留最新 REPORT_KEEP 份，只在插件目录内）。
 * @param {{ home: string, markdown: string, now?: number, keep?: number }} input
 * @returns {Promise<string>} 写入的绝对路径
 */
export async function writeReport({ home, markdown, now, keep }) {
  const dir = eventsDirOf(home);
  const at = typeof now === "number" ? now : Date.now();
  const limit =
    Number.isSafeInteger(keep) && /** @type {number} */ (keep) > 0
      ? /** @type {number} */ (keep)
      : REPORT_KEEP;
  await mkdir(dir, { recursive: true });
  const path = join(dir, reportFileName(at));
  await writeFile(path, markdown, "utf8");
  try {
    const entries = (await readdir(dir))
      .filter((name) => /^report-\d{8}-\d{6}\.md$/u.test(name))
      .sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - limit))) {
      await rm(join(dir, stale), { force: true });
    }
  } catch (_error) {
    // 清理失败不影响本次报告
  }
  return path;
}
