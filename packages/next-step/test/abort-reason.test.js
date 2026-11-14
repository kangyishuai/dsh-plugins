// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  abortReasonOf,
  abortReasonText,
  abortSkipKind,
  TIMEOUT_MESSAGE,
} from "../lib/abort-reason.js";

test("abortReasonOf：超时定时器的 reason → timeout", () => {
  assert.equal(abortReasonOf(new Error(TIMEOUT_MESSAGE)), "timeout");
  assert.equal(abortReasonOf(new Error("generation timeout after 20s")), "timeout");
  assert.equal(abortReasonOf(new Error("operation TIMED OUT")), "timeout");
  assert.equal(abortReasonOf(new Error("connect timeout")), "timeout");
});

test("abortReasonOf：其它情况一律算取消", () => {
  assert.equal(abortReasonOf(undefined), "cancelled");
  assert.equal(abortReasonOf(null), "cancelled");
  assert.equal(abortReasonOf(new Error("superseded by a newer generation")), "cancelled");
  assert.equal(abortReasonOf("user cancelled"), "cancelled");
  // 宿主/浏览器对 cancel 的常见 reason 形状
  assert.equal(abortReasonOf({ code: "ABORT_ERR" }), "cancelled");
  // 非 Error 也带 message 字段
  assert.equal(abortReasonOf({ message: "next-step timeout" }), "timeout");
});

test("abortSkipKind：诊断行里的 kind 用普通人能读的词", () => {
  assert.equal(abortSkipKind("timeout"), "timeout");
  assert.equal(abortSkipKind("cancelled"), "cancelled");
});

test("abortReasonText：超时带秒数，取消只说 cancelled", () => {
  assert.equal(abortReasonText("timeout", 20_000), "generation timeout after 20s");
  assert.equal(abortReasonText("timeout", 3000), "generation timeout after 3s");
  // 没给时长也要能说清楚，不能拼出 "after NaNs"
  assert.equal(abortReasonText("timeout"), "generation timeout");
  assert.equal(abortReasonText("timeout", 0), "generation timeout");
  assert.equal(abortReasonText("timeout", Number.NaN), "generation timeout");
  assert.equal(abortReasonText("cancelled", 20_000), "cancelled");
});
