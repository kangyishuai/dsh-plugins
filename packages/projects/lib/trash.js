// @ts-check
// 删除项目的安全逻辑：回收站路径、影响面汇总、可恢复性判定。纯函数、零 I/O。
// 依据 ADR 0002：默认移入回收站、必须能说清影响面、支持 dry-run、写审计。

/** 回收站目录名（放在数据根下，和元数据文件同级）。 */
export const TRASH_DIR = "trash";

/**
 * 一个项目的回收站条目目录。
 * @param {{ dataRoot: string, projectId: string, now?: number }} input
 * @returns {string}
 */
export function trashDirFor(input) {
  const dataRoot = String(input?.dataRoot ?? "").replace(/\/+$/u, "");
  if (dataRoot === "") throw new Error("projects: trashDirFor requires dataRoot");
  const projectId = String(input?.projectId ?? "").replace(/[^A-Za-z0-9_-]/gu, "");
  if (projectId === "") throw new Error("projects: trashDirFor requires projectId");
  const stamp = new Date(
    Number.isFinite(input?.now) ? Number(input.now) : Date.now(),
  ).toISOString();
  const safeStamp = stamp.replace(/[:.]/gu, "-");
  return `${dataRoot}/${TRASH_DIR}/${projectId}-${safeStamp}`;
}

/**
 * 汇总「删除这个项目会影响什么」。数字全部由调用方给，函数只负责表述与兜底。
 * ADR 0002 要求：数量 · 体积 · 是否在跑 · 能否恢复，四件都要能说清。
 * @param {{threads: {state?: string}[], contentBytes: number, hasContentDir: boolean, name: string, worktrees?: any[]}} input
 * @returns {{
 *   threadCount: number,
 *   liveThreadCount: number,
 *   worktreeCount: number,
 *   contentBytes: number,
 *   hasContentDir: boolean,
 *   restorable: true,
 *   summary: string,
 * }}
 */
export function impactOf(input) {
  const threads = Array.isArray(input?.threads) ? input.threads : [];
  const live = threads.filter((thread) => thread?.state === "working").length;
  const contentBytes = Number.isFinite(input?.contentBytes)
    ? Math.max(0, Number(input.contentBytes))
    : 0;
  const hasContentDir = input?.hasContentDir === true;
  const worktrees = Array.isArray(input?.worktrees) ? input.worktrees : [];
  const parts = [
    `${threads.length} 个线程（${live} 个在跑）`,
    hasContentDir ? `项目内容 ${formatBytes(contentBytes)}` : "无项目内容文件",
    worktrees.length > 0 ? `${worktrees.length} 个 worktree 留在磁盘（删除不会清理）` : "",
    "会话日志不受影响",
    "可恢复：删除只移入回收站",
  ];
  return {
    threadCount: threads.length,
    liveThreadCount: live,
    worktreeCount: worktrees.length,
    contentBytes,
    hasContentDir,
    restorable: true,
    summary: parts.join(" · "),
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 从回收站目录名里取项目 id（目录名形如 `<projectId>-<ISO 时间戳>`）。
 * projectId 是 `prj_xxx`，本身不含 “-”；时间戳里才有。
 * @param {string} name
 * @returns {string}
 */
export function trashProjectIdOf(name) {
  const raw = String(name ?? "").trim();
  if (raw === "") return "";
  const [id] = raw.split("-");
  return String(id ?? "").replace(/[^A-Za-z0-9_-]/gu, "");
}
