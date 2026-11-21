// @ts-check
// 回收站保留期清理的纯逻辑（规格 §7.5 行 4c）：只挑「已在回收站且超保留期」的条目，
// 并在删除前产出可恢复清单。零 I/O，扫描与删除由 service 做。

/** 默认保留天数（与项目 policy.budget 无关，属于删除策略）。 */
export const DEFAULT_RETENTION_DAYS = 30;

/** 一天毫秒。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从目录名 `trash/<projectId>-<isoStamp>` 里取时间戳。
 * 目录名由 trashDirFor() 生成（冒号与点被替换成 `-`）。
 * @param {string} name
 * @returns {number|null}
 */
export function deletedAtFromName(name) {
  const match = String(name ?? "").match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/u);
  if (!match) return null;
  const iso = match[2].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u, "T$1:$2:$3.$4Z");
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

/**
 * 挑出超过保留期、可以永久删除的条目。
 * @param {Array<{ name: string, path: string, deletedAt?: number|null, bytes?: number }>} entries
 * @param {{ nowMs?: number, retentionDays?: number }} [options]
 * @returns {{ eligible: Array<{ name: string, path: string, deletedAt: number, bytes: number, ageDays: number }>, kept: number }}
 */
export function selectExpired(entries, options) {
  const opts = options ?? {};
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const retentionDays = Number.isFinite(opts.retentionDays)
    ? Math.max(0, Number(opts.retentionDays))
    : DEFAULT_RETENTION_DAYS;
  const cutoff = nowMs - retentionDays * DAY_MS;
  const list = Array.isArray(entries) ? entries : [];
  const eligible = [];
  let kept = 0;
  for (const entry of list) {
    const name = String(entry?.name ?? "");
    const path = String(entry?.path ?? "");
    const deletedAt = Number.isFinite(entry?.deletedAt)
      ? Number(entry.deletedAt)
      : deletedAtFromName(name);
    if (path === "" || deletedAt === null || !Number.isFinite(deletedAt)) {
      kept += 1; // 认不出时间的条目一律保留（宁可留着，也不猜着删）
      continue;
    }
    if (deletedAt > cutoff) {
      kept += 1;
      continue;
    }
    eligible.push({
      name,
      path,
      deletedAt,
      bytes: Math.max(0, Number(entry?.bytes ?? 0)),
      ageDays: Math.max(0, Math.round(((nowMs - deletedAt) / DAY_MS) * 10) / 10),
    });
  }
  return { eligible, kept };
}

/**
 * 删除前生成的可恢复清单（规格 §7.5 行 4c ②）。
 * 只记录「删了什么、多大、什么时候删的」，不记录文件内容——内容本身在删之前已经要没了，
 * 这份清单的用途是让人知道去哪找备份、以及审计能对上号。
 * @param {{ purgedAt: string, retentionDays: number, entries: Array<{ name: string, path: string, bytes: number, ageDays: number }> }} input
 * @returns {string}
 */
export function buildPurgeManifest(input) {
  const entries = Array.isArray(input?.entries) ? input.entries : [];
  const totalBytes = entries.reduce(
    (/** @type {number} */ sum, /** @type {any} */ entry) => sum + Number(entry?.bytes ?? 0),
    0,
  );
  const lines = [
    "# 回收站清理清单",
    "",
    `- 清理时间：${input?.purgedAt ?? ""}`,
    `- 保留期：${input?.retentionDays ?? DEFAULT_RETENTION_DAYS} 天`,
    `- 条目数：${entries.length}`,
    `- 合计体积：${totalBytes} 字节`,
    "",
    "## 已永久删除的条目",
    "",
    ...entries.map(
      (/** @type {any} */ entry) =>
        `- \`${entry.name}\`（${entry.bytes} 字节，删除于 ${entry.ageDays} 天前）\n  \`${entry.path}\``,
    ),
    "",
    "> 这些条目已超出保留期并被永久删除。若需要找回，只能从你自己的备份恢复。",
  ];
  return `${lines.join("\n")}\n`;
}
