// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_VIEWS, normalizeView, normalizeViews } from "../lib/views.js";

describe("自定义视图（Add view）的收敛规则", () => {
  it("合法视图保留 name/filter/query", () => {
    const view = normalizeView({ id: "v_1", name: "  在跑的  ", filter: "working", query: " CI " });
    assert.deepEqual(view, { id: "v_1", name: "在跑的", filter: "working", query: "CI" });
  });

  it("缺 id / 缺名字 → null（不编造）", () => {
    assert.equal(normalizeView({ name: "x" }), null);
    assert.equal(normalizeView({ id: "v_1" }), null);
  });

  it("非法 filter 退化为「全部」，超长 query 截断", () => {
    const view = normalizeView({ id: "v_2", name: "x", filter: "nope", query: "a".repeat(200) });
    assert.ok(view);
    assert.equal(view.filter, "");
    assert.equal(view.query.length, 60);
  });

  it("读盘时去重、限 8 个", () => {
    const list = normalizeViews(
      Array.from({ length: MAX_VIEWS + 5 }, (_, index) => ({
        id: `v_${index}`,
        name: `视图${index}`,
      })),
    );
    assert.equal(list.length, MAX_VIEWS);
    const dup = normalizeViews([
      { id: "v_x", name: "a" },
      { id: "v_x", name: "b" },
    ]);
    assert.equal(dup.length, 1);
  });
});

// 落盘层：addView / deleteView 真的写进 projects.json，重启后还能读出来
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../lib/store.js";

describe("视图落盘（addView / deleteView）", () => {
  it("保存后写盘、冷启动回读；删除后不再出现", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-projects-views-"));
    try {
      const store = new ProjectStore({ root }).load();
      const project = store.createProject("视图落盘");
      const view = store.addView(project.id, { name: "在跑的", filter: "working", query: "CI" });
      assert.equal(view.filter, "working");
      store.save();
      const raw = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
      assert.equal(raw.projects[project.id].views.length, 1);
      assert.equal(raw.projects[project.id].views[0].name, "在跑的");

      const reopened = new ProjectStore({ root }).load();
      assert.equal(reopened.getProject(project.id)?.views?.[0]?.query, "CI");
      const left = reopened.deleteView(project.id, view.id);
      assert.equal(left.length, 0);
      reopened.save();
      const afterDelete = new ProjectStore({ root }).load();
      assert.deepEqual(afterDelete.getProject(project.id)?.views, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("名字为空 / 超过 8 个 → 抛错（不静默丢弃）", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-projects-views2-"));
    try {
      const store = new ProjectStore({ root }).load();
      const project = store.createProject("视图上限");
      assert.throws(() => store.addView(project.id, { name: "   " }), /view name is required/u);
      for (let index = 0; index < MAX_VIEWS; index += 1) {
        store.addView(project.id, { name: `v${index}` });
      }
      assert.throws(() => store.addView(project.id, { name: "overflow" }), /too many views/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
