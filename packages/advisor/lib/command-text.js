// @ts-check
// `/advisor` 命令输出的文案规则（纯函数，单测可直接导入）。
//
// 为什么单独成文件：service.js 一开头就 import 宿主包（`@deepseek-ai/dsh-session` 等），
// 单测环境解析不到，命令文案就只能靠人肉回归。审计 USIM-U2-07 / USIM-U2-08 的修复
// 全部落在这几个字符串规则上，所以抽出来测。
//
// 两条宿主事实（docs/runtime/0.2.2-rc.5.md §5.2 / 本地 `app.asar` 内的
// `dsh-client-ui-chat/src/client/chat/GenericCommandCard.tsx`）：
//   1. 通用命令卡片只显示 `node.name`（= `advisor`），**不显示用户敲的子命令**；
//      单行 summary 会被 CSS 省略号截断，多行正文要点开卡片第二层折叠才看得见。
//   2. 命令节点被宿主 Chat 的分组逻辑放进可折叠的 process 块（标题固定是「已完成分析」），
//      插件没有办法把节点移出分组。所以插件自己的命令卡片必须把「原始命令行 + 多行正文」
//      一次给全，并且回执（shell.overlay）不依赖分组是否展开。

/** 命令名（注册与回显共用一处，避免两处漂移）。 */
export const COMMAND_NAME = "advisor";

/**
 * 把用户实际敲的参数拼回命令行。宿主的 `command/run.args` 是 `rawInput` 原文
 * （含分隔空白），这里统一 trim 后只留一个空格。
 * @param {unknown} rawInput
 * @returns {string} 形如 `/advisor status`
 */
export function commandEcho(rawInput) {
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  return raw === "" ? `/${COMMAND_NAME}` : `/${COMMAND_NAME} ${raw}`;
}

/**
 * 命令回执文本：第一行永远是原始命令行，正文原样保留（不做折行/截断）。
 * 这样即使只看 `command/done.data.text`（会话日志、宿主的通用卡片、冒烟脚本），
 * 也能知道用户执行了哪条命令。
 * @param {unknown} rawInput
 * @param {unknown} text
 * @returns {string}
 */
export function commandReply(rawInput, text) {
  const echo = commandEcho(rawInput);
  const body = typeof text === "string" ? text.trim() : "";
  return body === "" ? echo : `${echo}\n${body}`;
}

/**
 * 保存态 → 真实生效态。
 *
 * 与宿主 `runAdvisor` 的判据保持一致（service.js 里先判 mode、再判是否配置了模型）：
 * - `mode === "off"` → 关闭，原因是模式；
 * - 没有 provider/model → 关闭，原因是未选择模型（即使保存的 mode 是 advisory）；
 * - `mode === "shadow"` → 影子：照常调用并记账，但建议不回灌给模型；
 * - 其余 → 正常生效。
 * @param {any} settings
 * @returns {{ effective: "on" | "shadow" | "off", reason: "mode" | "unconfigured" | null }}
 */
export function effectiveStateOf(settings) {
  const mode = settings?.mode === "advisory" || settings?.mode === "shadow" ? settings.mode : "off";
  const provider = typeof settings?.provider === "string" ? settings.provider.trim() : "";
  const model = typeof settings?.model === "string" ? settings.model.trim() : "";
  const configured = provider !== "" && model !== "";
  if (mode === "off") return { effective: "off", reason: "mode" };
  if (!configured) return { effective: "off", reason: "unconfigured" };
  if (mode === "shadow") return { effective: "shadow", reason: null };
  return { effective: "on", reason: null };
}

/**
 * 生效状态的一行中文（`/advisor status` 与设置页共用同一套判据）。
 * @param {{ effective: "on" | "shadow" | "off", reason: "mode" | "unconfigured" | null }} state
 * @returns {string}
 */
export function effectiveLine(state) {
  if (state.effective === "on") return "已生效：会征询顾问";
  if (state.effective === "shadow") return "影子模式：只记账，不回灌建议";
  return state.reason === "unconfigured" ? "已关闭：未选择顾问模型" : "已关闭：模式为 off";
}

/**
 * `/advisor status` 的正文（不含第一行命令回显，由 {@link commandReply} 加）。
 * 拆成纯函数：多行结构、生效状态与路由的措辞都是审计点。
 * @param {{
 *   settings: any,
 *   counters?: { sessionCalls?: number, turnCalls?: number } | null,
 *   totals?: { inputTokens?: number, outputTokens?: number, calls?: number } | null,
 *   last?: any,
 *   skip?: string | undefined | null,
 * }} input
 * @returns {string}
 */
export function formatStatusText(input) {
  const settings = input.settings ?? {};
  const counters = input.counters ?? {};
  const totals = input.totals ?? {};
  const state = effectiveStateOf(settings);
  const provider = typeof settings.provider === "string" ? settings.provider : "";
  const model = typeof settings.model === "string" ? settings.model : "";
  const configured = provider !== "" && model !== "";
  const route = configured ? `${provider}/${model}` : "（未配置）";
  const effort = typeof settings.reasoningEffort === "string" ? settings.reasoningEffort : "";
  const last = input.last ?? null;
  const lastText =
    last === null || typeof last !== "object"
      ? "（还没有）"
      : `${String(last.status ?? "")}${
          typeof last.code === "string" && last.code !== "" && last.code !== "ok"
            ? ` · ${last.code}`
            : ""
        }${typeof last.usage === "string" && last.usage !== "" ? ` · ${last.usage}` : ""}`;
  const maxTurn = Number(settings.maxCallsPerTurn) > 0 ? String(settings.maxCallsPerTurn) : "∞";
  const maxSession =
    Number(settings.maxCallsPerSession) > 0 ? String(settings.maxCallsPerSession) : "∞";
  const skip = typeof input.skip === "string" && input.skip !== "" ? input.skip : "（无）";
  return [
    `模式：${typeof settings.mode === "string" && settings.mode !== "" ? settings.mode : "off"}`,
    `生效：${effectiveLine(state)}`,
    `顾问：${route}${effort === "" ? "" : ` · 思考档 ${effort}`}`,
    `本会话：${Number(counters.sessionCalls ?? 0)} 次（本回合 ${Number(
      counters.turnCalls ?? 0,
    )}/${maxTurn}，本会话上限 ${maxSession}）`,
    `累计 token：${Number(totals.inputTokens ?? 0)} in / ${Number(
      totals.outputTokens ?? 0,
    )} out（${Number(totals.calls ?? 0)} 次）`,
    `最近一次：${lastText}`,
    `最近跳过：${skip}`,
  ].join("\n");
}
