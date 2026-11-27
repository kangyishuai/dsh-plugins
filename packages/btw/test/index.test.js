// @ts-check
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { renderBadge, renderScopeInstruction } from "../lib/badge.js";
import {
  buildBoundedDigest,
  buildBoundedPrompt,
  collectBoundedEvents,
  extractBoundedMessages,
  isBoundedEligible,
} from "../lib/bounded.js";
import { parseAllowedTools } from "../lib/config.js";
import {
  buildCostHint,
  COST_RATIO_HIGH,
  COST_RATIO_LOW,
  formatCostHintLine,
  lastPromptTokens,
  promptTokensOfCost,
} from "../lib/cost-hint.js";
import { formatDuration, formatTokens } from "../lib/format.js";
import { appendRecord, lastRecord, listRecent, readRecords } from "../lib/history.js";
import { clip, LIMITS } from "../lib/limits.js";
import { inlineText, parseMarkdown, truncateMarkdown } from "../lib/markdown.js";
import {
  flattenMessages,
  format,
  loadMessages,
  loadMessagesSync,
  mapMessages,
  pickLanguage,
} from "../lib/messages.js";
import { btwRoot, historyFile, resolveDataRoot } from "../lib/paths.js";
import {
  buildSideQuestionPrompt,
  looksLikeToolCalls,
  sanitizeReplayAnswer,
} from "../lib/prompts.js";
import {
  buildSettingsPatch,
  DEFAULT_SETTINGS,
  HISTORY_LIMIT_MAX,
  HISTORY_LIMIT_MIN,
  historyLimitOf,
  loadSettings,
  readHistoryLimit,
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
  promoteRecordForThread,
  renderPromoteDraft,
  renderThreadDetails,
  SCOPES,
  threadHistory,
  threadOf,
  threadTurn,
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

test("history: 同一文件并发 append 不丢记录（同会话两次 /btw）", async () => {
  const dir = await tempDir();
  const file = join(dir, "s.jsonl");
  // 读全量 → push → 整体重写，之前并发三条只会剩下最后一条（后写覆盖前写）。
  const results = await Promise.all([
    appendRecord(file, { id: "a" }, 50),
    appendRecord(file, { id: "b" }, 50),
    appendRecord(file, { id: "c" }, 50),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(
    (await readRecords(file)).map((record) => record.id),
    ["a", "b", "c"],
    "并发写入必须串行化，不能互相覆盖",
  );
  // 临时文件必须唯一且都被 rename 掉，不能留残骸
  const left = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(left, []);
});

test("history: 并发 append 时 lastRecord 仍是最后一条", async () => {
  const dir = await tempDir();
  const file = join(dir, "s.jsonl");
  await Promise.all(Array.from({ length: 6 }, (_, i) => appendRecord(file, { id: `r${i}` }, 50)));
  assert.equal((await readRecords(file)).length, 6);
  assert.equal((await lastRecord(file))?.id, "r5");
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

test("messages: 嵌套 locale 被摊平成 host 半可用的平面键（英文 FALLBACK 的根因）", async () => {
  const zh = await loadMessages(LOCALE_DIR, "zh");
  const en = await loadMessages(LOCALE_DIR, "en");
  // 关键回归：嵌套对象若被原样 merge 进去，这些平面键会全部缺失，界面/命令结果永远是英文。
  assert.match(zh.description, /只读旁问/u, "命令 description 应是中文");
  assert.match(zh.hint, /问题/u);
  assert.match(zh.meta, /命中缓存/u);
  assert.match(zh.panelOnly, /旁问面板/u);
  assert.match(zh.threadFull, /线程已满/u);
  assert.equal(zh.noHistory, "本会话还没有旁问记录。");
  assert.ok(en.description.startsWith("Ask a read-only"), en.description);
  assert.match(en.meta, /cached/u);
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, "string", `${key} 必须是字符串，不能是嵌套对象`);
    assert.ok(value !== "", `${key} 不能是空串`);
  }
  // 所有 FALLBACK 键都必须被映射到（新增 host 文案时漏映射会在这里红）。
  const mapped = Object.keys(zh).sort();
  assert.deepEqual(mapped, Object.keys(en).sort());
  assert.ok(mapped.includes("description") && mapped.includes("threadFull"));
});

test("messages: 同步加载器与异步加载器结果一致（host 半注册命令前要用同步版）", async () => {
  for (const lang of /** @type {("zh" | "en")[]} */ (["zh", "en"])) {
    const sync = loadMessagesSync(LOCALE_DIR, lang);
    const async = await loadMessages(LOCALE_DIR, lang);
    assert.deepEqual(sync, async);
  }
});

test("messages: 原始 locale 文件的中英 key 集一一对应（含未映射的展示文案）", async () => {
  /** @param {"zh" | "en"} lang */
  const raw = async (lang) =>
    flattenMessages(JSON.parse(await readFile(join(LOCALE_DIR, `${lang}.json`), "utf8")));
  const zh = Object.keys(await raw("zh")).sort();
  const en = Object.keys(await raw("en")).sort();
  assert.deepEqual(zh, en);
});

test("messages: 已是平面键的字典也能映射（兼容未来简化格式）", () => {
  const flat = mapMessages({
    description: "d",
    hint: "h",
    meta: "m",
    threadFull: "t",
  });
  assert.deepEqual(flat, { description: "d", hint: "h", threadFull: "t", meta: "m" });
  // 坏形状不炸：非对象、缺键都只是少几个文案。
  assert.deepEqual(mapMessages(null), {});
  assert.deepEqual(mapMessages({ btw: { command: { description: 42 } } }), {});
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
    echoAnswer: true,
    boundedContext: false,
  });
  const clamped = sanitizeSettings({
    allowedTools: "read, send_message ,read ,grep",
    historyLimit: 9999,
  });
  assert.deepEqual(clamped.allowedTools, ["read", "grep"], "去空、去重、拒绝 send_message");
  assert.equal(clamped.historyLimit, 200, "上限夹到 200");
  assert.equal(sanitizeSettings({ historyLimit: 0 }).historyLimit, 1, "下限夹到 1");
  assert.equal(sanitizeSettings({ echoAnswer: false }).echoAnswer, false, "显式关闭");
  assert.equal(sanitizeSettings({ echoAnswer: "false" }).echoAnswer, true, "非布尔值不轻信");
  assert.equal(sanitizeSettings({}).boundedContext, false, "bounded 默认关");
  assert.equal(sanitizeSettings({ boundedContext: true }).boundedContext, true, "显式开启");
  assert.equal(
    sanitizeSettings({ boundedContext: "true" }).boundedContext,
    false,
    "bounded 只认显式 true",
  );
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

test("settings: updateSettings 的补丁包含 echoAnswer（真机漏字段回归）", () => {
  assert.deepEqual(buildSettingsPatch({ echoAnswer: false }), { echoAnswer: false });
  assert.deepEqual(buildSettingsPatch({ echoAnswer: true, unknown: 1 }), { echoAnswer: true });
  assert.deepEqual(buildSettingsPatch({ allowedTools: ["read"], historyLimit: 7 }), {
    allowedTools: ["read"],
    historyLimit: 7,
  });
  assert.deepEqual(buildSettingsPatch(undefined), {});
});

test("settings: 保存是原子替换且只合并已知字段", async () => {
  const dir = await tempDir();
  const saved = await saveSettings(dir, {
    allowedTools: ["read"],
    historyLimit: 7,
    echoAnswer: false,
    unknown: "x",
  });
  assert.deepEqual(saved.allowedTools, ["read"]);
  assert.equal(saved.historyLimit, 7);
  assert.equal(saved.echoAnswer, false);
  assert.ok(!("unknown" in saved), "未知字段被丢弃");
  const reread = await loadSettings(dir);
  assert.deepEqual(reread.allowedTools, ["read"]);
  assert.equal(reread.historyLimit, 7);
  assert.equal(reread.echoAnswer, false);
  const raw = await readFile(settingsPath(dir), "utf8");
  assert.ok(raw.trim().startsWith("{"), "落盘是 JSON");
});

test("settings: historyLimit 的 1–200 边界只有一个来源，服务端读到的就是保存值", async () => {
  assert.equal(HISTORY_LIMIT_MIN, 1);
  assert.equal(HISTORY_LIMIT_MAX, 200);
  assert.equal(historyLimitOf(undefined), LIMITS.perSessionRecords, "没有设置时用默认值");
  assert.equal(historyLimitOf({ historyLimit: 7 }), 7);
  assert.equal(historyLimitOf({ historyLimit: "12" }), 12, "设置面板可能传字符串");
  assert.equal(historyLimitOf({ historyLimit: 0 }), HISTORY_LIMIT_MIN, "下限夹到 1");
  assert.equal(historyLimitOf({ historyLimit: 10_000 }), HISTORY_LIMIT_MAX, "上限夹到 200");
  assert.equal(historyLimitOf({ historyLimit: "abc" }), LIMITS.perSessionRecords, "非法值回落默认");

  const dir = await tempDir();
  assert.equal(await readHistoryLimit(dir), LIMITS.perSessionRecords, "无设置文件时用默认值");
  await saveSettings(dir, { historyLimit: 7 });
  assert.equal(await readHistoryLimit(dir), 7, "服务端读到的就是设置页保存的值（死设置回归）");
  await writeFile(settingsPath(dir), JSON.stringify({ historyLimit: 0 }), "utf8");
  assert.equal(await readHistoryLimit(dir), HISTORY_LIMIT_MIN, "越界值按下限夹紧");
});

test("history: 降低 historyLimit 后读侧立即只返回 N 条，下次写入物理裁掉", async () => {
  const dir = await tempDir();
  const file = join(dir, "s.jsonl");
  for (let i = 0; i < 8; i += 1) await appendRecord(file, { id: `r${i}` }, 50);
  assert.equal((await readRecords(file)).length, 8);
  // 读侧用配置值：设置一保存就只展示最后 N 条，不需要先全盘重写历史文件。
  assert.deepEqual(
    (await listRecent(file, 3)).map((record) => record.id),
    ["r5", "r6", "r7"],
  );
  // 下一次旁问落盘时按新上限裁剪（appendRecord 的 limit 来自同一条设置）。
  await appendRecord(file, { id: "r8" }, 3);
  assert.deepEqual(
    (await readRecords(file)).map((record) => record.id),
    ["r6", "r7", "r8"],
  );
});

test("service: 服务端历史读写都用设置里的 historyLimit（死设置回归）", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "lib", "service.js"), "utf8");
  assert.equal(
    (source.match(/LIMITS\.perSessionRecords/g) ?? []).length,
    0,
    "service.js 不能再硬编码 perSessionRecords：那样 historyLimit 就是可改、可存、但永不生效的死设置",
  );
  assert.ok(
    (source.match(/readHistoryLimit\(/g) ?? []).length >= 4,
    "history 读写路径（history/stats/threads/promote/costHint）都要读配置上限",
  );
  assert.ok(
    source.includes("historyLimitOf(") && source.includes("appendRecord(file, record,"),
    "handle() 落盘时要用设置里的上限",
  );
});

// --- 旁问成本提示（Phase 1，纯逻辑）-----------------------------------------

test("cost-hint: 拿不到 pressure 就是 unknown，不伪造 0", () => {
  assert.equal(buildCostHint({}).level, "unknown");
  assert.equal(buildCostHint({ pressureTokens: 0 }).level, "unknown");
  assert.equal(buildCostHint({ pressureTokens: Number.NaN }).level, "unknown");
  const unknown = buildCostHint({ pressureTokens: undefined, lastActualPromptTokens: 1234 });
  assert.equal(unknown.level, "unknown");
  assert.equal(unknown.lastActualPromptTokens, 1234, "上次实际值仍保留");
  assert.equal(unknown.pressureTokens, undefined);
});

test("cost-hint: 阈值边界与 0.75–1.2 倍区间", () => {
  const below = buildCostHint({ pressureTokens: LIMITS.pressureWarnTokens - 1 });
  assert.equal(below.level, "ok");
  assert.equal(below.threshold, LIMITS.pressureWarnTokens);
  const at = buildCostHint({ pressureTokens: LIMITS.pressureWarnTokens });
  assert.equal(at.level, "warn");
  assert.equal(at.pressureTokens, LIMITS.pressureWarnTokens);
  assert.equal(at.estimatedLow, Math.round(LIMITS.pressureWarnTokens * COST_RATIO_LOW));
  assert.equal(at.estimatedHigh, Math.round(LIMITS.pressureWarnTokens * COST_RATIO_HIGH));
  assert.equal(COST_RATIO_LOW, 0.75);
  assert.equal(COST_RATIO_HIGH, 1.2);
  assert.equal(LIMITS.pressureWarnTokens, 250_000);
  // 自定义阈值
  assert.equal(buildCostHint({ pressureTokens: 1000, threshold: 500 }).level, "warn");
  assert.equal(
    buildCostHint({ pressureTokens: 1000, threshold: 0 }).threshold,
    LIMITS.pressureWarnTokens,
  );
});

test("cost-hint: prompt 总量 = 新增 + 命中缓存，取最近一条有 cost 的记录", () => {
  assert.equal(promptTokensOfCost({ inputTokens: 100, cacheReadTokens: 900 }), 1000);
  assert.equal(promptTokensOfCost({ inputTokens: 5, cacheReadTokens: 0 }), 5);
  assert.equal(promptTokensOfCost(null), null);
  assert.equal(promptTokensOfCost({}), null);
  assert.equal(promptTokensOfCost({ inputTokens: -1 }), null);
  const records = [
    { cost: { inputTokens: 1000, cacheReadTokens: 0 } },
    { cost: null },
    { question: "no cost yet" },
    { cost: { inputTokens: 200, cacheReadTokens: 800 } },
  ];
  assert.equal(lastPromptTokens(records), 1000);
  assert.equal(lastPromptTokens([]), null);
  assert.equal(lastPromptTokens([{ cost: null }]), null);
});

test("cost-hint: 渲染成一行时只给区间 + 上次实际，ok/unknown 不出现", () => {
  const zh = {
    costWarn: "上下文约 {pressure} tokens（约 {low}–{high}）",
    costLast: "上次实际 {tokens} tokens。",
  };
  const warn = buildCostHint({ pressureTokens: 300_000, lastActualPromptTokens: 260_000 });
  const line = formatCostHintLine(warn, zh);
  assert.match(line, /^⚠ 上下文约 300K tokens/u);
  assert.match(line, /225K–360K/u);
  assert.match(line, /上次实际 260K tokens/u);
  assert.equal(
    formatCostHintLine({ ...warn, lastActualPromptTokens: null }, zh).includes("上次实际"),
    false,
  );
  assert.equal(
    formatCostHintLine(/** @type {any} */ ({ level: "ok", pressureTokens: 10 }), zh),
    "",
  );
  assert.equal(formatCostHintLine(null, zh), "");
  assert.equal(formatCostHintLine(undefined, zh), "");
});

test("cost-hint: locale 译文已映射（中文/英文都能取到）", async () => {
  const zh = await loadMessages(LOCALE_DIR, "zh");
  const en = await loadMessages(LOCALE_DIR, "en");
  assert.match(zh.costWarn, /本会话上下文约 \{pressure\} tokens/u);
  assert.match(zh.costWarn, /0\.75–1\.2 倍/u);
  assert.match(zh.costLast, /上次实际 \{tokens\}/u);
  assert.match(en.costWarn, /forks the whole session/u);
  assert.match(en.costLast, /Last actual: \{tokens\}/u);
  assert.equal(format(zh.costLast, { tokens: 1234 }), "上次实际 1234 tokens。");
});

// --- bounded-context（ADR-0022 纯逻辑）------------------------------------

test("bounded: 只抽真实用户消息与 assistant 文本，过滤 reminder/工具块", () => {
  const events = [
    {
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "第一个问题" }] },
    },
    {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "<system-reminder>注入</system-reminder>" }],
      },
    },
    {
      type: "user/message",
      data: {
        source: { kind: "github-picker-mention" },
        content: [{ type: "text", text: "mention" }],
      },
    },
    {
      type: "assistant/message",
      data: {
        message: {
          content: [
            { type: "reasoning", text: "内部推理" },
            { type: "tool-call", name: "bash", arguments: "{}" },
            { type: "text", text: "第一个回答" },
          ],
        },
      },
    },
    {
      type: "assistant/message",
      data: { message: { content: [{ type: "tool-call", name: "x" }] } },
    },
    { type: "tool/result", data: { content: [{ type: "text", text: "工具输出" }] } },
  ];
  assert.deepEqual(extractBoundedMessages(events), [
    { role: "User", text: "第一个问题" },
    { role: "Assistant", text: "第一个回答" },
  ]);
});

