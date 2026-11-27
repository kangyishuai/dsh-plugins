// @ts-check
// 命令文案的纯函数测试（审计 USIM-U2-07 / USIM-U2-08）。
//
// 这两条审计的共同根因是「命令输出只有一行、且不显示用户敲了什么」：
// - 宿主的命令卡片（`GenericCommandCard`）只渲染一行 summary，多行正文要点开第二层折叠；
//   命令本身（`/advisor status`）在宿主的通用卡片里根本不显示（它只显示 name）。
// 所以插件自己的命令回执必须**把原始命令行写进文本的第一行**，并让可选状态独立成行。
//
// service.js 依赖宿主包、单测里导入不了，所以这些字符串规则放这里测。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_NAME,
  commandEcho,
  commandReply,
  effectiveStateOf,
  formatStatusText,
} from "../lib/command-text.js";

test("commandEcho 保留用户实际敲的命令（含子命令）", () => {
  assert.equal(COMMAND_NAME, "advisor");
  assert.equal(commandEcho(""), "/advisor");
  assert.equal(commandEcho("   "), "/advisor");
  assert.equal(commandEcho("status"), "/advisor status");
  assert.equal(commandEcho(" doctor "), "/advisor doctor");
  assert.equal(commandEcho("mock/kimi high"), "/advisor mock/kimi high");
});

test("commandReply 的第一行永远是原始命令行，正文原样保留", () => {
  assert.equal(commandReply("status", "模式：off"), "/advisor status\n模式：off");
  assert.equal(
    commandReply("doctor", "✅ 宿主 llm 服务可用"),
    "/advisor doctor\n✅ 宿主 llm 服务可用",
  );
  // 正文已空时只留命令行（避免出现尾随空行）。
  assert.equal(commandReply("off", ""), "/advisor off");
  // 多行正文不被压平（宿主命令卡片 / 回执都靠它做多行渲染）。
  assert.equal(
    commandReply("status", "模式：off\n顾问：未配置"),
    "/advisor status\n模式：off\n顾问：未配置",
  );
});

test("effectiveStateOf 区分保存态与真实生效态（USIM-U2-08）", () => {
  assert.deepEqual(effectiveStateOf({ mode: "advisory", provider: "", model: "" }), {
    effective: "off",
    reason: "unconfigured",
  });
  assert.deepEqual(effectiveStateOf({ mode: "advisory", provider: "p", model: "m" }), {
    effective: "on",
    reason: null,
  });
  assert.deepEqual(effectiveStateOf({ mode: "shadow", provider: "", model: "" }), {
    effective: "off",
    reason: "unconfigured",
  });
  assert.deepEqual(effectiveStateOf({ mode: "shadow", provider: "p", model: "m" }), {
    effective: "shadow",
    reason: null,
  });
  assert.deepEqual(effectiveStateOf({ mode: "off", provider: "p", model: "m" }), {
    effective: "off",
    reason: "mode",
  });
  // 畸形 / 缺字段一律按「未配置的 off」处理，绝不抛。
  assert.deepEqual(effectiveStateOf(null), { effective: "off", reason: "mode" });
  assert.deepEqual(effectiveStateOf({ mode: "??", provider: 1, model: 2 }), {
    effective: "off",
    reason: "mode",
  });
});

test("formatStatusText 多行、含生效状态，且四行核心信息都在", () => {
  const text = formatStatusText({
    settings: { mode: "advisory", provider: "", model: "", reasoningEffort: "" },
    counters: { sessionCalls: 0, turnCalls: 0 },
    totals: { inputTokens: 0, outputTokens: 0, calls: 0 },
    last: null,
    skip: undefined,
  });
  const lines = text.split("\n");
  assert.ok(lines.length >= 5, `状态至少 5 行，实际 ${lines.length}`);
  assert.match(text, /^模式：advisory$/mu);
  // 保存态是 advisory、但没有模型 → 必须明说「已关闭」和原因。
  assert.match(text, /^生效：已关闭：未选择顾问模型$/mu);
  assert.match(text, /^顾问：（未配置）$/mu);
  assert.match(text, /^本会话：0 次/mu);
  assert.match(text, /^最近一次：（还没有）$/mu);
});

test("formatStatusText 的生效状态覆盖 off / 影子 / 已生效", () => {
  const base = {
    counters: { sessionCalls: 2, turnCalls: 1 },
    totals: { inputTokens: 1200, outputTokens: 300, calls: 3 },
  };
  const off = formatStatusText({
    ...base,
    settings: { mode: "off", provider: "p", model: "m", reasoningEffort: "" },
    last: { status: "reviewed", code: "ok" },
    skip: "顾问已关闭（/advisor on 打开）",
  });
  assert.match(off, /^生效：已关闭：模式为 off$/mu);
  assert.match(off, /^最近跳过：顾问已关闭/mu);

  const shadow = formatStatusText({
    ...base,
    settings: { mode: "shadow", provider: "p", model: "m", reasoningEffort: "" },
    last: null,
  });
  assert.match(shadow, /^生效：影子模式：只记账，不回灌建议$/mu);

  const on = formatStatusText({
    ...base,
    settings: { mode: "advisory", provider: "p", model: "m", reasoningEffort: "high" },
    last: null,
  });
  assert.match(on, /^生效：已生效：会征询顾问$/mu);
  assert.match(on, /^顾问：p\/m · 思考档 high$/mu);
});
