// @ts-check
// 纯函数层：不 import 任何 @deepseek-ai/*，可以脱离宿主单测。
//
// 输入是会话的两个只读视图：
//   - `session.snapshotEvents()`：append-only 事件日志；
//   - `session.surface.nodes`：模型可见的 surface 节点顺序（seq 数组）。
// 回溯只追加一条 marker（`user/message` + `surfaceOp: replace`），不删改日志；
// 本模块负责「哪些消息能当目标」「replace 区间是什么」「已经有哪些 marker」。

/** marker 的 source.kind，即本插件的生产者身份。 */
export const MARKER_SOURCE_KIND = "session-rewind";

/** marker 的固定文本：非空、provider 无关（严格网关也接受空语义的占位消息）。 */
export const MARKER_TEXT = "(empty message)";

/** 候选列表默认条数上限（最新优先）。 */
export const DEFAULT_CANDIDATE_LIMIT = 100;

/** 列表预览的最大字符数。 */
export const PREVIEW_MAX_CHARS = 80;

/**
 * 会话事件的最小只读形状（只列本模块用到的字段）。
 * @typedef {object} SessionEventLike
 * @property {number} seq 事件在日志中的序号
 * @property {number} time Unix epoch 毫秒
 * @property {string} type 事件类型
 * @property {any} data 事件负载；`user/message` 时就是消息本身
 */

/**
 * 消息的最小只读形状。
 * @typedef {object} MessageLike
 * @property {string} [id]
 * @property {string} [role]
 * @property {Array<any>} [content]
 * @property {Record<string, any>} [source]
 */

/**
 * 一条可回溯的候选：surface 上的真人用户消息。
 * @typedef {object} Candidate
 * @property {number} seq 日志序号
 * @property {number} index 1 基的「从新到旧」序号：1 = 最新的一条
 * @property {number} time 消息时间（Unix epoch 毫秒）
 * @property {string} preview 折叠空白并截断后的单行预览
 * @property {string} text 完整文本（回填输入框用）
 */

/**
 * 一次回溯的校验结果。
 * @typedef {object} RewindPlan
 * @property {number} targetSeq 目标消息的日志序号
 * @property {number} targetIndex 目标在 surface 中的下标
 * @property {number[]} shadowedSeqs 被 marker 遮蔽的 surface 节点（目标及其后全部）
 * @property {number} surfaceStart replace 区间起点（= 目标 seq）
 * @property {number} surfaceEnd replace 区间终点（= 最后一个 surface 节点）
 * @property {string} text 目标消息的完整文本
 */

/**
 * 校验失败（不 throw，返回结构化错误，便于宿主映射成 RemoteError code）。
 * @typedef {object} RewindPlanError
 * @property {{code: "bad-target" | "not-on-surface", message: string}} error
 */

/**
 * 一个已经存在的回溯区间：marker 节点遮蔽了从 targetSeq 起的内容。
 * @typedef {object} Cut
 * @property {number} targetSeq 目标消息 seq（区间起点）
 * @property {number} markerSeq marker 事件自身 seq（区间终点）
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 是否为合法的非负安全整数事件序号。
 * @param {unknown} value
 * @returns {boolean}
 */
function isEventSeq(value) {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

/**
 * 取出 `user/message` 事件里的消息负载；其他类型返回 undefined。
 * @param {any} event
 * @returns {MessageLike | undefined}
 */
function messageOf(event) {
  if (!isRecord(event) || event.type !== "user/message" || !isRecord(event.data)) return undefined;
  return /** @type {MessageLike} */ (event.data);
}

/**
 * 是否为 `user/message` 事件。
 * @param {any} event
 * @returns {boolean}
 */
export function isUserMessageEvent(event) {
  return isRecord(event) && event.type === "user/message";
}

/**
 * 是否为「真人」用户消息：`user/message` 且 `source.kind === "user"`。
 *
 * surface 上的 `user/message` 并不都来自用户：runtime context、compaction
 * checkpoint、工具结果回填等也以 `user/message` 出现，但 source.kind 不同。
 * 只有真人的消息（含运行中 steer 的消息，它的 kind 仍是 `user`）才能作为回溯边界。
 * @param {any} event
 * @returns {boolean}
 */
export function isHumanUserMessageEvent(event) {
  const message = messageOf(event);
  if (message === undefined) return false;
  const source = message.source;
  return isRecord(source) && source.kind === "user";
}

/**
 * 是否为本插件追加的回溯 marker（`user/message` + 约定的 source.kind）。
 * @param {any} event
 * @returns {boolean}
 */
export function isMarkerEvent(event) {
  const message = messageOf(event);
  if (message === undefined) return false;
  const source = message.source;
  return isRecord(source) && source.kind === MARKER_SOURCE_KIND;
}

/**
 * 拼接消息里的全部文本块（忽略图片/文件等非文本块），不做空白折叠。
 * @param {any} message
 * @returns {string}
 */
export function messageText(message) {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string")
      text += block.text;
  }
  return text;
}