test("bounded: digest 保留最近 N 条并压到总字符预算", () => {
  const events = [];
  for (let i = 0; i < 30; i += 1) {
    events.push({
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: `问题 ${i}` }] },
    });
    events.push({
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: `回答 ${i}` }] } },
    });
  }
  const digest = buildBoundedDigest(events, {
    maxMessages: 4,
    maxCharsPerMessage: 20,
    maxTotalChars: 200,
  });
  assert.equal(digest.messages, 4);
  assert.equal(digest.truncated, true);
  assert.ok(digest.text.includes("问题 29"));
  assert.ok(!digest.text.includes("问题 20"), "更早的消息应被裁掉");
  assert.ok(digest.chars <= 200 + 100, `总字符应受预算约束，实际 ${digest.chars}`);
});

test("bounded: 单条超长消息按字符截断并加省略号", () => {
  const events = [
    {
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "字".repeat(200) }] },
    },
  ];
  const digest = buildBoundedDigest(events, {
    maxMessages: 4,
    maxCharsPerMessage: 50,
    maxTotalChars: 4000,
  });
  assert.equal([...digest.text].filter((c) => c === "字").length, 50);
  assert.ok(digest.text.endsWith("…"));
  assert.equal(digest.messages, 1);
});

test("bounded: prompt 含裁剪声明、excerpt、线程历史，问题在末尾", () => {
  const prompt = buildBoundedPrompt(
    "这次要问什么？",
    { text: "User: 早先的问题\n\nAssistant: 早先的回答" },
    {
      history: [{ question: "旧旁问", answer: "旧旁答" }],
    },
  );
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0].type, "text");
  assert.match(prompt[0].text, /trimmed excerpt/u);
  assert.match(prompt[0].text, /no tools/iu);
  assert.match(prompt[0].text, /User: 早先的问题/u);
  assert.match(prompt[0].text, /旧旁问/u);
  assert.ok(prompt[0].text.trimEnd().endsWith("这次要问什么？"));
  // 无消息时也不抛，并明确说没有可用消息
  const empty = buildBoundedPrompt("q", { text: "" });
  assert.match(empty[0].text, /no recent messages available/u);
});

