// @ts-check
// 账本（`advisor/usage.jsonl`）与建议账本（`advisor/advice.jsonl`）：钱与预算的持久层。
// 审计 AUD-ADV-01 / 04 / 05 / 06 / 10：这里以前既没有单测，又是「读全文 + 覆盖写」+ UTC 日键。
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { dayKey } from "../lib/day.js";
import { createLedger, LEDGER_MAX_BYTES } from "../lib/ledger.js";

import { cleanupTempDirs, tempDir } from "./temp.js";

after(cleanupTempDirs);

/**
 * @param {Partial<import("../lib/ledger.js").LedgerEntry>} [over]
 * @returns {import("../lib/ledger.js").LedgerEntry}
 */
const entry = (over = {}) => ({
  at: new Date().toISOString(),
  sessionId: "s1",
  trigger: "tool",
  provider: "p",
  model: "m",
  effort: "",
  verdict: "reviewed",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  ms: 100,
  ...over,
});

/** @param {string} path @returns {Promise<any[]>} */
async function readJsonLines(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("usage 账本：追加写", () => {
  it("record 追加一行，已写入的历史不被重写", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    await ledger.record(entry({ sessionId: "a" }));
    const first = await readFile(ledger.path, "utf8");
    await ledger.record(entry({ sessionId: "b" }));
    const text = await readFile(ledger.path, "utf8");
    assert.ok(text.startsWith(first), "已有内容必须是原样前缀，不能整份重写");
    assert.equal((await readJsonLines(ledger.path)).length, 2);
  });

  it("并发 record 不丢行（旧实现会读同一份基线互相覆盖）", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    await Promise.all(
      Array.from({ length: 8 }, (_item, index) => ledger.record(entry({ sessionId: `s${index}` }))),
    );
    const rows = await readJsonLines(ledger.path);
    assert.equal(rows.length, 8);
    assert.deepEqual(new Set(rows.map((row) => row.sessionId)).size, 8);
  });

  it("每行带上本地日键 day（日预算跨重启的稳定口径）", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    await ledger.record(entry());
    const [row] = await readJsonLines(ledger.path);
    assert.equal(row.day, dayKey());
  });

  it("超过滚动阈值后改名为 .1，新文件从一行开始", async () => {
    const { mkdir } = await import("node:fs/promises");
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    const dir = join(home, "advisor");
    await mkdir(dir, { recursive: true });
    await writeFile(ledger.path, `${"x".repeat(LEDGER_MAX_BYTES + 10)}\n`, "utf8");
    await ledger.record(entry({ sessionId: "after-rotate" }));
    const fresh = await readJsonLines(ledger.path);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].sessionId, "after-rotate");
    assert.ok((await readdir(dir)).includes("usage.jsonl.1"));
  });

  it("写失败只告警，不把征询拖挂（返回 void）", async () => {
    const home = await tempDir("advisor-ledger");
    const warnings = [];
    const ledger = createLedger({
      home,
      logger: /** @type {any} */ ({
        warn: (/** @type {unknown} */ message) => warnings.push(message),
      }),
    });
    // 把账本目录先占成一个普通文件 → mkdir/append 都会失败。
    await writeFile(join(home, "advisor"), "not a directory", "utf8");
    await ledger.record(entry());
    assert.ok(warnings.length > 0);
  });
});