/**
 * 生成单行预览：折叠空白并截断到 `max` 个字符（超出时以 `…` 结尾）。
 * @param {any} message
 * @param {number} [max] 最大字符数，默认 {@link PREVIEW_MAX_CHARS}
 * @returns {string}
 */
export function messagePreview(message, max = PREVIEW_MAX_CHARS) {
  const limit =
    typeof max === "number" && Number.isSafeInteger(max) && max > 0 ? max : PREVIEW_MAX_CHARS;
  const text = messageText(message).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

// 设计文档里用的是 textOf / previewOf 这两个名字；对外同时保留，避免调用方二选一。
/** @type {(message: any) => string} */
export const textOf = messageText;

/** @type {(message: any, max?: number) => string} */
export const previewOf = messagePreview;

/**
 * 列出可回溯的候选：surface 上的真人用户消息，最新在前。
 *
 * 被 compaction 遮蔽的消息不在 surface 上，因此不会出现——回溯边界不能落在
 * 模型上下文已经到不了的位置。
 * @param {any} events 会话事件日志（`session.snapshotEvents()`）
 * @param {any} surfaceNodes surface 节点顺序（`session.surface.nodes`）
 * @param {number} [limit] 最多返回多少条，默认 {@link DEFAULT_CANDIDATE_LIMIT}
 * @returns {Candidate[]}
 */
export function listCandidates(events, surfaceNodes, limit = DEFAULT_CANDIDATE_LIMIT) {
  const source = Array.isArray(events) ? events : [];
  const surface = new Set(Array.isArray(surfaceNodes) ? surfaceNodes : []);
  const max =
    typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0
      ? limit
      : DEFAULT_CANDIDATE_LIMIT;
  /** @type {Candidate[]} */
  const candidates = [];
  for (let i = source.length - 1; i >= 0 && candidates.length < max; i--) {
    const event = source[i];
    if (!isHumanUserMessageEvent(event)) continue;
    if (!surface.has(event.seq)) continue;
    candidates.push({
      seq: event.seq,
      index: candidates.length + 1,
      time: event.time,
      preview: messagePreview(event.data),
      text: messageText(event.data),
    });
  }
  return candidates;
}

/**
 * 校验目标并算出 replace 区间：目标消息及其后的全部 surface 节点被 marker 取代。
 * @param {any} events 会话事件日志（`session.snapshotEvents()`）
 * @param {any} surfaceNodes surface 节点顺序（`session.surface.nodes`）
 * @param {any} targetSeq 目标消息的日志序号
 * @returns {RewindPlan | RewindPlanError}
 */
export function planRewind(events, surfaceNodes, targetSeq) {
  if (!isEventSeq(targetSeq)) {
    return {
      error: {
        code: "bad-target",
        message: `target seq ${String(targetSeq)} is not a non-negative safe integer`,
      },
    };
  }
  const source = Array.isArray(events) ? events : [];
  const surface = Array.isArray(surfaceNodes) ? surfaceNodes : [];
  const targetEvent = source.find((event) => isRecord(event) && event.seq === targetSeq);
  if (targetEvent === undefined) {
    return { error: { code: "bad-target", message: `no session event at seq ${targetSeq}` } };
  }
  if (!isHumanUserMessageEvent(targetEvent)) {
    const type = isRecord(targetEvent) ? String(targetEvent.type) : "unknown";
    return {
      error: {
        code: "bad-target",
        message: `session event at seq ${targetSeq} is not a human user message (${type})`,
      },
    };
  }
  const targetIndex = surface.indexOf(targetSeq);
  if (targetIndex === -1) {
    return {
      error: {
        code: "not-on-surface",
        message: `user message at seq ${targetSeq} is no longer in the model context`,
      },
    };
  }
  const shadowedSeqs = surface.slice(targetIndex);
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1],
    text: messageText(targetEvent.data),
  };
}

/**
 * 从日志里还原已经存在的回溯区间（marker 事件）。
 *
 * marker 的 source 约定为 `{ kind: MARKER_SOURCE_KIND, targetSeq: number }`；
 * 形状不完整或区间不自洽的 marker 直接跳过（宁可少隐藏，也不隐藏错误区间）。
 * 返回顺序与日志一致（markerSeq 递增）。
 * @param {any} events 会话事件日志（`session.snapshotEvents()`）
 * @returns {Cut[]}
 */