test("bounded: 不 eligible 时完全不物化父会话事件（长会话性能，AUD-BTW-07）", () => {
  let calls = 0;
  const session = {
    seq: 50_000,
    snapshotEvents: () => {
      calls += 1;
      return [];
    },
  };
  assert.deepEqual(collectBoundedEvents(session, false), { events: [] });
  assert.equal(calls, 0, "bounded 没开时不能先 snapshotEvents() 全量再筛 12 条");
  // 开关与阈值都来自设置：默认关；到 400K tokens 才算 eligible
  assert.equal(isBoundedEligible(undefined, 999_999), false);
  assert.equal(isBoundedEligible({ boundedContext: false }, 999_999), false);
  assert.equal(isBoundedEligible({ boundedContext: true }, LIMITS.boundedTriggerTokens - 1), false);
  assert.equal(isBoundedEligible({ boundedContext: true }, LIMITS.boundedTriggerTokens), true);
});

test("bounded: eligible 时全量取一次事件，且不截尾窗（复审 BLK-1 回归）", () => {
  /** @type {any[]} */
  const events = [];
  for (let i = 0; i < 400; i += 1) {
    events.push({
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: `q${i}` }] },
    });
    events.push({
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: `a${i}` }] } },
    });
  }
  /** @type {any[][]} */
  const calls = [];
  const session = {
    seq: events.length,
    snapshotEvents: (/** @type {any[]} */ ...args) => {
      calls.push(args);
      return events;
    },
  };
  const collected = collectBoundedEvents(session, true);
  // 必须是「全量取」：带 fromSeq 的尾部窗口在真实事件配比下凑不满 12 条消息（BLK-1）。
  assert.deepEqual(calls, [[]], "snapshotEvents() 必须不带参数（全量），不能偷偷截尾窗");
  assert.equal(collected.events.length, events.length);
  const digest = buildBoundedDigest(collected.events);
  assert.equal(digest.messages, LIMITS.boundedMessages);
  assert.ok(digest.text.includes("q399"), "最近的消息仍在 digest 里");
});

