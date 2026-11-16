// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能 import / JSX。
// 职责（v0.2a 只读）：在输入框上方浮层里列出本会话最近的旁问与成本徽章。
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

    const zh = {
      button: "旁问",
      title: "最近的旁问",
      empty: "本会话还没有旁问。用 /btw <问题> 提一个。",
      close: "关闭",
      cost: "新增 {newTokens} · 命中缓存 {cachedTokens} · {ms}ms",
      failed: "读取旁问历史失败",
    };
    const en = {
      button: "btw",
      title: "Recent side questions",
      empty: "No side question yet. Ask one with /btw <question>.",
      close: "Close",
      cost: "new {newTokens} · cached {cachedTokens} · {ms}ms",
      failed: "Could not read side-question history",
    };

    const CSS = [
      ".dsh-btw-btn{height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;cursor:pointer;}",
      ".dsh-btw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,CanvasText);}",
      ".dsh-btw-panel{position:absolute;left:0;right:0;bottom:100%;margin-bottom:6px;max-height:40vh;overflow:auto;z-index:30;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.55;box-shadow:0 12px 32px rgba(0,0,0,.28);}",
      ".dsh-btw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-weight:600;}",
      ".dsh-btw-item{padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));}",
      ".dsh-btw-q{color:var(--dsw-alias-label-secondary,GrayText);}",
      ".dsh-btw-a{white-space:pre-wrap;word-break:break-word;margin-top:2px;}",
      ".dsh-btw-meta{margin-top:2px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:11px;}",
      ".dsh-btw-dim{color:var(--dsw-alias-label-tertiary,GrayText);padding:6px 0;}",
      ".dsh-btw-err{color:var(--dsw-alias-state-error-primary,#d9534f);padding:6px 0;}",
    ].join("");

    /** 与 next-step 同形的服务定位器。 @param {any} ctx @param {string} name */
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

    exports.inject = ["slots", "locale", "connection"];
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

      /** Typert Remote 调用；统一解 { ok, value } 信封，失败返回 undefined。 */
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
              lastRpcError = `no-value:${JSON.stringify(result).slice(0, 120)}`;
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

      /** 浮层：只读列出最近旁问。 */
      function BtwPanel(/** @type {any} */ props) {
        const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
        const [open, setOpen] = React.useState(false);
        const [items, setItems] = React.useState(/** @type {any[] | null} */ (null));
        const [failed, setFailed] = React.useState(false);

        React.useEffect(() => {
          if (!open) return undefined;
          let alive = true;
          callRemote("history", { sessionId, limit: 5 }).then((value) => {
            if (!alive) return;
            if (Array.isArray(/** @type {any} */ (value))) {
              setItems(value.slice().reverse());
              setFailed(false);
            } else {
              setItems([]);
              setFailed(true);
            }
          });
          return () => {
            alive = false;
          };
        }, [open, sessionId]);

        React.useEffect(() => {
          if (!open) return undefined;
          const onKey = (/** @type {any} */ event) => {
            if (event?.key === "Escape") setOpen(false);
          };
          document.addEventListener("keydown", onKey);
          return () => document.removeEventListener("keydown", onKey);
        }, [open]);

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
          ),
        );
      }

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
