// @ts-check
// 人格单测：默认三条准则、用户设定、边界声明、不吞权限、不与上下文重复。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPersona,
  DEFAULT_PERSONA_RULES,
  PERSONA_ORDER,
  personaRepeatsContext,
} from "../lib/persona.js";

describe("buildPersona", () => {
  it("无自定义人格时用默认三条准则", () => {
    const text = buildPersona({ projectName: "payments" });
    assert.match(text, /# 你是「payments」的协调器/u);
    for (const rule of DEFAULT_PERSONA_RULES) assert.ok(text.includes(rule), `缺准则：${rule}`);
    assert.ok(!text.includes("## 用户设定"), "没有自定义就别留空段");
  });

  it("有自定义人格时单独成段，排在默认准则之前", () => {
    const text = buildPersona({ projectName: "payments", persona: "回答尽量短。" });
    assert.match(text, /## 用户设定\n回答尽量短。/u);
    const customAt = text.indexOf("## 用户设定");
    const defaultAt = text.indexOf("## 默认准则");
    assert.ok(customAt < defaultAt, "用户设定优先于默认准则呈现");
  });

  it("明确声明人格不改权限（防止从人格里塞权限）", () => {
    const text = buildPersona({ projectName: "x" });
    assert.match(text, /人格不改变权限/u);
    assert.match(text, /只能发起「申请」，不能自己执行/u);
    assert.ok(text.includes("不要声称自己做了没做的事"));
  });

  it("项目名为空时退化为「这个项目」而不是留下空引号", () => {
    assert.match(buildPersona({}), /你是「这个项目」的协调器/u);
  });

  it("段落顺序常量固定（比项目上下文更靠后）", () => {
    assert.equal(PERSONA_ORDER, 140);
  });
});

describe("personaRepeatsContext", () => {
  it("人格里不会把项目指令原样再贴一遍", () => {
    const context = { instructions: "# 项目规则\n一律先跑测试。" };
    assert.equal(personaRepeatsContext(buildPersona({ projectName: "x" }), context), false);
  });

  it("如果确实重复了（用户把指令粘进人格）能检测出来", () => {
    const instructions = "# 项目规则\n一律先跑测试再提交，且不要改版本号。";
    const text = buildPersona({ projectName: "x", persona: instructions });
    assert.equal(personaRepeatsContext(text, { instructions }), true);
  });

  it("空指令时不判定重复", () => {
    assert.equal(personaRepeatsContext("anything", {}), false);
    assert.equal(personaRepeatsContext("anything", undefined), false);
  });
});
