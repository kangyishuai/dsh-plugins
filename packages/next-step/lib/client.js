// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能使用 import / JSX。
// 功能：
// A. 决策卡（conversation.chat.turnTail）：从投影 nextStep 读 {cards, decisions}，只对最后一轮
//    渲染可交互卡（更早的卡只读）；点击胶囊 → nextStep/act → setDraft + 等草稿落定 + submit。
// B. 幽灵提示（conversation.input.overlay，默认关）：settings.ghost 打开后，在输入框空、无附件、
//    无 @ 引用、无斜杠命令、会话空闲时显示最新卡的 nextPrompt；Tab / → 接受，Esc 清除。
// C. i18n：locale 命名空间 nextStep（同一份字典也落在 locale/*.json）。
// 宿主调用走 ctx.connection.rpc.call("/api", ...)——无构建插件没有 typert 客户端产物，
// 不能用 ctx.reflect.get("remote.xxx")（见 docs/runtime/0.2.2-rc.1.md §7）。
// 客户端状态一律来自投影（禁止用内存 Set 记「已点击」）；只有「本轮正在提交」与
// 「幽灵提示抑制（输入后 2s 内不闪回 / Esc 清除）」这两类瞬时 UI 态留在内存。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-next-step",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;

    /** @type {any} */
    let React = require("react");
    let h = React.createElement;

    /** locale 命名空间；必须与 locale/*.json 顶层键、slot descriptor 的 locale 一致。 */
    let NS = "nextStep";
    /** 样式归属：桌面端只读回归靠 style[data-plugin] 判断 client 半已加载。 */
    let PLUGIN_ID = "@kangyishuai/dsh-next-step";
    let CSS_TAG_ID = `${PLUGIN_ID}/client.css`;

    /** setDraft 走 Lexical 异步更新：轮询草稿落定，15 × 20ms 兜底。 */
    let DRAFT_POLL_TRIES = 15;
    let DRAFT_POLL_INTERVAL_MS = 20;
    /** 输入第一个字符后，幽灵提示在这段时间内不闪回。 */
    let GHOST_SUPPRESS_MS = 2000;

    /**
     * 简体中文字典（键集的事实来源）。
     * @type {Record<string, string>}
     */
    let zh = {
      "card.aria": "下一步建议",
      "summary.expand": "展开",
      "summary.collapse": "收起",
      "pill.aria": "发送：{label}",
      "pill.draftBusy": "输入框已有内容，先清空再发送",
      sent: "已发出",
      dismiss: "关闭",
      "ghost.aria": "按 Tab 或 → 接受这条建议",
      "error.stale": "这条建议已过期，请用最新的一条",
      "error.missing": "找不到这条建议",
      "error.disabled": "插件已停用",
      "error.failed": "操作失败，请重试",
      "error.send": "没能把建议写进输入框",
    };

    /**
     * English dictionary (same key set as `zh`).
     * @type {Record<string, string>}
     */
    let en = {
      "card.aria": "Next-step suggestion",
      "summary.expand": "Show more",
      "summary.collapse": "Show less",
      "pill.aria": "Send: {label}",
      "pill.draftBusy": "Clear the composer first",
      sent: "Sent",
      dismiss: "Dismiss",
      "ghost.aria": "Press Tab or → to accept this suggestion",
      "error.stale": "This suggestion is out of date; use the newest one",
      "error.missing": "That suggestion is no longer available",
      "error.disabled": "The plugin is disabled",
      "error.failed": "Something went wrong. Try again.",
      "error.send": "Could not fill the composer",
    };

    /**
     * RPC 失败原因到文案 key 的映射（契约 §3 的 reason 枚举）。
     * @type {Record<string, string>}
     */
    let ERROR_KEYS = {
      stale: "error.stale",
      missing: "error.missing",
      disabled: "error.disabled",
    };

    // 颜色/尺寸严格照契约 §5 的表：优先用宿主 token，token 缺失时用截图实测值兜底。
    // 只注入这一份样式（data-plugin-css 判重，HMR/重复挂载不会再插一份）。
    let CSS = `
.ns_card{box-sizing:border-box;position:relative;margin:16px 0;padding:14px 16px 16px;border:1px solid var(--dsw-alias-border-l2,#242424);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#191919);color:var(--dsw-alias-label-primary,#e8e8e8);font-size:13px;line-height:20px;box-shadow:none;}
.ns_body{min-width:0;padding-right:22px;}
.ns_summary{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a4a4a4);white-space:pre-wrap;overflow-wrap:anywhere;}
.ns_card[data-ns-expanded="true"] .ns_summary{display:block;-webkit-line-clamp:unset;line-clamp:unset;overflow:visible;}
.ns_more{align-self:flex-start;margin:4px 0 0;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#a4a4a4);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;}
.ns_more:hover{color:var(--dsw-alias-label-secondary,#a4a4a4);}
.ns_more:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;border-radius:4px;}
.ns_question{margin:16px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e8e8e8);white-space:pre-wrap;overflow-wrap:anywhere;}
.ns_pills{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px;}
.ns_pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:28px;padding:0 12px;border:1px solid transparent;border-radius:14px;font-family:inherit;font-size:13px;line-height:20px;font-weight:400;cursor:pointer;transition:opacity 120ms ease,border-color 120ms ease,color 120ms ease;}
.ns_pillPrimary{background:var(--dsw-alias-label-primary,#efefef);color:var(--dsw-alias-bg-base,#191919);font-weight:500;}
.ns_pillPrimary:hover:not(:disabled){opacity:.9;}
.ns_pillSecondary{background:transparent;border-color:var(--dsw-alias-border-l4,#424242);color:var(--dsw-alias-label-secondary,#d2d2d2);}
.ns_pillSecondary:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary,#a4a4a4);color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;}
.ns_pill:disabled{cursor:not-allowed;opacity:.5;}
.ns_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ns_key{flex:none;padding:0 4px;border-radius:4px;background:var(--dsw-alias-label-secondary,#c5c5c5);color:var(--dsw-alias-bg-base,#191919);font-size:11px;font-weight:400;line-height:16px;}
.ns_spinner{flex:none;width:12px;height:12px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:ns_spin .8s linear infinite;}
.ns_close{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#a4a4a4);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;}
.ns_close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#e8e8e8);}
.ns_close:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px;}
.ns_close:disabled{cursor:not-allowed;opacity:.5;}
.ns_sent{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,#81858c);}
.ns_error{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#f25a5a);}
.ns_ghost{position:absolute;z-index:1;top:12px;left:14px;right:12px;color:var(--dsw-alias-label-caption,#81858c);font-size:inherit;line-height:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;user-select:none;}
@keyframes ns_spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.ns_spinner{animation-duration:2.4s;}}
`;

    // ------------------------------------------------------------------
    // 小工具（全部是纯函数，不碰 DOM / 全局状态）
    // ------------------------------------------------------------------

    /**
     * slot 的 `t` 缺失时的兜底（返回 key 本身）。
     * @param {string} key
     * @param {Record<string, unknown>} [_params]
     * @returns {string}
     */
    function fallbackTranslate(key, _params) {
      return key;
    }

    /** @type {any} 标准 hook 缺失时的占位，保证 hook 调用顺序稳定。 */
    let emptySelectorHook = function emptySelectorHook() {
      return undefined;
    };
    /** @type {any} */
    let emptyKeyedHook = function emptyKeyedHook() {
      return undefined;
    };

    /**
     * Turn 对象里的轮次数字（渲染 slot 时宿主传的是 Turn 记录，不是数字）。
     * @param {any} turn
     * @returns {number}
     */
    function turnNumberOf(turn) {
      if (!turn || typeof turn !== "object") return -1;
      return typeof turn.turn === "number" && Number.isFinite(turn.turn) ? turn.turn : -1;
    }

    /**
     * 槽位是否已经可以渲染：流式中（没有 turn/end）或 closing === null（Stop / 报错 / 无文本）都不渲染。
     * @param {any} turn
     * @returns {boolean}
     */
    function isTurnTailReady(turn) {
      if (!turn || typeof turn !== "object") return false;
      if (turn.end === undefined || turn.end === null) return false;
      let data = turn.data;
      if (!data || typeof data.get !== "function") return false;
      let tail = data.get("turn-tail");
      if (tail === undefined || tail === null) return false;
      return tail.closing !== null && tail.closing !== undefined;
    }

    /**
     * 从投影视图里取一张卡。
     * @param {any} view
     * @param {number} turn
     * @returns {any}
     */
    function cardOf(view, turn) {
      if (!view || typeof view !== "object") return undefined;
      let cards = view.cards;
      if (!cards || typeof cards !== "object" || turn < 0) return undefined;
      return cards[String(turn)];
    }

    /**
     * 从投影视图里取一条决策。
     * @param {any} view
     * @param {number} turn
     * @returns {any}
     */
    function decisionOf(view, turn) {
      if (!view || typeof view !== "object") return undefined;
      let decisions = view.decisions;
      if (!decisions || typeof decisions !== "object" || turn < 0) return undefined;
      return decisions[String(turn)];
    }

    /**
     * 最新一张卡所在的轮次（-1 = 没有卡）。
     * @param {any} view
     * @returns {number}
     */
    function latestCardTurnOf(view) {
      if (!view || typeof view !== "object") return -1;
      let cards = view.cards;
      if (!cards || typeof cards !== "object") return -1;
      let latest = -1;
      for (let key of Object.keys(cards)) {
        let value = Number(key);
        if (Number.isFinite(value) && value > latest && cards[key]) latest = value;
      }
      return latest;
    }

    /**
     * 卡片/幽灵的视觉状态：投影优先，其次本轮乐观态。
     * @param {any} decision
     * @param {string} optimistic "" | "sent" | "dismissed"
     * @param {number} pendingIndex >= 0 表示 RPC 在途
     * @param {boolean} isLastTurn
     * @returns {"interactive" | "sending" | "sent" | "dismissed" | "readonly"}
     */
    function phaseOf(decision, optimistic, pendingIndex, isLastTurn) {
      if (decision && typeof decision === "object") {
        if (decision.phase === "sent" || decision.phase === "dismissed") return decision.phase;
        // superseded 或未知 phase：历史卡只读
        return "readonly";
      }
      if (optimistic === "sent" || optimistic === "dismissed") return optimistic;
      if (!isLastTurn) return "readonly";
      return pendingIndex >= 0 ? "sending" : "interactive";
    }

    /**
     * RPC 返回里的可发送文本（`{ ok: true, text }`）。
     * @param {any} result
     * @returns {string}
     */
    function answerTextOf(result) {
      return result && typeof result === "object" && typeof result.text === "string"
        ? result.text
        : "";
    }

    /**
     * RPC 失败原因 → 文案 key。
     * @param {any} result
     * @returns {string}
     */
    function errorKeyOf(result) {
      if (result && typeof result === "object" && typeof result.reason === "string") {
        let mapped = ERROR_KEYS[result.reason];
        if (typeof mapped === "string") return mapped;
      }
      return "error.failed";
    }

    /**
     * 幽灵提示的身份串：同一张卡的同一段 nextPrompt 只清除一次。
     * @param {number} turn
     * @param {string} text
     * @returns {string}
     */
    function ghostKeyOf(turn, text) {
      return `${String(turn)}\u0000${text}`;
    }

    /**
     * 纯修饰键（Shift / Meta / Control / Alt / CapsLock）不算「输入第一个字符」。
     * @param {string} code
     * @returns {boolean}
     */
    function isModifierCode(code) {
      return (
        code === "ShiftLeft" ||
        code === "ShiftRight" ||
        code === "MetaLeft" ||
        code === "MetaRight" ||
        code === "ControlLeft" ||
        code === "ControlRight" ||
        code === "AltLeft" ||
        code === "AltRight" ||
        code === "CapsLock" ||
        code === "Fn" ||
        code === "FnLock"
      );
    }

    /**
     * 键帽文案只是视觉提示（v1 不绑定快捷键）：mac 用 ⌘↵，其它平台 Ctrl+↵。
     * @returns {string}
     */
    function detectKeycap() {
      let apple = false;
      try {
        if (typeof document !== "undefined" && document.documentElement) {
          apple = document.documentElement.dataset.platform === "darwin";
        }
      } catch (_error) {
        apple = false;
      }
      if (!apple) {
        try {
          let platform = typeof navigator === "undefined" ? "" : navigator.platform || "";
          let agent = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
          apple = /Mac|iPod|iPhone|iPad/u.test(platform) || /Macintosh/u.test(agent);
        } catch (_error) {
          apple = false;
        }
      }
      return apple ? "⌘↵" : "Ctrl+↵";
    }

    /**
     * 等 setDraft 落定：readDraft 返回当前草稿，与 text 一致即视为落定。
     * @param {() => (string | undefined)} readDraft
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    function waitDraftSettled(readDraft, text) {
      return new Promise((resolve) => {
        let tries = 0;
        let tick = () => {
          let draft;
          try {
            draft = readDraft();
          } catch (_error) {
            draft = undefined;
          }
          if (draft === text) {
            resolve(true);
            return;
          }
          tries += 1;
          if (tries >= DRAFT_POLL_TRIES) {
            resolve(false);
            return;
          }
          setTimeout(tick, DRAFT_POLL_INTERVAL_MS);
        };
        tick();
      });
    }

    /**
     * 读输入框 façade 的草稿快照（拿不到返回 undefined）。
     * @param {any} shell
     * @returns {string | undefined}
     */
    function shellDraftOf(shell) {
      try {
        let state = shell?.state;
        let snapshot =
          state && typeof state.getSnapshot === "function" ? state.getSnapshot() : undefined;
        if (snapshot && typeof snapshot.draft === "string") return snapshot.draft;
      } catch (_error) {
        return undefined;
      }
      return undefined;
    }

    // ------------------------------------------------------------------
    // 幽灵提示的键盘桥：组件登记当前建议，apply 里的 fixed-input 观察者消费
    // ------------------------------------------------------------------

    /** @type {Map<string, {insert: () => boolean, typed: () => void, clear: () => void}>} */
    let ghostEntries = new Map();

    /**
     * 宿主 fixed-input 观察通道（docs/runtime/0.2.2-rc.1.md §9.5）：Tab / → 接受，Esc 清除，
     * 其它按键 → 2s 内不闪回。裸 Tab / 方向键在输入框里是编辑动作，注册快捷键会冲突；
     * 这条通道连输入法组合与「是否已被消费」都替我们算好了。
     * @param {any} input
     * @returns {void}
     */
    function onFixedInput(input) {
      if (input?.type !== "keydown") return;
      let gesture = input.gesture || {};
      let context = input.context || {};
      if (context.modal !== null && context.modal !== undefined) return;
      if (context.region !== "editable") return;
      let target = context.target;
      let occurrence =
        target && typeof target.closest === "function"
          ? target.closest("[data-conversation-session]")
          : null;
      if (!occurrence || typeof occurrence.getAttribute !== "function") return;
      let sessionId = occurrence.getAttribute("data-conversation-session");
      if (!sessionId) return;
      let entry = ghostEntries.get(sessionId);
      if (!entry) return;

      let code = typeof gesture.code === "string" ? gesture.code : "";

      // Esc：只清除本次建议，不 consume（把宿主 / 其它插件的 Esc Esc 让出去）。
      if (code === "Escape" && !gesture.control && !gesture.alt && !gesture.meta) {
        if (!gesture.repeat) entry.clear();
        return;
      }

      // Tab / → 接受：只在本会话的幽灵提示可见时接管。
      if (code === "Tab" || code === "ArrowRight") {
        if (gesture.shift || gesture.control || gesture.alt || gesture.meta) return;
        if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return;
        if (entry.insert() && typeof input.consume === "function") {
          try {
            input.consume();
          } catch (_error) {
            /* consume 失败不影响插入结果 */
          }
        }
        return;
      }

      if (isModifierCode(code)) return;
      if (gesture.defaultPrevented) return;
      // 输入第一个字符：立即消失，且 2s 内不再闪回。
      entry.typed();
    }

    // ------------------------------------------------------------------
    // A. 决策卡
    // ------------------------------------------------------------------

    /**
     * 决策卡组件：只对最后一轮渲染可交互态，更早的卡渲染只读态。
     * @param {any} props slot 注入的 props（turn / seq / openFile / sessionId / t / 标准 hooks / api）
     * @returns {any}
     */
    function NextStepTail(props) {
      let api = props.api;
      let t = typeof props.t === "function" ? props.t : fallbackTranslate;
      let useProjection =
        typeof props.useProjection === "function" ? props.useProjection : emptyKeyedHook;
      let useChat = typeof props.useChat === "function" ? props.useChat : emptySelectorHook;
      let useInput = typeof props.useInput === "function" ? props.useInput : emptySelectorHook;
      let inputActions = props.inputActions;

      let turn = props.turn;
      let turnNumber = turnNumberOf(turn);
      let sessionId = typeof props.sessionId === "string" ? props.sessionId : "";

      let view = useProjection("nextStep");
      let isLastTurn = useChat((/** @type {any} */ snapshot) => {
        let order = snapshot?.timeline?.turnOrder;
        return Array.isArray(order) && order.length > 0
          ? order[order.length - 1] === turnNumber
          : false;
      });
      let inputDraft = useInput((/** @type {any} */ input) =>
        input && typeof input.draft === "string" ? input.draft : "",
      );
      let draft = typeof inputDraft === "string" ? inputDraft : "";

      // 发送流程要拿「最新」草稿（façade 缺失时的兜底信号），不能读渲染期的旧值。
      let draftRef = React.useRef(draft);
      draftRef.current = draft;

      let pendingState = React.useState(-1);
      let pendingIndex = pendingState[0];
      let setPendingIndex = pendingState[1];
      let optimisticState = React.useState("");
      let optimistic = optimisticState[0];
      let setOptimistic = optimisticState[1];
      let errorState = React.useState("");
      let errorKey = errorState[0];
      let setErrorKey = errorState[1];
      let expandedState = React.useState(false);
      let expanded = expandedState[0];
      let setExpanded = expandedState[1];
      let moreState = React.useState(false);
      let showMore = moreState[0];
      let setShowMore = moreState[1];
      let summaryRef = React.useRef(/** @type {any} */ (null));

      let card = cardOf(view, turnNumber);
      let decision = decisionOf(view, turnNumber);

      // 投影一旦追上，乐观态就退场（投影是唯一事实来源）。
      React.useEffect(() => {
        if (decision && optimistic !== "") setOptimistic("");
      }, [decision, optimistic]);

      // 摘要超过 2 行才出「展开 / 收起」；折叠状态才测量，展开状态保留按钮。
      React.useLayoutEffect(() => {
        let element = summaryRef.current;
        if (!element || expanded) return;
        let overflowing = element.scrollHeight > element.clientHeight + 1;
        setShowMore(overflowing);
      });

      if (turnNumber < 0 || !isTurnTailReady(turn)) return null;
      if (card === undefined || card === null) return null;

      let options = Array.isArray(card.options) ? card.options : [];
      let summary = typeof card.summary === "string" ? card.summary : "";
      let question = typeof card.question === "string" ? card.question : "";
      let status = phaseOf(decision, optimistic, pendingIndex, isLastTurn);
      let busy = status === "sending";
      let showPills = (status === "interactive" || status === "sending") && options.length > 0;
      let draftBusy = draft !== "";
      let canCall = Boolean(api) && typeof api.act === "function";
      let keycap = api && typeof api.keycap === "string" ? api.keycap : "⌘↵";

      /**
       * 点击胶囊：RPC → 立刻切只读态 → 写草稿、等落定、提交。
       * @param {number} index
       */
      let sendPill = (index) => {
        if (busy || pendingIndex >= 0 || optimistic !== "") return;
        if (draftBusy) return;
        if (!canCall || !api || typeof api.sendText !== "function") {
          setErrorKey("error.failed");
          return;
        }
        setErrorKey("");
        setPendingIndex(index);
        Promise.resolve(api.act(sessionId, turnNumber, index))
          .then((result) => {
            let text = answerTextOf(result);
            setPendingIndex(-1);
            if (text === "") {
              setErrorKey(errorKeyOf(result));
              return undefined;
            }
            // RPC 一返回就切只读态，不等发送完成（发送慢时不至于卡在 sending）。
            setOptimistic("sent");
            return Promise.resolve(
              api.sendText(sessionId, text, inputActions, () => draftRef.current),
            ).then((outcome) => {
              if (outcome !== "ok") setErrorKey("error.send");
            });
          })
          .catch(() => {
            setPendingIndex(-1);
            setErrorKey("error.failed");
          });
      };

      /** ✕：dismiss RPC → 只读态。 */
      let dismissCard = () => {
        if (busy || !api || typeof api.dismiss !== "function") return;
        setErrorKey("");
        Promise.resolve(api.dismiss(sessionId, turnNumber))
          .then((result) => {
            if (result?.ok !== true) {
              setErrorKey(errorKeyOf(result));
              return;
            }
            setOptimistic("dismissed");
          })
          .catch(() => {
            setErrorKey("error.failed");
          });
      };

      /**
       * 一粒胶囊：第 0 条是 primary（带纯视觉键帽），第 1 条是 secondary。
       * @param {any} option
       * @param {number} index
       * @returns {any}
       */
      let renderPill = (option, index) => {
        let isPrimary = index === 0;
        let label = option && typeof option.label === "string" ? option.label : "";
        let stance = option && typeof option.stance === "string" ? option.stance : "";
        let disabled = busy || draftBusy;
        let title = draftBusy ? t("pill.draftBusy") : undefined;
        let children = [];
        if (busy && pendingIndex === index) {
          children.push(
            h("span", { key: "spinner", className: "ns_spinner", "aria-hidden": "true" }),
          );
        }
        children.push(h("span", { key: "label", className: "ns_label" }, label));
        if (isPrimary) {
          children.push(
            h("span", { key: "key", className: "ns_key", "aria-hidden": "true" }, keycap),
          );
        }
        return h(
          "button",
          {
            key: `pill-${String(index)}`,
            type: "button",
            className: `ns_pill ${isPrimary ? "ns_pillPrimary" : "ns_pillSecondary"}`,
            "data-next-step-pill": "",
            "data-stance": stance,
            "data-index": String(index),
            "data-text": typeof option?.text === "string" ? option.text : "",
            disabled: disabled,
            title: title,
            "aria-label": t("pill.aria", { label: label }),
            onClick: () => {
              sendPill(index);
            },
          },
          children,
        );
      };

      let body = [];
      if (summary !== "") {
        body.push(
          h(
            "p",
            {
              key: "summary",
              ref: summaryRef,
              className: "ns_summary",
              "data-next-step-summary": "",
            },
            summary,
          ),
        );
        if (showMore) {
          body.push(
            h(
              "button",
              {
                key: "more",
                type: "button",
                className: "ns_more",
                "data-next-step-more": "",
                "aria-expanded": expanded ? "true" : "false",
                onClick: () => {
                  setExpanded(!expanded);
                },
              },
              t(expanded ? "summary.collapse" : "summary.expand"),
            ),
          );
        }
      }
      // 提问段任何状态都保留（只读 / 已发出 / 已关闭）。
      if (question !== "") {
        body.push(
          h(
            "p",
            { key: "question", className: "ns_question", "data-next-step-question": "" },
            question,
          ),
        );
      }
      if (showPills) {
        body.push(
          h(
            "div",
            { key: "pills", className: "ns_pills", "data-next-step-pills": "" },
            options.map(renderPill),
          ),
        );
      }
      if (status === "sent") {
        body.push(h("p", { key: "sent", className: "ns_sent", role: "status" }, t("sent")));
      }
      if (errorKey !== "") {
        body.push(h("p", { key: "error", className: "ns_error", role: "alert" }, t(errorKey)));
      }

      let children = [h("div", { key: "body", className: "ns_body" }, body)];
      if (showPills) {
        children.push(
          h(
            "button",
            {
              key: "dismiss",
              type: "button",
              className: "ns_close",
              "data-next-step-dismiss": "",
              "aria-label": t("dismiss"),
              disabled: busy,
              onClick: () => {
                dismissCard();
              },
            },
            "✕",
          ),
        );
      }

      return h(
        "section",
        {
          className: "ns_card",
          "data-next-step-card": "",
          "data-next-step-turn": String(turnNumber),
          "data-next-step-state": status,
          "data-ns-expanded": expanded ? "true" : "false",
          "aria-label": t("card.aria"),
        },
        children,
      );
    }

    // ------------------------------------------------------------------
    // B. 幽灵提示
    // ------------------------------------------------------------------

    /**
     * 幽灵提示组件：默认关闭（settings.ghost），只在输入框干净且会话空闲时显示最新卡的 nextPrompt。
     * @param {any} props slot 注入的 props
     * @returns {any}
     */
    function NextStepGhost(props) {
      let api = props.api;
      let t = typeof props.t === "function" ? props.t : fallbackTranslate;
      let useProjection =
        typeof props.useProjection === "function" ? props.useProjection : emptyKeyedHook;
      let useInput = typeof props.useInput === "function" ? props.useInput : emptySelectorHook;
      let useSession =
        typeof props.useSession === "function" ? props.useSession : emptySelectorHook;
      let inputActions = props.inputActions;
      let sessionId = typeof props.sessionId === "string" ? props.sessionId : "";

      let view = useProjection("nextStep");
      let draft = useInput((/** @type {any} */ input) =>
        input && typeof input.draft === "string" ? input.draft : "",
      );
      let phase = useInput((/** @type {any} */ input) =>
        input && typeof input.phase === "string" ? input.phase : "",
      );
      let attachmentCount = useInput((/** @type {any} */ input) =>
        input && Array.isArray(input.attachmentIds) ? input.attachmentIds.length : 0,
      );
      let occurrenceCount = useInput((/** @type {any} */ input) =>
        Array.isArray(input?.occurrences) ? input.occurrences.length : 0,
      );
      let hasClaim = useInput((/** @type {any} */ input) => Boolean(input?.claim));
      let idle = useSession(
        (/** @type {any} */ session) =>
          Boolean(session) && session.running !== true && !session.removed && !session.subagent,
      );

      let suppressState = React.useState(0);
      let suppressUntil = suppressState[0];
      let setSuppressUntil = suppressState[1];
      let clearedState = React.useState("");
      let clearedKey = clearedState[0];
      let setClearedKey = clearedState[1];
      let settingsState = React.useState(/** @type {any} */ (null));
      let settings = settingsState[0];
      let setSettings = settingsState[1];
      let ghostRef = React.useRef(/** @type {any} */ (null));

      let latestTurn = latestCardTurnOf(view);
      let card = cardOf(view, latestTurn);
      let decided = decisionOf(view, latestTurn) !== undefined;
      // 原样显示（不截断）：桌面端只读回归会拿 textContent 和投影里的 nextPrompt 对比。
      let rawPrompt = card && typeof card.nextPrompt === "string" ? card.nextPrompt : "";
      let prompt = rawPrompt.trim() === "" ? "" : rawPrompt;
      let promptKey = ghostKeyOf(latestTurn, prompt);
      let suppressed = suppressUntil > Date.now();
      let enabled = Boolean(settings) && settings.ghost === true;
      let visible =
        sessionId !== "" &&
        enabled &&
        prompt !== "" &&
        !decided &&
        clearedKey !== promptKey &&
        !suppressed &&
        draft === "" &&
        phase === "plain" &&
        !hasClaim &&
        attachmentCount === 0 &&
        occurrenceCount === 0 &&
        idle === true;

      // 设置只从宿主 RPC 读（投影里没有 settings）；失败就静默当关闭。
      React.useEffect(() => {
        if (!api || typeof api.settings !== "function") return undefined;
        let alive = true;
        Promise.resolve(api.settings())
          .then((value) => {
            if (alive) setSettings(value || null);
          })
          .catch(() => undefined);
        return () => {
          alive = false;
        };
      }, [api]);

      // 登记到键盘桥：只有可见时登记，Tab / → 才会被接管。
      React.useEffect(() => {
        if (!visible) return undefined;
        let actions = inputActions;
        let entry = {
          insert: () => {
            if (!actions) return false;
            if (typeof actions.captureInsertion !== "function") return false;
            if (typeof actions.insertText !== "function") return false;
            try {
              let span = actions.captureInsertion();
              return actions.insertText(prompt, span) === true;
            } catch (_error) {
              return false;
            }
          },
          typed: () => {
            setSuppressUntil(Date.now() + GHOST_SUPPRESS_MS);
          },
          clear: () => {
            setClearedKey(promptKey);
          },
        };
        ghostEntries.set(sessionId, entry);
        return () => {
          if (ghostEntries.get(sessionId) === entry) ghostEntries.delete(sessionId);
        };
      }, [visible, prompt, promptKey, sessionId, inputActions]);

      // 抑制到期自动解除（2s 内不闪回）。
      React.useEffect(() => {
        if (suppressUntil === 0) return undefined;
        let remaining = suppressUntil - Date.now();
        if (remaining <= 0) {
          setSuppressUntil(0);
          return undefined;
        }
        let timer = setTimeout(() => setSuppressUntil(0), remaining + 30);
        return () => clearTimeout(timer);
      }, [suppressUntil]);

      // 对齐宿主 placeholder：同基线、同字号（查不到就用 CSS 的兜底值）。
      React.useLayoutEffect(() => {
        let element = ghostRef.current;
        if (!element || typeof element.closest !== "function") return;
        let cardElement = element.closest("[data-composer-card]");
        if (!cardElement || typeof cardElement.querySelector !== "function") return;
        let placeholder = cardElement.querySelector("[data-composer-placeholder]");
        if (!placeholder) return;
        let cardBox = cardElement.getBoundingClientRect();
        let placeholderBox = placeholder.getBoundingClientRect();
        if (!placeholderBox || placeholderBox.width <= 0) return;
        element.style.top = `${placeholderBox.top - cardBox.top}px`;
        element.style.left = `${placeholderBox.left - cardBox.left}px`;
        element.style.maxWidth = `${placeholderBox.width}px`;
        try {
          let computed =
            typeof window === "undefined" ? null : window.getComputedStyle(placeholder);
          if (computed) {
            element.style.fontSize = computed.fontSize;
            element.style.lineHeight = computed.lineHeight;
          }
        } catch (_error) {
          /* 取不到计算样式就沿用 CSS 兜底 */
        }
      });

      if (!visible) return null;

      return h(
        "span",
        {
          ref: ghostRef,
          className: "ns_ghost",
          "data-next-step-ghost": "",
          "data-next-step-ghost-text": prompt,
          "aria-label": t("ghost.aria"),
          title: t("ghost.aria"),
        },
        prompt,
      );
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------

    exports.inject = ["slots", "locale", "connection"];

    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "next-step: dictionaries");

      // 只注入一份样式；判重让 HMR / 重复挂载不会插第二份。
      ctx.effect(() => {
        if (typeof document === "undefined" || !document.head) return undefined;
        let selector = `style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`;
        if (document.querySelector(selector) !== null) return undefined;
        let tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "next-step: styles");

      /**
       * 取宿主服务（服务可能缺席，绝不能抛）。
       * @param {string} name
       * @returns {any}
       */
      let serviceOf = (name) => {
        try {
          if (ctx && typeof ctx.get === "function") {
            let found = ctx.get(name);
            if (found !== undefined && found !== null) return found;
          }
        } catch (_error) {
          /* 服务未挂载 */
        }
        try {
          return ctx ? ctx[name] : undefined;
        } catch (_error) {
          return undefined;
        }
      };

      /**
       * Typert Remote 调用：统一解开 { ok, value } 信封，失败返回 undefined。
       * @param {string} method
       * @param {any} [request]
       * @returns {Promise<any>}
       */
      let callRemote = (method, request) => {
        let connection = serviceOf("connection");
        let channel = connection?.rpc;
        if (!channel || typeof channel.call !== "function") return Promise.resolve(undefined);
        let payload = request === undefined ? { args: {} } : { args: { request } };
        try {
          return Promise.resolve(channel.call("/api", `nextStep/${method}`, payload)).then(
            (result) => {
              if (result && typeof result === "object" && Object.hasOwn(result, "value")) {
                return result.value;
              }
              return result;
            },
            () => undefined,
          );
        } catch (_error) {
          return Promise.resolve(undefined);
        }
      };

      /**
       * 解析某个会话的输入框 façade（契约 §4）。
       * @param {string} sessionId
       * @returns {any}
       */
      let shellOf = (sessionId) => {
        if (!sessionId) return undefined;
        try {
          let conversation = serviceOf("conversation");
          let input = conversation?.input;
          if (!input) return undefined;
          if (typeof input.shell === "function") {
            try {
              let shell = input.shell(sessionId);
              if (shell) return shell;
            } catch (_error) {
              /* 退到 for(scope) */
            }
          }
          if (typeof input.for === "function") {
            let sessions = serviceOf("sessions");
            let scope =
              sessions && typeof sessions.scope === "function"
                ? sessions.scope(sessionId)
                : undefined;
            if (scope !== undefined) return input.for(scope);
          }
        } catch (_error) {
          return undefined;
        }
        return undefined;
      };

      /**
       * 写草稿 → 等落定 → 提交。绝不覆盖用户已有草稿（胶囊在草稿非空时是禁用的，这里再兜一道）。
       * @param {string} sessionId
       * @param {string} text
       * @param {any} fallbackActions slot 注入的 inputActions
       * @param {() => string} readFallbackDraft 渲染期草稿的兜底读法
       * @returns {Promise<"ok" | "empty" | "no-composer" | "not-settled">}
       */
      let sendText = (sessionId, text, fallbackActions, readFallbackDraft) => {
        if (typeof text !== "string" || text === "") return Promise.resolve("empty");
        let shell = shellOf(sessionId);
        let actions = shell?.actions ?? fallbackActions;
        if (!actions || typeof actions.setDraft !== "function") {
          return Promise.resolve("no-composer");
        }
        try {
          actions.setDraft(text);
        } catch (_error) {
          return Promise.resolve("no-composer");
        }
        let readDraft = () => {
          let snapshotDraft = shellDraftOf(shell);
          if (typeof snapshotDraft === "string") return snapshotDraft;
          try {
            return typeof readFallbackDraft === "function" ? readFallbackDraft() : undefined;
          } catch (_error) {
            return undefined;
          }
        };
        return waitDraftSettled(readDraft, text).then((settled) => {
          // 只有确认草稿就是我们要发的那段文本才提交，绝不发用户自己的内容。
          if (!settled && readDraft() !== text) return "not-settled";
          try {
            if (typeof actions.submit === "function") actions.submit();
          } catch (_error) {
            return "not-settled";
          }
          return "ok";
        });
      };

      let api = {
        keycap: detectKeycap(),
        act: (
          /** @type {string} */ sessionId,
          /** @type {number} */ turn,
          /** @type {number} */ index,
        ) => callRemote("act", { sessionId: sessionId, turn: turn, index: index }),
        dismiss: (/** @type {string} */ sessionId, /** @type {number} */ turn) =>
          callRemote("dismiss", { sessionId: sessionId, turn: turn }),
        settings: () =>
          callRemote("settings").then((result) => {
            if (!result || typeof result !== "object") return null;
            if (result.ok === false) return null;
            return result.settings && typeof result.settings === "object"
              ? result.settings
              : result;
          }),
        sendText: sendText,
      };

      // 决策卡：每轮答案尾部一张。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.chat.turnTail", () =>
            ctx.slots.register(
              {
                name: "conversation.chat.turnTail",
                id: "next-step",
                locale: NS,
                inject: () => ({ api: api }),
              },
              NextStepTail,
            ),
          ),
        "next-step: card",
      );

      // 幽灵提示：输入框覆盖层（默认关，settings.ghost 打开才显示）。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.input.overlay", () =>
            ctx.slots.register(
              {
                name: "conversation.input.overlay",
                id: "next-step-ghost",
                order: 10,
                locale: NS,
                inject: () => ({ api: api }),
              },
              NextStepGhost,
            ),
          ),
        "next-step: ghost",
      );

      // 键盘：宿主的 fixed-input 观察通道（Tab / → 接受，Esc 清除）。
      try {
        ctx.inject(["shortcuts"], (/** @type {any} */ scope) => {
          let shortcuts = scope?.shortcuts;
          if (!shortcuts || typeof shortcuts.observeFixedInput !== "function") return;
          scope.effect(() => shortcuts.observeFixedInput(onFixedInput), "next-step: ghost keys");
        });
      } catch (_error) {
        /* shortcuts 缺失：幽灵提示只显示、不响应键盘 */
      }
    };

    return module.exports;
  },
});