test("bounded: 真实事件配比（消息之间夹 step/tool/job）也能凑满 12 条消息", () => {
  // 复审 BLK-1 的实测口径：长会话里每条消息之间夹着 step/tool/job 事件，
  // 「最近 12 条消息」在事件轴上跨得很远（p50≈586 条事件）。尾窗 80 只能拿到 p50=5 条。
  /** @type {any[]} */
  const events = [];
  for (let turn = 0; turn < 120; turn += 1) {
    events.push({
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: `问题 ${turn}` }] },
    });
    events.push({ type: "step/start", data: { step: 1 } });
    events.push({ type: "tool/call", data: { name: "read", id: `c${turn}` } });
    events.push({ type: "tool/result", data: { id: `c${turn}` } });
    events.push({
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: `回答 ${turn}` }] } },
    });
    events.push({ type: "step/end", data: { step: 1 } });
    events.push({ type: "job/registered", data: { id: `j${turn}` } });
  }
  // 会话尾部再挂 500 个纯 tool/step 事件：真实会话常见（工具批量跑完才回复）。
  for (let i = 0; i < 500; i += 1) events.push({ type: "tool/result", data: { id: `tail${i}` } });

  // 假会话要像宿主的 snapshotEvents(fromSeq) 那样真的切片：否则尾窗实现测不出来。
  const session = {
    seq: events.length,
    snapshotEvents: (/** @type {number} */ from = 0) => events.slice(from),
  };
  const digest = buildBoundedDigest(collectBoundedEvents(session, true).events);
  assert.equal(digest.messages, LIMITS.boundedMessages, "必须凑满 12 条消息（尾窗会掉到 0–5 条）");
  assert.ok(digest.text.includes("问题 119"), "保留的是最近的用户消息");
  const tailOnly = buildBoundedDigest(events.slice(-80));
  assert.equal(
    tailOnly.messages,
    0,
    "旧尾窗 80 在这条流上一条消息都拿不到（BLK-1 的 5.1% 静默 fork 场景）",
  );
});

