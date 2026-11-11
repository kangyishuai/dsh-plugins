// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能使用 import / JSX。
// 功能：
// A. 装饰 `/advisor` 命令：popupSelect 列出「宿主已配置」的顾问候选（当前 / 各路由模型 / off / 去配置），
//    每次打开都重新走 advisor/candidates RPC，绝不跨次缓存路由或模型。
// B. 选中反馈：advisor/setModel 的结果（成功或结构化的失败原因）通过 shell.overlay 里右下角的
//    一行轻量提示显示，4 秒后自动消失；默认不渲染任何东西。
// C. 所有宿主调用都走 ctx.connection.rpc.call("/api", "advisor/<method>", { args: { request } })，
//    client 不直连 llm 服务。任何一路失败（服务缺失、RPC 抛错、返回畸形）都降级成一个引导选项，
//    options 永远 resolve 数组、onSelect 永不抛错。
// 参考：packages/session-rewind/lib/client.js（commandUi.decorate + popupSelect 样本）、
// packages/next-step/lib/client.js（callRemote 信封解包）、packages/session-delete/lib/client.js（toast）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-advisor",
  factory(require) {
    const module = { exports: /** @type {any} */ ({}) };
    const exports = module.exports;

    /** @type {any} */
    let React = require("react");
    let h = React.createElement;

    /** locale 命名空间：必须与 locale/*.json 顶层键、slot descriptor 的 locale 一致。 */
    let NS = "advisor";
    /** 插件标识：样式标签的归属，桌面端只读回归靠 style[data-plugin] 判断 client 半已加载。 */
    let PLUGIN_ID = "@kangyishuai/dsh-advisor";
    /** 轻量提示停留时间；到点后把自己清掉。 */
    let TOAST_MS = 4000;

    /** 简体中文字典（键集的事实来源）。 */
    /** @type {Record<string, string>} */
    let zh = {
      title: "让主模型在关键时刻咨询一个更强的顾问模型",
      "notReady.label": "顾问尚未就绪 · 打开 /advisor doctor",
      "notReady.detail": "宿主没有返回候选路由：插件可能未启用，或宿主 RPC 暂不可用",
      "group.current": "当前",
      "group.extras": "开关与配置",
      "current.detail": "本会话正在使用",
      "toast.current": "已经是当前顾问",
      "blocked.detail": "该路由当前不可用",
      "off.label": "不使用顾问（off）",
      "off.detail": "随时可用 /advisor 重新开启",
      "settings.label": "+ 添加或配置 provider…",
      "settings.detail": "打开 设置 → 模型",
      "settings.hint": "已把 /advisor doctor 放进输入框，回车查看下一步",
      "toast.settings": "请打开 设置 → 模型 添加或配置 provider",
      "search.placeholder": "搜索顾问模型…",
      "search.empty": "还没有可选的顾问模型",
      "search.noResults": "没有匹配的模型",
      "effort.auto": "自动",
      "toast.applied": "顾问已设为 {route}（思考档 {effort}），下一次徵询生效",
      "toast.off": "顾问已关闭，随时可用 /advisor 重新开启",
      "toast.stale": "这项选择已过期，请重新打开 /advisor",
      "error.failed": "设置失败，请重试",
      "error.unreachable": "连不上宿主，稍后重试或运行 /advisor doctor",
      "error.malformed": "宿主返回了无法识别的结果，运行 /advisor doctor 查看诊断",
    };

    /** 英文字典（键集必须与 zh 完全一致，locale/*.json 同步）。 */
    /** @type {Record<string, string>} */
    let en = {
      title: "Pair the main model with a stronger advisor model it can consult at key moments",
      "notReady.label": "Advisor is not ready · run /advisor doctor",
      "notReady.detail":
        "The host returned no candidate routes: the plugin may be disabled, or host RPC is unavailable",
      "group.current": "Current",
      "group.extras": "Toggle & configure",
      "current.detail": "In use in this session",
      "toast.current": "This is already the current advisor",
      "blocked.detail": "This route is unavailable right now",
      "off.label": "Turn the advisor off",
      "off.detail": "Reopen with /advisor at any time",
      "settings.label": "+ Add or configure a provider…",
      "settings.detail": "Open Settings → Models",
      "settings.hint": "Put /advisor doctor in the composer — press Enter to see the next step",
      "toast.settings": "Open Settings → Models to add or configure a provider",
      "search.placeholder": "Search advisor models…",
      "search.empty": "No advisor models are available yet",
      "search.noResults": "No matching models",
      "effort.auto": "auto",
      "toast.applied":
        "Advisor set to {route} (reasoning effort {effort}); effective on the next consultation",
      "toast.off": "Advisor turned off — reopen with /advisor at any time",
      "toast.stale": "This choice is stale — reopen /advisor",
      "error.failed": "Could not save the advisor; try again",
      "error.unreachable": "Cannot reach the host — try again later or run /advisor doctor",
      "error.malformed": "The host returned an unrecognized result — run /advisor doctor",
    };

    /** 提示条样式：只用宿主 CSS 变量，深浅色自动跟随；同时充当「client 半已加载」的标记。 */
    let CSS = [
      ".dsh-advisor-toast{position:fixed;right:24px;bottom:24px;z-index:2147000000;display:flex;align-items:flex-start;gap:10px;max-width:min(440px,86vw);padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));box-shadow:0 10px 30px rgba(0,0,0,.28);font-size:13px;line-height:1.5;cursor:pointer;transition:opacity .18s ease,transform .18s ease;}",
      ".dsh-advisor-toast-mark{font-weight:600;line-height:1.4;}",
      ".dsh-advisor-toast-text{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;}",
    ].join("\n");

    // ------------------------------------------------------------------
    // 纯函数（可被 node:vm 单测直接调用；挂在 __test 上）
    // ------------------------------------------------------------------

    /**
     * @param {any} value
     * @returns {string}
     */
    function asString(value) {
      return typeof value === "string" ? value : "";
    }

    /**
     * 从候选 id 里解析路由：`provider/model[#effort]`。
     * provider 按第一段 `/` 切分，model 允许再包含 `/`；`#effort` 是可选后缀。
     * @param {any} id
     * @returns {{ provider: string, model: string, reasoningEffort: string } | null}
     */
    function parseRouteId(id) {
      let text = asString(id).trim();
      if (text === "") return null;
      let body = text;
      let effort = "";
      let hash = body.lastIndexOf("#");
      if (hash > 0) {
        effort = body.slice(hash + 1).trim();
        body = body.slice(0, hash);
      }
      let slash = body.indexOf("/");
      if (slash <= 0 || slash === body.length - 1) return null;
      let provider = body.slice(0, slash).trim();
      let model = body.slice(slash + 1).trim();
      if (provider === "" || model === "") return null;
      return { provider: provider, model: model, reasoningEffort: effort };
    }

    /**
     * 候选行的路由：宿主直接给 provider/model/reasoningEffort 时优先用它，否则解析 id。
     * @param {any} item
     * @returns {{ provider: string, model: string, reasoningEffort: string } | null}
     */
    function routeOfItem(item) {
      if (!item || typeof item !== "object") return null;
      let provider = asString(item.provider).trim();
      let model = asString(item.model).trim();
      if (provider !== "" && model !== "") {
        let rawEffort = item.reasoningEffort !== undefined ? item.reasoningEffort : item.effort;
        return { provider: provider, model: model, reasoningEffort: asString(rawEffort).trim() };
      }
      return parseRouteId(item.id);
    }

    /**
     * @param {any} item
     * @returns {{ id: string, label: string, detail: string, reason: string, disabled: boolean, route: any } | null}
     */
    function normalizeItem(item) {
      if (!item || typeof item !== "object") return null;
      let id = asString(item.id).trim();
      if (id === "") return null;
      let label = asString(item.label).trim();
      return {
        id: id,
        label: label === "" ? id : label,
        detail: asString(item.detail).trim(),
        reason: asString(item.reason).trim(),
        disabled: item.disabled === true,
        route: routeOfItem(item),
      };
    }

    /**
     * @param {any} extra
     * @returns {{ id: "off" | "settings", label: string, detail: string } | null}
     */
    function normalizeExtra(extra) {
      if (!extra || typeof extra !== "object") return null;
      let id = asString(extra.id).trim();
      if (id !== "off" && id !== "settings") return null;
      return { id: id, label: asString(extra.label).trim(), detail: asString(extra.detail).trim() };
    }

    /**
     * @param {any} current
     * @returns {{ id: string, label: string, detail: string, route: any } | null}
     */
    function normalizeCurrent(current) {
      if (!current || typeof current !== "object") return null;
      let id = asString(current.id).trim();
      let label = asString(current.label).trim();
      if (id === "" && label === "") return null;
      return {
        id: id === "" ? label : id,
        label: label === "" ? id : label,
        detail: asString(current.detail).trim(),
        route: routeOfItem(current),
      };
    }

    /**
     * 把宿主 `advisor/candidates` 的返回整理成结构化数据；畸形返回一律 null（调用方降级）。
     * @param {any} raw
     * @returns {{ groups: { label: string, items: any[] }[], extras: any[], current: any } | null}
     */
    function normalizeCandidates(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok === false && raw.groups === undefined && raw.extras === undefined) return null;
      let groups = [];
      let sourceGroups = Array.isArray(raw.groups) ? raw.groups : [];
      for (let index = 0; index < sourceGroups.length; index += 1) {
        let group = sourceGroups[index];
        if (!group || typeof group !== "object") continue;
        let items = [];
        let sourceItems = Array.isArray(group.items) ? group.items : [];
        for (let j = 0; j < sourceItems.length; j += 1) {
          let normalized = normalizeItem(sourceItems[j]);
          if (normalized !== null) items.push(normalized);
        }
        groups.push({ label: asString(group.label).trim(), items: items });
      }
      let extras = [];
      let sourceExtras = Array.isArray(raw.extras) ? raw.extras : [];
      for (let k = 0; k < sourceExtras.length; k += 1) {
        let extra = normalizeExtra(sourceExtras[k]);
        if (extra !== null) extras.push(extra);
      }
      return { groups: groups, extras: extras, current: normalizeCurrent(raw.current) };
    }

    /**
     * 解 Typert 的 `{ ok, value }` 信封；没有 value 字段时按原样返回（可能是宿主直接给的结果）。
     * @param {any} result
     * @returns {any}
     */
    function unwrapEnvelope(result) {
      if (result === null || typeof result !== "object") return result;
      if (Object.hasOwn(result, "value")) return result.value;
      return result;
    }

    /**
     * 网关失败是 `{ ok:false, error:{ code, message } }`（普通 resolve，不是 reject），
     * 与业务失败（`{ ok:false, code, message }`）要分开处理。
     * @param {any} value
     * @returns {boolean}
     */
    function isRpcFailure(value) {
      return Boolean(
        value &&
          typeof value === "object" &&
          value.ok === false &&
          value.error &&
          typeof value.error === "object",
      );
    }

    /**
     * 把 `advisor/setModel` 的返回翻成人话；永远返回结构化结论。
     * @param {any} result
     * @param {(key: string) => string} translate
     * @returns {{ ok: boolean, message: string, route: any }}
     */
    function interpretSetModel(result, translate) {
      if (result === undefined || result === null) {
        return { ok: false, message: translate("error.unreachable"), route: null };
      }
      if (typeof result !== "object") {
        return { ok: false, message: translate("error.malformed"), route: null };
      }
      if (result.ok === true) {
        return {
          ok: true,
          message: "",
          route: result.route && typeof result.route === "object" ? result.route : null,
        };
      }
      let code = asString(result.code).trim();
      if (code === "" && result.error && typeof result.error === "object") {
        code = asString(result.error.code).trim();
      }
      // 网关层的参数/签名问题对用户是噪音：只留「哪里去看诊断」。
      if (code.startsWith("gateway/") || code === "remote-access/denied") {
        return { ok: false, message: translate("error.malformed"), route: null };
      }
      let message = asString(result.message).trim();
      if (message === "" && result.error && typeof result.error === "object") {
        message = asString(result.error.message).trim();
      }
      if (message === "") message = translate("error.failed");
      return { ok: false, message: message, route: null };
    }

    /**
     * 极简 store：组件用 useSyncExternalStore 订阅，写入方直接 set。
     * @param {any} initial
     * @returns {any}
     */
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

    // ------------------------------------------------------------------
    // toast 组件（属于 shell.overlay；没有提示时返回 null）
    // ------------------------------------------------------------------

    /** @param {any} props */
    function AdvisorToast(props) {
      let toast = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
      let entryId = toast ? toast.id : null;
      let shownState = React.useState(false);
      let shown = shownState[0];
      let setShown = shownState[1];

      React.useEffect(() => {
        if (entryId === null) {
          setShown(false);
          return undefined;
        }
        let raise = setTimeout(() => {
          setShown(true);
        }, 10);
        let timer = setTimeout(() => {
          props.store.set(null);
        }, TOAST_MS);
        return () => {
          clearTimeout(raise);
          clearTimeout(timer);
        };
      }, [entryId, props.store]);

      if (!toast) return null;
      let tone = toast.tone === "error" ? "error" : toast.tone === "ok" ? "ok" : "info";
      let color =
        tone === "error"
          ? "var(--dsw-alias-state-error-primary,#d9534f)"
          : tone === "ok"
            ? "var(--dsw-alias-state-success-primary,#2f9e63)"
            : "var(--dsw-alias-label-secondary,GrayText)";
      return h(
        "div",
        {
          className: "dsh-advisor-toast",
          role: "status",
          "data-tone": tone,
          title: asString(toast.message),
          onClick: () => {
            props.store.set(null);
          },
          style: {
            borderLeft: `3px solid ${color}`,
            opacity: shown ? 1 : 0,
            transform: shown ? "translateY(0)" : "translateY(8px)",
          },
        },
        h(
          "span",
          { className: "dsh-advisor-toast-mark", style: { color: color } },
          tone === "error" ? "!" : tone === "ok" ? "✓" : "i",
        ),
        h("span", { className: "dsh-advisor-toast-text" }, asString(toast.message)),
      );
    }

    exports.inject = ["slots", "locale", "connection"];

    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "advisor: dictionaries");

      /** @type {any} */
      let t;
      try {
        t = ctx.locale.bind(NS);
      } catch (_error) {
        t = function fallbackT(/** @type {string} */ key) {
          return key;
        };
      }

      // 注入样式；判重让 HMR / 重复挂载不会插第二份。
      ctx.effect(() => {
        if (typeof document === "undefined" || !document.head) return undefined;
        let selector = `style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`;
        if (document.querySelector(selector) !== null) return undefined;
        let tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, "advisor: styles");

      let toastStore = createStore(null);
      let toastSeq = 0;

      /**
       * @param {string} message
       * @param {"ok" | "error" | "info"} [tone]
       */
      function showToast(message, tone) {
        let text = asString(message).trim();
        if (text === "") return;
        toastSeq += 1;
        toastStore.set({
          id: toastSeq,
          message: text,
          tone: tone === "error" || tone === "ok" ? tone : "info",
        });
      }

      /**
       * 取宿主服务（可能缺席，绝不抛）。
       * @param {string} name
       * @returns {any}
       */
      function serviceOf(name) {
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
      }

      /**
       * Typert Remote 调用：统一解 `{ ok, value }` 信封，失败返回 undefined（调用方决定降级）。
       * @param {string} method
       * @param {any} [request]
       * @returns {Promise<any>}
       */
      function callRemote(method, request) {
        return new Promise((resolve) => {
          let channel;
          try {
            let connection = serviceOf("connection");
            channel = connection ? connection.rpc : undefined;
          } catch (_error) {
            channel = undefined;
          }
          if (!channel || typeof channel.call !== "function") {
            resolve(undefined);
            return;
          }
          try {
            let payload = request === undefined ? { args: {} } : { args: { request: request } };
            Promise.resolve(channel.call("/api", `advisor/${method}`, payload)).then(
              (result) => {
                resolve(unwrapEnvelope(result));
              },
              () => {
                resolve(undefined);
              },
            );
          } catch (_error) {
            resolve(undefined);
          }
        });
      }

      /** 本次打开选择器的候选行缓存：id → 行（用于 onSelect 拿回 route/reason）。 */
      /** @type {Map<string, any>} */
      let lastRows = new Map();

      /** 「顾问尚未就绪」引导项：RPC 缺失/畸形/空目录时的唯一降级出口。 */
      function notReadyOption() {
        return {
          id: "advisor:not-ready",
          label: t("notReady.label"),
          detail: t("notReady.detail"),
          kind: "not-ready",
          reason: "",
          route: null,
        };
      }

      /**
       * 把 RPC 数据摊平成宿主 popupSelect 需要的行；空 / 畸形时退回引导项。
       * @param {any} raw
       * @returns {any[]}
       */
      function buildOptions(raw) {
        let data = normalizeCandidates(raw);
        /** @type {any[]} */
        let rows = [];
        /** @type {Set<string>} */
        let seen = new Set();
        /** @param {any} row */
        let push = (row) => {
          if (!row || typeof row.id !== "string" || row.id === "" || seen.has(row.id)) return;
          seen.add(row.id);
          rows.push(row);
        };

        if (data !== null && data.current !== null) {
          push({
            id: `current:${data.current.id}`,
            label: data.current.label,
            detail: data.current.detail || t("current.detail"),
            group: { name: "current", label: t("group.current") },
            active: true,
            kind: "current",
            reason: "",
            route: data.current.route,
          });
        }

        if (data !== null) {
          for (let index = 0; index < data.groups.length; index += 1) {
            let group = data.groups[index];
            let groupField =
              group.label === "" ? undefined : { name: `group:${index}`, label: group.label };
            for (let j = 0; j < group.items.length; j += 1) {
              let item = group.items[j];
              let blocked = item.disabled === true;
              push({
                id: `model:${item.id}`,
                label: blocked ? `${item.label} ⚠` : item.label,
                detail: blocked ? item.reason || item.detail || t("blocked.detail") : item.detail,
                group: groupField,
                kind: blocked ? "blocked" : "model",
                reason: item.reason,
                route: item.route,
                disabled: blocked,
              });
            }
          }
          for (let k = 0; k < data.extras.length; k += 1) {
            let extra = data.extras[k];
            if (extra.id === "off") {
              push({
                id: "off",
                label: extra.label || t("off.label"),
                detail: extra.detail || t("off.detail"),
                group: { name: "extras", label: t("group.extras") },
                kind: "off",
                reason: "",
                route: null,
              });
            } else {
              push({
                id: "settings",
                label: extra.label || t("settings.label"),
                detail: extra.detail || t("settings.detail"),
                group: { name: "extras", label: t("group.extras") },
                kind: "settings",
                reason: "",
                route: null,
              });
            }
          }
        }

        let hasChoice = rows.some((row) => row.kind === "model" || row.kind === "current");
        if (!hasChoice) return [notReadyOption()].concat(rows);
        return rows;
      }

      /**
       * 取候选列表。宿主的 SRC 派发按方法参数名做严格校验：宿主方法没有声明参数时
       * 传 `request` 会被判 "unexpected request"；声明了 `request` 时又必须传。
       * 两种形状都兼容：先按无参数调用，失败再带空 request 重试一次。
       * @returns {Promise<any>}
       */
      async function fetchCandidates() {
        let raw = await callRemote("candidates", undefined);
        if (raw === undefined || isRpcFailure(raw)) raw = await callRemote("candidates", {});
        return raw;
      }

      /**
       * 每次打开选择器都重新 RPC（宿主的路由/模型随时可能被用户改），绝不跨次缓存。
       * @returns {Promise<any[]>}
       */
      async function optionsFor() {
        /** @type {any[]} */
        let rows;
        try {
          let raw = await fetchCandidates();
          rows = buildOptions(raw);
        } catch (_error) {
          rows = [notReadyOption()];
        }
        if (!Array.isArray(rows) || rows.length === 0) rows = [notReadyOption()];
        lastRows = new Map();
        for (let index = 0; index < rows.length; index += 1) {
          lastRows.set(rows[index].id, rows[index]);
        }
        return rows;
      }

      /**
       * 尽力把 `/advisor doctor` 写进会话输入框草稿；拿不到输入框就返回 false（绝不报错）。
       * @param {any} sessionId
       * @param {string} text
       * @returns {boolean}
       */
      function writeDraft(sessionId, text) {
        try {
          if (typeof sessionId !== "string" || sessionId === "") return false;
          let conversation = serviceOf("conversation");
          let input = conversation ? conversation.input : undefined;
          if (!input) return false;
          /** @type {any} */
          let facade;
          if (typeof input.shell === "function") {
            try {
              facade = input.shell(sessionId);
            } catch (_error) {
              facade = undefined;
            }
          }
          if (!facade && typeof input.for === "function") {
            let sessions = serviceOf("sessions");
            let scope =
              sessions && typeof sessions.scope === "function"
                ? sessions.scope(sessionId)
                : undefined;
            if (scope !== undefined) facade = input.for(scope);
          }
          if (!facade) return false;
          let actions =
            facade.actions && typeof facade.actions === "object" ? facade.actions : facade;
          if (typeof actions.setDraft !== "function") return false;
          actions.setDraft(text);
          return true;
        } catch (_error) {
          return false;
        }
      }

      /**
       * 「去配置」的降级路径：0.2.2 的设置面板是 slot 壳，宿主没有向业务包暴露「打开设置页」
       * 的客户端导航 API，所以退化成把 /advisor doctor 塞进输入框草稿（拿不到输入框就只提示）。
       * @param {any} sessionId
       */
      function openSettingsBestEffort(sessionId) {
        if (writeDraft(sessionId, "/advisor doctor")) {
          showToast(t("settings.hint"), "info");
          return;
        }
        showToast(t("toast.settings"), "info");
      }

      /**
       * 选中回调：成功/失败都必须有反馈；永不抛错（宿主会把它当命令失败弹错误）。
       * @param {any} option
       * @param {any} session
       */
      async function onSelect(option, session) {
        try {
          let sessionId = session && typeof session.sessionId === "string" ? session.sessionId : "";
          let optionId = option && typeof option.id === "string" ? option.id : "";
          let row = optionId === "" ? null : lastRows.get(optionId);
          if (!row && option && typeof option === "object") row = option;
          if (!row) {
            showToast(t("toast.stale"), "error");
            return;
          }

          if (row.kind === "current") {
            showToast(t("toast.current"), "info");
            return;
          }
          if (row.kind === "blocked") {
            showToast(row.reason || t("blocked.detail"), "error");
            return;
          }
          if (row.kind === "not-ready") {
            openSettingsBestEffort(sessionId);
            return;
          }
          if (row.kind === "settings") {
            openSettingsBestEffort(sessionId);
            return;
          }
          if (row.kind === "off") {
            let result = await callRemote("setModel", {
              provider: "",
              model: "",
              reasoningEffort: "",
            });
            let outcome = interpretSetModel(result, t);
            showToast(outcome.ok ? t("toast.off") : outcome.message, outcome.ok ? "info" : "error");
            return;
          }

          let route = row.route || parseRouteId(row.id);
          if (!route || route.provider === "" || route.model === "") {
            showToast(t("toast.stale"), "error");
            return;
          }
          let request = {
            provider: route.provider,
            model: route.model,
            reasoningEffort: asString(route.reasoningEffort),
          };
          let applied = await callRemote("setModel", request);
          let outcome = interpretSetModel(applied, t);
          if (!outcome.ok) {
            showToast(outcome.message, "error");
            return;
          }
          let appliedRoute = outcome.route || request;
          let provider = asString(appliedRoute.provider) || request.provider;
          let model = asString(appliedRoute.model) || request.model;
          let rawEffort =
            appliedRoute.reasoningEffort !== undefined
              ? appliedRoute.reasoningEffort
              : appliedRoute.effort;
          let effort = asString(rawEffort) || request.reasoningEffort;
          showToast(
            t("toast.applied")
              .replace("{route}", `${provider}/${model}`)
              .replace("{effort}", effort === "" ? t("effort.auto") : effort),
            "ok",
          );
        } catch (_error) {
          showToast(t("error.failed"), "error");
        }
      }

      // ------------------------------------------------------------------
      // 注册：toast（shell.overlay）+ `/advisor` 命令装饰（popupSelect）
      // ------------------------------------------------------------------

      // shell.overlay 是常驻浮层：默认渲染 null，只有 showToast 之后才出现一行提示。
      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              { name: "shell.overlay", id: "advisor", order: 860, locale: NS },
              function AdvisorOverlay(/** @type {any} */ props) {
                return h(AdvisorToast, Object.assign({}, props, { store: toastStore }));
              },
            ),
          ),
        "advisor: overlay toast",
      );

      /**
       * 装饰 `/advisor`：宿主 popupSelect 打开模型选择器。
       * 必须等 commandUi 服务就绪（它不一定在 apply 时已挂载），否则装饰会被静默跳过。
       * @param {any} scope
       * @param {any} commandUi
       */
      function installCommandDecoration(scope, commandUi) {
        scope.effect(
          () =>
            commandUi.decorate({
              name: "advisor",
              // 缺了 available，不同宿主的菜单/回车路径会直接跳过装饰（表现为回车没反应）。
              available: (/** @type {any} */ session) =>
                Boolean(session && typeof session.sessionId === "string"),
              ui: {
                kind: "popupSelect",
                searchMode: "substring",
                searchLabels: () => ({
                  placeholder: t("search.placeholder"),
                  empty: t("search.empty"),
                  noResults: t("search.noResults"),
                }),
                options: () => optionsFor(),
                onSelect: (/** @type {any} */ option, /** @type {any} */ session) =>
                  onSelect(option, session),
              },
            }),
          "advisor: command decoration",
        );
      }

      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["commandUi"], (/** @type {any} */ scope) => {
            let commandUi =
              (scope ? scope.commandUi : undefined) ||
              (scope && typeof scope.get === "function" ? scope.get("commandUi") : undefined) ||
              serviceOf("commandUi");
            if (commandUi && typeof commandUi.decorate === "function") {
              installCommandDecoration(scope || ctx, commandUi);
            }
          });
        } else {
          let commandUi = serviceOf("commandUi");
          if (commandUi && typeof commandUi.decorate === "function") {
            installCommandDecoration(ctx, commandUi);
          }
        }
      } catch (_error) {
        /* commandUi 缺失：不装饰；宿主命令本身仍然可用 */
      }
    };

    // 供 node:vm 单测读取的纯函数出口（非枚举，不影响运行时）。
    Object.defineProperty(exports, "__test", {
      value: Object.freeze({
        parseRouteId: parseRouteId,
        normalizeCandidates: normalizeCandidates,
        interpretSetModel: interpretSetModel,
      }),
    });

    return module.exports;
  },
});
