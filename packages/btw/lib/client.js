// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能 import / JSX。
//
// 职责（v0.2b）：
//   A. 输入框左侧一个「旁问」按钮，点开浮层。
//   B. 浮层里列出本会话最近的旁问（Typert Remote `btw/history`），带成本徽章。
//   C. 浮层里可以直接发问：把 `/btw <问题>` 塞进 composer 再提交。
//      **必须借 composer 提交**——真实 Agent 只能在命令调用上下文里拿到
//      （`ctx.agents.get()` 返回 undefined，见公开仓库 docs/adr/0016）。
//
// 宿主调用走 ctx.connection.rpc.call("/api", "btw/<method>", { args: { request } })——
// 无构建插件没有 typert 客户端产物（见 docs/runtime/0.2.2-rc.1.md §7）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-btw",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;

    /** @type {any} */
    const React = require("react");
    const h = React.createElement;

    const NS = "btw";
    const PLUGIN_ID = "@kangyishuai/dsh-btw";
    /** setDraft 走异步更新：轮询草稿落定（与 next-step 同参数）。 */
    const DRAFT_POLL_TRIES = 15;
    const DRAFT_POLL_INTERVAL_MS = 20;
    /** 浮层列出的线程条数上限。 */
    const LIMITS_CLIENT_THREADS = 20;
    /** 提交后轮询历史，等新记录出现；按实测 /btw 耗时（32–40s）给足 120s 窗口。 */
    const REFRESH_MAX_MS = 120_000;
    const REFRESH_INTERVAL_MS = 1500;

    const zh = {
      button: "旁问",
      title: "最近的旁问",
      placeholder: "提一个只读旁问…",
      send: "提问",
      empty: "本会话还没有旁问。在下面提一个，或直接用 /btw <问题>。",
      close: "关闭",
      cost: "新增 {newTokens} · 命中缓存 {cachedTokens} · {ms}ms",
      failed: "读取旁问历史失败",
      sent: "已提交，答案会出现在对话里",
      followUp: "追问",
      collapse: "收起",
      followPlaceholder: "在这个线程里追问…",
      turns: "轮",
      promote: "转正",
      promoted: "已插入输入框草稿（未发送）",
      promoteBlocked: "输入框已有内容，先清空再转正",
      promoteFailed: "生成转正草稿失败",
      sending: "正在等待答案…（通常 20–40 秒）",
      sentPending: "命令已提交，答案稍后出现在对话里",
      expandAnswer: "展开全文",
      collapseAnswer: "收起",
      scopeAny: "范围：不限",
      scopeSession: "范围：整个会话",
      scopeRecent: "范围：最近几轮",
      scopeSelection: "范围：仅选中片段",
      sendFailed: "提交失败（输入框不可用）",
      "settings.nav": "旁问",
      "settings.title": "旁问（只读）",
      "settings.tools": "允许旁问使用的工具",
      "settings.toolsHint": "留空 = 完全只读（推荐）。多个工具用逗号分隔；send_message 永不放行。",
      "settings.limit": "每会话保留条数",
      "settings.more": "更多设置",
      "settings.save": "保存",
      "settings.saved": "已保存",
      "settings.failed": "保存失败",
      "settings.mode": "模式",
      "settings.readOnly": "只读",
    };
    const en = {
      button: "btw",
      title: "Recent side questions",
      placeholder: "Ask a read-only side question…",
      send: "Ask",
      empty: "No side question yet. Ask one below, or use /btw <question>.",
      close: "Close",
      cost: "new {newTokens} · cached {cachedTokens} · {ms}ms",
      failed: "Could not read side-question history",
      sent: "Submitted; the answer appears in the conversation",
      followUp: "Follow up",
      collapse: "Collapse",
      followPlaceholder: "Ask a follow-up in this thread…",
      turns: "turns",
      promote: "Promote",
      promoted: "Inserted into the composer as a draft (not sent)",
      promoteBlocked: "Composer already has content; clear it before promoting",
      promoteFailed: "Could not create the promotion draft",
      sending: "Waiting for the answer… (usually 20–40s)",
      sentPending: "Command submitted; the answer will appear in the conversation",
      expandAnswer: "Show all",
      collapseAnswer: "Collapse",
      scopeAny: "Scope: any",
      scopeSession: "Scope: whole session",
      scopeRecent: "Scope: recent turns",
      scopeSelection: "Scope: selection only",
      sendFailed: "Could not submit (composer unavailable)",
      "settings.nav": "Side questions",
      "settings.title": "Side questions (read-only)",
      "settings.tools": "Tools the side question may use",
      "settings.toolsHint":
        "Empty = fully read-only (recommended). Separate names with commas; send_message is never allowed.",
      "settings.limit": "Records kept per session",
      "settings.more": "More settings",
      "settings.save": "Save",
      "settings.saved": "Saved",
      "settings.failed": "Save failed",
      "settings.mode": "Mode",
      "settings.readOnly": "read-only",
    };

    const CSS = [
      ".dsh-btw-btn{height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;cursor:pointer;}",
      ".dsh-btw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-btw-btn:disabled{opacity:.5;cursor:default;}",
      ".dsh-btw-panel{position:absolute;left:0;right:0;bottom:100%;margin-bottom:6px;max-height:46vh;overflow:auto;z-index:30;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.55;box-shadow:0 12px 32px rgba(0,0,0,.28);}",
      ".dsh-btw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:600;}",
      ".dsh-btw-item{padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));}",
      ".dsh-btw-q{color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-btw-a{white-space:pre-wrap;word-break:break-word;margin-top:2px;}",
      ".dsh-btw-a.is-clamped{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;line-clamp:6;overflow:hidden;}",
      ".dsh-btw-meta{margin-top:2px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:11px;}",
      ".dsh-btw-dim{color:var(--dsw-alias-label-tertiary,GrayText);padding:6px 0;}",
      ".dsh-btw-err{color:var(--dsw-alias-state-error-primary,#d9534f);padding:6px 0;}",
      ".dsh-btw-row{display:flex;gap:6px;margin-top:8px;}",
      ".dsh-btw-status{position:sticky;top:-10px;z-index:2;display:flex;align-items:center;gap:6px;margin:0 0 8px;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;box-shadow:0 1px 0 var(--dsw-alias-border-l1,rgba(128,128,128,.2));}",
      ".dsh-btw-status.is-busy{color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-btw-spinner{display:inline-block;animation:dsh-btw-spin 1s linear infinite;}",
      "@keyframes dsh-btw-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
      ".dsh-btw-setrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0;}",
      ".dsh-btw-setlabel{min-width:0;color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-btw-input{flex:1 1 auto;min-width:0;resize:vertical;min-height:52px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:inherit;}",
    ].join("");

    /** @param {any} ctx @param {string} name */
    function serviceOf(ctx, name) {
      try {
        if (typeof ctx?.get === "function") return ctx.get(name);
      } catch {
        /* 服务未挂载 */
      }
      try {
        return ctx?.[name];
      } catch {
        return undefined;
      }
    }

    /** @param {string} template @param {Record<string, string|number>} values */
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (m, k) =>
        Object.hasOwn(values, k) ? String(values[k]) : m,
      );
    }

    exports.inject = ["slots", "locale", "connection", "sessions"];
    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "btw: dictionaries");
      /** @type {any} */
      let t;
      try {
        t = ctx.locale.bind(NS);
      } catch {
        t = (/** @type {string} */ key) => key;
      }

      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = PLUGIN_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "btw: styles");

      /** 当前界面语言（转正草稿用）。取不到默认 zh。 */
      const langOf = () => {
        try {
          const docLang = String(document?.documentElement?.lang ?? "").toLowerCase();
          if (docLang.startsWith("en")) return "en";
          if (docLang.startsWith("zh")) return "zh";
        } catch {
          /* 忽略 */
        }
        return "zh";
      };

      /** 最近一次 RPC 失败原因（诊断用，渲染进 data-btw-error）。 */
      let lastRpcError = "";

      /** Typert Remote 调用；解 { ok, value } 信封，失败返回 undefined。 */
      const callRemote = (/** @type {string} */ method, /** @type {any} */ request) => {
        const connection = serviceOf(ctx, "connection");
        const channel = connection?.rpc;
        if (!channel || typeof channel.call !== "function") return Promise.resolve(undefined);
        const payload = request === undefined ? { args: {} } : { args: { request } };
        try {
          return Promise.resolve(channel.call("/api", `btw/${method}`, payload)).then(
            (/** @type {any} */ result) => {
              if (result && typeof result === "object" && Object.hasOwn(result, "value")) {
                lastRpcError = "";
                return result.value;
              }
              lastRpcError = `no-value:${JSON.stringify(result).slice(0, 160)}`;
              return result;
            },
            (/** @type {any} */ error) => {
              lastRpcError = `reject:${String(error?.message ?? error).slice(0, 160)}`;
              return undefined;
            },
          );
        } catch (error) {
          lastRpcError = `throw:${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`;
          return Promise.resolve(undefined);
        }
      };

      /** 输入框 façade（与 next-step 同形：先 shell(sessionId)，再 for(scope)）。 */
      const shellOf = (/** @type {string} */ sessionId) => {
        if (!sessionId) return undefined;
        try {
          const conversation = serviceOf(ctx, "conversation");
          const input = conversation?.input;
          if (!input) return undefined;
          if (typeof input.shell === "function") {
            try {
              const shell = input.shell(sessionId);
              if (shell) return shell;
            } catch {
              /* 退到 for(scope) */
            }
          }
          if (typeof input.for === "function") {
            const sessions = serviceOf(ctx, "sessions");
            const scope =
              sessions && typeof sessions.scope === "function"
                ? sessions.scope(sessionId)
                : undefined;
            if (scope !== undefined) return input.for(scope);
          }
        } catch {
          return undefined;
        }
        return undefined;
      };

      /** @param {any} shell */
      const shellDraftOf = (shell) => {
        try {
          const state = shell?.state;
          const snapshot =
            state && typeof state.getSnapshot === "function" ? state.getSnapshot() : undefined;
          if (snapshot && typeof snapshot.draft === "string") return snapshot.draft;
        } catch {
          return undefined;
        }
        return undefined;
      };

      /**
       * 等 setDraft 落定。
       * @param {() => (string | undefined)} readDraft
       * @param {string} text
       * @returns {Promise<boolean>}
       */
      const waitDraftSettled = (readDraft, text) =>
        new Promise((resolve) => {
          let tries = 0;
          const tick = () => {
            let draft;
            try {
              draft = readDraft();
            } catch {
              draft = undefined;
            }
            if (draft === text) return resolve(true);
            tries += 1;
            if (tries >= DRAFT_POLL_TRIES) return resolve(false);
            setTimeout(tick, DRAFT_POLL_INTERVAL_MS);
          };
          tick();
        });

      /**
       * 把文本塞进 composer 并提交。绝不提交不是我们写的那段文本。
       * @param {string} sessionId
       * @param {string} text
       * @returns {Promise<'ok' | 'empty' | 'no-composer' | 'not-settled'>}
       */
      const sendText = async (sessionId, text) => {
        if (typeof text !== "string" || text === "") return "empty";
        const shell = shellOf(sessionId);
        const actions = shell?.actions;
        if (!actions || typeof actions.setDraft !== "function") return "no-composer";
        try {
          actions.setDraft(text);
        } catch {
          return "no-composer";
        }
        const settled = await waitDraftSettled(() => shellDraftOf(shell), text);
        if (!settled && shellDraftOf(shell) !== text) return "not-settled";
        try {
          if (typeof actions.submit === "function") actions.submit();
        } catch {
          return "not-settled";
        }
        return "ok";
      };

      /** 浮层：只读列表 + 浮层内发问。 */
      function BtwPanel(/** @type {any} */ props) {
        const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
        const [open, setOpen] = React.useState(false);
        const [threads, setThreads] = React.useState(/** @type {any[] | null} */ (null));
        const [failed, setFailed] = React.useState(false);
        const [activeId, setActiveId] = React.useState("");
        const [question, setQuestion] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const [badge, setBadge] = React.useState("");
        const [scope, setScope] = React.useState("");
        const [expandedAnswers, setExpandedAnswers] = React.useState(
          /** @type {Record<string, boolean>} */ ({}),
        );
        const aliveRef = React.useRef(true);

        React.useEffect(
          () => () => {
            aliveRef.current = false;
          },
          [],
        );

        const load = React.useCallback(
          () =>
            callRemote("threads", { sessionId, limit: LIMITS_CLIENT_THREADS }).then((value) => {
              if (!aliveRef.current) return 0;
              if (Array.isArray(/** @type {any} */ (value))) {
                setThreads(value);
                setFailed(false);
                return value.length;
              }
              setThreads([]);
              setFailed(true);
              return 0;
            }),
          [sessionId],
        );

        React.useEffect(() => {
          if (!open) return undefined;
          const scopeLabel =
            scope === ""
              ? ""
              : t(
                  scope === "session"
                    ? "scopeSession"
                    : scope === "recent"
                      ? "scopeRecent"
                      : "scopeSelection",
                ).replace(/^范围：|^Scope:\s*/i, "");
          callRemote("stats", { sessionId, scope: scopeLabel, lang: langOf() }).then((value) => {
            if (!aliveRef.current) return;
            if (value && typeof value.badge === "string") setBadge(value.badge);
          });
        }, [open, sessionId, scope]);

        React.useEffect(() => {
          if (!open) return undefined;
          void load();
          const onKey = (/** @type {any} */ event) => {
            if (event?.key === "Escape") setOpen(false);
          };
          document.addEventListener("keydown", onKey);
          return () => document.removeEventListener("keydown", onKey);
        }, [open, load]);

        /**
         * 发问：新线程走 `/btw <q>`；追问走 `/btw --thread <id> <q>`。
         *
         * 2026-11-17 修复（实测用户反馈「点了没反应、按钮永久卡死」）：
         *  1. 旧实现轮询 20×1.5s=30s，而真实 /btw 耗时 32–40s，永远等不到 → 改为按
         *     实际耗时给足窗口（REFRESH_MAX_MS），并保留「线程数增加即提前结束」。
         *  2. poll 的 `.then()` 没有 `.catch()`，一次 RPC 失败就断链，
         *     `setBusy(false)` 永不执行 → 改用 try/finally 兜底，任何路径都恢复按钮。
         */
        const submit = async (/** @type {string} */ threadId) => {
          const text = question.trim();
          if (text === "" || busy) return;
          setBusy(true);
          setNotice(t("sending"));
          const before = Array.isArray(threads) ? threads.length : 0;
          const flags = [
            threadId === "" ? "" : `--thread ${threadId}`,
            scope === "" ? "" : `--scope ${scope}`,
          ]
            .filter(Boolean)
            .join(" ");
          const line = flags === "" ? `/btw ${text}` : `/btw ${flags} ${text}`;
          try {
            const result = await sendText(sessionId, line);
            if (result !== "ok") {
              setNotice(t("sendFailed"));
              return;
            }
            setQuestion("");
            setNotice(t("sent"));
            // 轮询到「线程数增加」为止，最长 REFRESH_MAX_MS；单次失败不中断。
            const deadline = Date.now() + REFRESH_MAX_MS;
            let refreshed = false;
            while (Date.now() < deadline && aliveRef.current) {
              await new Promise((resolve) => setTimeout(resolve, REFRESH_INTERVAL_MS));
              if (!aliveRef.current) break;
              let count = before;
              try {
                count = await load();
              } catch {
                count = before; // 单次失败继续轮询，不静默卡死
              }
              if (count > before) {
                refreshed = true;
                break;
              }
            }
            setNotice(refreshed ? "" : t("sentPending"));
          } finally {
            // 无论如何都要放开按钮：卡死的按钮是实测最劝退的问题。
            if (aliveRef.current) setBusy(false);
          }
        };

        /**
         * 一键转正：取 host 生成的四节草稿，**只插进 composer，不发送**。
         * 输入框已有内容时拒绝，避免覆盖用户正在写的东西。
         */
        const promote = async (/** @type {any} */ thread) => {
          if (busy) return;
          setBusy(true);
          setNotice("");
          const shell = shellOf(sessionId);
          const actions = shell?.actions;
          if (!actions || typeof actions.setDraft !== "function") {
            setBusy(false);
            setNotice(t("sendFailed"));
            return;
          }
          const existing = shellDraftOf(shell);
          if (typeof existing === "string" && existing.trim() !== "") {
            setBusy(false);
            setNotice(t("promoteBlocked"));
            return;
          }
          const result = await callRemote("promote", {
            sessionId,
            recordId: String(thread?.lastId ?? ""),
            lang: langOf(),
          });
          if (result?.ok !== true || typeof result?.text !== "string") {
            setBusy(false);
            setNotice(t("promoteFailed"));
            return;
          }
          try {
            actions.setDraft(result.text);
          } catch {
            setBusy(false);
            setNotice(t("promoteFailed"));
            return;
          }
          setBusy(false);
          setNotice(t("promoted"));
        };

        const button = h(
          "button",
          {
            type: "button",
            className: "dsh-btw-btn",
            "data-btw-toggle": "true",
            title: t("button"),
            onClick: () => setOpen((/** @type {boolean} */ value) => !value),
          },
          t("button"),
        );

        if (!open) return h("span", { "data-btw-root": "true" }, button);

        const renderThread = (/** @type {any} */ thread, /** @type {number} */ index) => {
          const expanded = activeId === thread.threadId;
          return h(
            "div",
            {
              className: "dsh-btw-item",
              key: thread.threadId ?? String(index),
              "data-btw-thread": "true",
              "data-btw-thread-id": String(thread.threadId ?? ""),
            },
            h(
              "div",
              { className: "dsh-btw-q" },
              `/btw ${String(thread.question ?? "")}`,
              Number(thread.turns) > 1
                ? h(
                    "span",
                    { className: "dsh-btw-meta" },
                    ` · ${String(thread.turns)} ${t("turns")}`,
                  )
                : null,
            ),
            (() => {
              // 长答案默认折叠 6 行：实测一条 3000+ 字答案会把浮层撑满，
              // 用户只能看到答案中部、找不到成本与按钮。
              const answerText = String(thread.answer ?? "");
              const key = String(thread.threadId ?? "");
              const isOpen = expandedAnswers[key] === true;
              const needsClamp = answerText.length > 400;
              return h(
                React.Fragment,
                null,
                h(
                  "div",
                  {
                    className: `dsh-btw-a${needsClamp && !isOpen ? " is-clamped" : ""}`,
                    "data-btw-answer": "true",
                  },
                  answerText,
                ),
                needsClamp
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "dsh-btw-btn",
                        "data-btw-expand": "true",
                        onClick: () =>
                          setExpandedAnswers((/** @type {any} */ prev) => ({
                            ...prev,
                            [key]: !isOpen,
                          })),
                      },
                      isOpen ? t("collapseAnswer") : t("expandAnswer"),
                    )
                  : null,
              );
            })(),
            h(
              "div",
              { className: "dsh-btw-meta", "data-btw-meta": "true" },
              fmt(t("cost"), {
                newTokens: String(thread.cost?.inputTokens ?? 0),
                cachedTokens: String(thread.cost?.cacheReadTokens ?? 0),
                ms: String(thread.ms ?? 0),
              }),
            ),
            h(
              "div",
              { className: "dsh-btw-row" },
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-btw-btn",
                  "data-btw-followup": "true",
                  onClick: () => setActiveId(expanded ? "" : String(thread.threadId ?? "")),
                },
                expanded ? t("collapse") : t("followUp"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-btw-btn",
                  "data-btw-promote": "true",
                  disabled: busy,
                  onClick: () => void promote(thread),
                },
                t("promote"),
              ),
            ),
            expanded
              ? h(
                  "div",
                  { className: "dsh-btw-row", "data-btw-thread-input": "true" },
                  h("textarea", {
                    className: "dsh-btw-input",
                    "data-btw-input": "true",
                    placeholder: t("followPlaceholder"),
                    value: question,
                    rows: 2,
                    onChange: (/** @type {any} */ event) =>
                      setQuestion(String(event?.target?.value ?? "")),
                    onKeyDown: (/** @type {any} */ event) => {
                      if (event?.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submit(String(thread.threadId ?? ""));
                      }
                    },
                  }),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dsh-btw-btn",
                      "data-btw-send": "true",
                      disabled: busy || question.trim() === "",
                      onClick: () => void submit(String(thread.threadId ?? "")),
                    },
                    t("send"),
                  ),
                )
              : null,
          );
        };

        const body =
          threads === null
            ? h("div", { className: "dsh-btw-dim" }, "…")
            : threads.length === 0
              ? h("div", { className: "dsh-btw-dim", "data-btw-empty": "true" }, t("empty"))
              : threads.map(renderThread);

        return h(
          "span",
          { "data-btw-root": "true" },
          button,
          h(
            "div",
            { className: "dsh-btw-panel", "data-btw-overlay": "true", role: "dialog" },
            h(
              "div",
              { className: "dsh-btw-head" },
              h("span", null, t("title")),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-btw-btn",
                  "data-btw-close": "true",
                  onClick: () => setOpen(false),
                },
                t("close"),
              ),
            ),
            // 提示条固定在**头部正下方**：旧实现放在浮层最底部，列表一长就被推到
            // 滚动区外（实测浮层底 616px、提示在 918px），用户提交后完全看不到反馈。
            notice === "" && !busy
              ? null
              : h(
                  "div",
                  {
                    className: `dsh-btw-status${busy ? " is-busy" : ""}`,
                    "data-btw-notice": "true",
                  },
                  busy ? h("span", { className: "dsh-btw-spinner" }, "⟳") : null,
                  h("span", null, busy ? t("sending") : notice),
                ),
            failed
              ? h(
                  "div",
                  { className: "dsh-btw-err", "data-btw-error": "history_unavailable" },
                  `${t("failed")} — ${lastRpcError}`,
                )
              : body,
            h(
              "div",
              { className: "dsh-btw-row", "data-btw-newline": "true" },
              h("textarea", {
                className: "dsh-btw-input",
                "data-btw-input": "true",
                placeholder: t("placeholder"),
                value: activeId === "" ? question : "",
                rows: 2,
                onChange: (/** @type {any} */ event) =>
                  setQuestion(String(event?.target?.value ?? "")),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event?.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit("");
                  }
                },
              }),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-btw-btn",
                  "data-btw-send": "true",
                  disabled: busy || question.trim() === "",
                  onClick: () => void submit(""),
                },
                t("send"),
              ),
            ),
            h(
              "div",
              { className: "dsh-btw-row" },
              h(
                "select",
                {
                  className: "dsh-btw-input",
                  "data-btw-scope": "true",
                  value: scope,
                  onChange: (/** @type {any} */ event) =>
                    setScope(String(event?.target?.value ?? "")),
                },
                h("option", { value: "" }, t("scopeAny")),
                h("option", { value: "session" }, t("scopeSession")),
                h("option", { value: "recent" }, t("scopeRecent")),
                h("option", { value: "selection" }, t("scopeSelection")),
              ),
            ),
            badge === ""
              ? null
              : h("div", { className: "dsh-btw-meta", "data-btw-badge": "true" }, badge),
          ),
        );
      }

      /** 设置分节（约定 §7.2：首屏 ≤3 行、可直改、无改动时禁用保存）。 */
      function BtwSettings(/** @type {any} */ props) {
        const api = props?.api;
        const [loaded, setLoaded] = React.useState(/** @type {any} */ (null));
        const [tools, setTools] = React.useState("");
        const [limit, setLimit] = React.useState("");
        const [saving, setSaving] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const [expanded, setExpanded] = React.useState(false);

        const hydrate = React.useCallback((/** @type {any} */ value) => {
          if (!value || typeof value !== "object") return;
          setLoaded(value);
          setTools(Array.isArray(value.allowedTools) ? value.allowedTools.join(", ") : "");
          setLimit(String(value.historyLimit ?? ""));
        }, []);

        React.useEffect(() => {
          const call = api && typeof api.settings === "function" ? api.settings : undefined;
          if (!call) return;
          Promise.resolve(call()).then((value) => hydrate(value));
        }, [api, hydrate]);

        const dirty =
          loaded !== null &&
          (tools !== (loaded.allowedTools ?? []).join(", ") ||
            limit !== String(loaded.historyLimit ?? ""));

        const save = async () => {
          const call =
            api && typeof api.updateSettings === "function" ? api.updateSettings : undefined;
          if (!call || saving) return;
          setSaving(true);
          setNotice("");
          const next = await Promise.resolve(
            call({ allowedTools: tools, historyLimit: Number(limit) }),
          ).catch(() => undefined);
          setSaving(false);
          if (next && typeof next === "object") {
            hydrate(next);
            setNotice(t("settings.saved"));
          } else {
            setNotice(t("settings.failed"));
          }
        };

        const row = (
          /** @type {string} */ label,
          /** @type {any} */ control,
          /** @type {string} */ hint,
        ) =>
          h(
            "div",
            { className: "dsh-btw-setrow" },
            h("span", { className: "dsh-btw-setlabel" }, label),
            control,
            hint === "" ? null : h("div", { className: "dsh-btw-meta" }, hint),
          );

        return h(
          "div",
          { "data-btw-settings": "true" },
          h(
            "div",
            { className: "dsh-btw-setrow" },
            h("span", { className: "dsh-btw-setlabel" }, t("settings.mode")),
            h(
              "span",
              { className: "dsh-btw-a" },
              loaded === null
                ? "…"
                : loaded.readOnly
                  ? t("settings.readOnly")
                  : `${loaded.allowedTools.length}`,
            ),
          ),
          row(
            t("settings.tools"),
            h("input", {
              className: "dsh-btw-input",
              "data-btw-setting-tools": "true",
              value: tools,
              placeholder: "read, grep",
              onChange: (/** @type {any} */ event) => setTools(String(event?.target?.value ?? "")),
            }),
            "",
          ),
          h(
            "div",
            { className: "dsh-btw-setrow" },
            h(
              "button",
              {
                type: "button",
                className: "dsh-btw-btn",
                "data-btw-settings-more": "true",
                onClick: () => setExpanded((/** @type {boolean} */ value) => !value),
              },
              t("settings.more"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-btw-btn",
                "data-btw-settings-save": "true",
                disabled: !dirty || saving,
                onClick: () => void save(),
              },
              t("settings.save"),
            ),
            notice === "" ? null : notice,
          ),
          expanded
            ? h(
                "div",
                { "data-btw-settings-extra": "true" },
                row(
                  t("settings.limit"),
                  h("input", {
                    className: "dsh-btw-input",
                    "data-btw-setting-limit": "true",
                    value: limit,
                    onChange: (/** @type {any} */ event) =>
                      setLimit(String(event?.target?.value ?? "")),
                  }),
                  "",
                ),
                h("div", { className: "dsh-btw-meta" }, t("settings.toolsHint")),
              )
            : null,
        );
      }

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "btw",
            order: 94,
            label: () => t("settings.nav"),
            locale: NS,
            inject: () => ({
              api: {
                settings: () => callRemote("settings", undefined),
                updateSettings: (/** @type {any} */ patch) => callRemote("updateSettings", patch),
              },
            }),
          },
          (/** @type {any} */ slotProps) => h(BtwSettings, slotProps),
        ),
      );

      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          { name: "conversation.input.left", id: "btw-toggle", order: 40, locale: NS },
          (/** @type {any} */ props) => h(BtwPanel, props),
        ),
      );
    };

    return module.exports;
  },
});
