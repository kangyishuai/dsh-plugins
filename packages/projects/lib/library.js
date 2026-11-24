// @ts-check
// F33/F34/U15：Library 的纯逻辑层（不碰宿主服务，便于单测）。
//
// 为什么需要「自存映射」：artifacts 的 meta 里**不保证**有 projectId（0.1.0 没有；0.2 的
// 契约才把归属写进行里，但旧数据仍然是 null）。所以 projects 在项目线程里发布产物时，
// 自己记一条 `projectId → artifactId`（带标题/类型/版本/字节/时间/来源），
// artifacts 服务在不在都能解释「这个项目产出了什么」。

/** 我们自存的一条产物引用（UI 只依赖这些字段）。 */
export const MAX_ARTIFACT_REFS = 200;

/** artifacts 面板需要的契约版本（docs/plugin-conventions §8.3）。 */
export const ARTIFACTS_CONTRACT = "artifacts/2";

/** 产物类型词表（与 artifacts 0.2 一致；未知类型原样保留但 UI 走兜底样式）。 */
export const ARTIFACT_KINDS = Object.freeze(["html", "markdown", "json", "csv", "image"]);

/** @param {unknown} value @param {number} max @returns {string} */
function shortText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 把任意输入收敛成一条合法的产物引用；缺 id 就返回 null（不编造）。
 * @param {unknown} value
 * @returns {{ id: string, title: string, kind: string, version: number, bytes: number, totalBytes: number, updatedAt: number|null, at: string, coverUrl: string, sessionId: string, threadId: string, source: { sessionId: string, toolCallId: string, via: string }|null } | null}
 */
export function normalizeArtifactRef(value) {
  const source = value && typeof value === "object" ? /** @type {any} */ (value) : {};
  // id 必须是**单段目录名**（与 artifacts 契约一致）：带分隔符/控制字符/点开头的直接拒绝，
  // 不做静默改写——改写会让两个不同 id 撞成同一个键。
  const id = shortText(source.id, 120);
  if (id === "" || id === "." || id === ".." || id.startsWith(".")) return null;
  if (/[/\\]/u.test(id)) return null;
  for (const char of id) {
    const code = char.codePointAt(0);
    if (code !== undefined && code < 0x20) return null;
  }
  const kind = shortText(source.kind, 24).toLowerCase();
  const version = Number(source.version ?? source.latest ?? 1);
  const bytes = Number(source.bytes ?? 0);
  const updatedAt = Number(source.updatedAt ?? 0);
  const rawSource = source.source && typeof source.source === "object" ? source.source : {};
  return {
    id,
    title: shortText(source.title, 200) || id,
    kind: kind === "" ? "html" : kind,
    version: Number.isFinite(version) ? Math.max(1, Math.trunc(version)) : 1,
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0,
    totalBytes:
      Number.isFinite(Number(source.totalBytes)) && Number(source.totalBytes) > 0
        ? Math.trunc(Number(source.totalBytes))
        : 0,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : null,
    // 我们自己在记录时写下产出时间（ISO）；catalog 行没有这个字段，UI 的"时间未知"靠它补
    at: typeof source.at === "string" ? source.at : "",
    // artifacts 服务给的封面地址（GET .../cover.svg）：卡片用它显示真实缩略图
    coverUrl: shortText(source.coverUrl, 300),
    sessionId: shortText(source.sessionId, 120),
    threadId: shortText(source.threadId, 120),
    source:
      shortText(rawSource.sessionId, 120) === "" && shortText(rawSource.toolCallId, 120) === ""
        ? null
        : {
            sessionId: shortText(rawSource.sessionId, 120),
            toolCallId: shortText(rawSource.toolCallId, 120),
            via: shortText(rawSource.via, 40),
          },
  };
}

/**
 * 合并引用：同 id 以后来的为准（版本会涨），最新更新的排前面，上限 MAX_ARTIFACT_REFS。
 * @param {any[]} current @param {unknown} incoming
 * @returns {any[]}
 */
export function mergeArtifactRefs(current, incoming) {
  const list = Array.isArray(current) ? current.map(normalizeArtifactRef).filter(Boolean) : [];
  const ref = normalizeArtifactRef(incoming);
  if (ref === null) return /** @type {any[]} */ (list);
  const rest = list.filter((/** @type {any} */ item) => item.id !== ref.id);
  /** @type {any[]} */
  const merged = [ref, ...rest];
  merged.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
  return merged.slice(0, MAX_ARTIFACT_REFS);
}

/**
 * 产物面的计量（bytes 一律按「最新版本」口径，与 artifacts 的 summary 一致）。
 * @param {any[]} refs
 * @returns {{ count: number, bytes: number, latestAt: number|null }}
 */
export function summarizeArtifactRefs(refs) {
  const list = Array.isArray(refs) ? refs : [];
  const bytes = list.reduce(
    (/** @type {number} */ sum, /** @type {any} */ item) => sum + Number(item?.bytes ?? 0),
    0,
  );
  const latestAt = list.reduce(
    (/** @type {number|null} */ at, /** @type {any} */ item) =>
      typeof item?.updatedAt === "number" && (at === null || item.updatedAt > at)
        ? item.updatedAt
        : at,
    null,
  );
  return { count: list.length, bytes, latestAt };
}

/**
 * 把 artifacts 服务的行投影成我们自存的引用形状（projectId 命中时用来补齐/合并）。
 * @param {any} row
 * @returns {any}
 */
export function refFromArtifactRow(row) {
  const source = row && typeof row === "object" ? row : {};
  return normalizeArtifactRef({
    id: source.id,
    title: source.title,
    kind: source.kind,
    version: source.latest ?? source.version,
    bytes: source.bytes,
    totalBytes: source.totalBytes,
    updatedAt: source.updatedAt,
    sessionId: source.sessionId,
    threadId: source.threadId,
    source: source.source,
    coverUrl: source.coverUrl,
  });
}

/**
 * 产物来源的一句话文案（「来自哪条线程/哪次调用」是 Library 的核心价值）。
 * UI 用，保持纯函数好测。
 * @param {any} ref
 * @returns {{ sessionId: string, toolCallId: string, via: string }}
 */
export function provenanceOf(ref) {
  const source = ref?.source && typeof ref.source === "object" ? ref.source : {};
  return {
    sessionId: String(source.sessionId ?? ref?.sessionId ?? ""),
    toolCallId: String(source.toolCallId ?? ""),
    via: String(source.via ?? ""),
  };
}

/**
 * 降级判定：artifacts 服务不在 / 版本不对，都要**明示**，不能显示成「没有产物」。
 * @param {{ installed: boolean, contract?: string }} probe
 * @returns {{ degraded: boolean, reason: string, note: string }}
 */
export function artifactsDegradation(probe) {
  if (probe?.installed !== true) {
    return {
      degraded: true,
      reason: "artifacts-not-installed",
      note: "产物库需要 dsh-artifacts 0.2（当前未安装）；下面只列项目文件。",
    };
  }
  if (String(probe.contract ?? "") !== ARTIFACTS_CONTRACT) {
    return {
      degraded: true,
      reason: "artifacts-contract-mismatch",
      note: `产物库需要 dsh-artifacts 0.2（当前契约 ${String(probe.contract ?? "未知")}）；下面只列项目文件。`,
    };
  }
  return { degraded: false, reason: "", note: "" };
}
