// @ts-check
// 「最近一次生成尝试」的会话级记录（USIM-U2-04 的 host 半纯逻辑）。
//
// 背景：生成失败原来只在诊断面板/events.jsonl 里可见。自动生成（turn/end 之后那次调用）失败
// **不写会话日志**，客户端也没有任何通道知道它失败了——于是补生成入口一直写「生成下一步建议」，
// 用户看不出刚才失败过；手动补生成撞上在途生成时又只回一句静态「正在生成，请稍候」，永远不消失
// （真实用户报告：卡了 2 分钟；刷新后再点，失败又静默）。所以宿主侧要留一条**每会话最近一次生成**
// 的记录，供客户端用 `nextStep/generateState` 查询，把「刚才失败了，为什么」显示成「重试 + 原因摘要」。
//
// service.js 依赖宿主包，`node --test` 加载不了；能纯化的部分全部放 `lib/generate-status.js`，
// 这里直接覆盖记录归一化、detail 截断、每会话只留一条与 FIFO 上限。
import assert from "node:assert/strict";
import test from "node:test";

import {
  clipGenerateDetail,
  createGenerateStatus,
  GENERATE_DETAIL_CLIP,
  GENERATE_STATUS_LIMIT,
  generateRecordOf,
} from "../lib/generate-status.js";

test("generateRecordOf：成功归一成 ok:true / reason:ok / detail 空", () => {
  const record = generateRecordOf({ ok: true, card: { turn: 1 } }, { turn: 2, at: 123 });
  assert.deepEqual(record, { turn: 2, ok: true, reason: "ok", detail: "", at: 123 });
});

test("generateRecordOf：失败保留 reason 与 detail（客户端据此显示一行原因摘要 + 可展开详情）", () => {
  const record = generateRecordOf(
    {
      ok: false,
      reason: "schema",
      detail: "model output did not match the card schema (json:empty)",
    },
    { turn: 4, at: 456 },
  );
  assert.equal(record.ok, false);
  assert.equal(record.reason, "schema");
  assert.equal(record.detail, "model output did not match the card schema (json:empty)");
  assert.equal(record.turn, 4);
});

test("generateRecordOf：缺 reason 的返回兜底成 failed，非法 turn 记 -1", () => {
  assert.equal(generateRecordOf({ ok: false }, { turn: Number.NaN, at: 0 }).reason, "failed");
  assert.equal(generateRecordOf(null, { turn: 3, at: 0 }).reason, "failed");
  assert.equal(generateRecordOf(null, { turn: 3, at: 0 }).turn, 3);
  assert.equal(generateRecordOf({ ok: false }, { turn: 1.5, at: 0 }).turn, -1);
});

test("detail 超长截断成上限内的省略号（不把一整段模型错误原样塞进 UI）", () => {
  const long = "x".repeat(GENERATE_DETAIL_CLIP + 50);
  const clipped = clipGenerateDetail(long);
  assert.ok(clipped.length <= GENERATE_DETAIL_CLIP, `截断后应 <= ${GENERATE_DETAIL_CLIP}`);
  assert.ok(clipped.endsWith("…"), "截断后要有省略号");
  assert.equal(clipGenerateDetail("  短原因  "), "短原因");
  assert.equal(clipGenerateDetail(undefined), "");
  assert.equal(clipGenerateDetail(42), "");
});

test("每会话只留最近一条记录：后来的结果覆盖先前的（含成功覆盖失败）", () => {
  const status = createGenerateStatus({ limit: 4, now: () => 7 });
  assert.equal(status.last("s1"), null);
  status.record("s1", { ok: false, reason: "schema", detail: "bad" }, 3);
  assert.equal(status.last("s1").reason, "schema");
  status.record("s1", { ok: true }, 4);
  assert.deepEqual(status.last("s1"), { turn: 4, ok: true, reason: "ok", detail: "", at: 7 });
  assert.equal(status.size, 1, "同一会话不重复占位");
});

test("会话间互不影响；空 sessionId 不记", () => {
  const status = createGenerateStatus({ limit: 4 });
  status.record("a", { ok: false, reason: "failed", detail: "boom" }, 1);
  status.record("b", { ok: true }, 2);
  assert.equal(status.last("a").reason, "failed");
  assert.equal(status.last("b").ok, true);
  assert.equal(status.record("", { ok: true }, 1), null);
  assert.equal(status.last(""), null);
  assert.equal(status.size, 2);
});

test("FIFO 上限：超出 limit 时淘汰最早写入的会话，防止长进程里无限增长", () => {
  const status = createGenerateStatus({ limit: 2 });
  status.record("a", { ok: false, reason: "failed" }, 1);
  status.record("b", { ok: false, reason: "schema" }, 2);
  status.record("c", { ok: true }, 3);
  assert.equal(status.size, 2);
  assert.equal(status.last("a"), null, "最早的 a 被淘汰");
  assert.ok(status.last("b") && status.last("c"));
});

test("默认上限与 detail 上限是稳定常量（文档/诊断口径引用它们）", () => {
  assert.equal(typeof GENERATE_STATUS_LIMIT, "number");
  assert.ok(GENERATE_STATUS_LIMIT >= 16);
  assert.equal(typeof GENERATE_DETAIL_CLIP, "number");
  assert.ok(GENERATE_DETAIL_CLIP >= 120 && GENERATE_DETAIL_CLIP <= 400);
});
