// @ts-check
// command.js 的单测（AUD-REW-09）：`/rewind @<seq> [chat|both] [confirm]` 的解析与回执。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_USAGE,
  formatBothConflicts,
  formatBothPreview,
  formatRewindReceipt,
  parseRewindCommand,
} from "../lib/command.js";

test("parseRewindCommand: 解析 @seq / 裸 seq、mode 与显式确认", () => {
  assert.deepEqual(parseRewindCommand("@12 both"), {
    ok: true,
    targetSeq: 12,
    mode: "both",
    confirmed: false,
  });
  assert.deepEqual(parseRewindCommand("12"), {
    ok: true,
    targetSeq: 12,
    mode: "chat",
    confirmed: false,
  });
  assert.deepEqual(parseRewindCommand("@3 both confirm"), {
    ok: true,
    targetSeq: 3,
    mode: "both",
    confirmed: true,
  });
  for (const token of ["confirm", "--confirm", "-y", "--yes"]) {
    const parsed = parseRewindCommand(`@3 both ${token}`);
    assert.ok(parsed.ok, token);
    if (parsed.ok) assert.equal(parsed.confirmed, true, token);
  }
  const chat = parseRewindCommand("@3 chat confirm");
  assert.ok(chat.ok);
  if (chat.ok) assert.equal(chat.mode, "chat");
});

test("parseRewindCommand: 缺目标/非法目标返回用法提示", () => {
  for (const raw of ["", "both", "hello", "@", "@x"]) {
    const parsed = parseRewindCommand(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.text, COMMAND_USAGE);
  }
  // 负数不算目标（正则不接受 -1，因此按「没有目标」处理）。
  assert.equal(parseRewindCommand("@-1 both").ok, false);
});

test("formatBothPreview: 执行前回执影响面，并明确「尚未写任何东西」", () => {
  const text = formatBothPreview(
    {
      chat: { removedCount: 4 },
      files: {
        restore: [{ path: "a.txt" }],
        trash: [{ path: "b.txt" }, { path: "c.txt" }],
        skipped: [{ path: "big.bin", reason: "too-large" }],
        conflicts: [],
      },
    },
    9,
  );
  assert.match(text, /message 9/u);
  assert.match(text, /withdraws 4 message/u);
  assert.match(text, /restore 1 file/u);
  assert.match(text, /move 2 new file/u);
  assert.match(text, /skip 1 file/u);
  assert.match(text, /rescue point/u);
  assert.match(text, /Nothing has been written yet/u);
  assert.match(text, /`confirm`/u);
});

test("formatBothConflicts: 列出冲突路径并明确没有写入", () => {
  const text = formatBothConflicts({
    files: {
      conflicts: [
        { path: "a.txt" },
        { path: "b.txt" },
        { path: "c.txt" },
        { path: "d.txt" },
        { path: "e.txt" },
        { path: "f.txt" },
      ],
    },
  });
  assert.match(text, /blocked: 6 file/u);
  assert.match(text, /a\.txt/u);
  assert.match(text, /e\.txt/u);
  assert.doesNotMatch(text, /f\.txt/u, "只列前 5 条");
  assert.match(text, /Nothing was changed/u);
});

test("formatRewindReceipt: 报对话与文件结果（含跳过/失败/救援点）", () => {
  const text = formatRewindReceipt(
    {
      targetSeq: 7,
      removedCount: 3,
      tokens: 1200,
      cancelledTurn: true,
      files: {
        restored: ["a.txt"],
        trashed: ["b.txt", "c.txt"],
        skipped: [{ path: "big.bin" }],
        failed: [],
        rescueId: "res-9",
      },
    },
    "both",
  );
  assert.match(text, /message 7 \(3 messages, ~1200 tokens\)/u);
  assert.match(text, /restored 1 file/u);
  assert.match(text, /moved 2 to trash/u);
  assert.match(text, /skipped 1/u);
  assert.match(text, /rescue res-9/u);
  assert.match(text, /recovered from the rewind panel/u);
  assert.match(text, /running turn was stopped/u);
  // chat 模式不追加文件部分。
  const chat = formatRewindReceipt(
    { targetSeq: 7, removedCount: 1, tokens: 10, files: null },
    "chat",
  );
  assert.doesNotMatch(chat, /file\(s\)/u);
});
