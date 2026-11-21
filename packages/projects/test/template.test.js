// @ts-check
// 一键建项目模板（规格 §7.7.6）：只规划；不覆盖用户已有文件。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { INSTRUCTIONS_SKELETON, planTemplate } from "../lib/template.js";

describe("planTemplate", () => {
  it("目录不存在 → 先建目录，再写骨架", () => {
    const plan = planTemplate({ dir: "/tmp/new-proj", exists: { dirExists: false } });
    assert.deepEqual(plan.mkdirs, ["/tmp/new-proj"]);
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].path, "/tmp/new-proj/instructions.md");
    assert.equal(plan.files[0].content, INSTRUCTIONS_SKELETON);
  });

  it("目录已存在 → 不重复建目录", () => {
    const plan = planTemplate({ dir: "/tmp/x", exists: { dirExists: true } });
    assert.deepEqual(plan.mkdirs, []);
    assert.equal(plan.files.length, 1);
  });

  it("已有 AGENTS.md → **不覆盖**，只在骨架里提示去重", () => {
    const plan = planTemplate({
      dir: "/tmp/x",
      exists: { dirExists: true, agentsMd: true },
    });
    const content = plan.files[0].content;
    assert.match(content, /已有 AGENTS\.md/u);
    assert.match(content, /避免写重复内容/u);
  });

  it("已有 instructions.md → 跳过而不是覆盖", () => {
    const plan = planTemplate({
      dir: "/tmp/x",
      exists: { dirExists: true, instructionsMd: true },
    });
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.skipped, [{ path: "/tmp/x/instructions.md", reason: "exists" }]);
  });

  it("没有目录（dir 为空）时只规划项目内的 instructions.md", () => {
    const plan = planTemplate({ dir: "", exists: {} });
    assert.deepEqual(plan.mkdirs, []);
    assert.equal(plan.files[0].path, "instructions.md");
  });

  it("真的写盘时用 wx 语义：已存在文件不会被覆盖（端到端小验证）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-tpl-"));
    const file = join(dir, "instructions.md");
    writeFileSync(file, "用户原内容", "utf8");
    const plan = planTemplate({ dir, exists: { dirExists: true, instructionsMd: true } });
    assert.deepEqual(plan.files, [], "已存在就不该规划写入");
    assert.equal(readFileSync(file, "utf8"), "用户原内容");
    rmSync(dir, { recursive: true, force: true });
  });
});