test("bounded: 没有 snapshotEvents / 抛错都降级为空", () => {
  const small = { seq: 3, snapshotEvents: () => [{}, {}, {}] };
  assert.equal(collectBoundedEvents(small, true).events.length, 3);
  assert.deepEqual(collectBoundedEvents({}, true), { events: [] });
  assert.deepEqual(
    collectBoundedEvents(
      {
        seq: 10,
        snapshotEvents: () => {
          throw new Error("boom");
        },
      },
      true,
    ),
    { events: [] },
  );
  assert.deepEqual(collectBoundedEvents(undefined, true), { events: [] });
});

test("service: bounded 只在 eligible 时取事件，不再无条件 snapshotEvents（AUD-BTW-07）", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "lib", "service.js"), "utf8");
  // 只看代码，注释里提到旧实现不算违规
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  assert.equal(
    (code.match(/snapshotEvents/g) ?? []).length,
    0,
    "service.js 必须通过 collectBoundedEvents 取事件（只在 eligible 时），不能自己无条件取",
  );
  assert.ok(source.includes("isBoundedEligible("), "触发条件要与 bounded 模块同一处判定");
  assert.ok(source.includes("collectBoundedEvents("), "取事件要走 bounded 模块（可单测）");
  assert.ok(
    source.includes("falling back to a full fork"),
    "digest 为空退回 full fork 时必须 warn（不能静默降级，复审 BLK-1）",
  );
});