describe("usage 账本：启动恢复（AUD-ADV-04 / 05）", () => {
  /** @param {string} home @param {any[]} rows */
  async function seed(home, rows) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "advisor"), { recursive: true });
    await writeFile(
      join(home, "advisor", "usage.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
  }

  it("优先用行里的 day 字段判断「今天」，不再切 UTC 的 at（时区无关的硬回归）", async () => {
    const home = await tempDir("advisor-ledger");
    // `at` 用**远古固定日期**：旧实现把 at 的 UTC 日期切片当「今天」，
    // 在任何时区、任何运行日都算不出今天 → 这条用例在 UTC CI 上也必红（复审 F2）。
    await seed(home, [
      entry({ at: "2020-01-01T00:00:00.000Z", day: dayKey(), costUsd: 0.5, sessionId: "s1" }),
    ]);
    const ledger = createLedger({ home });
    await ledger.ready();
    assert.equal(ledger.counters("s1").dayCostUsd, 0.5);
  });

  it("没有 day 的旧行落到别的日期时不计入今天（迁移不污染当日预算）", async () => {
    const home = await tempDir("advisor-ledger");
    // 旧行没有 day：按 at 的**本地日期**折算。固定用远古日期 → 任何时区都不可能是今天。
    await seed(home, [entry({ at: "2020-01-01T00:00:00.000Z", costUsd: 0.25, sessionId: "s1" })]);
    const ledger = createLedger({ home });
    await ledger.ready();
    // 本地/UTC 的折算口径由纯函数测试（day.test.js）钉住，这里只守「旧行不会污染今天」。
    assert.equal(ledger.counters("s1").dayCostUsd, 0);
  });

  it("恢复会话调用数与最近一小时时间戳（重启不再清零）", async () => {
    const home = await tempDir("advisor-ledger");
    const now = Date.now();
    await seed(home, [
      entry({ at: new Date(now - 5_000).toISOString(), costUsd: 0.1, sessionId: "s1" }),
      entry({ at: new Date(now - 10 * 60_000).toISOString(), costUsd: 0.2, sessionId: "s1" }),
      entry({ at: new Date(now - 2 * 60 * 60_000).toISOString(), costUsd: 0.3, sessionId: "s1" }),
    ]);
    const ledger = createLedger({ home });
    await ledger.ready();
    const counters = ledger.counters("s1", now);
    assert.equal(counters.sessionCalls, 3, "会话级计数必须跨重启保留");
    assert.equal(counters.hourStamps.length, 2, "只有最近一小时内的时间戳进 hourStamps");
    assert.ok(Math.abs(counters.dayCostUsd - 0.6) < 1e-9);
  });

  it("回合内计数不跨重启恢复（它的生命周期就是一个回合）", async () => {
    const home = await tempDir("advisor-ledger");
    await seed(home, [entry({ sessionId: "s1" })]);
    const ledger = createLedger({ home });
    await ledger.ready();
    assert.equal(ledger.counters("s1").turnCalls, 0);
    ledger.noteCall("s1", { turn: 7, costUsd: 0.02, at: Date.now() });
    assert.equal(ledger.counters("s1").turnCalls, 1);
    assert.equal(ledger.counters("s1").sessionCalls, 2);
  });
});

describe("建议账本（advice.jsonl）", () => {
  it("recordAdvice 追加而不是整份重写，并发不丢行", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    await Promise.all(
      Array.from({ length: 6 }, (_item, index) =>
        ledger.recordAdvice({
          ...entry({ at: new Date().toISOString() }),
          adviceId: `adv_${index}`,
        }),
      ),
    );
    const rows = await readJsonLines(ledger.advicePath);
    assert.equal(rows.length, 6);
    assert.equal(rows[0].day, dayKey());
  });

  it("adviceTotals 按本地日键分桶（day 字段优先）", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    await ledger.recordAdvice({
      at: "2026-11-27T18:06:00.000Z",
      day: "2026-11-28",
      severity: "concern",
      model: "m",
      confidence: "high",
    });
    const totals = await ledger.adviceTotals();
    assert.equal(totals.total, 1);
    assert.deepEqual(totals.byDay, { "2026-11-28": 1 });
  });

  it("文件不存在时汇总为空、不抛错", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    const totals = await ledger.adviceTotals();
    assert.equal(totals.total, 0);
    assert.deepEqual(totals.byDay, {});
  });
});

describe("死代码（AUD-ADV-10）", () => {
  it("不再暴露从未被调用、顺序还与注释相反的 recent()", async () => {
    const home = await tempDir("advisor-ledger");
    const ledger = createLedger({ home });
    assert.equal("recent" in ledger, false);
  });
});
