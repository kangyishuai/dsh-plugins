// @ts-check
// F52 权限**收窄**开关：把宿主 `permissionPresets` 的 {sandbox, approval} 组合翻译成人话。
//
// 方向别写反（docs/runtime/0.2.2-rc.5.md §12 实测）：
// 本部署的 `catalog.defaultPreset` 已经是 `danger-full-access` + `approval: never`，
// 所以项目开关不是"打开自动放行"，而是**把新建线程/协调器会话收窄回更安全的档位**。
// 默认档 = 「继承宿主」（不改任何东西）；用户显式选一档才切。
//
// 另外两条硬事实决定这里的形状：
// 1. preset 名是部署配置（`static Config.presets` + 本机 profile patch），**不能写死名字**：
//    只能 `catalog()` 列出来、逐个 `resolve()` 看 bundle，再按 bundle 挑。
// 2. 没有匹配档时用 `session.append('approval/policy'|'sandbox/mode')` 兜底，
//    并在 UI 标「自定义」。兜底吃事件类型版本风险（硬性约定 1），所以只作退路。

/** 「继承宿主」的哨兵值（UI 用它，store 里也存它：空串 = 不干预）。 */
export const INHERIT_PRESET = "";

/** sandbox 三档的中文标签。 */
export const SANDBOX_LABELS = Object.freeze({
  "read-only": "只读",
  "workspace-write": "工作区可写",
  "danger-full-access": "全权限",
});

/** approval 两档的中文标签。 */
export const APPROVAL_LABELS = Object.freeze({
  ask: "逐次询问",
  never: "从不询问",
});

/** 三档 sandbox 的宽松程度（数字越大越宽），用于「相对默认是收窄还是放宽」。 @type {Record<string, number>} */
const SANDBOX_RANK = {
  "read-only": 1,
  "workspace-write": 2,
  "danger-full-access": 3,
};

/** 五条 UI 必须写明的边界（F52 的"别让用户误会"）。 */
export const PRESET_SAFETY_NOTES = Object.freeze([
  "推 / 合并 / 删除永远需要你在面板里批准（插件执行器六闸），本开关不绕过任何一道。",
  "本开关只影响工具调用是否逐次询问、以及命令能否写到项目目录之外。",
  "默认「继承宿主」＝不改变宿主默认档；本部署的默认档是全权限，所以要更安全请显式收窄。",
  "作用点：新建线程会话与协调器会话创建后套用；已经存在的旧会话按「应用」按钮补一次。",
  "宿主没有「记住这次授权」的通用接口（ApprovalOutcome 只有 allowed-once），本开关也不假装有。",
]);

/**
 * @typedef {{ sandbox: string, approval: string }} PresetSpec
 * @typedef {{ kind: 'read-only'|'workspace-write'|'full-access'|'custom', label: string, detail: string }} PresetHuman
 */

/** @param {unknown} value @returns {string} */
export function normalizeSandbox(value) {
  const text = String(value ?? "").trim();
  return Object.hasOwn(SANDBOX_LABELS, text) ? text : "";
}

/** @param {unknown} value @returns {string} */
export function normalizeApproval(value) {
  const text = String(value ?? "").trim();
  return Object.hasOwn(APPROVAL_LABELS, text) ? text : "";
}

/**
 * `{sandbox, approval}` → 人话。
 * 只读 / 工作区可写 / 全权限 三档按 sandbox 定；approval 决定"要不要逐次询问"的补充说明。
 * 认不出的组合标「自定义」——不猜、不假装它是某一档。
 * @param {any} spec
 * @returns {PresetHuman}
 */