test("bounded: threadTurn 透出 mode（老记录为空 = fork）", () => {
  const turn = threadTurn({ id: "x", question: "q", answer: "a", mode: "bounded" });
  assert.equal(turn.mode, "bounded");
  assert.equal(threadTurn({ id: "y", question: "q", answer: "a" }).mode, "");
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

test("threads: listThreads 旧→新且带完整轮次（panel 是聊天式，最新在下面）", () => {
  const records = [
    { id: "a", at: 10, question: "first", answer: "A1" },
    { id: "b", at: 20, threadId: "a", question: "second", answer: "A2" },
    { id: "c", at: 30, question: "newer", answer: "C1" },
  ];
  const threads = listThreads(records);
  assert.deepEqual(
    threads.map((t) => t.threadId),
    ["a", "c"],
    "旧线程在前、新线程在后",
  );
  assert.equal(threads[0].turns, 2);
  assert.equal(threads[0].question, "first", "首问");
  assert.deepEqual(
    threads[0].items.map((item) => item.question),
    ["first", "second"],
    "线程内全部轮次",
  );
  assert.equal(threads[0].lastId, "b");
  assert.ok(Array.isArray(threads[0].items[0].blocks), "每轮带解析好的 Markdown 块");
});

test("threads: newThreadId 稳定且带前缀", () => {
  const id = newThreadId(1700000000000, () => 0.5);
  // 短 id：`t_` + 时间 36 进制 + 2 位随机（浮层发问会把它带进 composer，越短越不刺眼）
  assert.match(id, /^t_[0-9a-z]+[0-9a-z]{2}$/);
  assert.ok(id.length <= 14, `id 应够短，实际 ${id.length}: ${id}`);
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

test("promote: 线程级转正用首问 + 最后一轮答案", () => {
  const records = [
    { id: "a", at: 1, threadId: "t_x", question: "first", answer: "A1" },
    { id: "b", at: 2, threadId: "t_x", question: "second", answer: "A2" },
  ];
  const record = promoteRecordForThread(records, "t_x");
  assert.equal(record?.question, "first", "标题保留线程首问");
  assert.equal(record?.answer, "A2", "结论取最后一轮答案");
  assert.equal(promoteRecordForThread(records, "missing"), undefined);
  assert.equal(promoteRecordForThread(records, ""), undefined);
});

test("promote: 多轮线程把追问明细放进「关键细节」", () => {
  const records = [
    { id: "a", at: 1, threadId: "t_x", question: "首问", answer: "首答" },
    { id: "b", at: 2, threadId: "t_x", question: "追问一", answer: "追答一" },
    { id: "c", at: 3, threadId: "t_x", question: "追问二", answer: "追答二" },
  ];
  const details = renderThreadDetails(records, "t_x");
  assert.match(details, /### 追问 1/u);
  assert.match(details, /追问一/u);
  assert.match(details, /追答一/u);
  assert.match(details, /### 追问 2/u);
  const record = promoteRecordForThread(records, "t_x");
  assert.equal(record?.question, "首问");
  assert.equal(record?.answer, "追答二");
  const draft = renderPromoteDraft(record, { details, maxChars: 1200 });
  assert.match(draft, /## 关键细节/u);
  assert.match(draft, /追问一/u);
  // 单轮线程没有明细，不会伪造空节
  assert.equal(renderThreadDetails(records.slice(0, 1), "t_x"), "");
});

test("promote: 末答只在「结论」出现一次（USIM-U2-18 去重）", () => {
  const records = [
    { id: "a", at: 1, threadId: "t_x", question: "首问：旁问和主对话有什么区别", answer: "A0" },
    { id: "b", at: 2, threadId: "t_x", question: "追问一：再短一点", answer: "A1" },
    { id: "c", at: 3, threadId: "t_x", question: "追问二：一句话", answer: "A2 末答" },
  ];
  const details = renderThreadDetails(records, "t_x");
  // 末答同时是「结论」，不能在「关键细节」里再贴一遍（审计实测重复把草稿白耗一倍）
  assert.ok(!details.includes("A2 末答"), `末答不应重复出现在关键细节：${details}`);
  assert.ok(details.includes("追问二：一句话"), "最后一轮的问题仍保留（否则不知道结论从哪来");
  assert.ok(details.includes("A1"), "中间轮的答案仍保留（首答之后只有它是细节）");
  const record = promoteRecordForThread(records, "t_x");
  const draft = renderPromoteDraft(record, { details, maxChars: 1200 });
  assert.equal(
    (draft.match(/A2 末答/gu) ?? []).length,
    1,
    `末答在整份草稿里只能出现一次：${draft}`,
  );
  assert.equal((draft.match(/A1/gu) ?? []).length, 1, "中间轮答案出现一次");
  // 关键细节至少保留信息，不能因为去重被整节删掉
  assert.match(draft, /## 关键细节/u);
});

test("promote: 追问答案与末答相同时不重复贴（去重按答案内容，不只按位置）", () => {
  const records = [
    { id: "a", at: 1, threadId: "t_x", question: "q0", answer: "共同答案" },
    { id: "b", at: 2, threadId: "t_x", question: "q1", answer: "共同答案" },
    { id: "c", at: 3, threadId: "t_x", question: "q2", answer: "共同答案" },
  ];
  const details = renderThreadDetails(records, "t_x");
  assert.ok(!details.includes("共同答案"), "与结论相同的答案在细节里全部跳过");
  assert.match(details, /q1/u);
  assert.match(details, /q2/u);
});

test("promote: 草稿是四节 Markdown 模板，只生成文本不发送", () => {
  const draft = renderPromoteDraft({ question: "配置文件叫什么？", answer: "config.json" });
  assert.ok(draft.startsWith("## 我问了什么"), "用 Markdown 标题");
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
  assert.ok(en.startsWith("## What I asked"));
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

test("promote: 草稿保留 Markdown 源码（输入框里是原文，发送后由 DSH 渲染）", () => {
  const draft = renderPromoteDraft({
    question: "CI 跑什么？",
    answer: "**8 个检查**\n\n| 名 | 说明 |\n|---|---|\n| `verify` | 主链 |\n\n- 列表项",
  });
  assert.ok(draft.includes("**8 个检查**"), "粗体源码保留");
  assert.ok(draft.includes("| 名 | 说明 |"), "表格源码保留");
  assert.ok(draft.includes("|---|"), "表格分隔线保留");
  assert.ok(draft.includes("`verify`"), "行内代码保留");
  assert.ok(draft.includes("- 列表项"), "列表符号保留");
  assert.ok(draft.startsWith("## 我问了什么"), "四节标题仍是 Markdown");
});

test("promote: 截断不会把代码围栏留在打开状态", () => {
  const answer = `开头\n\n\`\`\`js\n${"const a = 1;\n".repeat(200)}\`\`\``;
  const draft = renderPromoteDraft({ question: "q", answer }, { maxChars: 300 });
  assert.ok(draft.length <= 300, `长度 ${draft.length} 应 <= 300`);
  const fences = (draft.match(/```/gu) ?? []).length;
  assert.equal(fences % 2, 0, "围栏必须成对（补闭或回退）");
});

test("promote: 草稿长度受 promoteChars 约束（实测 4000 字撑爆输入框）", () => {
  const draft = renderPromoteDraft(
    { question: "q", answer: "x".repeat(5000) },
    { maxChars: LIMITS.promoteChars },
  );
  assert.ok(
    draft.length <= LIMITS.promoteChars,
    `长度 ${draft.length} 应 <= ${LIMITS.promoteChars}`,
  );
  assert.equal(LIMITS.promoteChars, 1200, "默认上限收到 1200");
});

// --- client 半的转正行数预算（源码抽取，避免为 classic script 复制一份逻辑）---------

/**
 * 从 client.js 抽取 `// @testable:begin` … `// @testable:end` 之间的纯函数并在 node 里跑。
 * client 半是 classic script，没有模块导出；复制一份到 lib/ 又会漂移，所以直接测源码本身。
 * @returns {Promise<{ PROMOTE_MAX_LINES: number, estimateDraftLines: (value: string, charsPerLine: number) => number, fitDraftToLines: (value: string, options?: any) => { text: string, truncated: boolean }, compactDraftForComposer: (value: string) => string }>}
 */
async function clientDraftHelpers() {
  const source = await readFile(join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  const begin = source.indexOf("// @testable:begin");
  const end = source.indexOf("// @testable:end");
  assert.ok(begin >= 0 && end > begin, "client.js 必须有 @testable 纯函数块");
  const block = source.slice(begin, end);
  return new Function(
    `${block}\nreturn { PROMOTE_MAX_LINES, estimateDraftLines, fitDraftToLines, compactDraftForComposer };`,
  )();
}

test("client 转正：草稿的行数估算与 6 行预算", async () => {
  const { PROMOTE_MAX_LINES, estimateDraftLines, fitDraftToLines, compactDraftForComposer } =
    await clientDraftHelpers();
  assert.equal(PROMOTE_MAX_LINES, 6, "预算与桌面回归阈值一致");
  assert.equal(estimateDraftLines("", 20), 0);
  assert.equal(estimateDraftLines("短", 20), 1);
  assert.equal(estimateDraftLines("字".repeat(20), 20), 1);
  assert.equal(estimateDraftLines("字".repeat(21), 20), 2);
  assert.equal(estimateDraftLines("a\n\nb", 20), 3, "空行也占一行");

  // 短草稿原样插入（四节 Markdown 不无故被截）
  const short = "## 我问了什么\n配置文件叫什么？\n\n## 结论\nconfig.json";
  const kept = fitDraftToLines(short, { maxLines: 6, charsPerLine: 20 });
  assert.equal(kept.truncated, false);
  assert.equal(kept.text, short);

  // 长草稿压成摘要收进 6 行：保留首问 + 结论开头 + 指回面板，不静默丢内容
  const long = `## 我问了什么\n这个仓库用哪个测试框架？\n\n## 结论\n${"每个 PR 都会跑 verify。".repeat(60)}`;
  const fitted = fitDraftToLines(long, {
    maxLines: 6,
    charsPerLine: 20,
    footer: "完整内容见右侧「旁问」面板。",
  });
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.text.startsWith("这个仓库用哪个测试框架？"), fitted.text.slice(0, 30));
  assert.ok(!fitted.text.includes("## "), "摘要里不再有四节标题");
  assert.ok(fitted.text.endsWith("完整内容见右侧「旁问」面板。"), fitted.text.slice(-40));
  assert.ok(fitted.text.includes("…"), "截断处有省略号");
  assert.ok(
    estimateDraftLines(fitted.text, 20) <= 6,
    `摘要应 <= 6 行，实际 ${estimateDraftLines(fitted.text, 20)} 行`,
  );

  // 输入框越宽保留越多；窄到极限也不会超行数
  const narrow = fitDraftToLines(long, { maxLines: 6, charsPerLine: 14, footer: "foot" });
  const wide = fitDraftToLines(long, { maxLines: 6, charsPerLine: 48, footer: "foot" });
  assert.ok(wide.text.length > narrow.text.length, "宽输入框应保留更多内容");
  assert.ok(estimateDraftLines(narrow.text, 14) <= 6);
  assert.ok(estimateDraftLines(wide.text, 48) <= 6);

  // 代码围栏里的 # 与空行要原样保留（不能把代码内容当标题删掉）
  const fenced = "## 我问了什么\nq\n\n## 结论\n```bash\n# 注释\n\nls -la\n```";
  const compact = compactDraftForComposer(fenced);
  assert.ok(compact.includes("# 注释"), "围栏内的 # 注释不能删");
  assert.ok(compact.includes("\n\nls -la"), "围栏内的空行不能吞掉");
  assert.ok(!compact.includes("## 我问了什么"), "围栏外的标题要删掉");

  // 没有 footer 时只留省略号；空串不额外加省略号
  const noFooter = fitDraftToLines(long, { maxLines: 2, charsPerLine: 20 });
  assert.ok(noFooter.text.endsWith("…"));
  assert.equal(fitDraftToLines("", { maxLines: 2, charsPerLine: 20 }).text, "");

  // 按字符数组切分，不把 emoji 的多字节代理对劈成半个
  const emoji = `## 标题\n${"🙂".repeat(80)}`;
  const cut = fitDraftToLines(emoji, { maxLines: 2, charsPerLine: 10, footer: "foot" });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(cut.text), "不能留孤立的高位代理");
});

test("client 转正：promote 走的是行数预算后的草稿（不是 host 的完整草稿）", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  assert.ok(source.includes("fitDraftToLines(full"), "promote 必须用 fitDraftToLines 收紧草稿");
  assert.ok(source.includes("composerDraftLines()"), "promote 必须量一次实际渲染行数");
  assert.ok(source.includes("promotedShort"), "截断时给用户不同提示（完整内容在面板）");
});

test("client 设置分节：order 95、保留条数输入 1–200 且带语义提示", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  const order = source.match(/name: "settings\.section",\s*id: "btw",\s*order: (\d+)/u);
  assert.ok(order !== null, "settings.section 必须声明 order");
  assert.equal(order?.[1], "95", "与 projects(94)/casefile(96) 去重，不能同 order 抢占时序");
  for (const attribute of ['min: "1"', 'max: "200"', 'step: "1"']) {
    assert.ok(source.includes(attribute), `保留条数输入要声明 ${attribute}`);
  }
  assert.ok(
    source.includes('"data-btw-setting-limit-hint": "true"'),
    "保留条数要有语义提示（改了要生效、范围 1–200）",
  );
  assert.equal(
    (source.match(/"settings\.limitHint":/gu) ?? []).length,
    2,
    "中英内嵌字典各一条（只加一份会让另一语言露出字面键）",
  );
});

// --- Markdown 渲染树（v0.4）------------------------------------------------

test("markdown: 标题/段落/粗体/行内代码/链接", () => {
  const { blocks } = parseMarkdown("# 标题\n\n正文 **粗体** 和 `code`，见 https://x.dev/path。");
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].level, 1);
  assert.equal(inlineText(blocks[0].inlines), "标题");
  assert.equal(blocks[1].type, "paragraph");
  assert.ok(inlineText(blocks[1].inlines).includes("正文 粗体 和 code"));
  const link = blocks[1].inlines.find((/** @type {any} */ run) => run.type === "link");
  assert.equal(link?.href, "https://x.dev/path", "裸 URL 变链接且句号被剥掉");
});

test("markdown: 围栏代码块与未闭合的流式态", () => {
  const closed = parseMarkdown("说明\n\n```js\nconst a = 1;\n```\n\n结束").blocks;
  assert.deepEqual(
    closed.map((block) => block.type),
    ["paragraph", "code", "paragraph"],
  );
  assert.equal(closed[1].lang, "js");
  assert.equal(closed[1].code, "const a = 1;");
  assert.equal(closed[1].streaming, false);

  const streaming = parseMarkdown("```ts\nconst b = 2;").blocks;
  assert.equal(streaming[0].type, "code");
  assert.equal(streaming[0].streaming, true, "没闭合就是流式态");
  assert.equal(streaming[0].code, "const b = 2;");
});

test("markdown: 列表/引用/表格/分隔线", () => {
  const blocks = parseMarkdown(
    "- 一\n- 二\n\n> 引用 **粗**\n\n| 名 | 值 |\n|:---|---:|\n| a | 1 |\n\n---",
  ).blocks;
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].type, "quote");
  assert.equal(blocks[2].type, "table");
  assert.deepEqual(blocks[2].align, ["left", "right"]);
  assert.equal(blocks[2].rows.length, 1);
  assert.equal(blocks[3].type, "hr");
});

test("markdown: 有序列表保留起始号，表格内行内代码可渲染", () => {
  const blocks = parseMarkdown(
    "3. 第三\n4. 第四\n\n| 检查 | 说明 |\n|---|---|\n| `verify` | 主链 |",
  ).blocks;
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].start, 3);
  const cell = blocks[1].rows[0][0];
  assert.equal(cell[0].type, "code");
  assert.equal(cell[0].text, "verify");
});

test("markdown: 不支持 HTML，尖括号按文本处理", () => {
  const blocks = parseMarkdown("<img src=x onerror=alert(1)>").blocks;
  assert.equal(blocks[0].type, "paragraph");
  assert.ok(inlineText(blocks[0].inlines).includes("<img"));
});

test("markdown: 转义与下划线标识符不被拆坏", () => {
  const blocks = parseMarkdown("file_name 和 \\*literal\\*").blocks;
  const text = inlineText(blocks[0].inlines);
  assert.ok(text.includes("file_name"));
  assert.ok(text.includes("*literal*"));
});

test("markdown: 空输入与纯空白不抛", () => {
  assert.deepEqual(parseMarkdown("").blocks, []);
  assert.deepEqual(parseMarkdown("   \n\n").blocks, []);
  assert.deepEqual(inlineText([]), "");
});

test("markdown: truncateMarkdown 在预算内截断且围栏成对", () => {
  const text = `开头\n\n\`\`\`js\n${"x\n".repeat(100)}\`\`\``;
  const cut = truncateMarkdown(text, 60);
  assert.ok(cut.length <= 60, `长度 ${cut.length}`);
  assert.equal((cut.match(/```/gu) ?? []).length % 2, 0);
  assert.equal(truncateMarkdown("short", 10), "short");
});

// --- 自适应数字/时长（v0.4）------------------------------------------------

test("formatTokens: K/M/B/T 自适应，边界不出现 1000K", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1234), "1.2K");
  assert.equal(formatTokens(12345), "12.3K");
  assert.equal(formatTokens(123456), "123K");
  assert.equal(formatTokens(999999), "1M", "999.999K 升档成 1M");
  assert.equal(formatTokens(1234567), "1.2M");
  assert.equal(formatTokens(3.4e9), "3.4B");
  assert.equal(formatTokens(5e12), "5T");
  assert.equal(formatTokens(-5), "0");
  assert.equal(formatTokens(undefined), "0");
  assert.equal(formatTokens("abc"), "0");
});

test("formatDuration: ms/s/m/h 自适应", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(1234), "1.2s");
  assert.equal(formatDuration(12_345), "12.3s");
  assert.equal(formatDuration(59_900), "59.9s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(90_000), "1.5m");
  assert.equal(formatDuration(5_400_000), "1.5h");
  assert.equal(formatDuration(-1000), "0ms");
});
