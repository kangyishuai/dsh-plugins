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
    /** 提交后轮询历史，等新记录出现。 */
    const REFRESH_TRIES = 20;
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
      ".dsh-btw-meta{margin-top:2px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:11px;}",
      ".dsh-btw-dim{color:var(--dsw-alias-label-tertiary,GrayText);padding:6px 0;}",
      ".dsh-btw-err{color:var(--dsw-alias-state-error-primary,#d9534f);padding:6px 0;}",
      ".dsh-btw-row{display:flex;gap:6px;margin-top:8px;}",
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
        const [items, setItems] = React.useState(/** @type {any[] | null} */ (null));
        const [failed, setFailed] = React.useState(false);
        const [question, setQuestion] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState("");
        const aliveRef = React.useRef(true);

        React.useEffect(
          () => () => {
            aliveRef.current = false;
          },
          [],
        );

        const load = React.useCallback(
          () =>
            callRemote("history", { sessionId, limit: 5 }).then((value) => {
              if (!aliveRef.current) return 0;
              if (Array.isArray(/** @type {any} */ (value))) {
                setItems(value.slice().reverse());
                setFailed(false);
                return value.length;
              }
              setItems([]);
              setFailed(true);
              return 0;
            }),
          [sessionId],
        );

        React.useEffect(() => {
          if (!open) return undefined;
          void load();
          const onKey = (/** @type {any} */ event) => {
            if (event?.key === "Escape") setOpen(false);
          };
          document.addEventListener("keydown", onKey);
          return () => document.removeEventListener("keydown", onKey);
        }, [open, load]);

        const submit = async () => {
          const text = question.trim();
          if (text === "" || busy) return;
          setBusy(true);
          setNotice("");
          const before = Array.isArray(items) ? items.length : 0;
          const line = `/btw ${text}`;
          const result = await sendText(sessionId, line);
          if (result !== "ok") {
            setBusy(false);
            setNotice(t("sendFailed"));
            return;
          }
          setQuestion("");
          setNotice(t("sent"));
          // 轮询历史，等新记录出现（命令走 fork，答案进 history）
          let tries = 0;
          const poll = () => {
            load().then((/** @type {number} */ count) => {
              if (!aliveRef.current) return;
              if (count > before) {
                setBusy(false);
                setNotice("");
                return;
              }
              tries += 1;
              if (tries >= REFRESH_TRIES) {
                setBusy(false);
                return;
              }
              setTimeout(poll, REFRESH_INTERVAL_MS);
            });
          };
          setTimeout(poll, REFRESH_INTERVAL_MS);
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

        const body =
          items === null
            ? h("div", { className: "dsh-btw-dim" }, "…")
            : items.length === 0
              ? h("div", { className: "dsh-btw-dim", "data-btw-empty": "true" }, t("empty"))
              : items.map((/** @type {any} */ item, /** @type {number} */ index) =>
                  h(
                    "div",
                    {
                      className: "dsh-btw-item",
                      key: item?.id ?? String(index),
                      "data-btw-item": "true",
                    },
                    h("div", { className: "dsh-btw-q" }, `/btw ${String(item?.question ?? "")}`),
                    h(
                      "div",
                      { className: "dsh-btw-a", "data-btw-answer": "true" },
                      String(item?.answer ?? ""),
                    ),
                    h(
                      "div",
                      { className: "dsh-btw-meta", "data-btw-meta": "true" },
                      fmt(t("cost"), {
                        newTokens: String(item?.cost?.inputTokens ?? 0),
                        cachedTokens: String(item?.cost?.cacheReadTokens ?? 0),
                        ms: String(item?.ms ?? 0),
                      }),
                    ),
                  ),
                );

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
            failed
              ? h(
                  "div",
                  { className: "dsh-btw-err", "data-btw-error": "history_unavailable" },
                  `${t("failed")} — ${lastRpcError}`,
                )
              : body,
            h(
              "div",
              { className: "dsh-btw-row" },
              h("textarea", {
                className: "dsh-btw-input",
                "data-btw-input": "true",
                placeholder: t("placeholder"),
                value: question,
                rows: 2,
                onChange: (/** @type {any} */ event) =>
                  setQuestion(String(event?.target?.value ?? "")),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event?.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
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
                  onClick: () => void submit(),
                },
                t("send"),
              ),
            ),
            notice === ""
              ? null
              : h("div", { className: "dsh-btw-dim", "data-btw-notice": "true" }, notice),
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