export function describePresetSpec(spec) {
  const sandbox = normalizeSandbox(spec?.sandbox);
  const approval = normalizeApproval(spec?.approval);
  if (sandbox === "" || approval === "") {
    return {
      kind: "custom",
      label: "自定义",
      detail: "宿主给的这个档位不在已知的 sandbox/approval 组合里",
    };
  }
  const approvalText =
    approval === "ask" ? "工具调用会逐次询问" : "工具调用从不询问（只受执行器闸门约束）";
  /** @type {Record<string, {kind: PresetHuman['kind'], label: string}>} */
  const table = {
    "read-only": { kind: "read-only", label: "只读" },
    "workspace-write": { kind: "workspace-write", label: "工作区可写" },
    "danger-full-access": { kind: "full-access", label: "全权限" },
  };
  const base = table[sandbox];
  const sandboxText =
    sandbox === "read-only"
      ? "只能读文件与跑只读命令，写操作会被沙箱拒绝"
      : sandbox === "workspace-write"
        ? "可以写项目目录，目录之外仍然受限"
        : "可以写任意路径（宿主默认档）";
  return { kind: base.kind, label: base.label, detail: `${sandboxText}；${approvalText}` };
}

/**
 * 相对「宿主默认档」是收窄、放宽还是混合。
 * 默认档由 `catalog().defaultOptions`/`defaultPreset` 的 bundle 给出。
 * @param {any} optionSpec
 * @param {any} defaultSpec
 * @returns {'narrower'|'wider'|'same'|'mixed'|'unknown'}
 */
export function relationToDefault(optionSpec, defaultSpec) {
  const sandbox = normalizeSandbox(optionSpec?.sandbox);
  const defaultSandbox = normalizeSandbox(defaultSpec?.sandbox);
  const approval = normalizeApproval(optionSpec?.approval);
  const defaultApproval = normalizeApproval(defaultSpec?.approval);
  if (sandbox === "" || defaultSandbox === "" || approval === "" || defaultApproval === "") {
    return "unknown";
  }
  const sandboxDelta = (SANDBOX_RANK[sandbox] ?? 0) - (SANDBOX_RANK[defaultSandbox] ?? 0);
  const approvalMore = approval === "ask" && defaultApproval === "never";
  const approvalLess = approval === "never" && defaultApproval === "ask";
  if (sandboxDelta === 0 && !approvalMore && !approvalLess) return "same";
  if (sandboxDelta <= 0 && !approvalLess) return "narrower";
  if (sandboxDelta >= 0 && !approvalMore) return "wider";
  return "mixed";
}

/**
 * 把 `catalog()` 的原始形状整理成 UI 选项（名字**一律来自 catalog**）。
 * @param {any} catalog `{ options:[{value,name}], defaultOptions:[...], defaultPreset:string }`
 * @param {(name: string) => any} resolve 宿主 `resolve(name)`
 * @returns {{ options: any[], defaultPreset: string, defaultSpec: any, defaultHuman: PresetHuman }}
 */
export function summarizeCatalog(catalog, resolve) {
  const options = Array.isArray(catalog?.options) ? catalog.options : [];
  const defaultPreset = typeof catalog?.defaultPreset === "string" ? catalog.defaultPreset : "";
  const defaultSpec =
    typeof resolve === "function" && defaultPreset !== "" ? resolve(defaultPreset) : undefined;
  const defaultHuman = describePresetSpec(defaultSpec);
  /** @type {any[]} */
  const rows = [];
  for (const option of options) {
    const name = typeof option === "string" ? option : String(option?.value ?? "");
    if (name === "") continue;
    let spec;
    try {
      spec = typeof resolve === "function" ? resolve(name) : undefined;
    } catch {
      spec = undefined;
    }
    const human = describePresetSpec(spec);
    rows.push({
      name,
      label: human.label,
      detail: human.detail,
      kind: human.kind,
      spec:
        spec && typeof spec === "object"
          ? { sandbox: spec.sandbox, approval: spec.approval }
          : null,
      relation: relationToDefault(spec, defaultSpec),
      isDefault: name === defaultPreset,
    });
  }
  return { options: rows, defaultPreset, defaultSpec: defaultSpec ?? null, defaultHuman };
}

