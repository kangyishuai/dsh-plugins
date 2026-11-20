// @ts-check
// gate:all 的纯函数：插件解析、缺脚本检查、dry-run 计划。
// 这些逻辑是六插件批量门禁的「结构正确性」，CI 用 `pnpm gate:all --dry-run` 跑，这里用单测锁住。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildPlan,
  compareCounts,
  missingScripts,
  normalizePlugins,
  RELEASE_PLUGINS,
} from "../gate-all.mjs";
import { REPO_ROOT } from "../lib/repo.mjs";

test("默认插件列表就是六个发布插件", () => {
  assert.deepEqual(normalizePlugins(undefined), RELEASE_PLUGINS);
  assert.deepEqual(normalizePlugins(""), RELEASE_PLUGINS);
  assert.deepEqual(normalizePlugins("   "), RELEASE_PLUGINS);
  assert.deepEqual(RELEASE_PLUGINS, [
    "advisor",
    "btw",
    "casefile",
    "next-step",
    "session-delete",
    "session-rewind",
  ]);
});

test("--plugins 解析：去空白、去空项、去重复、保序", () => {
  assert.deepEqual(normalizePlugins("advisor, btw ,,advisor"), ["advisor", "btw"]);
  assert.deepEqual(normalizePlugins("casefile"), ["casefile"]);
});

test("缺脚本检查：桌面脚本可由 --skip-desktop 豁免", () => {
  const scripts = { "smoke:a": "node a.mjs" };
  assert.deepEqual(missingScripts(["a"], scripts, false), ["smoke:a-desktop"]);
  assert.deepEqual(missingScripts(["a"], scripts, true), []);
  assert.deepEqual(missingScripts(["a", "b"], { "smoke:a": "x", "smoke:a-desktop": "y" }, false), [
    "smoke:b",
    "smoke:b-desktop",
  ]);
});

test("dry-run 计划覆盖顺序与步骤编号", () => {
  const plan = buildPlan({
    plugins: ["advisor", "btw"],
    skipVerify: false,
    skipDesktop: false,
    idleTitle: "空闲会话",
    repeat: 1,
  });
  assert.equal(plan[0], "1. pnpm verify");
  assert.equal(plan[1], "2. pnpm probe:runtime");
  assert.ok(plan.includes("3.1 pnpm smoke:advisor"));
  assert.ok(plan.includes("3.2 pnpm smoke:btw"));
  assert.ok(plan.includes("4.1 pnpm smoke:advisor-desktop --require"));
  assert.ok(plan.includes("4.2 pnpm smoke:btw-desktop --require"));
  assert.ok(plan.some((line) => line.includes("切到空闲会话「空闲会话」")));
  assert.ok(!plan.some((line) => line.includes("连跑")));
});

test("dry-run 计划：跳过项与 --repeat 标注", () => {
  const skipped = buildPlan({
    plugins: ["advisor"],
    skipVerify: true,
    skipDesktop: true,
    idleTitle: null,
    repeat: 1,
  });
  assert.match(skipped[0], /^- verify/);
  assert.ok(skipped.includes("- 桌面端（已按 --skip-desktop 跳过）"));
  assert.ok(!skipped.some((line) => line.startsWith("4.")));

  const repeated = buildPlan({
    plugins: ["advisor"],
    skipVerify: true,
    skipDesktop: false,
    idleTitle: null,
    repeat: 2,
  });
  assert.ok(repeated.includes("4.1 pnpm smoke:advisor-desktop --require（连跑 2 次）"));
});

test("compareCounts：一致返回 null，SKIP 漂移/新增失败都要看得见", () => {
  assert.equal(compareCounts({ pass: 19, skip: 1, fail: 0 }, { pass: 19, skip: 1, fail: 0 }), null);
  assert.equal(
    compareCounts({ pass: 21, skip: 1, fail: 0 }, { pass: 20, skip: 2, fail: 0 }),
    "21/1/0 → 20/2/0",
    "数据相关 SKIP 变化要能打印出来",
  );
  assert.equal(
    compareCounts({ pass: 19, skip: 1, fail: 0 }, { pass: 18, skip: 1, fail: 1 }),
    "19/1/0 → 18/1/1",
    "FAIL 变化同样要看得见（门禁本身还会因退出码判红）",
  );
});

test("仓库里六个发布插件的 web/桌面脚本真的都在（离线结构检查）", () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {};
  assert.deepEqual(missingScripts(RELEASE_PLUGINS, scripts, false), []);
});
