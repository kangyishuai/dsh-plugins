// @ts-check
// 上下文徽章的**纯文本生成**（不 import 宿主包，便于单测）。
//
// 诚实原则（v0.3 设计的硬要求）：
// fork 子代理继承的是父会话**全部已完成轮次**，第三方插件无法只继承其中一部分
// （`ctx.llm` 拿不到 adapter，见 ADR 0016）。所以「上下文范围」只能在提示词里声明
// 「请只看这些」，徽章必须如实写明「模型可见完整会话」，**不能**声称限制了上下文。

/**
 * 生成徽章文本。
 * @param {{ records?: number, scope?: string, lang?: string }} [input]
 * @returns {string}
 */
export function renderBadge(input = {}) {
  const lang = input.lang === "en" ? "en" : "zh";
  const records = Math.max(0, Math.trunc(Number(input.records) || 0));
  const scope = String(input.scope ?? "").trim();
  if (lang === "en") {
    const base =
      records === 0
        ? "No side question yet"
        : `Based on ${records} side-question record${records === 1 ? "" : "s"}`;
    const caveat =
      "the model can see the whole conversation; only the instruction scopes the answer";
    return scope === "" ? `${base} · ${caveat}` : `${base} · ${caveat} · asked to focus: ${scope}`;
  }
  const base = records === 0 ? "本会话还没有旁问" : `基于 ${records} 条旁问记录`;
  const caveat = "模型可见完整会话，范围只约束回答";
  return scope === "" ? `${base} · ${caveat}` : `${base} · ${caveat} · 已要求只看：${scope}`;
}

/**
 * 把「范围」要求渲染成提示词片段（真正生效的只有这段指令，不是上下文裁剪）。
 * @param {string} scope
 * @returns {string}
 */
export function renderScopeInstruction(scope) {
  const text = String(scope ?? "").trim();
  if (text === "") return "";
  return [
    "Scope requested by the user for this side question (advisory only — you can see the whole session):",
    text,
    "Prefer information inside that scope; if the answer is outside it, say so explicitly.",
  ].join("\n");
}
