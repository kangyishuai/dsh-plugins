// @ts-check
// 工作区预算池（`advisor/budget.json`）：跨会话共享的「今天已经花了多少」。
// 审计 AUD-ADV-02 / 06 / 12：RMW（读-改-写）无锁会丢更新，边界口径还与四级预算不一致。
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { checkPool, createBudgetPool, dayKey, normalizePool } from "../lib/budget.js";

import { cleanupTempDirs, tempDir } from "./temp.js";

after(cleanupTempDirs);

const settings = {
  workspaceMaxCallsPerDay: 10,
  workspaceMaxCostPerDay: 1,
  currency: "USD",
  usdToCny: 7.2,
};

/** @param {any} result */
const codeOf = (result) => (result.ok ? "ok" : result.code);

describe("normalizePool", () => {
  it("跨日清零；同日的负值/NaN 夹回 0", () => {
    assert.deepEqual(normalizePool({ day: "2000-01-01", calls: 9, costUsd: 9 }, "2026-11-11"), {
      day: "2026-11-11",
      calls: 0,
      costUsd: 0,
    });
    assert.deepEqual(
      normalizePool({ day: "2026-11-11", calls: -3, costUsd: Number.NaN }, "2026-11-11"),
      {
        day: "2026-11-11",
        calls: 0,
        costUsd: 0,
      },
    );
    assert.deepEqual(normalizePool(null, "2026-11-11"), {
      day: "2026-11-11",
      calls: 0,
      costUsd: 0,
    });
  });
});

describe("checkPool：两个闸的边界口径统一为「已达上限即拒绝」", () => {
  it("调用数达到上限就拒绝（>=），不是超过才拒绝", () => {
    assert.equal(codeOf(checkPool({ calls: 9, costUsd: 0 }, settings)), "ok");
    assert.equal(codeOf(checkPool({ calls: 10, costUsd: 0 }, settings)), "workspace_calls");
  });

  it("金额 + 本次预估达到上限就拒绝（>=）", () => {
    assert.equal(codeOf(checkPool({ calls: 0, costUsd: 0.79 }, settings, 0.2)), "ok");
    assert.equal(codeOf(checkPool({ calls: 0, costUsd: 0.8 }, settings, 0.2)), "workspace_budget");
    assert.equal(codeOf(checkPool({ calls: 0, costUsd: 1 }, settings)), "workspace_budget");
  });

  it("0 = 不限制；CNY 限额先换算成 USD", () => {
    const unlimited = {
      workspaceMaxCallsPerDay: 0,
      workspaceMaxCostPerDay: 0,
      currency: "CNY",
      usdToCny: 7.2,
    };
    assert.equal(codeOf(checkPool({ calls: 999, costUsd: 999 }, unlimited, 999)), "ok");
    const cny = {
      workspaceMaxCallsPerDay: 10,
      workspaceMaxCostPerDay: 7.2,
      currency: "CNY",
      usdToCny: 7.2,
    };
    assert.equal(codeOf(checkPool({ calls: 0, costUsd: 0.9 }, cny)), "ok");
    assert.equal(codeOf(checkPool({ calls: 0, costUsd: 1 }, cny)), "workspace_budget");
  });
});

describe("createBudgetPool", () => {
  it("add 累加调用数与金额，并由 read 读回", async () => {
    const home = await tempDir("advisor-budget");
    const pool = createBudgetPool({ home });
    await pool.add({ calls: 1, costUsd: 0.02 });
    await pool.add({ calls: 2, costUsd: 0.03 });
    assert.deepEqual(await pool.read(), { day: dayKey(), calls: 3, costUsd: 0.05 });
  });

  it("并发 add 不丢更新（旧实现读同一份基线互相覆盖）", async () => {
    const home = await tempDir("advisor-budget");
    const pool = createBudgetPool({ home });
    await Promise.all(Array.from({ length: 24 }, () => pool.add({ calls: 1, costUsd: 0.01 })));
    const result = await pool.read();
    assert.equal(result.calls, 24);
    assert.ok(Math.abs(result.costUsd - 0.24) < 1e-9);
    // 唯一 tmp 名 + rename：不留临时文件。
    assert.deepEqual(await readdir(join(home, "advisor")), ["budget.json"]);
  });

  it("跨日滚动：昨天的计数不带进今天", async () => {
    const home = await tempDir("advisor-budget");
    await mkdir(join(home, "advisor"), { recursive: true });
    await writeFile(
      join(home, "advisor", "budget.json"),
      JSON.stringify({ day: "2000-01-01", calls: 9, costUsd: 9 }),
      "utf8",
    );
    const pool = createBudgetPool({ home });
    assert.deepEqual(await pool.read(), { day: dayKey(), calls: 0, costUsd: 0 });
    assert.deepEqual(await pool.add({ calls: 1, costUsd: 0.01 }), {
      day: dayKey(),
      calls: 1,
      costUsd: 0.01,
    });
  });

  it("文件缺失或损坏时读成 0，不抛错", async () => {
    const home = await tempDir("advisor-budget");
    const warnings = [];
    const pool = createBudgetPool({
      home,
      logger: /** @type {any} */ ({
        warn: (/** @type {unknown} */ message) => warnings.push(message),
      }),
    });
    assert.deepEqual(await pool.read(), { day: dayKey(), calls: 0, costUsd: 0 });
    await mkdir(join(home, "advisor"), { recursive: true });
    await writeFile(join(home, "advisor", "budget.json"), "{not json", "utf8");
    assert.deepEqual(await pool.read(), { day: dayKey(), calls: 0, costUsd: 0 });
    assert.ok(warnings.length > 0);
    assert.equal((await readFile(join(home, "advisor", "budget.json"), "utf8")).length > 0, true);
  });
});

describe("checkPool：预设费用被拒时带回预估额（复审 F4）", () => {
  it("金额闸因「已花 + 预计」被拒时，返回值带上 estimatedCostUsd", () => {
    const result = checkPool({ calls: 0, costUsd: 0.2 }, settings, 0.9);
    assert.equal(result.ok, false);
    assert.equal(codeOf(result), "workspace_budget");
    assert.equal(/** @type {any} */ (result).used, 0.2);
    assert.equal(/** @type {any} */ (result).limit, 1);
    assert.equal(/** @type {any} */ (result).estimatedCostUsd, 0.9);
  });
});