export function cutsOf(events) {
  const log = Array.isArray(events) ? events : [];
  /** @type {Cut[]} */
  const cuts = [];
  for (const event of log) {
    if (!isMarkerEvent(event)) continue;
    const markerSource = isRecord(event.data) ? event.data.source : undefined;
    const targetSeq = isRecord(markerSource) ? markerSource.targetSeq : undefined;
    if (!isEventSeq(targetSeq) || targetSeq >= event.seq) continue;
    cuts.push({ targetSeq, markerSeq: event.seq });
  }
  return cuts;
}

/**
 * 分页/搜索候选：surface 上的真人用户消息，最新在前。
 * `cursor` 是上一页最后一条的 seq（下一页取比它更早的候选）。
 * `index` 是「全部候选（忽略 q）里从新到旧」的 1 基序号，便于 UI 显示。
 * @param {any} events 会话事件日志
 * @param {any} surfaceNodes surface 节点顺序
 * @param {{limit?: number, cursor?: number, q?: string}} [options]
 * @returns {{candidates: Candidate[], nextCursor: number | null}}
 */
export function listCandidatesPage(events, surfaceNodes, options = {}) {
  const source = Array.isArray(events) ? events : [];
  const surface = new Set(Array.isArray(surfaceNodes) ? surfaceNodes : []);
  const rawLimit =
    options && typeof options.limit === "number" ? options.limit : DEFAULT_CANDIDATE_LIMIT;
  const limit =
    Number.isSafeInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : DEFAULT_CANDIDATE_LIMIT;
  const cursor =
    options &&
    typeof options.cursor === "number" &&
    Number.isSafeInteger(options.cursor) &&
    options.cursor >= 0
      ? options.cursor
      : null;
  const needle = options && typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
  /** @type {Candidate[]} */
  const page = [];
  let ordinal = 0;
  let nextCursor = null;
  for (let i = source.length - 1; i >= 0; i--) {
    const event = source[i];
    if (!isHumanUserMessageEvent(event)) continue;
    if (!surface.has(event.seq)) continue;
    ordinal += 1;
    if (cursor !== null && event.seq >= cursor) continue;
    const text = messageText(event.data);
    if (needle !== "" && !text.toLowerCase().includes(needle)) continue;
    if (page.length >= limit) {
      nextCursor = page.length > 0 ? page[page.length - 1].seq : event.seq;
      break;
    }
    page.push({
      seq: event.seq,
      index: ordinal,
      time: event.time,
      preview: messagePreview(event.data),
      text,
    });
  }
  return { candidates: page, nextCursor };
}

/**
 * 目标之后（含目标）是否跨过未闭合的工具调用：存在 tool/call 没有对应 tool/result。
 * 用于预览里提示「回退会截断未完成的工具调用」。
 * @param {any} events 会话事件日志
 * @param {number} fromSeq 起点（含）
 * @returns {boolean}
 */
export function hasOpenToolCalls(events, fromSeq) {
  const source = Array.isArray(events) ? events : [];
  const calls = new Set();
  const results = new Set();
  for (const event of source) {
    if (!isRecord(event) || typeof event.seq !== "number" || event.seq < fromSeq) continue;
    if (
      event.type === "tool/call" &&
      isRecord(event.data) &&
      typeof event.data.callId === "string"
    ) {
      calls.add(event.data.callId);
    } else if (event.type === "tool/result" && isRecord(event.data)) {
      const message = isRecord(event.data.message) ? event.data.message : undefined;
      if (message && typeof message.toolCallId === "string") results.add(message.toolCallId);
      else if (typeof event.data.callId === "string") results.add(event.data.callId);
    }
  }
  for (const callId of calls) if (!results.has(callId)) return true;
  return false;
}

/**
 * 消息里的图片引用（用于回填输入框）。只保留结构完整的 image block。
 * @param {any} message 用户消息
 * @returns {{attachmentId: string, mediaType: string, bytes?: number, width?: number, height?: number, name?: string}[]}
 */
export function messageImages(message) {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  /** @type {any[]} */
  const images = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "image") continue;
    const attachment = isRecord(block.attachment) ? block.attachment : undefined;
    if (
      !attachment ||
      typeof attachment.attachmentId !== "string" ||
      typeof attachment.mediaType !== "string"
    )
      continue;
    images.push({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      ...(typeof attachment.bytes === "number" ? { bytes: attachment.bytes } : {}),
      ...(typeof attachment.width === "number" ? { width: attachment.width } : {}),
      ...(typeof attachment.height === "number" ? { height: attachment.height } : {}),
      ...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
    });
  }
  return images;
}

/**
 * 从事件里取一条真人用户消息的完整内容 + 图片引用（回填用）。
 * @param {any} event `user/message` 事件
 * @returns {{text: string, images: any[]}}
 */
export function targetContent(event) {
  const message = isRecord(event?.data) ? event.data : {};
  return { text: messageText(message), images: messageImages(message) };
}
