// @ts-check
// `/rewind @<seq> [chat|both] [confirm]` 的解析与回执（纯函数、可单测，AUD-REW-09）。
//
// AUD-REW-09：命令形式曾经是唯一「输入一行就写工作区文件」的路径（无预览、无确认）。
// 现在的语义：
//   - `chat`：与其它入口一致（只追加 marker），行为不变；
//   - `both`：先做一次 preview，把文件影响面回执给用户；必须显式带 `confirm` 才执行，
//     并且运行中的会话一律拒绝（命令没有确认框来解释「会先停止回合」）。
// 宿主命令文本没有 locale（ctx.locale 只在 client 半），因此这里沿用英文回执。

/** 用法提示（与 handler 里的错误文案保持一处）。 */
export const COMMAND_USAGE =
  "Usage: /rewind @<seq> [chat|both] [confirm] — or pick a message from the UI.";

/**
 * @typedef {object} ParsedRewindCommand
 * @property {true} ok
 * @property {number} targetSeq
 * @property {"chat" | "both"} mode
 * @property {boolean} confirmed 是否带显式确认（仅 both 需要）
 */

/**
 * @typedef {object} RewindCommandParseError
 * @property {false} ok
 * @property {string} text
 */

/**
 * 解析命令参数。`@5` 与 `5` 等价；`confirm` / `--confirm` / `-y` / `--yes` 都算显式确认。
 * @param {unknown} rawInput
 * @returns {ParsedRewindCommand | RewindCommandParseError}
 */
export function parseRewindCommand(rawInput) {
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  const tokens = raw.split(/\s+/u).filter((token) => token !== "");
  const targetToken = tokens.find((token) => /^@?\d+$/u.test(token));
  if (targetToken === undefined) return { ok: false, text: COMMAND_USAGE };
  const targetSeq = Number(targetToken.replace(/^@/u, ""));
  if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) {
    return { ok: false, text: COMMAND_USAGE };
  }
  const mode = tokens.some((token) => token === "both") ? "both" : "chat";
  const confirmed = tokens.some(
    (token) => token === "confirm" || token === "--confirm" || token === "-y" || token === "--yes",
  );
  return { ok: true, targetSeq, mode, confirmed };
}

/**
 * `both` 的预演回执（执行前展示影响面；不含任何写入）。
 * @param {any} preview `service.preview()` 的返回值
 * @param {number} targetSeq
 * @returns {string}
 */
export function formatBothPreview(preview, targetSeq) {
  const files = preview?.files ?? {};
  const restore = Array.isArray(files.restore) ? files.restore.length : 0;
  const trash = Array.isArray(files.trash) ? files.trash.length : 0;
  const skipped = Array.isArray(files.skipped) ? files.skipped.length : 0;
  const removed = preview?.chat?.removedCount ?? 0;
  const parts = [
    `Rewind to before message ${targetSeq} withdraws ${removed} message(s).`,
    `File mode writes to the workspace: restore ${restore} file(s), move ${trash} new file(s) to the plugin trash${skipped > 0 ? `, skip ${skipped} file(s)` : ""}.`,
    "A rescue point is created before any write, and the trash can be restored from the panel.",
    "Nothing has been written yet. Re-run the same command with `confirm` to execute, or pick the message in the UI to review and confirm there.",
  ];
  return parts.join(" ");
}

/**
 * `both` 被冲突挡住时的回执（列出冲突路径，不执行任何写入）。
 * @param {any} preview
 * @returns {string}
 */
export function formatBothConflicts(preview) {
  const conflicts = Array.isArray(preview?.files?.conflicts) ? preview.files.conflicts : [];
  const listed = conflicts
    .slice(0, 5)
    .map((/** @type {any} */ item) => String(item?.path ?? ""))
    .filter((/** @type {string} */ item) => item.length > 0);
  return `File rewind is blocked: ${conflicts.length} file(s) differ from the expected state${
    listed.length > 0
      ? ` (${listed.join(", ")}${conflicts.length > listed.length ? ", …" : ""})`
      : ""
  }. Nothing was changed. Re-run from the UI to review the full conflict list.`;
}

/**
 * 成功回执（执行后）：对话影响 + 文件影响 + 跳过/失败计数 + 可恢复性提示。
 * @param {any} result `executeRewind()` 的返回值
 * @param {"chat" | "both"} mode
 * @returns {string}
 */
export function formatRewindReceipt(result, mode) {
  let text = `Rewound to before message ${result.targetSeq} (${result.removedCount} messages, ~${result.tokens} tokens)`;
  if (mode === "both" && result.files) {
    const restored = Array.isArray(result.files.restored) ? result.files.restored.length : 0;
    const trashed = Array.isArray(result.files.trashed) ? result.files.trashed.length : 0;
    const skipped = Array.isArray(result.files.skipped) ? result.files.skipped.length : 0;
    const failed = Array.isArray(result.files.failed) ? result.files.failed.length : 0;
    text += `; restored ${restored} file(s), moved ${trashed} to trash, skipped ${skipped}, failed ${failed}`;
    if (typeof result.files.rescueId === "string" && result.files.rescueId.length > 0) {
      text += `; rescue ${result.files.rescueId}`;
    }
    text += ". Files can be recovered from the rewind panel (recovery points / trash).";
  }
  if (result.cancelledTurn === true) text += " The running turn was stopped first.";
  return `${text}.`;
}