/**
 * 「继承宿主」那一行的人话（UI 下拉的第一项）。
 * @param {PresetHuman} defaultHuman
 * @param {string} defaultPreset
 * @returns {{ name: string, label: string, detail: string }}
 */
export function inheritOption(defaultHuman, defaultPreset) {
  return {
    name: INHERIT_PRESET,
    label: "继承宿主默认（不改变）",
    detail:
      defaultPreset === ""
        ? "不改变任何东西：新会话跟宿主默认走"
        : `不改变任何东西：新会话跟宿主默认走（本部署默认档是「${defaultHuman.label}」${defaultPreset ? ` = ${defaultPreset}` : ""}）`,
  };
}

/**
 * 选择一个 preset 名后，下一步该做什么。
 * - `inherit`：什么都不做；
 * - `preset`：名字在 catalog 里 → `permissionPresets.set(session, name)`；
 * - `fallback`：名字不在 catalog 里，但调用方显式给了 `sandbox/approval` 组合 → 用两个 session 事件兜底；
 * - `invalid`：名字不认，且没有可兜底的组合。
 * @param {{ preset?: unknown, catalogNames?: string[], fallbackSpec?: any }} input
 * @returns {{ mode: 'inherit' } | { mode: 'preset', name: string } | { mode: 'fallback', spec: PresetSpec } | { mode: 'invalid', reason: string }}
 */
export function planPresetApplication(input) {
  const preset = String(input?.preset ?? "").trim();
  const names = Array.isArray(input?.catalogNames) ? input.catalogNames.map(String) : [];
  if (preset === INHERIT_PRESET) return { mode: "inherit" };
  if (names.includes(preset)) return { mode: "preset", name: preset };
  const spec = input?.fallbackSpec;
  const sandbox = normalizeSandbox(spec?.sandbox);
  const approval = normalizeApproval(spec?.approval);
  if (sandbox !== "" && approval !== "") return { mode: "fallback", spec: { sandbox, approval } };
  return { mode: "invalid", reason: `preset/not-in-catalog:${preset}` };
}

/**
 * 兜底用的会话事件（只在没有匹配 preset 时用；顺序固定 approval → sandbox）。
 * @param {PresetSpec} spec
 * @returns {Array<{ type: string, payload: any }>}
 */
export function fallbackSessionEvents(spec) {
  return [
    { type: "approval/policy", payload: { policy: normalizeApproval(spec?.approval) } },
    { type: "sandbox/mode", payload: { mode: normalizeSandbox(spec?.sandbox) } },
  ];
}

/**
 * 回读比较：宿主 `current(session)` / 兜底读回值 vs 目标。
 * @param {{ targetPreset: string, currentPreset: string, targetSpec?: any, currentSpec?: any }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyPresetApplication(input) {
  const targetPreset = String(input?.targetPreset ?? "");
  const currentPreset = String(input?.currentPreset ?? "");
  if (targetPreset === "") return { ok: false, reason: "preset/target-empty" };
  if (currentPreset === "") return { ok: false, reason: "preset/readback-empty" };
  if (targetPreset === currentPreset) return { ok: true, reason: "" };
  // 走兜底时 `current(session)` 未必等于目标名（它读的是 override/投影），
  // 这时按 sandbox+approval 组合比对。
  const targetSandbox = normalizeSandbox(input?.targetSpec?.sandbox);
  const targetApproval = normalizeApproval(input?.targetSpec?.approval);
  const currentSandbox = normalizeSandbox(input?.currentSpec?.sandbox);
  const currentApproval = normalizeApproval(input?.currentSpec?.approval);
  if (
    targetSandbox !== "" &&
    targetApproval !== "" &&
    targetSandbox === currentSandbox &&
    targetApproval === currentApproval
  ) {
    return { ok: true, reason: "" };
  }
  return { ok: false, reason: `preset/readback-mismatch:${currentPreset}!==${targetPreset}` };
}
