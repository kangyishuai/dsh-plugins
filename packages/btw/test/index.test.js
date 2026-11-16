// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendRecord, lastRecord, listRecent, readRecords } from "../lib/history.js";
import { parseAllowedTools } from "../lib/index.js";
import { clip, LIMITS } from "../lib/limits.js";
import { format, loadMessages, pickLanguage } from "../lib/messages.js";
import { btwRoot, historyFile, resolveDataRoot } from "../lib/paths.js";
import {
  buildSideQuestionPrompt,
  looksLikeToolCalls,
  sanitizeReplayAnswer,
} from "../lib/prompts.js";
import { extractText, makeReadOnlyGuard } from "../lib/subagent.js";

const LOCALE_DIR = new URL("../locale/", import.meta.url).pathname;

/** @returns {Promise<string>} */
const tempDir = () => mkdtemp(join(tmpdir(), "dsh-btw-test-"));

// --- paths -----------------------------------------------------------------

test("resolveDataRoot: 配置 > DSH_HOME > ~/.dsh", () => {
  assert.equal(resolveDataRoot({ dataRoot: "/a" }, { DSH_HOME: "/b" }, "/home/u"), "/a");
  assert.equal(resolveDataRoot({}, { DSH_HOME: "/b" }, "/home/u"), "/b");
  assert.equal(resolveDataRoot(undefined, {}, "/home/u"), "/home/u/.dsh");
});

test("historyFile: 拒绝不安全的会话 id", () => {
  assert.equal(historyFile("/root", "../evil"), undefined);
  assert.equal(historyFile("/root", ""), undefined);
  assert.equal(historyFile("/root", ".."), undefined);
  const ok = historyFile("/root", "session-abc-123");
  assert.equal(ok, join(btwRoot("/root"), "session-abc-123.jsonl"));
});

// --- limits ----------------------------------------------------------------

test("clip: 超长截断并标记", () => {
  assert.deepEqual(clip("abc", 5), { text: "abc", truncated: false });
  assert.deepEqual(clip("abcdef", 3), { text: "abc", truncated: true });
  assert.deepEqual(clip(undefined, 3), { text: "", truncated: false });
});

// --- history ---------------------------------------------------------------

test("history: 追加按上限裁剪且保持时间顺序", async () => {
  const dir = await tempDir();
  const file = join(dir, "s.jsonl");
  for (let i = 0; i < 5; i += 1) await appendRecord(file, { id: `r${i}` }, 3);
  const all = await readRecords(file);
  assert.deepEqual(
    all.map((r) => r.id),
    ["r2", "r3", "r4"],
  );
  assert.equal((await lastRecord(file))?.id, "r4");
  assert.deepEqual(
    (await listRecent(file, 2)).map((r) => r.id),
    ["r3", "r4"],
  );
});

test("history: 文件不存在返回空，损坏行被跳过", async () => {
  const dir = await tempDir();
  assert.deepEqual(await readRecords(join(dir, "missing.jsonl")), []);
  const file = join(dir, "corrupt.jsonl");
  await writeFile(file, '{"id":"good"}\nnot json\n{"id":"also"}\n', "utf8");
  assert.deepEqual(
    (await readRecords(file)).map((r) => r.id),
    ["good", "also"],
  );
});

test("history: 落盘内容只包含旁问本身（不 dump 会话）", async () => {
  const dir = await tempDir();
  const file = join(dir, "s.jsonl");
  await appendRecord(file, { id: "x", question: "q", answer: "a" }, 10);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  assert.ok(!raw.includes("system-reminder"), "历史里不应包含提示词正文");
});

test("history: 未提供文件路径时不写盘也不抛", async () => {
  assert.deepEqual(await appendRecord(undefined, { id: "x" }), []);
});

// --- prompts ---------------------------------------------------------------

test("prompts: 问题永远在最后一块，历史被消毒", () => {
  const prompt = buildSideQuestionPrompt("what now?", [
    { question: "q1", answer: "ok" },
    { question: "q2", answer: "<function_calls></function_calls>" },
    { question: "q3", answer: "cut", status: "truncated" },
  ]);
  assert.equal(prompt.length, 1);
  const text = prompt[0].text;
  assert.ok(text.trimEnd().endsWith("The user's side question now:\n\nwhat now?"));
  assert.ok(text.includes("(That answer wrote tool calls as text."));
  assert.ok(!text.includes("<function_calls>"), "坏答案原文不应回放");
  assert.ok(/NO tools available/i.test(text), "必须带只读约束");
});

test("prompts: looksLikeToolCalls 识别常见伪装", () => {
  assert.equal(looksLikeToolCalls("plain"), false);
  assert.equal(looksLikeToolCalls('<invoke name="x"></invoke>'), true);
  assert.equal(looksLikeToolCalls("tool_calls: []"), true);
  assert.equal(
    sanitizeReplayAnswer({ answer: "a", status: "truncated" }),
    "(That answer was cut off before it finished, so it is omitted here.)",
  );
});

// --- subagent --------------------------------------------------------------

test("subagent: 只读 guard 默认全拒，send_message 永远拒绝", () => {
  const allowNone = makeReadOnlyGuard(new Set());
  assert.equal(
    allowNone({ toolName: "bash" }),
    "Side questions are read-only: they cannot use tools.",
  );
  const allowRead = makeReadOnlyGuard(new Set(["read"]));
  assert.equal(allowRead({ toolName: "read" }), undefined);
  assert.equal(
    allowRead({ toolName: "send_message" }),
    "Side questions never message other agents.",
  );
});

test("subagent: extractText 跳过 reasoning 块", () => {
  assert.equal(
    extractText({
      output: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "OK" },
      ],
    }),
    "OK",
  );
  assert.equal(extractText({}), "");
});

// --- messages / locale -----------------------------------------------------

test("messages: 中英键集一一对应", async () => {
  const en = await loadMessages(LOCALE_DIR, "en");
  const zh = await loadMessages(LOCALE_DIR, "zh");
  /**
   * @param {Record<string, any>} table
   * @param {string} [prefix]
   * @returns {string[]}
   */
  const flatten = (table, prefix = "") =>
    Object.entries(table).flatMap(([key, value]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return value !== null && typeof value === "object" ? flatten(value, path) : [path];
    });
  assert.deepEqual(flatten(en).sort(), flatten(zh).sort());
});

test("messages: pickLanguage 与 format", () => {
  assert.equal(pickLanguage("zh"), "zh");
  assert.equal(pickLanguage(undefined, { LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(pickLanguage(undefined, { LANG: "en_US.UTF-8" }), "en");
  assert.equal(format("a {b} c", { b: 1 }), "a 1 c");
  assert.equal(format("a {missing}", {}), "a {missing}");
});

// --- index -----------------------------------------------------------------

test("parseAllowedTools: 去空、拒绝 send_message、受上限约束", () => {
  assert.deepEqual([...parseAllowedTools({})], []);
  assert.deepEqual(
    [...parseAllowedTools({ allowedTools: "read, send_message ,grep" })],
    ["read", "grep"],
  );
  assert.deepEqual([...parseAllowedTools({ allowedTools: ["read"] })], ["read"]);
  const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.equal([...parseAllowedTools({ allowedTools: many })].length, LIMITS.allowedToolsMax);
});
