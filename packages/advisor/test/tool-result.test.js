// @ts-check
// 工具结果「对模型暴露什么」的纯函数测试（审计 USIM-U1-11）。
//
// 事实链（2026-11-28 复核宿主源码，复审 F2 指出旧注释把通道写反了）：
// 工具结果的 `value` 是 execution-local，**不进持久化事件**；模型读到的是
// `output.render(args, value)` 渲染出的 `content`（宿主用它构造并持久化 `tool/result`，
// UI 工具卡与模型上下文共用同一份）。所以「Advisor 当前是关闭状态」这句能进用户可见回复，
// 是因为 runAdvisor 的 skip 结果把 `code: "disabled" / reason: "顾问已关闭（/advisor on 打开）"`
// 留在 value 里、而 `renderToolOutput` 把它原样渲染成了模型可见文本 —— 下面最后一条用例
// 用 exposeSkip + renderToolOutput 的组合钉住「真正进模型的那段字符串」。
//
// service.js 依赖宿主包、单测里导入不了，所以「对模型暴露哪一份」这个决策放这里测。
import assert from "node:assert/strict";
import { test } from "node:test";
import { exposeSkip, INTERNAL_STATE_CODES, NEUTRAL_SKIP_REASON } from "../lib/tool-result.js";
import { renderToolOutput } from "../lib/tool-schema.js";

test("工具触发的内部开关跳过不再携带开关状态", () => {
  assert.ok(INTERNAL_STATE_CODES.includes("disabled"));
  for (const code of INTERNAL_STATE_CODES) {
    const exposed = exposeSkip({
      trigger: "tool",
      code,
      reason: "顾问已关闭（/advisor on 打开）",
    });
    assert.equal(exposed.status, "skipped");
    // 保留「没有建议」的语义，但不暴露开关/配置状态。
    assert.equal(exposed.code, "no_advice");
    assert.doesNotMatch(exposed.reason, /关闭/u);
    assert.doesNotMatch(exposed.reason, /未配置/u);
    assert.doesNotMatch(exposed.reason, /shadow/u);
    assert.doesNotMatch(exposed.reason, /advisor on/u);
    // 输入侧能收敛的只有这一句：明确要求模型不要把状态写进给用户看的回复。
    assert.match(exposed.reason, /不要/u);
    assert.match(exposed.reason, /回复/u);
    assert.equal(exposed.reason, NEUTRAL_SKIP_REASON);
  }
});

test("需要用户动作的跳过（跨 provider 确认）保留原文", () => {
  const exposed = exposeSkip({
    trigger: "tool",
    code: "needs_confirmation",
    reason: "跨 provider 首次征询需要确认：运行 /advisor confirm 允许",
  });
  assert.equal(exposed.code, "needs_confirmation");
  assert.equal(exposed.reason, "跨 provider 首次征询需要确认：运行 /advisor confirm 允许");
});

test("被动投递（shadow / post-answer）不经过模型，保留内部原因", () => {
  // 非 tool 触发的结果只会进插件的账本/面板，不会成为工具结果，所以不需要收敛。
  const exposed = exposeSkip({
    trigger: "shadow",
    code: "not_configured",
    reason: "还没配置顾问模型（/advisor 选择）",
  });
  assert.equal(exposed.code, "not_configured");
  assert.equal(exposed.reason, "还没配置顾问模型（/advisor 选择）");
});

test("renderToolOutput + exposeSkip 组合：真正进模型的文本不含开关状态（复审 F2/F7a）", () => {
  // 这是 U1-11 真正防泄漏的那一行：value 会被 renderToolOutput 渲染成 content，
  // 而 content 就是模型读到的工具结果。三种内部状态都要渲染成中性跳过。
  for (const code of INTERNAL_STATE_CODES) {
    const value = exposeSkip({
      trigger: "tool",
      code,
      reason: "顾问已关闭（/advisor on 打开）",
    });
    const rendered = renderToolOutput({}, value);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, "text");
    const modelVisible = String(rendered[0].text);
    // 中性语义仍在（模型知道「这次没有建议」），但开关状态/操作指引一个字都不能有。
    assert.match(modelVisible, /未征询/u);
    for (const banned of ["关闭", "未配置", "shadow", "advisor on", "shadow_mode"]) {
      assert.equal(
        modelVisible.includes(banned),
        false,
        `模型可见文本泄漏了内部状态「${banned}」：${modelVisible}`,
      );
    }
    assert.ok(modelVisible.includes(NEUTRAL_SKIP_REASON), `应渲染中性 reason：${modelVisible}`);
  }
});

test("畸形输入不抛，且永远不会把「内部 code」留在 tool 结果里", () => {
  assert.equal(exposeSkip(null).status, "skipped");
  assert.equal(exposeSkip({}).code, "skipped");
  const tool = exposeSkip({ trigger: "tool", code: "disabled" });
  assert.equal(tool.code, "no_advice");
  assert.equal(tool.reason, NEUTRAL_SKIP_REASON);
});
