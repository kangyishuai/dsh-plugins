// @ts-check
// F62：`@` 提及 provider 的数据面。宿主 client 半有 `ctx.inputTriggers.registerSource({trigger:'@'})`，
// 但 host 半没有 registry——所以条目由 host RPC 现算（`mentionItems`），client 只负责渲染与插入。
// 纯函数在这里，保证"列哪些、怎么排、怎么过滤"能单测。

/** 一次最多返回多少条（输入框候选列表太长反而难选）。 */
export const MENTION_LIMIT = 20;

/**
 * 把 `@` 后面的查询字符串归一：去空白、转小写。
 * @param {unknown} query
 * @returns {string}
 */
export function normalizeMentionQuery(query) {
  return String(query ?? "")
    .replace(/^@/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * 组装候选：项目 + 线程；按「项目名命中优先，其次线程标题命中」排序，
 * 空查询时先列项目再列最近活跃线程。
 * @param {{ projects?: any[], threads?: any[], query?: unknown, limit?: number }} input
 * @returns {{ kind: "project"|"thread", id: string, label: string, detail: string, projectId: string }[]}
 */
export function buildMentionItems(input) {
  const projects = Array.isArray(input?.projects) ? input.projects : [];
  const threads = Array.isArray(input?.threads) ? input.threads : [];
  const query = normalizeMentionQuery(input?.query);
  const limit = Number.isFinite(input?.limit) ? Math.max(1, Number(input.limit)) : MENTION_LIMIT;
  const nameOf = (/** @type {any} */ project) => String(project?.name ?? project?.id ?? "");
  const matches = (/** @type {string} */ value) =>
    query === "" || value.toLowerCase().includes(query);

  /** @type {{ kind: "project"|"thread", id: string, label: string, detail: string, projectId: string, rank: number, at: number }[]} */
  const out = [];
  for (const project of projects) {
    const label = nameOf(project);
    if (!matches(label) && !matches(String(project?.goal ?? ""))) continue;
    out.push({
      kind: "project",
      id: String(project?.id ?? ""),
      label,
      detail: "项目",
      projectId: String(project?.id ?? ""),
      rank: query === "" ? 0 : label.toLowerCase().startsWith(query) ? 0 : 1,
      at: Date.parse(String(project?.updatedAt ?? "")) || 0,
    });
  }
  const byId = new Map(
    projects.map((/** @type {any} */ project) => [String(project?.id ?? ""), project]),
  );
  for (const thread of threads) {
    const title = String(thread?.title ?? thread?.subtitle ?? thread?.sessionId ?? "");
    if (title === "" || !matches(title)) continue;
    const projectId = String(thread?.projectId ?? "");
    const project = byId.get(projectId);
    out.push({
      kind: "thread",
      id: String(thread?.sessionId ?? thread?.id ?? ""),
      label: title,
      detail: project ? `线程 · ${nameOf(project)}` : "线程",
      projectId,
      rank: query === "" ? 1 : title.toLowerCase().startsWith(query) ? 0 : 2,
      at: Date.parse(String(thread?.lastActivityAt ?? thread?.createdAt ?? "")) || 0,
    });
  }
  out.sort(
    (left, right) =>
      left.rank - right.rank || right.at - left.at || left.label.localeCompare(right.label),
  );
  return out.slice(0, limit).map(({ rank, at, ...rest }) => rest);
}
