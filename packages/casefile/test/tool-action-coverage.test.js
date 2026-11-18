// @ts-check
// 防回归：每个工具的 action 枚举值都必须在 execute 的 switch 里有分支。
//
// 背景（2026-11-18 真实事故，已随 0.1.1 发布）：`case_project` 的 schema 声明了
// `close` / `report`，但 switch 里没有对应 case，用户调用直接得到「未知 action」。
// 单元测试没覆盖到，因为只测了 handler 没测工具分支。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "lib", "tools.js"), "utf8");

/**
 * 把源码切成一个个工具块（以 `name: TOOL_NAMES.x,` 为界）。
 * @returns {Array<{ tool: string, body: string }>}
 */
function toolBlocks() {
  const marks = [...SOURCE.matchAll(/name: TOOL_NAMES\.(\w+),/g)];
  return marks.map((match, index) => ({
    tool: match[1],
    body: SOURCE.slice(match.index, marks[index + 1]?.index ?? SOURCE.length),
  }));
}

test("每个工具的 action 枚举值都被真正处理（case 分支或 assertAction 白名单）", () => {
  let checkedTools = 0;
  for (const { tool, body } of toolBlocks()) {
    const enumMatch = body.match(/action:\s*\{[^}]*?enum:\s*\[([^\]]+)\]/s);
    if (!enumMatch) continue;
    checkedTools += 1;
    const values = [...enumMatch[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(values.length > 0, `${tool} 的 action 枚举为空`);

    const cases = new Set([...body.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    // 另一种写法：assertAction(args.action, ["a", "b"])，白名单即处理面
    const guard = body.match(/assertAction\(\s*args\.action\s*,\s*\[([^\]]+)\]/s);
    const guarded = new Set(guard ? [...guard[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]) : []);

    if (cases.size > 0) {
      const missing = values.filter((value) => !cases.has(value));
      assert.deepEqual(missing, [], `工具 ${tool} 的 switch 缺少分支：${missing.join("、")}`);
      continue;
    }
    if (guarded.size > 0) {
      const missing = values.filter((value) => !guarded.has(value));
      const extra = [...guarded].filter((value) => !values.includes(value));
      assert.deepEqual(missing, [], `工具 ${tool} 的 assertAction 白名单缺：${missing.join("、")}`);
      assert.deepEqual(extra, [], `工具 ${tool} 的 assertAction 白名单多出：${extra.join("、")}`);
      continue;
    }
    assert.fail(`工具 ${tool} 声明了 action 枚举，但既没有 case 分支也没有 assertAction 白名单`);
  }
  assert.ok(checkedTools >= 6, `只检查到 ${checkedTools} 个带 action 枚举的工具`);
});

test("每个工具都声明了 action 的 required（避免参数漏传被静默接受）", () => {
  for (const { tool, body } of toolBlocks()) {
    if (!/action:\s*\{[^}]*?enum:\s*\[/s.test(body)) continue;
    assert.match(body, /required: \["action"\]/, `${tool} 的 parameters.required 里缺 action`);
  }
});
