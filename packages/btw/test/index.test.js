// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { renderBadge, renderScopeInstruction } from "../lib/badge.js";
import { parseAllowedTools } from "../lib/config.js";
import { appendRecord, lastRecord, listRecent, readRecords } from "../lib/history.js";
import { clip, LIMITS } from "../lib/limits.js";
import { format, loadMessages, pickLanguage } from "../lib/messages.js";
import { btwRoot, historyFile, resolveDataRoot } from "../lib/paths.js";
import {
  buildSideQuestionPrompt,
  looksLikeToolCalls,
  sanitizeReplayAnswer,
} from "../lib/prompts.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  settingsPath,
} from "../lib/settings.js";
import { extractText, makeReadOnlyGuard } from "../lib/subagent.js";
import {
  extractDetails,
  groupThreads,
  listThreads,
  newThreadId,
  parseCommandArgs,
  parseThreadFlag,
  renderPromoteDraft,
  SCOPES,
  threadHistory,
  threadOf,
} from "../lib/threads.js";

const LOCALE_DIR = new URL("../locale/", import.meta.url).pathname;

/** @returns {Promise<string>} */
/**
 * 建临时目录并**登记回收**。
 *
 * 这里必须登记：早期版本只 mkdtemp 不清理，每跑一次单测就在系统临时目录里留下若干
 * `dsh-btw-test-*`（一个目录一个 `s.jsonl`）。实测泄漏了 720 个、约 189 MB，
 * 是仓库里唯一有该问题的插件（其它插件都是 0）。
 * @type {Set<string>}
 */
const TEMP_DIRS = new Set();
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-btw-test-"));
  TEMP_DIRS.add(dir);
  return dir;
};

after(async () => {
  for (const dir of TEMP_DIRS) await rm(dir, { recursive: true, force: true });
  TEMP_DIRS.clear();
});

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

// --- settings --------------------------------------------------------------

test("settings: 默认值、夹紧与非法输入", () => {
  assert.deepEqual(sanitizeSettings({}), {
    schemaVersion: 1,
    allowedTools: [],
    historyLimit: DEFAULT_SETTINGS.historyLimit,
  });
  const clamped = sanitizeSettings({
    allowedTools: "read, send_message ,read ,grep",
    historyLimit: 9999,
  });
  assert.deepEqual(clamped.allowedTools, ["read", "grep"], "去空、去重、拒绝 send_message");
  assert.equal(clamped.historyLimit, 200, "上限夹到 200");
  assert.equal(sanitizeSettings({ historyLimit: 0 }).historyLimit, 1, "下限夹到 1");
  assert.deepEqual(sanitizeSettings(null).allowedTools, []);
  assert.deepEqual(
    sanitizeSettings({ allowedTools: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }).allowedTools
      .length,
    LIMITS.allowedToolsMax,
    "白名单条数受上限约束",
  );
});

test("settings: 文件缺失返回默认，坏 JSON 静默回落", async () => {
  const dir = await tempDir();
  assert.deepEqual((await loadSettings(dir)).allowedTools, []);
  await mkdir(join(dir, "btw"), { recursive: true });
  await writeFile(settingsPath(dir), "{not json", "utf8");
  assert.deepEqual((await loadSettings(dir)).allowedTools, []);
});

test("settings: 保存是原子替换且只合并已知字段", async () => {
  const dir = await tempDir();
  const saved = await saveSettings(dir, { allowedTools: ["read"], historyLimit: 7, unknown: "x" });
  assert.deepEqual(saved.allowedTools, ["read"]);
  assert.equal(saved.historyLimit, 7);
  assert.ok(!("unknown" in saved), "未知字段被丢弃");
  const reread = await loadSettings(dir);
  assert.deepEqual(reread.allowedTools, ["read"]);
  assert.equal(reread.historyLimit, 7);
  const raw = await readFile(settingsPath(dir), "utf8");
  assert.ok(raw.trim().startsWith("{"), "落盘是 JSON");
});

// --- threads / promote（v0.3 纯逻辑）---------------------------------------

