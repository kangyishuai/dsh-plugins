// @ts-check
// events.js 单测：构造器字段、sid 稳定性、追加/滚动/统计，以及「写失败不抛」。
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  actionEvent,
  createEventLog,
  EVENTS_MAX_BYTES,
  errorEvent,
  eventsPathOf,
  followupEvent,
  impressionEvent,
  metaEvent,
  promoteEvent,
  sidOf,
  turnEvent,
} from "../lib/events.js";

/** @type {string[]} */
const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** @returns {Promise<string>} */
async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "ns-events-"));
  tempDirs.push(home);
  return home;
}

test("sidOf：稳定、8 位十六进制，会话为空时给 unknown", () => {
  const a = sidOf("session-123");
  assert.match(a, /^[0-9a-f]{8}$/u);
  assert.equal(a, sidOf("session-123"), "同一 id 必须得到同一哈希");
  assert.notEqual(a, sidOf("session-124"));
  assert.equal(sidOf(""), "unknown");
  assert.equal(sidOf(/** @type {any} */ (undefined)), "unknown");
});

test("构造器：turn 事件带 feat 与 gate，没有 cand 时不出现该键", () => {
  const event = turnEvent({
    at: 1000,
    sid: "abcd1234",
    turn: 3,
    tier: "could",
    feat: { answerChars: 1200, toolCalls: 7 },
    gate: "short-answer",
  });
  assert.deepEqual(event, {
    t: "turn",
    at: 1000,
    sid: "abcd1234",
    turn: 3,
    tier: "could",
    feat: { answerChars: 1200, toolCalls: 7 },
    gate: "short-answer",
  });
  const withCand = turnEvent({
    at: 1000,
    sid: "abcd1234",
    turn: 3,
    tier: "could",
    feat: { answerChars: 1200, toolCalls: 0 },
    gate: "ok",
    cand: { value: "could", shown: true, opts: [] },
  });
  assert.deepEqual(withCand.cand, { value: "could", shown: true, opts: [] });
});

test("构造器：可选字段不出现时不留 undefined 键", () => {
  const action = actionEvent({
    at: 1,
    sid: "s",
    turn: 2,
    kind: "dismissed",
    msSinceShown: 1500,
  });
  assert.deepEqual(action, {
    t: "action",
    at: 1,
    sid: "s",
    turn: 2,
    kind: "dismissed",
    msSinceShown: 1500,
  });
  const promote = promoteEvent({ at: 1, sid: "s", turn: 2, found: false });
  assert.equal("value" in promote, false);
  const error = errorEvent({ at: 1, sid: "s", turn: 2, kind: "timeout" });
  assert.equal("detail" in error, false, "没有细节时不写空 detail");
});

test("构造器：数字字段被规整成非负整数（脏输入不进日志）", () => {
  const followup = followupEvent({
    at: 1,
    sid: "s",
    turn: 2,
    typed: true,
    delayMs: 1234.7,
    textChars: -3,
    overlap: Number.NaN,
  });
  assert.equal(followup.delayMs, 1235);
  assert.equal(followup.textChars, 0);
  assert.equal(followup.overlap, 0);
  const impression = impressionEvent({
    at: 1,
    sid: "s",
    turn: 2,
    visibleMs: 2400.4,
    ratio: Number.NaN,
  });
  assert.equal(impression.visibleMs, 2400);
  assert.equal(impression.ratio, -1, "没有 IntersectionObserver 时用 -1 表示未知");
  assert.equal(metaEvent({ at: 5, tier: "must" }).since, 5);
});

test("append：文件写进数据根，每行一条合法 JSON，并带上公共字段", async () => {
  const home = await tempHome();
  const log = createEventLog({ home, pkg: "0.4.0" });
  const ok = await log.append(actionEvent({ at: 1, sid: "abcd1234", turn: 1, kind: "clicked" }));
  assert.equal(ok, true);
  const text = await readFile(eventsPathOf(home), "utf8");
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].v, 1);
  assert.equal(rows[0].scheme, "v0.4");
  assert.equal(Number.isSafeInteger(rows[0].pv), true);
  assert.equal(rows[0].pkg, "0.4.0");
  assert.equal(rows[0].t, "action");
});

