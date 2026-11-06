// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能使用 import。
// 功能：① 聊天快照可见性层（把每次回溯的 [target,marker] 区间节点标记 hidden）；
// ② 每条用户消息旁的 ↶ 按钮；③ 连按两次 Esc 打开回溯对话框；④ shell.overlay 里
// 的列表/确认浮层 + toast；⑤ 回溯成功后把目标消息回填输入框。
// 宿主调用走 ctx.connection.rpc.call("/api", ...) —— 无构建插件没有 typert 客户端产物，
// 不能用 ctx.reflect.get("remote.xxx")（见 docs/runtime/0.2.2-rc.1.md §7）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-session-rewind",
  factory(require) {
    let module = { exports: /** @type {any} */ ({}) };
    let exports = module.exports;

    /** @type {any} */
    let React = require("react");
    let h = React.createElement;
    let Fragment = React.Fragment;
    let cloneElement = React.cloneElement;
    let isValidElement = React.isValidElement;

    /** 官方 UI 原语：缺失时安全降级（Tooltip 用 title 属性代替）。 */
    /** @type {any} */
    let primitives = {};
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
    } catch (_error) {
      primitives = {};
    }
    let Tooltip = primitives.Tooltip;

    /** locale 命名空间；必须与 locale/*.json 顶层键一致。 */
    let NS = "sessionRewind";

    /** 简体中文词典（键集的事实来源）。 */
    let zh = {
      "shortcut.rewind": "回溯",
      "dialog.title": "回溯",
      "dialog.desc": "将会话恢复到之前的某条消息。",
      "dialog.titleConfirm": "回退到此处",
      "dialog.descConfirm": "从对话中移除此消息及其后的所有内容。",
      "dialog.cancel": "取消",
      "dialog.confirm": "回退",
      "dialog.loading": "正在读取…",
      "dialog.empty": "没有可回溯的消息。",
      "button.rewind": "回退到此处",
      "toast.done": "已回退到此处，原消息已放回输入框",
      "toast.draft": "已回退；输入框已有内容，未覆盖",
      "toast.noComposer": "已回退，但未找到输入框",
      "error.busy": "请先停止当前回合（Esc）再回溯",
      "error.notFound": "会话不存在",
      "error.inert": "子代理会话不支持回溯",
      "error.badTarget": "无法定位这条消息",
      "error.notOnSurface": "这条消息已被压缩摘要遮蔽，无法回溯",
      "error.failed": "回溯失败",
      "error.generic": "操作失败：{message}",
      "relative.justNow": "刚刚",
      "relative.minutes": "{n} 分钟前",
      "relative.hours": "{n} 小时前",
      "relative.days": "{n} 天前",
    };

    /** English dictionary（键集与 zh 完全一致）。 */
    let en = {
      "shortcut.rewind": "Rewind",
      "dialog.title": "Rewind",
      "dialog.desc": "Restore this conversation to an earlier message.",
      "dialog.titleConfirm": "Rewind to here",
      "dialog.descConfirm": "Remove this message and everything after it from the conversation.",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Rewind",
      "dialog.loading": "Loading…",
      "dialog.empty": "No messages to rewind to.",
      "button.rewind": "Rewind to here",
      "toast.done": "Rewound. The original message is back in the composer.",
      "toast.draft": "Rewound. The composer already had content, so it was kept.",
      "toast.noComposer": "Rewound, but no composer was found.",
      "error.busy": "Stop the current turn first (Esc), then rewind.",
      "error.notFound": "Session not found.",
      "error.inert": "Subagent sessions cannot be rewound.",
      "error.badTarget": "That message could not be located.",
      "error.notOnSurface":
        "That message was shadowed by a compaction summary and cannot be rewound.",
      "error.failed": "Rewind failed.",
      "error.generic": "Operation failed: {message}",
      "relative.justNow": "just now",
      "relative.minutes": "{n} min ago",
      "relative.hours": "{n} h ago",
      "relative.days": "{n} d ago",
    };

    // ------------------------------------------------------------------
    // 迷你 store（参考 session-delete）
    // ------------------------------------------------------------------

    /** @param {any} initial @returns {any} */
    function createStore(initial) {
      let value = initial;
      let listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (/** @type {any} */ listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (/** @type {any} */ next) => {
          value = typeof next === "function" ? next(value) : next;
          listeners.forEach((/** @type {any} */ listener) => {
            listener();
          });
        },
      };
    }

    function useStore(/** @type {any} */ store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    // ------------------------------------------------------------------
    // 纯函数（顶部，vm 测试通过 exports.__test 覆盖）
    // ------------------------------------------------------------------

    /** 节点在顺序上的比较键：优先 anchorSeq，退化到 data.seq。 */
    function anchorOf(/** @type {any} */ node) {
      if (!node) return undefined;
      if (typeof node.anchorSeq === "number") return node.anchorSeq;
      let data = node.data;
      return data && typeof data.seq === "number" ? data.seq : undefined;
    }

    /**
     * 从一条 marker 节点还原一次裁剪：[targetSeq, markerSeq]。
     * marker = kind ∈ {user, steering} 且 data.source.kind === 'session-rewind'，
     * 且 data.source.targetSeq 是数字；markerSeq 取该节点自己的 data.seq。
     */
    function cutOfMarkerNode(/** @type {any} */ node) {
      if (!node || typeof node !== "object") return undefined;
      if (node.kind !== "user" && node.kind !== "steering") return undefined;
      let data = node.data;
      let source = data?.source;
      if (source?.kind !== "session-rewind") return undefined;
      if (typeof source.targetSeq !== "number") return undefined;
      let markerSeq = typeof data.seq === "number" ? data.seq : anchorOf(node);
      if (typeof markerSeq !== "number") return undefined;
      return { targetSeq: source.targetSeq, markerSeq: markerSeq };
    }

    function cutKey(/** @type {any} */ cut) {
      return `${cut.targetSeq}:${cut.markerSeq}`;
    }

    /** 合并去重两组 cut。 */
    function mergeCuts(/** @type {any} */ left, /** @type {any} */ right) {
      /** @type {Set<string>} */
      let seen = new Set();
      /** @type {any[]} */
      let out = [];
      /** @type {any[]} */
      let all = [];
      if (Array.isArray(left)) all = all.concat(left);
      if (Array.isArray(right)) all = all.concat(right);
      for (let i = 0; i < all.length; i += 1) {
        let cut = all[i];
        if (!cut || typeof cut.targetSeq !== "number" || typeof cut.markerSeq !== "number")
          continue;
        let key = cutKey(cut);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ targetSeq: cut.targetSeq, markerSeq: cut.markerSeq });
      }
      return out;
    }

    /**
     * 扫描一组节点里所有 marker，得到全部 cut。
     *
     * 0.2.2-rc.1 的 Chat 只把 `surfaceOp: "append"` 的 user/message 渲染成节点，
     * 回溯 marker 是 `replace`，不会出现在这里——所以这条路径本版恒为空数组。
     * 真正的 cut 来自宿主 `sessionRewind/cuts`（cutsRef）。保留扫描是为了未来
     * Chat 开始渲染 replacement 节点时的前向兼容；两边合并去重。
     */
    function collectCuts(/** @type {any} */ nodes) {
      /** @type {any[]} */
      let out = [];
      let seen = new Set();
      if (!nodes) return out;
      let list = Array.isArray(nodes) ? nodes : Array.from(nodes);
      for (let i = 0; i < list.length; i += 1) {
        let cut = cutOfMarkerNode(list[i]);
        if (!cut) continue;
        let key = cutKey(cut);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cut);
      }
      return out;
    }

    /** 节点是否落在任一 cut 的闭区间内。 */
    function inCut(/** @type {any} */ node, /** @type {any} */ cuts) {
      if (!Array.isArray(cuts) || cuts.length === 0) return false;
      let anchor = anchorOf(node);
      if (typeof anchor !== "number") return false;
      for (let i = 0; i < cuts.length; i += 1) {
        let cut = cuts[i];
        if (cut && cut.targetSeq <= anchor && anchor <= cut.markerSeq) return true;
      }
      return false;
    }

    /** 浅拷贝并标记 hidden（已 hidden 则原样返回，避免无谓的新引用）。 */
    function hiddenNode(/** @type {any} */ node) {
      if (!node) return node;
      if (node.visibility === "hidden") return node;
      return Object.assign({}, node, { visibility: "hidden" });
    }

    /** cut 集合签名，用于判断是否需要全量重建。 */
    function signatureOfCuts(/** @type {any} */ cuts) {
      if (!Array.isArray(cuts)) return "[]";
      return JSON.stringify(cuts.map(cutKey).sort());
    }

    /** 一条消息节点的纯文本（所有 text block 连接）。 */
    function textOfMessage(/** @type {any} */ data) {
      if (!data || !Array.isArray(data.content)) return "";
      let out = "";
      for (let i = 0; i < data.content.length; i += 1) {
        let block = data.content[i];
        if (block && block.type === "text" && typeof block.text === "string") out += block.text;
      }
      return out;
    }

    /** 预览文本，默认截到 80 字符。 */
    function previewOf(/** @type {any} */ text, /** @type {any} */ max) {
      let limit = typeof max === "number" && max > 0 ? max : 80;
      let value = typeof text === "string" ? text : "";
      return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    }

    /** 相对时间 → {key, params}，交给 t() 渲染。 */
    function relativeOf(/** @type {any} */ time, /** @type {any} */ now) {
      if (typeof time !== "number") return { key: "relative.justNow", params: {} };
      let current = typeof now === "number" ? now : Date.now();
      let diff = current - time;
      if (diff < 0) diff = 0;
      let minutes = Math.floor(diff / 60000);
      if (minutes < 1) return { key: "relative.justNow", params: {} };
      if (minutes < 60) return { key: "relative.minutes", params: { n: minutes } };
      let hours = Math.floor(minutes / 60);
      if (hours < 24) return { key: "relative.hours", params: { n: hours } };
      let days = Math.floor(hours / 24);
      return { key: "relative.days", params: { n: days } };
    }

    /**
     * 宿主错误码 → locale 键。host 只给 code（可能带 session-rewind/ 前缀）。
     */
    function errorTextKey(/** @type {any} */ code) {
      let raw = typeof code === "string" ? code : "";
      let short = raw.indexOf("session-rewind/") === 0 ? raw.slice("session-rewind/".length) : raw;
      switch (short) {
        case "busy":
          return "error.busy";
        case "not-found":
          return "error.notFound";
        case "inert":
          return "error.inert";
        case "bad-target":
          return "error.badTarget";
        case "not-on-surface":
          return "error.notOnSurface";
        case "failed":
          return "error.failed";
        default:
          return "error.generic";
      }
    }

    /** 双击（Esc Esc）状态机：同一会话、在 intervalMs 内的第二次按返回 true。 */
    class DoubleEscape {
      /** @param {any} intervalMs 双击窗口（毫秒） */
      constructor(intervalMs) {
        this.intervalMs = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : 500;
        /** @type {{ sessionId: any, time: number } | null} */
        this.first = null;
      }

      reset() {
        this.first = null;
      }

      /** @param {any} input @returns {boolean} */
      press(input) {
        let sessionId = input ? input.sessionId : undefined;
        let at = input && typeof input.time === "number" ? input.time : Date.now();
        let first = this.first;
        if (
          first &&
          first.sessionId === sessionId &&
          at >= first.time &&
          at - first.time <= this.intervalMs
        ) {
          this.first = null;
          return true;
        }
        this.first = { sessionId: sessionId, time: at };
        return false;
      }
    }

    function createDoubleEscape(/** @type {any} */ intervalMs) {
      return new DoubleEscape(intervalMs);
    }

    // ------------------------------------------------------------------
    // 可见性层：包装已注册的 chat view builder
    // ------------------------------------------------------------------

    /** 当前正在重建的会话 id（只在同步的 rebuild 调用栈内有效）。 @type {string | null} */
    let activeSession = null;

    /**
     * 结构包装：转发 inner 的 empty/replace/apply/groupInput/publish。
     * 每次 replace/apply 前扫描节点里的 marker 重算 cuts（并与宿主 cuts 兜底合并），
     * 把落在 [target, marker] 区间内的节点换成 `{...node, visibility:"hidden"}` 副本。
     * cut 集合变化时走内层 replace 全量重建，否则走 apply。
     */
    class RewindVisibilityBuilder {
      /** @param {any} inner @param {any} cutsRef @param {any} sessionId */
      constructor(inner, cutsRef, sessionId) {
        this.inner = inner;
        this.cutsRef = cutsRef;
        this.sessionId = typeof sessionId === "string" ? sessionId : null;
        /** @type {Map<string, any>} */
        this.originals = new Map();
        /** @type {Map<string, any>} */
        this.derived = new Map();
        /** @type {Map<string, any>} */
        this.derivedBase = new Map();
        /** @type {any[]} */
        this.cuts = [];
        this.cutSignature = "[]";
        this.lastSignature = "[]";
      }

      get empty() {
        return this.inner ? this.inner.empty : undefined;
      }

      /** @param {any} node */
      setOriginal(node) {
        if (node && typeof node.key === "string") this.originals.set(node.key, node);
      }

      /** @param {any} nodes */
      setAll(nodes) {
        this.originals.clear();
        this.derived.clear();
        this.derivedBase.clear();
        for (let i = 0; i < nodes.length; i += 1) this.setOriginal(nodes[i]);
        this.refreshCuts();
      }

      refreshCuts() {
        let marker = collectCuts(Array.from(this.originals.values()));
        /** @type {any[]} */
        let fallback = [];
        if (this.sessionId && this.cutsRef && typeof this.cutsRef.get === "function") {
          fallback = this.cutsRef.get(this.sessionId) || [];
        }
        this.cuts = mergeCuts(marker, fallback);
        this.cutSignature = signatureOfCuts(this.cuts);
      }

      /** @param {any} node */
      deriveOne(node) {
        let key = node?.key;
        if (this.derivedBase.get(key) === node && this.derived.has(key))
          return this.derived.get(key);
        let out = inCut(node, this.cuts) ? hiddenNode(node) : node;
        this.derivedBase.set(key, node);
        this.derived.set(key, out);
        return out;
      }

      deriveAll() {
        /** @type {any[]} */
        let out = [];
        let self = this;
        this.originals.forEach(function each(/** @type {any} */ node) {
          out.push(self.deriveOne(node));
        });
        return out;
      }

      /** @param {any} input */
      replace(input) {
        let nodes = input && Array.isArray(input.nodes) ? input.nodes : [];
        this.setAll(nodes);
        this.lastSignature = this.cutSignature;
        /** @type {{ nodes: any[], timeline: any, changedTurns?: any }} */
        let payload = { nodes: this.deriveAll(), timeline: input ? input.timeline : undefined };
        if (input && input.changedTurns !== undefined) payload.changedTurns = input.changedTurns;
        return this.inner.replace(payload);
      }

      /** @param {any} input */
      apply(input) {
        let upserts = input && Array.isArray(input.upserts) ? input.upserts : [];
        for (let i = 0; i < upserts.length; i += 1) this.setOriginal(upserts[i]);
        this.refreshCuts();
        if (this.cutSignature !== this.lastSignature) {
          this.lastSignature = this.cutSignature;
          /** @type {{ nodes: any[], timeline: any, changedTurns?: any }} */
          let full = { nodes: this.deriveAll(), timeline: input ? input.timeline : undefined };
          if (input && input.changedTurns !== undefined) full.changedTurns = input.changedTurns;
          return this.inner.replace(full);
        }
        /** @type {any[]} */
        let derived = [];
        for (let j = 0; j < upserts.length; j += 1) derived.push(this.deriveOne(upserts[j]));
        /** @type {{ upserts: any[], timeline: any, changedTurns?: any }} */
        let payload = { upserts: derived, timeline: input ? input.timeline : undefined };
        if (input && input.changedTurns !== undefined) payload.changedTurns = input.changedTurns;
        return this.inner.apply(payload);
      }

      groupInput() {
        return this.inner && typeof this.inner.groupInput === "function"
          ? this.inner.groupInput()
          : undefined;
      }

      publish() {
        if (this.inner && typeof this.inner.publish === "function") this.inner.publish();
      }
    }

    /** 在 activeSession 标记下调用某会话的 chat rebuild（让包装捕获会话 id）。 */
    function rebuildSession(/** @type {any} */ ui, /** @type {any} */ sessionId) {
      if (!ui || typeof ui.binding !== "function" || typeof sessionId !== "string") return;
      let previous = activeSession;
      activeSession = sessionId;
      try {
        let binding = ui.binding(sessionId);
        if (binding && typeof binding.rebuild === "function") binding.rebuild();
      } catch (_error) {
        // 该会话此刻不可重建（teardown 窗口）；忽略。
      } finally {
        activeSession = previous;
      }
    }

    /** 所有 retainedBy > 0 的会话重建一次 chat。 */
    function rebuildOpenSessions(/** @type {any} */ ui, /** @type {any} */ sessions) {
      if (!ui || !sessions) return;
      let snapshot;
      try {
        let list = sessions.list;
        snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : undefined;
      } catch (_error) {
        return;
      }
      if (!snapshot) return;
      let ids = new Set();
      if (Array.isArray(snapshot.ids))
        snapshot.ids.forEach((/** @type {any} */ id) => {
          ids.add(id);
        });
      if (snapshot.byId)
        Object.keys(snapshot.byId).forEach((/** @type {any} */ id) => {
          ids.add(id);
        });
      let byId = snapshot.byId || {};
      ids.forEach((/** @type {any} */ id) => {
        let row = byId[id];
        let retained = row?.retainedBy;
        if (!retained) return;
        let total = 0;
        Object.keys(retained).forEach((/** @type {any} */ source) => {
          let count = retained[source];
          if (typeof count === "number") total += count;
        });
        if (total > 0) rebuildSession(ui, id);
      });
    }

    /**
     * 安装可见性层：找到 views 里 target==='chat' 的定义，保存并替换 create。
     * 卸载时还原。ctx.effect 生命周期内生效。
     */
    function installChatVisibility(/** @type {any} */ ctx, /** @type {any} */ cutsRef) {
      let stopped = false;
      function install() {
        /** @type {null | (() => void)} */
        let currentCleanup = null;
        function installOn(/** @type {any} */ ui) {
          try {
            if (typeof currentCleanup === "function") currentCleanup();
            currentCleanup = null;
            if (!ui?.views || typeof ui.views.entries !== "function") return;
            let views = ui.views;
            let patches = new Map();
            function restore() {
              patches.forEach((/** @type {any} */ record, /** @type {any} */ definition) => {
                try {
                  if (definition.create === record.wrapper) definition.create = record.original;
                } catch (_error) {
                  /* ignore */
                }
              });
              patches.clear();
            }
            function ensure() {
              try {
                let found;
                let entries = views.entries();
                for (let i = 0; i < entries.length; i += 1) {
                  if (entries[i] && entries[i].target === "chat") {
                    found = entries[i];
                    break;
                  }
                }
                if (!found || typeof found.create !== "function") return;
                let record = patches.get(found);
                if (record && found.create === record.wrapper) return;
                let original = found.create;
                let wrapper = function createRewindAwareBuilder() {
                  return new RewindVisibilityBuilder(original.call(found), cutsRef, activeSession);
                };
                found.create = wrapper;
                patches.set(found, { original: original, wrapper: wrapper });
              } catch (_error) {
                /* 探测失败不影响其它功能 */
              }
            }
            let unsubscribe = null;
            try {
              if (typeof views.subscribe === "function") unsubscribe = views.subscribe(ensure);
            } catch (_error) {
              unsubscribe = null;
            }
            ensure();
            rebuildOpenSessions(ui, ctx.sessions);
            currentCleanup = function cleanup() {
              try {
                if (typeof unsubscribe === "function") unsubscribe();
              } catch (_error) {
                /* ignore */
              }
              restore();
              rebuildOpenSessions(ui, ctx.sessions);
            };
          } catch (_error) {
            /* degrade */
          }
        }
        let scopeOff = null;
        try {
          if (typeof ctx.inject === "function") {
            scopeOff = ctx.inject(["uiConversation"], (/** @type {any} */ scope) => {
              if (stopped) return;
              let ui;
              try {
                ui = scope.get("uiConversation");
              } catch (_error) {
                ui = undefined;
              }
              installOn(ui);
            });
          } else {
            installOn(safeGet(ctx, "uiConversation"));
          }
        } catch (_error) {
          /* degrade */
        }
        return function dispose() {
          stopped = true;
          try {
            if (typeof scopeOff === "function") scopeOff();
          } catch (_error) {
            /* ignore */
          }
          try {
            if (typeof currentCleanup === "function") currentCleanup();
          } catch (_error) {
            /* ignore */
          }
          currentCleanup = null;
        };
      }
      if (typeof ctx.effect === "function")
        return ctx.effect(install, "session-rewind: chat visibility");
      return install();
    }

    // ------------------------------------------------------------------
    // 每消息 ↶ 按钮：接管 conversation.chat.node 里 key==='user' 的 entry
    // ------------------------------------------------------------------

    /** 读注册组件背后的 renderer（解包 memo / forwardRef）。 */
    function rendererOf(/** @type {any} */ component) {
      if (typeof component === "function") return component;
      if (component && typeof component === "object") {
        if (typeof component.type === "function") return component.type;
        if (typeof component.render === "function") return component.render;
      }
      return undefined;
    }

    /** 行渲染 props 的寻址字段；形状不符返回 undefined。 */
    function targetOf(/** @type {any} */ props) {
      if (!props) return undefined;
      let node = props.node;
      let data = node?.data;
      let sessionId = props.sessionId;
      if (
        typeof sessionId !== "string" &&
        props.session &&
        typeof props.session.sessionId === "string"
      ) {
        sessionId = props.session.sessionId;
      }
      if (typeof sessionId !== "string") return undefined;
      if (!data || typeof data.seq !== "number" || typeof data.time !== "number") return undefined;
      return { sessionId: sessionId, seq: data.seq, time: data.time, text: textOfMessage(data) };
    }

    function isUserSource(/** @type {any} */ node) {
      let data = node?.data;
      let source = data?.source;
      return !!source && source.kind === "user";
    }

    /** 给 actions row 追加我们的按钮（extraActions）。形状不符返回原元素。 */
    function appendExtra(
      /** @type {any} */ actionsRow,
      /** @type {any} */ target,
      /** @type {any} */ text,
      /** @type {any} */ deps,
    ) {
      if (!isValidElement(actionsRow)) return actionsRow;
      try {
        let element = deps.renderElement({
          sessionId: target.sessionId,
          seq: target.seq,
          time: target.time,
          text: typeof text === "string" ? text : target.text,
        });
        if (element === null || element === undefined) return actionsRow;
        let existing = actionsRow.props ? actionsRow.props.extraActions : undefined;
        return cloneElement(actionsRow, { extraActions: h(Fragment, null, existing, element) });
      } catch (_error) {
        return actionsRow;
      }
    }

    /** 把我们的按钮塞进行元素构造出的 actions row。兼容两种 shape。 */
    function injectAction(
      /** @type {any} */ row,
      /** @type {any} */ target,
      /** @type {any} */ deps,
    ) {
      let props = row.props || {};
      if (typeof props.actions === "function") {
        let build = props.actions;
        return cloneElement(row, {
          actions: (/** @type {any} */ text) => appendExtra(build(text), target, text, deps),
        });
      }
      let children = props.children;
      if (children === undefined || children === null) return row;
      let list = Array.isArray(children) ? children : [children];
      let changed = false;
      let next = list.map((/** @type {any} */ child) => {
        if (changed || !isValidElement(child)) return child;
        let childProps = child.props || {};
        if (typeof childProps.clock !== "string") return child;
        changed = true;
        return appendExtra(child, target, childProps.text, deps);
      });
      if (!changed) return row;
      return cloneElement(row, { children: next.length === 1 ? next[0] : next });
    }

    /** 包装官方 renderer：先拿行元素，再注入按钮。任何异常原样返回。 */
    function rowWithAction(/** @type {any} */ official, /** @type {any} */ deps) {
      return function RewindActionRow(/** @type {any} */ props) {
        let row;
        try {
          row = official(props);
        } catch (_error) {
          return null;
        }
        try {
          if (!isValidElement(row)) return row;
          if (!isUserSource(props.node)) return row;
          let target = targetOf(props);
          if (!target) return row;
          if (typeof deps.canRewind === "function" && !deps.canRewind(target.sessionId)) return row;
          return injectAction(row, target, deps);
        } catch (_error) {
          return row;
        }
      };
    }

    /** ↶ 图标按钮（28px，跟随宿主主题）。 */
    function RewindButton(/** @type {any} */ props) {
      let label = props.t("button.rewind");
      let onClick = (/** @type {any} */ event) => {
        try {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        } catch (_error) {
          /* ignore */
        }
        props.onRewind(props.target);
      };
      let icon = h(
        "svg",
        {
          width: 15,
          height: 15,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M6.5 3.5 3 7l3.5 3.5" }),
        h("path", { d: "M3 7h6a3.5 3.5 0 0 1 0 7H7" }),
      );
      let button = h(
        "button",
        {
          type: "button",
          className: "dsh-srw-action",
          title: label,
          "aria-label": label,
          onClick: onClick,
        },
        icon,
      );
      if (typeof Tooltip === "function")
        return h(Tooltip, { label: label, side: "bottom" }, button);
      return button;
    }

    /** 接管 user 行组件，安装/卸载可重复。 */
    function installRowAction(/** @type {any} */ slots, /** @type {any} */ deps) {
      if (!slots || typeof slots.entries !== "function") return function noop() {};
      let taken = new Map();

      function tick() {
        if (typeof slots.register !== "function") return;
        try {
          slots.register(
            { name: "conversation.chat.node", key: "dsh-session-rewind:mount" },
            () => null,
          )();
        } catch (_error) {
          /* 只影响刷新速度 */
        }
      }

      function takeOver(/** @type {any} */ entry) {
        if (!entry || taken.has(entry)) return false;
        if (entry.options?.key !== "user") return false;
        let official = rendererOf(entry.component);
        if (!official) return false;
        let original = entry.component;
        let replacement = rowWithAction(official, deps);
        try {
          entry.component = replacement;
        } catch (_error) {
          return false;
        }
        taken.set(entry, { original: original, replacement: replacement });
        return true;
      }

      function sync() {
        let changed = false;
        let entries;
        try {
          entries = slots.entries("conversation.chat.node");
        } catch (_error) {
          return;
        }
        if (!entries) return;
        for (let i = 0; i < entries.length; i += 1) if (takeOver(entries[i])) changed = true;
        if (changed) tick();
      }

      sync();
      let unsubscribe = null;
      try {
        if (typeof slots.subscribe === "function")
          unsubscribe = slots.subscribe("conversation.chat.node", sync);
      } catch (_error) {
        unsubscribe = null;
      }
      return function dispose() {
        try {
          if (typeof unsubscribe === "function") unsubscribe();
        } catch (_error) {
          /* ignore */
        }
        taken.forEach((/** @type {any} */ record, /** @type {any} */ entry) => {
          try {
            if (entry.component === record.replacement) entry.component = record.original;
          } catch (_error) {
            /* ignore */
          }
        });
        taken.clear();
      };
    }

    // ------------------------------------------------------------------
    // 浮层 UI（list / confirm / toast）
    // ------------------------------------------------------------------

    function Btn(/** @type {any} */ props) {
      let className = props.primary ? "dsh-srw-btn dsh-srw-btn-primary" : "dsh-srw-btn";
      return h(
        "button",
        { type: "button", className: className, disabled: props.disabled, onClick: props.onClick },
        props.children,
      );
    }

    function RewindDialog(/** @type {any} */ props) {
      let state = props.state;
      let api = props.api;
      let t = props.t;
      let confirmMode = state.mode === "confirm";
      let title = confirmMode ? t("dialog.titleConfirm") : t("dialog.title");
      let desc = confirmMode ? t("dialog.descConfirm") : t("dialog.desc");

      let body;
      if (state.loading && !confirmMode && state.candidates.length === 0) {
        body = h("div", { className: "dsh-srw-dim" }, t("dialog.loading"));
      } else if (state.errorKey) {
        body = h("div", { className: "dsh-srw-error" }, t(state.errorKey, state.errorParams || {}));
      } else if (!confirmMode) {
        let rows = state.candidates.map(
          (/** @type {any} */ candidate, /** @type {any} */ index) => {
            let active = index === state.selected ? "true" : undefined;
            return h(
              "button",
              {
                key: String(candidate.seq),
                type: "button",
                className: "dsh-srw-row",
                "data-active": active,
                onClick: () => api.openConfirm(candidate, state.sessionId),
              },
              h(
                "span",
                { className: "dsh-srw-preview" },
                candidate.preview || candidate.text || "",
              ),
              h("span", { className: "dsh-srw-time" }, relativeText(t, candidate.time)),
            );
          },
        );
        if (rows.length === 0)
          rows = [h("div", { key: "empty", className: "dsh-srw-dim" }, t("dialog.empty"))];
        body = h("div", { className: "dsh-srw-list" }, rows);
      } else {
        let target = state.target || {};
        body = h(
          "div",
          { className: "dsh-srw-target" },
          h("span", { className: "dsh-srw-preview" }, target.preview || target.text || ""),
          h("span", { className: "dsh-srw-time" }, relativeText(t, target.time)),
        );
      }

      let footer = confirmMode
        ? h(
            Fragment,
            null,
            h(Btn, { onClick: () => api.back() }, t("dialog.cancel")),
            h(
              Btn,
              { primary: true, disabled: state.loading, onClick: () => api.doRewind() },
              state.loading ? t("dialog.loading") : t("dialog.confirm"),
            ),
          )
        : h(Btn, { onClick: () => api.close() }, t("dialog.cancel"));

      return h(
        "div",
        { className: "dsh-srw-mask", onClick: () => api.close() },
        h(
          "div",
          {
            className: "dsh-srw-dialog",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": title,
            onClick: (/** @type {any} */ event) => {
              if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            },
          },
          h("div", { className: "dsh-srw-title" }, title),
          h("div", { className: "dsh-srw-desc" }, desc),
          body,
          h("div", { className: "dsh-srw-footer" }, footer),
        ),
      );
    }

    function ToastLine(/** @type {any} */ props) {
      let toast = props.toast || {};
      return h(
        "div",
        { className: "dsh-srw-toast", role: "status" },
        props.t(toast.key, toast.params || {}),
      );
    }

    function relativeText(/** @type {any} */ t, /** @type {any} */ time) {
      let relative = relativeOf(time, Date.now());
      return t(relative.key, relative.params);
    }

    function handleOverlayKey(
      /** @type {any} */ event,
      /** @type {any} */ store,
      /** @type {any} */ api,
    ) {
      let state = store.getSnapshot();
      if (!state?.mode) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (state.mode === "confirm") api.back();
        else api.close();
        return;
      }
      if (state.mode === "list") {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          api.move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          api.move(-1);
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          api.pick();
        }
      } else if (state.mode === "confirm" && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!state.loading) api.doRewind();
      }
    }

    function RewindOverlay(/** @type {any} */ props) {
      let state = useStore(props.store);
      let store = props.store;
      let api = props.api;
      React.useEffect(() => {
        if (!state.mode) return undefined;
        let onKey = (/** @type {any} */ event) => handleOverlayKey(event, store, api);
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [state.mode]);
      React.useEffect(() => {
        if (!state.toast) return undefined;
        let timer = setTimeout(() => {
          api.clearToast();
        }, 3200);
        return () => clearTimeout(timer);
      }, [state.toast]);

      let dialog = state.mode ? h(RewindDialog, { state: state, api: api, t: props.t }) : null;
      let toast = state.toast ? h(ToastLine, { toast: state.toast, t: props.t }) : null;
      return h(Fragment, null, dialog, toast);
    }

    /** 会话级 bridge：挂载时拉一次宿主 cuts 作为可见性兜底（静默失败）。 */
    function CutsBridge(/** @type {any} */ props) {
      let api = props.api;
      let sessionId = props.sessionId;
      React.useEffect(() => {
        if (sessionId && api) api.seedCuts(sessionId);
      }, [sessionId]);
      return null;
    }

    // ------------------------------------------------------------------
    // 通用小工具
    // ------------------------------------------------------------------

    function safeGet(/** @type {any} */ ctx, /** @type {any} */ name) {
      try {
        return ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined;
      } catch (_error) {
        return undefined;
      }
    }

    function createCutStore() {
      let map = new Map();
      function isCut(/** @type {any} */ cut) {
        return !!cut && typeof cut.targetSeq === "number" && typeof cut.markerSeq === "number";
      }
      return {
        get: (/** @type {any} */ sessionId) => {
          let list = map.get(sessionId);
          return list ? list.slice() : [];
        },
        set: (/** @type {any} */ sessionId, /** @type {any} */ cuts) => {
          if (!Array.isArray(cuts)) {
            map.set(sessionId, []);
            return;
          }
          map.set(
            sessionId,
            cuts.filter(isCut).map((/** @type {any} */ cut) => ({
              targetSeq: cut.targetSeq,
              markerSeq: cut.markerSeq,
            })),
          );
        },
        add: (/** @type {any} */ sessionId, /** @type {any} */ cut) => {
          if (!isCut(cut)) return;
          let list = map.get(sessionId) || [];
          let exists = list.some(
            (/** @type {any} */ item) =>
              item.targetSeq === cut.targetSeq && item.markerSeq === cut.markerSeq,
          );
          if (exists) return;
          map.set(sessionId, list.concat([{ targetSeq: cut.targetSeq, markerSeq: cut.markerSeq }]));
        },
        has: (/** @type {any} */ sessionId) => map.has(sessionId),
        clear: (/** @type {any} */ sessionId) => {
          map.delete(sessionId);
        },
      };
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------

    exports.inject = ["slots", "locale", "sessions", "shortcuts", "connection"];
    /** @param {any} ctx */
    exports.apply = function apply(/** @type {any} */ ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "session-rewind: dictionaries");

      let t;
      try {
        t = ctx.locale.bind(NS);
      } catch (_error) {
        t = function fallbackT(/** @type {any} */ key) {
          return key;
        };
      }

      // 注入样式：全部走宿主 CSS 变量，深浅色自动跟随；用 data-plugin 标注归属。
      ctx.effect(() => {
        let style = document.createElement("style");
        style.dataset.plugin = "@kangyishuai/dsh-session-rewind";
        style.textContent = [
          ".dsh-srw-action{width:28px;height:28px;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary,GrayText);background:transparent;border:none;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer;transition:background-color 120ms ease,color 120ms ease;}",
          ".dsh-srw-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,GrayText);}",
          ".dsh-srw-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px;}",
          ".dsh-srw-mask{position:fixed;inset:0;z-index:2147000000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;}",
          ".dsh-srw-dialog{width:min(560px,92vw);max-height:78vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:18px 20px;box-shadow:0 16px 48px rgba(0,0,0,.35);font-size:13px;line-height:1.6;}",
          ".dsh-srw-title{font-size:15px;font-weight:600;margin-bottom:6px;}",
          ".dsh-srw-desc{color:var(--dsw-alias-label-secondary,GrayText);margin-bottom:12px;}",
          ".dsh-srw-list{display:flex;flex-direction:column;gap:2px;}",
          ".dsh-srw-dim{color:var(--dsw-alias-label-tertiary,GrayText);padding:8px 0;}",
          ".dsh-srw-error{color:var(--dsw-alias-state-error-primary,#d9534f);padding:8px 0;}",
          ".dsh-srw-row{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:13px;}",
          ".dsh-srw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
          ".dsh-srw-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}",
          ".dsh-srw-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
          ".dsh-srw-time{color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;white-space:nowrap;}",
          ".dsh-srw-target{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:baseline;}",
          ".dsh-srw-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}",
          ".dsh-srw-btn{padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));}",
          ".dsh-srw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}",
          ".dsh-srw-btn:disabled{opacity:.45;cursor:not-allowed;}",
          ".dsh-srw-btn-primary{background:var(--dsw-alias-brand-primary,#4f7cff);color:#fff;border-color:transparent;}",
          ".dsh-srw-btn-primary:hover{filter:brightness(1.05);}",
          ".dsh-srw-toast{position:fixed;bottom:24px;right:24px;z-index:2147000000;background:var(--dsw-alias-toast-bg,Canvas);color:var(--dsw-alias-toast-label,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:10px 14px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.35);}",
        ].join("\n");
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-rewind: styles");

      let cutStore = createCutStore();
      let store = createStore({
        mode: null,
        sessionId: null,
        candidates: [],
        selected: 0,
        target: null,
        loading: false,
        errorKey: null,
        errorParams: null,
        toast: null,
      });

      /** 宿主 RPC 通道。 */
      function call(/** @type {any} */ method, /** @type {any} */ request) {
        let rpc;
        try {
          rpc = ctx.connection?.rpc;
        } catch (_error) {
          rpc = undefined;
        }
        if (!rpc || typeof rpc.call !== "function") {
          return Promise.reject(new Error("session-rewind: no connection to the host"));
        }
        let payload = request === undefined ? { args: {} } : { args: { request: request } };
        return Promise.resolve(rpc.call("/api", `sessionRewind/${method}`, payload)).then(
          (/** @type {any} */ result) => {
            if (!result || typeof result !== "object") return result;
            if (result.ok === false) {
              let error = /** @type {Error & { code?: string }} */ (
                new Error(result.error?.message || "host rejected the call")
              );
              error.code = result.error ? result.error.code : undefined;
              throw error;
            }
            return Object.hasOwn(result, "value") ? result.value : result;
          },
        );
      }

      function patch(/** @type {any} */ partial) {
        store.set((/** @type {any} */ previous) =>
          Object.assign({}, previous, typeof partial === "function" ? partial(previous) : partial),
        );
      }

      /**
       * @param {any} key 文案 key
       * @param {any} [params] 文案参数
       */
      function showToast(key, params) {
        patch({ toast: { key: key, params: params || {} } });
      }

      function uiConversationOf() {
        return safeGet(ctx, "uiConversation");
      }

      function rebuildSessionById(/** @type {any} */ sessionId) {
        let ui = uiConversationOf();
        if (ui) rebuildSession(ui, sessionId);
      }

      function bindingOf(/** @type {any} */ sessionId) {
        try {
          return ctx.sessions && typeof ctx.sessions.binding === "function"
            ? ctx.sessions.binding(sessionId)
            : undefined;
        } catch (_error) {
          return undefined;
        }
      }

      function sessionSnapshotOf(/** @type {any} */ sessionId) {
        let binding = bindingOf(sessionId);
        if (!binding?.session || typeof binding.session.getSnapshot !== "function")
          return undefined;
        try {
          return binding.session.getSnapshot();
        } catch (_error) {
          return undefined;
        }
      }

      /** 子代理会话：不显示按钮、不响应 Esc Esc、host 返回 inert。 */
      function isInert(/** @type {any} */ sessionId) {
        let snapshot = sessionSnapshotOf(sessionId);
        if (!snapshot) return false;
        return snapshot.subagent !== null && snapshot.subagent !== undefined;
      }

      /** 空闲会话才参与双击判定。 */
      function isIdle(/** @type {any} */ sessionId) {
        let snapshot = sessionSnapshotOf(sessionId);
        if (!snapshot) return false;
        if (snapshot.removed) return false;
        if (snapshot.running !== false) return false;
        return snapshot.subagent === null || snapshot.subagent === undefined;
      }

      /** 回填输入框；返回 'ok' | 'draft' | 'none'。 */
      function fillComposer(/** @type {any} */ sessionId, /** @type {any} */ text) {
        let facade;
        try {
          let conversation = safeGet(ctx, "conversation");
          let scope =
            ctx.sessions && typeof ctx.sessions.scope === "function"
              ? ctx.sessions.scope(sessionId)
              : undefined;
          if (
            conversation?.input &&
            typeof conversation.input.for === "function" &&
            scope !== undefined
          ) {
            facade = conversation.input.for(scope);
          }
        } catch (_error) {
          facade = undefined;
        }
        if (facade) {
          let draft = "";
          try {
            draft =
              facade.snapshot && typeof facade.snapshot.draft === "string"
                ? facade.snapshot.draft
                : "";
          } catch (_error) {
            draft = "";
          }
          if (draft.trim() !== "") return "draft";
          try {
            if (typeof facade.setDraft === "function") {
              facade.setDraft(text);
              try {
                if (typeof facade.focus === "function") facade.focus();
              } catch (_error) {
                /* focus 是呈现，draft 才重要 */
              }
              return "ok";
            }
          } catch (_error) {
            /* facade 抛错时退化为 DOM 通道 */
          }
        }
        let el = null;
        try {
          el = document.querySelector("[data-composer-input]");
        } catch (_error) {
          el = null;
        }
        if (!el || !(el instanceof HTMLElement)) return "none";
        let current = el.textContent || "";
        if (current.trim() !== "") return "draft";
        try {
          el.focus();
        } catch (_error) {
          /* ignore */
        }
        try {
          let selection =
            typeof document.getSelection === "function" ? document.getSelection() : null;
          if (selection) {
            let range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } catch (_error) {
          /* ignore */
        }
        let ok = false;
        try {
          ok = document.execCommand("insertText", false, text);
        } catch (_error) {
          ok = false;
        }
        if (!ok) {
          try {
            el.textContent = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            ok = true;
          } catch (_error) {
            ok = false;
          }
        }
        return ok ? "ok" : "none";
      }

      // ---- store 上的行为 ----

      function openList(/** @type {any} */ sessionId) {
        patch({
          mode: "list",
          sessionId: sessionId,
          candidates: [],
          selected: 0,
          target: null,
          loading: true,
          errorKey: null,
          errorParams: null,
        });
        call("candidates", { sessionId: sessionId })
          .then((/** @type {any} */ value) => {
            let list = value && Array.isArray(value.candidates) ? value.candidates : [];
            patch((/** @type {any} */ state) =>
              state.mode === "list" && state.sessionId === sessionId
                ? { loading: false, candidates: list, selected: 0 }
                : {},
            );
          })
          .catch((/** @type {any} */ error) => {
            patch((/** @type {any} */ state) =>
              state.mode === "list" && state.sessionId === sessionId
                ? {
                    loading: false,
                    errorKey: errorTextKey(error?.code),
                    errorParams: { message: String(error?.message || error) },
                  }
                : {},
            );
          });
      }

      function openConfirm(/** @type {any} */ candidate, /** @type {any} */ sessionId) {
        if (!candidate) return;
        patch({
          mode: "confirm",
          sessionId: sessionId,
          target: candidate,
          loading: false,
          errorKey: null,
          errorParams: null,
        });
      }

      function back() {
        patch({ mode: "list", errorKey: null, errorParams: null });
      }

      function close() {
        patch({ mode: null, target: null, errorKey: null, errorParams: null });
      }

      function move(/** @type {any} */ delta) {
        patch((/** @type {any} */ state) => {
          if (state.mode !== "list" || !state.candidates.length) return {};
          let total = state.candidates.length;
          let next = Math.max(0, Math.min(total - 1, state.selected + delta));
          return { selected: next };
        });
      }

      function pick() {
        let state = store.getSnapshot();
        let candidate = state.candidates[state.selected];
        if (candidate) openConfirm(candidate, state.sessionId);
      }

      function doRewind() {
        let state = store.getSnapshot();
        if (state?.mode !== "confirm" || !state.target || state.loading) return;
        let target = state.target;
        let sessionId = state.sessionId;
        patch({ loading: true, errorKey: null, errorParams: null });
        call("rewind", { sessionId: sessionId, targetSeq: target.seq })
          .then((/** @type {any} */ value) => {
            let cut = {
              targetSeq:
                value && typeof value.targetSeq === "number" ? value.targetSeq : target.seq,
              markerSeq:
                value && typeof value.markerSeq === "number" ? value.markerSeq : target.seq,
            };
            cutStore.add(sessionId, cut);
            rebuildSessionById(sessionId);
            let text = value && typeof value.text === "string" ? value.text : target.text || "";
            let outcome = fillComposer(sessionId, text);
            patch({
              mode: null,
              target: null,
              candidates: [],
              loading: false,
              errorKey: null,
              errorParams: null,
            });
            showToast(
              outcome === "draft"
                ? "toast.draft"
                : outcome === "none"
                  ? "toast.noComposer"
                  : "toast.done",
            );
          })
          .catch((/** @type {any} */ error) => {
            patch({
              loading: false,
              errorKey: errorTextKey(error?.code),
              errorParams: { message: String(error?.message || error) },
            });
          });
      }

      /** 拉一次宿主 cuts 作为可见性兜底（静默失败）。 */
      function seedCuts(/** @type {any} */ sessionId) {
        return call("cuts", { sessionId: sessionId })
          .then((/** @type {any} */ value) => {
            let list = value && Array.isArray(value.cuts) ? value.cuts : [];
            cutStore.set(sessionId, list);
            rebuildSessionById(sessionId);
          })
          .catch(() => {
            /* 静默 */
          });
      }

      function clearToast() {
        patch({ toast: null });
      }

      let api = {
        openList: openList,
        openConfirm: openConfirm,
        back: back,
        close: close,
        move: move,
        pick: pick,
        doRewind: doRewind,
        seedCuts: seedCuts,
        clearToast: clearToast,
      };

      // ---- 安装各层 ----

      installChatVisibility(ctx, cutStore);

      ctx.effect(
        () =>
          installRowAction(ctx.slots, {
            canRewind: (/** @type {any} */ sessionId) => !isInert(sessionId),
            renderElement: (/** @type {any} */ target) =>
              h(RewindButton, {
                target: target,
                t: t,
                onRewind: (/** @type {any} */ picked) => openConfirm(picked, picked.sessionId),
              }),
          }),
        "session-rewind: row action",
      );

      // ESC ESC：仅空闲会话参与双击判定，绝不抢内置「Esc Esc 停止」。
      try {
        ctx.inject(["shortcuts"], (/** @type {any} */ scope) => {
          let shortcuts = scope?.shortcuts;
          if (!shortcuts) return;
          let interval =
            typeof shortcuts.stopSequenceMs === "number" ? shortcuts.stopSequenceMs : 500;
          let esc = new DoubleEscape(interval);

          scope.effect(
            () =>
              shortcuts.registerFixed({
                id: "fixed.rewind",
                label: () => t("shortcut.rewind"),
                keys: ["Esc", "Esc"],
                bindings: [{ code: "Escape", modifiers: [] }],
                group: "input",
              }),
            "session-rewind: shortcut reference",
          );

          scope.effect(
            () =>
              shortcuts.observeFixedInput((/** @type {any} */ input) => {
                if (!input || input.type === "reset") {
                  esc.reset();
                  return;
                }
                let gesture = input.gesture || {};
                let context = input.context || {};
                if (
                  gesture.code !== "Escape" ||
                  gesture.control ||
                  gesture.alt ||
                  gesture.shift ||
                  gesture.meta ||
                  gesture.repeat ||
                  gesture.composing ||
                  gesture.defaultPrevented ||
                  context.modal !== null ||
                  context.region === "terminal" ||
                  !context.target
                ) {
                  esc.reset();
                  return;
                }
                let occurrence = null;
                try {
                  occurrence = context.target.closest("[data-conversation-session]");
                } catch (_error) {
                  occurrence = null;
                }
                if (!occurrence) {
                  esc.reset();
                  return;
                }
                let sessionId = occurrence.getAttribute("data-conversation-session");
                if (!sessionId || !isIdle(sessionId)) {
                  esc.reset();
                  return;
                }
                let now =
                  typeof performance !== "undefined" && typeof performance.now === "function"
                    ? performance.now()
                    : Date.now();
                if (esc.press({ sessionId: sessionId, time: now })) {
                  try {
                    if (typeof input.consume === "function") input.consume();
                  } catch (_error) {
                    /* ignore */
                  }
                  openList(sessionId);
                }
              }),
            "session-rewind: esc esc",
          );
        });
      } catch (_error) {
        /* shortcuts 缺失时降级：无 Esc Esc 入口 */
      }

      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              { name: "shell.overlay", id: "session-rewind", locale: NS },
              (/** @type {any} */ props) =>
                h(
                  RewindOverlay,
                  Object.assign({}, props, { store: store, api: api, t: props.t || t }),
                ),
            ),
          ),
        "session-rewind: overlay",
      );

      // 会话级 bridge：挂载时对本 session 拉一次 host cuts 作为兜底。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.session.header.actions", () =>
            ctx.slots.register(
              {
                name: "conversation.session.header.actions",
                id: "session-rewind-cuts",
                order: 1000,
                locale: NS,
              },
              (/** @type {any} */ props) => h(CutsBridge, Object.assign({}, props, { api: api })),
            ),
          ),
        "session-rewind: cuts bridge",
      );
    };

    // 供 node:vm 单测读取的纯函数出口（非枚举，不影响运行时）。
    Object.defineProperty(exports, "__test", {
      value: Object.freeze({
        DoubleEscape: DoubleEscape,
        createDoubleEscape: createDoubleEscape,
        anchorOf: anchorOf,
        cutOfMarkerNode: cutOfMarkerNode,
        collectCuts: collectCuts,
        inCut: inCut,
        hiddenNode: hiddenNode,
        mergeCuts: mergeCuts,
        signatureOfCuts: signatureOfCuts,
        textOfMessage: textOfMessage,
        previewOf: previewOf,
        relativeOf: relativeOf,
        errorTextKey: errorTextKey,
      }),
    });

    return module.exports;
  },
});
