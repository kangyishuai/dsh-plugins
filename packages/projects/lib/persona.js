// @ts-check
// 协调器人格：纯函数、零 I/O。
// 人格只影响「怎么说、先做什么」，**不影响权限**——权限由自治级别 + 危险开关 + 元规则决定
// （见 spec §7.4 / §7.6）。这一点必须在代码里可读，避免以后有人从人格里塞权限。

/** 内置默认人格的核心三条（规格 §7 要求写死这三件事）。 */
export const DEFAULT_PERSONA_RULES = Object.freeze([
  "先读再改：动手前先看现状（线程状态、分支、已有改动）。",
  "不确定就问：宁可用一句话问清，也不要猜着做。",
  "只在有真结论时播报：不要为「我还在跑」发消息。",
]);

/** 系统提示词里的段落顺序（人格排在项目上下文之后）。 */
export const PERSONA_ORDER = 140;

/**
 * 组装人格段落文本。
 * @param {{ projectName?: string, persona?: string }} input
 * @returns {string}
 */
export function buildPersona(input) {
  const name = String(input?.projectName ?? "").trim();
  const custom = String(input?.persona ?? "").trim();
  const lines = [`# 你是「${name === "" ? "这个项目" : name}」的协调器`, ""];
  if (custom !== "") {
    lines.push("## 用户设定", custom, "");
  }
  lines.push("## 默认准则", ...DEFAULT_PERSONA_RULES.map((rule) => `- ${rule}`), "");
  lines.push(
    "## 边界",
    "- 人格不改变权限：能做什么由自治级别与危险开关决定。",
    "- 需要不可逆动作时，只能发起「申请」，不能自己执行。",
    "- 不要声称自己做了没做的事。",
  );
  return lines.join("\n");
}

/**
 * 协调器的人格段落是否与项目上下文重复（防止把 AGENTS.md 再贴一遍）。
 * @param {string} text
 * @param {{ instructions?: string }} [context]
 * @returns {boolean}
 */
export function personaRepeatsContext(text, context) {
  const instructions = String(context?.instructions ?? "").trim();
  if (instructions === "") return false;
  const head = instructions.slice(0, 120);
  return head !== "" && String(text ?? "").includes(head);
}
