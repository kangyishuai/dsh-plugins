// @ts-check
// `/btw` 执行回执（纯内存通知）的单测：USIM-U2-06（空白会话里命令卡片不渲染，
// 插件必须用自己的 UI 面给「已提交 / 完成 / 失败」立即可见的反馈）。
//
// 这个模块**不落盘、不 import 宿主包**（service.js 才连宿主 RPC），所以能直接单测。
import assert from "node:assert";
import { test } from "node:test";
import { createNoticeTracker, NOTICE_MAX_PREVIEW, previewOf } from "../lib/notice.js";

test("notice: begin 记 running，done/fail 更新同一会话的最新回执", () => {
  let clock = 1_700_000_000_000;
  const tracker = createNoticeTracker({ now: () => clock });

  const started = tracker.begin("s1", { threadId: "t_a" });
  assert.equal(started?.state, "running");
  assert.equal(started?.threadId, "t_a");
  assert.equal(started?.seq, 1, "第一条通知 seq=1");
  assert.equal(tracker.latest("s1")?.state, "running");

  clock += 5_800;
  const done = tracker.done("s1", { threadId: "t_a", ms: 5_800, preview: "旁问只读，主线可干活" });
  assert.equal(done?.state, "done");
  assert.equal(done?.seq, 2, "同一会话的下一条回执 seq 递增");
  assert.equal(done?.ms, 5_800);
  assert.equal(done?.preview, "旁问只读，主线可干活");
  assert.equal(tracker.latest("s1")?.state, "done");

  const failed = tracker.fail("s1", { threadId: "t_a", text: "旁问超时，没有得到答案。" });
  assert.equal(failed?.state, "error");
  assert.equal(failed?.seq, 3);
  assert.equal(failed?.text, "旁问超时，没有得到答案。");
});

test("notice: 会话之间互不串（latest 只取自己的），未知会话返回 null", () => {
  const tracker = createNoticeTracker();
  tracker.begin("s1", { threadId: "t_1" });
  tracker.done("s2", { threadId: "t_2", ms: 10, preview: "B 的答案" });
  assert.equal(tracker.latest("s1")?.state, "running");
  assert.equal(tracker.latest("s2")?.state, "done");
  assert.equal(tracker.latest("s3"), null);
  assert.equal(tracker.latest(""), null, "空 sessionId 不能造出通知");
  assert.equal(tracker.begin("", { threadId: "t_x" }), null, "空 sessionId 不记");
});

test("notice: seq 全局单调递增（客户端靠它去重，不能每次轮询都回放）", () => {
  const tracker = createNoticeTracker();
  const a = tracker.begin("s1", { threadId: "t_1" });
  const b = tracker.begin("s2", { threadId: "t_2" });
  const c = tracker.done("s1", { threadId: "t_1", ms: 1, preview: "x" });
  assert.ok(a !== null && b !== null && c !== null);
  assert.equal(b.seq, a.seq + 1);
  assert.equal(c.seq, b.seq + 1);
});

test("notice: 会话数有上限，淘汰最久未用的那条（不无限增长）", () => {
  const tracker = createNoticeTracker({ maxSessions: 2 });
  tracker.begin("s1", { threadId: "t_1" });
  tracker.begin("s2", { threadId: "t_2" });
  tracker.begin("s3", { threadId: "t_3" });
  assert.equal(tracker.latest("s1"), null, "最早的被淘汰");
  assert.equal(tracker.latest("s2")?.state, "running");
  assert.equal(tracker.latest("s3")?.state, "running");
  // 同一个会话再次更新时移到最新位置（Map 顺序按最近使用）
  tracker.done("s2", { threadId: "t_2", ms: 1, preview: "y" });
  tracker.begin("s4", { threadId: "t_4" });
  assert.equal(tracker.latest("s3"), null, "s2 刚更新过，s3 才是最旧的");
  assert.equal(tracker.latest("s2")?.state, "done");
});

test("notice: 返回的是快照，客户端拿到后改不动宿主内部状态", () => {
  const tracker = createNoticeTracker();
  tracker.begin("s1", { threadId: "t_1" });
  const snapshot = tracker.latest("s1");
  assert.ok(snapshot);
  snapshot.state = "error";
  assert.equal(tracker.latest("s1")?.state, "running");
});

test("notice: previewOf 压平空白并按上限截断（不把换行带进 toast）", () => {
  assert.equal(previewOf(undefined), "");
  assert.equal(previewOf(null), "");
  assert.equal(previewOf(""), "");
  assert.equal(previewOf("旁问  \n\n  只读\t主线可干活"), "旁问 只读 主线可干活");
  const long = previewOf("一".repeat(NOTICE_MAX_PREVIEW + 60));
  assert.equal(long.length, NOTICE_MAX_PREVIEW + 1, "截断后带一个省略号");
  assert.ok(long.endsWith("…"));
  assert.equal(previewOf("短答案"), "短答案", "没超上限不加省略号");
  assert.equal(previewOf("x".repeat(NOTICE_MAX_PREVIEW)), "x".repeat(NOTICE_MAX_PREVIEW));
});