test("threads: 老记录没有 threadId 时用自身 id 当单条线程", () => {
  assert.equal(threadOf({ id: "btw_1" }), "btw_1");
  assert.equal(threadOf({ id: "btw_1", threadId: "t_x" }), "t_x");
  assert.equal(threadOf({}), "t_unknown");
  assert.equal(threadOf(null), "t_unknown");
});

test("threads: 分组保持线程内正序、线程间按最后时间正序", () => {
  const records = [
    { id: "a", at: 1 },
    { id: "b", at: 2, threadId: "a" },
    { id: "c", at: 3 },
  ];
  const groups = groupThreads(records);
  assert.deepEqual(
    groups.map((g) => g.threadId),
    ["a", "c"],
  );
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].last.id, "b");
  assert.deepEqual(groupThreads([]), []);
  assert.deepEqual(groupThreads(/** @type {any} */ (null)), []);
});

test("threads: threadHistory 只取本线程且受轮数上限约束", () => {
  const records = [
    { id: "a", at: 1, question: "q1" },
    { id: "x", at: 2, question: "other" },
    { id: "b", at: 3, threadId: "a", question: "q2" },
  ];
  assert.deepEqual(
    threadHistory(records, "a").map((r) => r.id),
    ["a", "b"],
  );
  assert.deepEqual(threadHistory(records, "missing"), []);
  assert.equal(threadHistory(records, "a", 1).length, 1);
});

test("threads: parseThreadFlag 解析追问标记，普通问题原样返回", () => {
  assert.deepEqual(parseThreadFlag("--thread t_abc 它在哪个目录"), {
    threadId: "t_abc",
    question: "它在哪个目录",
  });
  assert.deepEqual(parseThreadFlag("普通问题"), { threadId: "", question: "普通问题" });
  assert.deepEqual(parseThreadFlag("  --thread   t_x   多空格  "), {
    threadId: "t_x",
    question: "多空格",
  });
  assert.deepEqual(parseThreadFlag("--thread t_only"), { threadId: "t_only", question: "" });
  assert.deepEqual(parseThreadFlag(""), { threadId: "", question: "" });
});

test("threads: listThreads 倒序且带轮数与首问", () => {
  const records = [
    { id: "a", at: 10, question: "first", answer: "A1" },
    { id: "b", at: 20, threadId: "a", question: "second", answer: "A2" },
    { id: "c", at: 30, question: "newer", answer: "C1" },
  ];
  const threads = listThreads(records);
  assert.deepEqual(
    threads.map((t) => t.threadId),
    ["c", "a"],
  );
  assert.equal(threads[1].turns, 2);
  assert.equal(threads[1].question, "first", "首问");
  assert.equal(threads[1].answer, "A2", "最后一条答案");
});

test("threads: newThreadId 稳定且带前缀", () => {
  const id = newThreadId(1700000000000, () => 0.5);
  assert.match(id, /^t_[0-9a-z]+_[0-9a-z]{4}$/);
  assert.equal(
    id,
    newThreadId(1700000000000, () => 0.5),
    "同输入同输出（可测）",
  );
  assert.notEqual(
    id,
    newThreadId(1700000000001, () => 0.5),
  );
});

test("promote: 草稿是四节模板，只生成文本不发送", () => {
  const draft = renderPromoteDraft({ question: "配置文件叫什么？", answer: "config.json" });
  assert.ok(draft.includes("## 我问了什么"));
  assert.ok(draft.includes("配置文件叫什么？"));
  assert.ok(draft.includes("## 结论"));
  assert.ok(draft.includes("config.json"));
  assert.ok(!draft.includes("## 关键细节"), "没传 details 就不出现该节");
  const withExtra = renderPromoteDraft(
    { question: "q", answer: "a" },
    { details: "d", unresolved: "u" },
  );
  assert.ok(withExtra.includes("## 关键细节"));
  assert.ok(withExtra.includes("## 仍未解决"));
  const en = renderPromoteDraft({ question: "q", answer: "a" }, { lang: "en" });
  assert.ok(en.includes("## What I asked"));
});

