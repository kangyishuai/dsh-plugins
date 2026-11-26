// @ts-check
// 源码守卫：这几处是"静默做错事"的高风险接线，纯函数单测覆盖不到，但用文本断言能防回归。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serviceSource = readFileSync(join(here, "..", "lib", "service.js"), "utf8");
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/**
 * 截出某个方法体（从 `async name(` 起，到下一个顶层方法注释/方法定义前）。
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function methodRegion(source, name) {
  const start = source.indexOf(`async ${name}(`);
  assert.ok(start >= 0, `找不到方法 ${name}`);
  const rest = source.slice(start + 1);
  // 下一个同级方法：以两个空格缩进的 `async xxx(` 或 `/**` 后的方法名为界
  const nextCandidates = [
    rest.indexOf("\n  async ", 1),
    rest.indexOf("\n  /**", 1),
    rest.indexOf("\n  constructor("),
  ].filter((index) => index > 0);
  const end = nextCandidates.length > 0 ? Math.min(...nextCandidates) : rest.length;
  return rest.slice(0, end);
}

describe("PR 命令的工作目录：必须走 pickRepoRoot（不能再用 dirs[0]）", () => {
  for (const method of ["prOverview", "mergePr"]) {
    it(`${method} 使用 pickRepoRoot 而不是 project.dirs[0]`, () => {
      const region = methodRegion(serviceSource, method);
      assert.match(region, /pickRepoRoot\(/u);
      assert.doesNotMatch(region, /project\.dirs\[0\]/u);
    });
  }
  it("pollPrs 使用 pickPollRoot", () => {
    const start = serviceSource.indexOf("async pollPrs(");
    assert.ok(start >= 0);
    const region = serviceSource.slice(start, start + 6000);
    assert.match(region, /pickPollRoot\(/u);
  });
});

describe("事件回写：高频路径必须合并写盘（saveSoon）", () => {
  it("applyThreadEvent 之后用 saveSoon(250)", () => {
    const anchor = serviceSource.indexOf("applyThreadEvent(sessionId, event, next)");
    assert.ok(anchor >= 0);
    const around = serviceSource.slice(anchor, anchor + 200);
    assert.match(around, /saveSoon\(250\)/u);
  });
});

describe("客户端轮询：后台标签页不轮询", () => {
  it("详情页 5s 轮询里有 document.hidden 门控", () => {
    const anchor = clientSource.indexOf("const timer = setInterval(() => load(true), 5000);");
    // 新写法不是单行，改为找 load(true) 附近的 setInterval 片段
    const fallback = clientSource.indexOf("load(true);");
    const index = anchor >= 0 ? anchor : fallback;
    assert.ok(index >= 0);
    const region = clientSource.slice(Math.max(0, index - 600), index + 200);
    assert.match(region, /hidden === true/u);
  });
});
