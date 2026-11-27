// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArtifactMarkdown } from "../lib/artifact-render.js";

describe("产物 Markdown 解析（M4）", () => {
  it("标题/段落/空行分组", () => {
    const blocks = parseArtifactMarkdown("# 标题\n\n第一段\n第二行\n\n## 小标题");
    assert.deepEqual(blocks, [
      { type: "heading", level: 1, text: "标题" },
      { type: "paragraph", text: "第一段 第二行" },
      { type: "heading", level: 2, text: "小标题" },
    ]);
  });

  it("勾选清单保留勾选状态（[x] / [ ]）", () => {
    const blocks = parseArtifactMarkdown("- [x] 已完成\n- [ ] 待办");
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], {
      type: "list",
      ordered: false,
      items: ["已完成", "待办"],
      checked: [true, false],
    });
  });

  it("表格解析表头与行（含中文）", () => {
    const blocks = parseArtifactMarkdown(
      "| 名称 | 状态 |\n|---|---|\n| 甲 | 完成 |\n| 乙 | 待办 |",
    );
    assert.deepEqual(blocks, [
      {
        type: "table",
        header: ["名称", "状态"],
        rows: [
          ["甲", "完成"],
          ["乙", "待办"],
        ],
      },
    ]);
  });

  it("代码块内容原样保留；普通列表与段落不吞", () => {
    const blocks = parseArtifactMarkdown("```\nconst a = 1;\n```\n- 要点一");
    assert.equal(blocks[0].type, "code");
    assert.equal(/** @type {any} */ (blocks[0]).text, "const a = 1;");
    assert.equal(blocks[1].type, "list");
  });

  it("空/纯文本不炸，段落合并空白行", () => {
    assert.deepEqual(parseArtifactMarkdown(""), []);
    const blocks = parseArtifactMarkdown("just text\n\nmore");
    assert.equal(blocks.length, 2);
  });
});
