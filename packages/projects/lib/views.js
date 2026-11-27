// @ts-check
// 自定义视图（对齐 Claude 的 "+ Add view"）：名字 + 当前状态过滤 + 关键词，存进项目记录。
//
// 只存"筛选条件"，不存数据快照：视图是**怎么筛**，不是筛出来的结果。
// 读盘只收敛类型、非法条目丢弃——旧数据/坏数据不能让整份 projects.json 读不出来。

/** 每个项目最多保存多少个视图（再多不如直接用搜索）。 */
export const MAX_VIEWS = 8;
/** 视图名上限（面板 chip 一行放得下）。 */
export const MAX_VIEW_NAME = 24;
/** 关键词上限（与面板搜索框一致）。 */
export const MAX_VIEW_QUERY = 60;

/**
 * 允许的状态过滤值：空串（全部）+ 六态。
 * 与 `overview.js` 的 THREAD_STATES 保持同一套；这里显式列出，避免读盘依赖运行时枚举。
 */
const FILTERS = ["", "waiting-user", "failed", "working", "resolved", "idle", "archived"];

/**
 * @param {unknown} value
 * @returns {{ id: string, name: string, filter: string, query: string } | null}
 */
export function normalizeView(value) {
  const source = value && typeof value === "object" ? /** @type {any} */ (value) : {};
  const id = typeof source.id === "string" ? source.id.trim().slice(0, 40) : "";
  if (id === "") return null;
  const rawName = typeof source.name === "string" ? source.name.trim() : "";
  if (rawName === "") return null;
  const filter = FILTERS.includes(String(source.filter ?? "")) ? String(source.filter ?? "") : "";
  const query =
    typeof source.query === "string" ? source.query.trim().slice(0, MAX_VIEW_QUERY) : "";
  return { id, name: rawName.slice(0, MAX_VIEW_NAME), filter, query };
}

/**
 * @param {unknown} list
 * @returns {Array<{ id: string, name: string, filter: string, query: string }>}
 */
export function normalizeViews(list) {
  if (!Array.isArray(list)) return [];
  /** @type {Array<{ id: string, name: string, filter: string, query: string }>} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const view = normalizeView(item);
    if (!view || seen.has(view.id)) continue;
    seen.add(view.id);
    out.push(view);
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

/**
 * 视图保存时的 id：`v_` + 小写十六进制（稳定、可读、不与用户输入冲突）。
 * @param {() => number} [now]
 * @returns {string}
 */
export function nextViewId(now) {
  const stamp = Math.max(0, Math.trunc((now ? now() : Date.now()) % 0xffffffff));
  const salt = Math.floor(Math.random() * 0x10000);
  return `v_${stamp.toString(16)}${salt.toString(16).padStart(4, "0")}`;
}
