// @ts-check
// 旁问的实时文本缓冲：在 `llm/stream` waterfall 上旁听子会话的 text-delta，
// 供 `btw/live` 给面板做流式显示。
//
// 边界：
//   - 只观察，不改写、不短路：无论是否命中，都把原 chunks 原样 yield 出去；
//   - 只记录**已登记的旁问子会话**（按 childSessionId 精确匹配），不碰主会话；
//   - 文本只存在内存里，随 run 结束释放；不落盘（README 的副作用说明）。
import { LIMITS } from "./limits.js";

/**
 * @typedef {{
 *   threadId: string,
 *   question: string,
 *   parentSessionId: string,
 *   childId: string,
 *   text: string,
 *   startedAt: number,
 *   updatedAt: number,
 *   done: boolean,
 * }} LiveRun
 */

/**
 * 建一个按父会话分组的实时旁问表。
 * @param {any} ctx host 上下文（需要 `on`）
 * @param {{ now?: () => number }} [options]
 */
export function createLiveTracker(ctx, options = {}) {
  const now = options.now ?? Date.now;
  /** @type {Map<string, Map<string, LiveRun>>} */
  const byParent = new Map();
  /** @type {Map<string, LiveRun>} */
  const byChild = new Map();

  const listen = typeof ctx?.on === "function" ? ctx.on.bind(ctx) : undefined;
  if (listen !== undefined) {
    listen("llm/stream", (/** @type {any} */ request, /** @type {any} */ next) => {
      const sessionId = String(request?.sessionId ?? "");
      const run = sessionId === "" ? undefined : byChild.get(sessionId);
      if (run === undefined) return next();
      const inner = next();
      return (async function* () {
        for await (const chunk of inner) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
            if (!run.done && run.text.length < LIMITS.liveTextChars) {
              run.text = (run.text + chunk.text).slice(0, LIMITS.liveTextChars);
              run.updatedAt = now();
            }
          }
          yield chunk;
        }
      })();
    });
  }

  return {
    /**
     * 登记一次旁问（在调用 fork 之前）。返回的 run 要原样交给 attachChild / finish。
     * @param {string} parentSessionId
     * @param {{ threadId: string, question: string }} input
     * @returns {LiveRun}
     */
    begin(parentSessionId, input) {
      const startedAt = now();
      /** @type {LiveRun} */
      const run = {
        threadId: String(input?.threadId ?? ""),
        question: String(input?.question ?? ""),
        parentSessionId: String(parentSessionId ?? ""),
        childId: "",
        text: "",
        startedAt,
        updatedAt: startedAt,
        done: false,
      };
      let bucket = byParent.get(run.parentSessionId);
      if (bucket === undefined) {
        bucket = new Map();
        byParent.set(run.parentSessionId, bucket);
      }
      bucket.set(run.threadId, run);
      return run;
    },

    /**
     * fork 拿到 childId 后登记，之后该子会话的 text-delta 才会进入 run.text。
     * @param {LiveRun | undefined} run
     * @param {unknown} childId
     * @returns {void}
     */
    attachChild(run, childId) {
      if (run === undefined || run === null || run.done) return;
      const id = String(childId ?? "");
      if (id === "") return;
      run.childId = id;
      byChild.set(id, run);
    },

    /**
     * 一次旁问结束时释放（无论成功失败都要调）。
     * @param {LiveRun | undefined} run
     * @returns {void}
     */
    finish(run) {
      if (run === undefined || run === null || run.done) return;
      run.done = true;
      if (run.childId !== "") byChild.delete(run.childId);
      const bucket = byParent.get(run.parentSessionId);
      if (bucket !== undefined && bucket.get(run.threadId) === run) {
        bucket.delete(run.threadId);
        if (bucket.size === 0) byParent.delete(run.parentSessionId);
      }
    },

    /**
     * 某父会话当前在跑的旁问快照（按开始时间正序）。
     * @param {string} parentSessionId
     * @returns {(LiveRun & { ms: number })[]}
     */
    list(parentSessionId) {
      const bucket = byParent.get(String(parentSessionId ?? ""));
      if (bucket === undefined) return [];
      const at = now();
      return [...bucket.values()]
        .filter((run) => !run.done)
        .sort((left, right) => left.startedAt - right.startedAt)
        .map((run) => ({ ...run, ms: Math.max(0, at - run.startedAt) }));
    },

    /** 诊断用：当前跟踪中的子会话数。 */
    size() {
      return byChild.size;
    },
  };
}