test("append：并发写入不丢行（内部串行化）", async () => {
  const home = await tempHome();
  const log = createEventLog({ home });
  await Promise.all(
    Array.from({ length: 20 }, (_unused, index) =>
      log.append(actionEvent({ at: index, sid: "abcd1234", turn: index, kind: "clicked" })),
    ),
  );
  const text = await readFile(eventsPathOf(home), "utf8");
  const rows = text.trim().split("\n").filter(Boolean);
  assert.equal(rows.length, 20, `期望 20 行，实际=${rows.length}`);
  // 每行都必须是完整 JSON（交错写会解析失败）
  for (const row of rows) assert.doesNotThrow(() => JSON.parse(row));
});

test("append：超过 2 MB 滚动成 .1，旧的 .1 被替换", async () => {
  const home = await tempHome();
  const log = createEventLog({ home });
  // 先塞一个接近上限的假文件
  await log.append(actionEvent({ at: 1, sid: "abcd1234", turn: 1, kind: "clicked" }));
  const path = eventsPathOf(home);
  await writeFile(path, "x".repeat(EVENTS_MAX_BYTES + 10), "utf8");
  await log.append(actionEvent({ at: 2, sid: "abcd1234", turn: 2, kind: "clicked" }));
  const files = (await readdir(join(home, "next-step"))).sort();
  assert.deepEqual(files, ["events.jsonl", "events.jsonl.1"], `期望两个文件，实际=${files}`);
  const current = await readFile(path, "utf8");
  assert.equal(current.trim().split("\n").length, 1, "新文件只应有滚动后写入的那一条");
});

test("stats：体积与行数；文件不存在时返回 0", async () => {
  const home = await tempHome();
  const log = createEventLog({ home });
  assert.deepEqual(await log.stats(), { path: eventsPathOf(home), bytes: 0, lines: 0 });
  await log.append(actionEvent({ at: 1, sid: "abcd1234", turn: 1, kind: "clicked" }));
  await log.append(actionEvent({ at: 2, sid: "abcd1234", turn: 2, kind: "clicked" }));
  const stats = await log.stats();
  assert.equal(stats.lines, 2);
  assert.ok(stats.bytes > 0);
});

test("ensureMeta：空目录时写一次，之后再调用不重复写", async () => {
  const home = await tempHome();
  const log = createEventLog({ home });
  assert.equal(await log.ensureMeta({ tier: "could" }), true);
  assert.equal(await log.ensureMeta({ tier: "must" }), false, "已有事件时不再写 meta");
  const rows = (await readFile(eventsPathOf(home), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].t, "meta");
  assert.equal(rows[0].tier, "could");
});

test("写失败只 warn 一次、返回 false，不抛错（数据根不可写）", async () => {
  const home = await tempHome();
  /** @type {string[]} */
  const warnings = [];
  // 用一个普通文件当 home，mkdir 会失败（ENOTDIR）
  const blocker = join(home, "blocker");
  await writeFile(blocker, "x", "utf8");
  const log = createEventLog({
    home: blocker,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(await log.append(metaEvent({ at: 1, tier: "could" })), false);
  assert.equal(await log.append(metaEvent({ at: 2, tier: "could" })), false);
  assert.equal(warnings.length, 1, `期望只 warn 一次，实际=${warnings.length}`);
  assert.match(warnings[0], /cannot write events log/u);
});

test("ensureMeta：并发调用只写一条 meta（stat 必须在串行链内部）", async () => {
  const home = await tempHome();
  const log = createEventLog({ home });
  const results = await Promise.all([
    log.ensureMeta({ tier: "could" }),
    log.ensureMeta({ tier: "could" }),
    log.ensureMeta({ tier: "could" }),
  ]);
  assert.equal(
    results.filter(Boolean).length,
    1,
    `期望只有一次真的写入，实际=${JSON.stringify(results)}`,
  );
  const rows = (await readFile(eventsPathOf(home), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.t === "meta").length, 1, "并发时也绝不能写出两条 meta");
});
