// @ts-check
// B5 · F33/F34/U15：Library 的纯逻辑与自存映射落盘。
// 为什么先测这一层：artifacts 在冒烟环境里**没装**，产物面的正确性只能靠
// 「自存映射 + 降级判定」的单测保证；宿主真实服务由 libraryView 的降级路径兜底。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  artifactsDegradation,
  mergeArtifactRefs,
  normalizeArtifactRef,
  provenanceOf,
  refFromArtifactRow,
  summarizeArtifactRefs,
} from "../lib/library.js";
import { ProjectStore } from "../lib/store.js";

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-projects-library-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("F33 产物引用归一（不编造、不越界）", () => {
  it("缺 id / 路径穿越 / 点开头 → 拒绝；正常行保留字段", () => {
    assert.equal(normalizeArtifactRef({}), null);
    assert.equal(normalizeArtifactRef({ id: "" }), null);
    assert.equal(normalizeArtifactRef({ id: "../escape" }), null);
    assert.equal(normalizeArtifactRef({ id: "a/b" }), null);
    assert.equal(normalizeArtifactRef({ id: ".hidden" }), null);
    const ref = normalizeArtifactRef({
      id: "art-1",
      title: "  Weekly report  ",
      kind: "MARKDOWN",
      version: 3,
      bytes: 2048,
      updatedAt: 1_700_000_000_000,
      sessionId: "s-1",
      source: { sessionId: "s-1", toolCallId: "call-9", via: "tool" },
    });
    assert.equal(ref?.id, "art-1");
    assert.equal(ref?.title, "Weekly report");
    assert.equal(ref?.kind, "markdown");
    assert.equal(ref?.version, 3);
    assert.equal(ref?.bytes, 2048);
    assert.equal(ref?.updatedAt, 1_700_000_000_000);
    assert.equal(ref?.source?.toolCallId, "call-9");
    // 未知类型不强行归成 html：UI 走兜底样式，但数据要保真
    assert.equal(normalizeArtifactRef({ id: "x", kind: "pdf" })?.kind, "pdf");
  });

  it("合并按 id 去重、版本更新覆盖、按更新时间倒序、上限 200", () => {
    const merged = mergeArtifactRefs(
      [
        { id: "a", version: 1, updatedAt: 10 },
        { id: "b", version: 1, updatedAt: 30 },
      ],
      { id: "a", version: 2, updatedAt: 20 },
    );
    assert.deepEqual(
      merged.map((item) => `${item.id}:v${item.version}`),
      ["b:v1", "a:v2"],
    );
    let list = [];
    for (let index = 0; index < 260; index += 1) {
      list = mergeArtifactRefs(list, { id: `id-${index}`, updatedAt: index + 1 });
    }
    assert.equal(list.length, 200);
    // 最新更新的排最前
    assert.equal(list[0].id, "id-259");
  });

  it("计量按最新版本字节求和；provenance 能说出会话与调用", () => {
    const summary = summarizeArtifactRefs([
      { id: "a", bytes: 100, updatedAt: 5 },
      { id: "b", bytes: 50, updatedAt: 9 },
    ]);
    assert.deepEqual(summary, { count: 2, bytes: 150, latestAt: 9 });
    assert.deepEqual(provenanceOf({ source: { sessionId: "s", toolCallId: "c", via: "tool" } }), {
      sessionId: "s",
      toolCallId: "c",
      via: "tool",
    });
  });

  it("artifacts 行投影成引用（latest → version，缺字段不编造）", () => {
    const ref = refFromArtifactRow({
      id: "art-2",
      title: "图表",
      kind: "image",
      latest: 4,
      bytes: 900,
      totalBytes: 4000,
      updatedAt: 1234,
      sessionId: "s-2",
      source: { toolCallId: "c-2" },
    });
    assert.equal(ref.version, 4);
    assert.equal(ref.totalBytes, 4000);
    assert.equal(ref.sessionId, "s-2");
    assert.equal(ref.source.toolCallId, "c-2");
  });

  it("artifacts 封面地址透传到引用（卡片要用真实缩略图，不能只画灰线）", () => {
    const ref = refFromArtifactRow({
      id: "art-cover",
      title: "封面",
      kind: "html",
      latest: 1,
      coverUrl: "/artifacts/art-cover/cover.svg",
    });
    assert.equal(ref.coverUrl, "/artifacts/art-cover/cover.svg");
  });

  it("没有封面地址时留空串（不编造 URL）", () => {
    const ref = refFromArtifactRow({ id: "art-nocover", title: "无封面", kind: "html" });
    assert.equal(ref.coverUrl, "");
  });
});

describe("F33 artifacts 降级判定（明示缺依赖，不显示「没有产物」）", () => {
  it("未安装 / 契约不符 / 正常 三种结论都有可读文案", () => {
    const missing = artifactsDegradation({ installed: false });
    assert.equal(missing.degraded, true);
    assert.equal(missing.reason, "artifacts-not-installed");
    assert.match(missing.note, /dsh-artifacts 0\.2/u);
    const mismatch = artifactsDegradation({ installed: true, contract: "artifacts/1" });
    assert.equal(mismatch.degraded, true);
    assert.equal(mismatch.reason, "artifacts-contract-mismatch");
    assert.match(mismatch.note, /artifacts\/1/u);
    const ok = artifactsDegradation({ installed: true, contract: "artifacts/2" });
    assert.deepEqual(ok, { degraded: false, reason: "", note: "" });
  });
});

describe("F33 自存映射：写→落盘→冷启动回读", () => {
  it("recordArtifact 按 id 合并、冷启动后还在；非法引用返回 null 且不写盘；未知项目抛错", () => {
    const store = new ProjectStore({ root });
    store.load();
    const project = store.createProject("library");
    const first = store.recordArtifact(project.id, {
      id: "art-1",
      title: "报告",
      kind: "markdown",
      version: 1,
      bytes: 100,
      sessionId: "session-1",
      source: { sessionId: "session-1", toolCallId: "call-1" },
    });
    assert.equal(first?.refs.length, 1);
    assert.equal(store.recordArtifact(project.id, { id: "../nope" }), null);
    assert.equal(store.listArtifactRefs(project.id).length, 1);
    // 同 id 新版本覆盖
    store.recordArtifact(project.id, { id: "art-1", version: 2, bytes: 200, updatedAt: 20 });
    const live = store.listArtifactRefs(project.id);
    assert.equal(live.length, 1);
    assert.equal(live[0].version, 2);
    assert.equal(live[0].bytes, 200);
    store.save();
    const reloaded = new ProjectStore({ root });
    reloaded.load();
    const back = reloaded.listArtifactRefs(project.id);
    assert.equal(back.length, 1);
    assert.equal(back[0].id, "art-1");
    assert.equal(back[0].version, 2);
    assert.throws(() => store.recordArtifact("nope", { id: "art-1" }), /unknown project/u);
  });
});