test("promote: 草稿按上限截断并加省略号", () => {
  const long = "x".repeat(9000);
  const draft = renderPromoteDraft({ question: "q", answer: long }, { maxChars: 500 });
  assert.ok(draft.length <= 500, `长度 ${draft.length} 应 <= 500`);
  assert.ok(draft.endsWith("…"));
});

test("promote: 空答案也产出可编辑骨架（不抛）", () => {
  const draft = renderPromoteDraft({});
  assert.ok(draft.includes("## 结论"));
  assert.ok(draft.includes("—"), "空值用破折号占位");
});

test("promote: extractDetails 只挑列表项与代码围栏", () => {
  const details = extractDetails("- 一\n普通句子\n- 二\n```js\ncode\n```", 3);
  assert.deepEqual(details, ["- 一", "- 二", "```js"]);
  assert.deepEqual(extractDetails("", 3), []);
});

// --- badge（v0.3 上下文徽章）-----------------------------------------------

test("badge: 必须如实写明模型可见完整会话，不能假装限制了上下文", () => {
  const zh = renderBadge({ records: 3 });
  assert.ok(zh.includes("基于 3 条旁问记录"));
  assert.ok(zh.includes("模型可见完整会话"), "诚实原则：必须写明这点");
  assert.ok(zh.includes("范围只约束回答"));
  const en = renderBadge({ records: 1, lang: "en" });
  assert.ok(en.includes("Based on 1 side-question record"));
  assert.ok(en.includes("can see the whole conversation"));
});

test("badge: 空记录、范围附加、非法输入都不抛", () => {
  assert.ok(renderBadge({ records: 0 }).includes("还没有旁问"));
  const scoped = renderBadge({ records: 3, scope: "最近 2 轮" });
  assert.ok(scoped.includes("已要求只看：最近 2 轮"));
  assert.ok(renderBadge().includes("还没有旁问"), "无参数也不抛");
  assert.ok(renderBadge({ records: -5 }).includes("还没有旁问"), "负数夹到 0");
});

test("badge: 范围指令是建议性的，要说明可看到全部", () => {
  const text = renderScopeInstruction("最近 2 轮");
  assert.ok(text.includes("advisory only"));
  assert.ok(text.includes("you can see the whole session"));
  assert.ok(text.includes("最近 2 轮"));
  assert.equal(renderScopeInstruction(""), "");
  assert.equal(renderScopeInstruction("   "), "");
});

// --- 范围档位与轮数上限（v0.3 第 4 步收尾）--------------------------------

test("scope: parseCommandArgs 解析 --thread / --scope，问题可取整段", () => {
  assert.deepEqual(parseCommandArgs("--thread t_1 --scope recent 它在哪个目录"), {
    threadId: "t_1",
    scope: "recent",
    question: "它在哪个目录",
  });
  assert.deepEqual(parseCommandArgs("--scope selection 只看这一段"), {
    threadId: "",
    scope: "selection",
    question: "只看这一段",
  });
  assert.deepEqual(parseCommandArgs("普通问题"), {
    threadId: "",
    scope: "",
    question: "普通问题",
  });
  assert.deepEqual(parseCommandArgs("--scope bogus 问题").scope, "", "非法档位被丢弃");
  assert.equal(parseCommandArgs("").question, "");
});

test("scope: SCOPES 是封闭枚举", () => {
  assert.deepEqual(SCOPES, ["session", "recent", "selection"]);
});

test("prompts: 只有传了范围才把范围指令写进提示词", async () => {
  const plain = JSON.stringify(buildSideQuestionPrompt("q", []));
  assert.ok(!plain.includes("Scope requested"), "没范围就不该出现指令");
  const scoped = JSON.stringify(buildSideQuestionPrompt("q", [], "recent"));
  assert.ok(scoped.includes("Scope requested"), "有范围才出现");
  assert.ok(scoped.includes("advisory only"), "必须写成建议，不能声称裁剪上下文");
});
