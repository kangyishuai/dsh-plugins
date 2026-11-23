// @ts-check
// 项目级上下文的渲染单测：预算、裁剪顺序、去重约定。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipIndex,
  INSTRUCTION_BUDGET,
  MEMORY_INDEX_MAX_LINES,
  PROJECT_CONTEXT_ORDER,
  projectContextOrder,
  renderProjectContext,
} from "../lib/context.js";

describe("renderProjectContext", () => {
  it("没有任何内容时返回空串（不注入空块）", () => {
    assert.equal(renderProjectContext({ project: { name: "" } }), "");
    assert.equal(renderProjectContext({ project: { name: "  " }, instructions: "  " }), "");
  });

  it("只写项目名也会产出一段可用上下文", () => {
    const text = renderProjectContext({ project: { name: "payments" } });
    assert.match(text, /当前项目：payments/u);
    assert.match(text, /使用约定/u);
  });

  it("包含身份/目标/目录/规则/记忆/约定六部分", () => {
    const text = renderProjectContext({
      project: { name: "payments", goal: "p95 < 200ms", dirs: ["/repo/api"] },
      instructions: "分支从 main 起。",
      memoryIndex: "- 缓存层在 src/cache.ts",
    });
    assert.match(text, /当前项目：payments/u);
    assert.match(text, /目标：p95 < 200ms/u);
    assert.match(text, /工作目录：\/repo\/api/u);
    assert.match(text, /常设规则\n分支从 main 起。/u);
    assert.match(text, /项目记忆索引（MEMORY\.md）\n- 缓存层在 src\/cache\.ts/u);
    // F40：明确「这是项目记忆，不是 AGENTS.md」
    assert.match(text, /不是 AGENTS\.md 或 CLAUDE\.md/u);
    assert.match(text, /后者已由宿主单独加载/u);
    // F38：注入契约带包裹标签
    assert.match(text, /^<project-context>/u);
    assert.match(text, /<\/project-context>$/u);
  });

  it("**不**重复渲染 AGENTS.md 的内容（去重是纪律）", () => {
    const text = renderProjectContext({
      project: { name: "alpha" },
      instructions: "规则 A",
      memoryIndex: "- 记忆 B",
    });
    // 约定里提到 AGENTS.md 只是「别重复引用」，不应出现任何 AGENTS 正文
    assert.equal((text.match(/AGENTS\.md/gu) ?? []).length, 1);
    assert.doesNotMatch(text, /# AGENTS|## AGENTS/u);
  });

  it("超预算时先砍记忆、保留规则，并给出截断提示", () => {
    const memory = "- ".concat("x".repeat(INSTRUCTION_BUDGET));
    const text = renderProjectContext({
      project: { name: "alpha", goal: "g" },
      instructions: "规则保留",
      memoryIndex: memory,
      budget: 2_000,
    });
    assert.ok(text.length <= 2_000, `长度应在预算内，实际 ${text.length}`);
    assert.match(text, /规则保留/u);
    assert.match(text, /已按字符预算截断/u);
    assert.doesNotMatch(text, /x{500}/u);
  });

  it("预算极小时仍保留身份与截断说明，不抛错", () => {
    const text = renderProjectContext({
      project: { name: "alpha" },
      instructions: "y".repeat(5_000),
      budget: 200,
    });
    assert.ok(text.length <= 200 + 200, "允许截断说明略超");
    assert.match(text, /截断/u);
  });

  it("默认预算就是 16,000（对齐 Claude Projects）", () => {
    assert.equal(INSTRUCTION_BUDGET, 16_000);
    const text = renderProjectContext({
      project: { name: "alpha" },
      instructions: "z".repeat(INSTRUCTION_BUDGET + 5_000),
    });
    assert.ok(text.length <= INSTRUCTION_BUDGET, `实际 ${text.length}`);
  });
});

describe("clipIndex", () => {
  it("短索引原样返回", () => {
    assert.equal(clipIndex("- a\n- b"), "- a\n- b");
  });

  it("超长索引截到上限并说明剩余行数", () => {
    const lines = Array.from({ length: MEMORY_INDEX_MAX_LINES + 40 }, (_, i) => `- item ${i}`);
    const text = clipIndex(lines.join("\n"));
    assert.match(text, /还有 40 行未展示/u);
    assert.ok(text.split("\n").length < MEMORY_INDEX_MAX_LINES + 5);
  });

  it("空输入安全", () => {
    assert.equal(clipIndex(""), "");
    // @ts-expect-error 故意传 undefined
    assert.equal(clipIndex(undefined), "");
  });
});

describe("顺序", () => {
  it("order 是稳定常量，两组 API 一致", () => {
    assert.equal(typeof PROJECT_CONTEXT_ORDER, "number");
    assert.equal(projectContextOrder(), PROJECT_CONTEXT_ORDER);
  });
});
