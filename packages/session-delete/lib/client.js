// @ts-check
// client 半：classic script，以 __ModuleLoader__.load 注册 factory，不能使用 import。
// 注册：会话「…」菜单两项 + shell.overlay 里的确认框、回收站面板、toast（一次注册，三个浮层）。
// 宿主调用走 ctx.connection.rpc.call("/api", ...) —— 无构建插件没有 typert 生成的客户端产物，
// 因此不能用 ctx.reflect.get("remote.xxx")（见 docs/runtime/0.2.1-rc.5.md §6.10）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-session-delete",
  factory(require) {
    var module = { exports: /** @type {any} */ ({}) };
    var exports = module.exports;

    /** @type {any} */
    var React = require("react");
    var h = React.createElement;

    /** 官方 UI 原语：优先用它们以获得主题与动效，缺失时回退到自绘。 */
    /** @type {any} */
    var primitives = {};
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
    } catch (_error) {
      primitives = {};
    }
    var MenuItemButton = primitives.MenuItemButton;
    var Modal = primitives.Modal;
    var IconTrash = primitives.IconTrashOutlineRegular;

    /** 设计变量（宿主主题 token）：深色/浅色自动跟随。 */
    var T = {
      bg: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, Canvas))",
      bgBase: "var(--dsw-alias-bg-base, Canvas)",
      text: "var(--dsw-alias-label-primary, CanvasText)",
      dim: "var(--dsw-alias-label-secondary, GrayText)",
      faint: "var(--dsw-alias-label-tertiary, GrayText)",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
      danger: "var(--dsw-alias-state-error-primary, #d9534f)",
      mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))",
      toastBg: "var(--dsw-alias-toast-bg, Canvas)",
      toastText: "var(--dsw-alias-toast-label, CanvasText)",
      radius: "10px",
    };

    /** locale 命名空间；必须与 locale/*.json 顶层键一致。 */
    var NS = "sessionDelete";

    /** 简体中文词典（键集的事实来源）。 */
    var zh = {
      "menu.delete": "删除会话…",
      "menu.trash": "回收站…",
      "footer.trash": "回收站",
      "confirm.title": "删除这个会话？",
      "confirm.loading": "正在读取影响面…",
      "confirm.desc": "会话会被移入本机回收站，可以恢复。",
      "confirm.size": "会话日志约 {size}",
      "confirm.live": "该会话仍在本机打开，删除前会先停止它的工作。",
      "confirm.children": "会一并带上 {n} 个子代理会话",
      "confirm.cascade": "同时删除这 {n} 个子会话（各自进入回收站，需分别恢复）",
      "confirm.refs": "将清理：{list}",
      "confirm.trashPath": "回收站位置：{path}",
      "confirm.blocked": "暂时无法删除：{reason}",
      "confirm.cancel": "取消",
      "confirm.confirm": "移入回收站",
      "confirm.pending": "正在移入回收站…",
      "confirm.done": "已移入回收站",
      "confirm.undo": "撤销",
      "confirm.failed": "删除失败",
      "panel.title": "会话回收站",
      "panel.tabTrash": "回收站",
      "panel.tabAudit": "审计",
      "panel.tabHealth": "体检",
      "panel.tabReceipts": "回执",
      "trash.selectAll": "全选",
      "trash.clear": "清空",
      "trash.restoreMany": "批量恢复（{n}）",
      "trash.purgeMany": "批量彻底删除（{n}）",
      "trash.purgeManyConfirm": "确认彻底删除 {n} 个？不可恢复",
      "batch.done": "完成：{ok}/{total} 成功",
      "receipts.empty": "还没有操作回执。",
      "receipts.restored": "已移回原位置",
      "health.loading": "正在检查…",
      "health.inventory":
        "已存 {stored} · live {live} · 归档 {archived} · 回收站 {trash} · 待处理 {pending}",
      "health.ok": "未发现失效引用。",
      "health.items": "{n} 条",
      "health.agentTool": "模型工具 session_delete：{state}",
      "health.agentToolOn": "已注册",
      "health.agentToolOff": "未注册（宿主未提供 tools 运行时）",
      "health.unavailable": "无法体检：{reason}",
      "health.clean": "清理失效引用（{n}）",
      "health.cleanConfirm": "确认清理 {n} 条？只动登记表，不碰会话文件",
      "health.cleanDone": "已清理 {n} 条",
      "panel.empty": "回收站是空的。",
      "panel.auditEmpty": "还没有审计记录。",
      "panel.restore": "恢复",
      "panel.purge": "彻底删除",
      "panel.purgeConfirm": "彻底删除？不可恢复",
      "panel.size": "占用 {size}",
      "panel.trashedAt": "删除于 {time}",
      "panel.unknown": "{n} 个无法识别的目录已保留",
      "panel.pending": "{n} 个未完成的操作",
      "panel.readOnly": "只读模式：当前 DSH 版本缺少依赖接口，删除功能已禁用。",
      "panel.close": "关闭",
      "toast.failed": "操作失败：{message}",
    };

    /** English dictionary（键集与 zh 完全一致）。 */
    var en = {
      "menu.delete": "Delete session…",
      "menu.trash": "Trash…",
      "footer.trash": "Trash",
      "confirm.title": "Delete this session?",
      "confirm.loading": "Reading what will be removed…",
      "confirm.desc": "The session moves to the local trash and can be restored.",
      "confirm.size": "Session log is about {size}",
      "confirm.live": "This session is still open; its work is stopped first.",
      "confirm.children": "{n} subagent session(s) come along",
      "confirm.cascade": "Also delete these {n} child session(s) (each goes to trash separately)",
      "confirm.refs": "Will clean: {list}",
      "confirm.trashPath": "Trash location: {path}",
      "confirm.blocked": "Cannot delete right now: {reason}",
      "confirm.cancel": "Cancel",
      "confirm.confirm": "Move to trash",
      "confirm.pending": "Moving to trash…",
      "confirm.done": "Moved to trash",
      "confirm.undo": "Undo",
      "confirm.failed": "Deletion failed",
      "panel.title": "Session trash",
      "panel.tabTrash": "Trash",
      "panel.tabAudit": "Audit",
      "panel.tabHealth": "Health",
      "panel.tabReceipts": "Receipts",
      "trash.selectAll": "Select all",
      "trash.clear": "Clear",
      "trash.restoreMany": "Restore {n}",
      "trash.purgeMany": "Delete {n} permanently",
      "trash.purgeManyConfirm": "Permanently delete {n}? This cannot be undone",
      "batch.done": "Done: {ok}/{total} succeeded",
      "receipts.empty": "No operation receipts yet.",
      "receipts.restored": "restored",
      "health.loading": "Checking…",
      "health.inventory":
        "stored {stored} · live {live} · archived {archived} · trash {trash} · pending {pending}",
      "health.ok": "No dangling references found.",
      "health.items": "{n} item(s)",
      "health.agentTool": "Agent tool session_delete: {state}",
      "health.agentToolOn": "registered",
      "health.agentToolOff": "not registered (host has no tools runtime)",
      "health.unavailable": "Cannot run the check: {reason}",
      "health.clean": "Clean dangling references ({n})",
      "health.cleanConfirm": "Clean {n} dangling reference(s)? Bookkeeping only, no session files.",
      "health.cleanDone": "Cleaned {n}",
      "panel.empty": "The trash is empty.",
      "panel.auditEmpty": "No audit entries yet.",
      "panel.restore": "Restore",
      "panel.purge": "Delete for good",
      "panel.purgeConfirm": "Delete for good? This cannot be undone",
      "panel.size": "{size}",
      "panel.trashedAt": "Trashed {time}",
      "panel.unknown": "{n} unrecognized director(ies) kept",
      "panel.pending": "{n} unfinished operation(s)",
      "panel.readOnly":
        "Read-only: this DSH version is missing required APIs; deletion is disabled.",
      "panel.close": "Close",
      "toast.failed": "Operation failed: {message}",
    };

    /** @param {any} initial @returns {any} */
    function createStore(initial) {
      var value = initial;
      var listeners = new Set();
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
      return [React.useSyncExternalStore(store.subscribe, store.getSnapshot), store.set];
    }

    /** 主题化按钮：优先官方 Button，缺失时自绘。 */
    /** 主题化按钮：hover / active / focus-visible 由注入的 CSS 类提供，不依赖合成事件。 */
    function Btn(/** @type {any} */ props) {
      return h(
        "button",
        {
          type: "button",
          autoFocus: props.autoFocus,
          disabled: props.disabled,
          onClick: props.onClick,
          className: `dsh-sdel-btn${props.danger ? " dsh-sdel-btn--danger" : ""}`,
          style: {
            padding: "6px 14px",
            borderRadius: "8px",
            fontSize: "13px",
            cursor: props.disabled ? "not-allowed" : "pointer",
            opacity: props.disabled ? 0.45 : 1,
          },
        },
        props.children,
      );
    }

    /** 挂载时淡入的容器：官方 Modal 没有明确的入场过渡时，用它补齐。 */
    function Reveal(/** @type {any} */ props) {
      const state = React.useState(false);
      const shown = state[0];
      const setShown = state[1];
      React.useEffect(() => {
        const frame = requestAnimationFrame(() => setShown(true));
        return () => cancelAnimationFrame(frame);
      }, []);
      const style = Object.assign(
        {
          opacity: shown ? 1 : 0,
          transform: shown ? "translateY(0) scale(1)" : "translateY(6px) scale(0.985)",
          transition: "opacity 180ms ease-out, transform 180ms ease-out",
        },
        props.style || {},
      );
      return h("div", { style: style }, props.children);
    }

    /** 主题化浮层：优先官方 Modal，缺失时自绘（至少跟随深浅色）。 */
    function Dialog(/** @type {any} */ props) {
      React.useEffect(() => {
        const onKey = (/** @type {any} */ event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          props.onClose?.();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);
      if (typeof Modal === "function") {
        return h(
          Modal,
          {
            open: true,
            onClose: props.onClose,
            closeLabel: props.closeLabel,
            title: props.title,
            description: props.description,
            footer: props.footer,
          },
          h(
            Reveal,
            { style: { maxHeight: "60vh", overflowY: "auto", paddingRight: "4px" } },
            props.children,
          ),
        );
      }
      return h(
        "div",
        {
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 2147000000,
            background: T.mask,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          },
          onClick: props.onClose,
        },
        h(
          Reveal,
          { style: { width: "min(600px, 92vw)" } },
          h(
            "div",
            {
              style: {
                width: "100%",
                maxHeight: "82vh",
                overflow: "auto",
                background: T.bg,
                color: T.text,
                border: `1px solid ${T.border}`,
                borderRadius: T.radius,
                padding: "18px 20px",
                fontSize: "13px",
                lineHeight: 1.6,
                boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
              },
              onClick: (/** @type {any} */ event) => {
                event.stopPropagation();
              },
            },
            props.title
              ? h(
                  "div",
                  { style: { fontSize: "15px", fontWeight: 600, marginBottom: "6px" } },
                  props.title,
                )
              : null,
            props.description
              ? h("div", { style: { color: T.dim, marginBottom: "12px" } }, props.description)
              : null,
            props.children,
            props.footer
              ? h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: "8px",
                      marginTop: "16px",
                    },
                  },
                  props.footer,
                )
              : null,
          ),
        ),
      );
    }

    function formatBytes(/** @type {any} */ bytes) {
      if (typeof bytes !== "number" || bytes < 0) return "?";
      if (bytes < 1024) return `${Math.round(bytes)} B`;
      var units = ["KB", "MB", "GB", "TB"];
      var value = bytes / 1024;
      var unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value = value / 1024;
        unit += 1;
      }
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
    }

    function formatTime(/** @type {any} */ value) {
      if (typeof value !== "string") return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function errorText(/** @type {any} */ error) {
      if (!error) return "unknown error";
      if (typeof error === "string") return error;
      if (error.message) return String(error.message);
      return String(error);
    }

    function DeleteSessionMenuItem(/** @type {any} */ props) {
      var menuState =
        typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : [false, () => {}];
      var closeMenu = menuState[1];
      var onSelect = () => {
        closeMenu(false);
        props.requestDelete({ sessionId: props.sessionId, title: props.displayTitle || null });
      };
      if (typeof MenuItemButton === "function") {
        return h(
          MenuItemButton,
          {
            icon: typeof IconTrash === "function" ? h(IconTrash, { size: 14 }) : undefined,
            danger: true,
            separatorBefore: true,
            onSelect: onSelect,
          },
          props.t("menu.delete"),
        );
      }
      return h(
        "button",
        {
          type: "button",
          onClick: onSelect,
          style: {
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "6px 12px",
            border: "none",
            borderRadius: "6px",
            background: "transparent",
            color: T.danger,
            cursor: "pointer",
            fontSize: "13px",
            transition: "background-color .15s ease",
          },
        },
        props.t("menu.delete"),
      );
    }

    /** 侧栏底部的固定入口（slot: sidebar.footer.action，list，props 带 wide）。 */
    function TrashFooterButton(/** @type {any} */ props) {
      var panelState = useStore(props.panelStore);
      var tickState = useStore(props.tickStore);
      var countState = React.useState(null);
      var count = countState[0];
      var setCount = countState[1];
      const fetchCount = () => {
        props
          .call("list")
          .then((/** @type {any} */ value) => {
            setCount(value?.entries ? value.entries.length : 0);
          })
          .catch(() => setCount(null));
      };
      React.useEffect(() => {
        fetchCount();
      }, [panelState[0], tickState[0]]);
      React.useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState === "visible") fetchCount();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
      }, []);

      var label =
        props.t("footer.trash") + (typeof count === "number" && count > 0 ? ` (${count})` : "");
      return h(
        "button",
        {
          type: "button",
          title: label,
          "aria-label": label,
          onClick: () => props.openPanel(),
          className: "dsh-sdel-footer",
          style: {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            width: props.wide ? "100%" : "32px",
            height: "32px",
            justifyContent: props.wide ? "flex-start" : "center",
            padding: props.wide ? "0 8px" : 0,
            cursor: "pointer",
            fontSize: "12px",
          },
        },
        typeof IconTrash === "function" ? h(IconTrash, { size: 16 }) : h("span", null, "Trash"),
        props.wide ? h("span", null, props.t("footer.trash")) : null,
        typeof count === "number" && count > 0
          ? h(
              "span",
              {
                style: {
                  marginLeft: props.wide ? "auto" : 0,
                  minWidth: "16px",
                  padding: "0 4px",
                  borderRadius: "8px",
                  background: T.danger,
                  color: "#fff",
                  fontSize: "10px",
                  lineHeight: "16px",
                  textAlign: "center",
                },
              },
              String(count),
            )
          : null,
      );
    }

    function DeleteConfirm(/** @type {any} */ props) {
      var requestState = useStore(props.requestStore);
      var request = requestState[0];
      var planState = React.useState(null);
      var plan = planState[0];
      var setPlan = planState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var requestId = request ? request.sessionId : null;
      var cascadeState = React.useState(false);
      var cascade = cascadeState[0];
      var setCascade = cascadeState[1];

      React.useEffect(() => {
        if (!requestId) {
          setPlan(null);
          setError(null);
          setBusy(false);
          setCascade(false);
          return undefined;
        }
        var alive = true;
        setPlan(null);
        setError(null);
        props
          .call("plan", { sessionId: requestId })
          .then((/** @type {any} */ value) => {
            if (alive) setPlan(value);
          })
          .catch((/** @type {any} */ reason) => {
            if (alive) setError(errorText(reason));
          });
        return () => {
          alive = false;
        };
      }, [requestId]);

      if (!request) return null;

      var close = () => {
        if (busy) return;
        props.requestStore.set(null);
      };
      var confirm = () => {
        if (!plan || busy) return;
        setBusy(true);
        props
          .call("trash", {
            sessionId: request.sessionId,
            digest: plan.digest,
            title: request.title || null,
            cascade: cascade && plan.children.length > 0,
          })
          .then((/** @type {any} */ result) => {
            props.requestStore.set(null);
            props.onTrashed(result);
          })
          .catch((/** @type {any} */ reason) => {
            setBusy(false);
            setError(errorText(reason));
          });
      };

      var lines = [];
      if (plan) {
        if (typeof plan.sizeBytes === "number")
          lines.push(props.t("confirm.size", { size: formatBytes(plan.sizeBytes) }));
        if (plan.live) lines.push(props.t("confirm.live"));
        if (plan.children && plan.children.length > 0)
          lines.push(props.t("confirm.children", { n: plan.children.length }));
        if (plan.removes && plan.removes.length > 0) {
          lines.push(
            props.t("confirm.refs", {
              list: plan.removes.map((/** @type {any} */ item) => item.label).join(" · "),
            }),
          );
        }
        if (plan.blockers && plan.blockers.length > 0)
          lines.push(props.t("confirm.blocked", { reason: plan.blockers[0].message }));
      }
      var blocked = !!(plan?.blockers && plan.blockers.length > 0);

      var body = h(
        React.Fragment,
        null,
        request.title
          ? h("div", { style: { fontWeight: 600, marginBottom: "10px" } }, request.title)
          : null,
        plan && plan.children.length > 0
          ? h(
              "label",
              {
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  margin: "8px 0 4px",
                  cursor: "pointer",
                },
              },
              h("input", {
                type: "checkbox",
                checked: cascade,
                disabled: busy,
                onChange: (/** @type {any} */ event) => setCascade(Boolean(event.target.checked)),
                style: { marginTop: "2px" },
              }),
              h(
                "span",
                null,
                props.t("confirm.cascade", { n: plan.children.length }),
                h(
                  "span",
                  {
                    style: { display: "block", color: T.faint, fontSize: "12px", marginTop: "2px" },
                  },
                  plan.children
                    .slice(0, 4)
                    .map((/** @type {any} */ child) => child.title || child.id)
                    .join(" · ") + (plan.children.length > 4 ? " …" : ""),
                ),
              ),
            )
          : null,
        lines.map((/** @type {any} */ line, /** @type {any} */ index) =>
          h("div", { key: `line-${index}`, style: { marginBottom: "4px" } }, line),
        ),
        !plan && !error ? h("div", { style: { color: T.dim } }, props.t("confirm.loading")) : null,
        error ? h("div", { style: { color: T.danger, marginTop: "8px" } }, error) : null,
      );

      return h(
        Dialog,
        {
          onClose: close,
          closeLabel: props.t("confirm.cancel"),
          title: props.t("confirm.title"),
          description: props.t("confirm.desc"),
          footer: h(
            React.Fragment,
            null,
            h(Btn, { autoFocus: true, onClick: close, disabled: busy }, props.t("confirm.cancel")),
            h(
              Btn,
              { onClick: confirm, danger: true, disabled: busy || blocked || !plan },
              busy ? props.t("confirm.pending") : props.t("confirm.confirm"),
            ),
          ),
        },
        body,
      );
    }

    function TrashPanel(/** @type {any} */ props) {
      var panelState = useStore(props.panelStore);
      var open = panelState[0];
      var tabState = React.useState("trash");
      var tab = tabState[0];
      var setTab = tabState[1];
      var dataState = React.useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var auditState = React.useState(null);
      var audit = auditState[0];
      var setAudit = auditState[1];
      var healthState = React.useState(null);
      var health = healthState[0];
      var setHealth = healthState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(null);
      var busyId = busyState[0];
      var setBusyId = busyState[1];
      var purgeState = React.useState(null);
      var confirmPurge = purgeState[0];
      var setConfirmPurge = purgeState[1];
      var selectedTrashState = React.useState({});
      var selectedTrash = selectedTrashState[0];
      var setSelectedTrash = selectedTrashState[1];
      var trashBusyState = React.useState(false);
      var trashBusy = trashBusyState[0];
      var setTrashBusy = trashBusyState[1];
      var trashMsgState = React.useState("");
      var trashMsg = trashMsgState[0];
      var setTrashMsg = trashMsgState[1];
      var scanState = React.useState(null);
      var scan = scanState[0];
      var setScan = scanState[1];
      var scanErrorState = React.useState(null);
      var scanError = scanErrorState[0];
      var setScanError = scanErrorState[1];
      var cleanState = React.useState(false);
      var cleaning = cleanState[0];
      var setCleaning = cleanState[1];
      var cleanMsgState = React.useState("");
      var cleanMsg = cleanMsgState[0];
      var setCleanMsg = cleanMsgState[1];
      var receiptsState = React.useState(null);
      var receipts = receiptsState[0];
      var setReceipts = receiptsState[1];

      const loadReceipts = React.useCallback(() => {
        props
          .call("receipts", { limit: 50 })
          .then((/** @type {any} */ value) => {
            setReceipts(value?.entries ? value.entries : []);
          })
          .catch(() => setReceipts([]));
      }, []);

      const loadHealth = React.useCallback(() => {
        setScan(null);
        setScanError(null);
        props
          .call("healthScan")
          .then((/** @type {any} */ value) => {
            setScan(value);
          })
          .catch((/** @type {any} */ reason) => {
            setScanError(errorText(reason));
          });
      }, []);

      const loadAudit = React.useCallback(() => {
        props
          .call("audit", { limit: 100 })
          .then((/** @type {any} */ value) => {
            setAudit(value?.entries ? value.entries : []);
          })
          .catch(() => {});
      }, []);

      var refresh = React.useCallback(() => {
        props
          .call("list")
          .then((/** @type {any} */ value) => {
            setData(value);
          })
          .catch((/** @type {any} */ reason) => {
            setError(errorText(reason));
          });
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        refresh();
        props
          .call("health")
          .then((/** @type {any} */ value) => {
            setHealth(value);
          })
          .catch(() => {});
        loadAudit();
        // 面板打开期间自动同步，不需要手动刷新按钮。
        const timer = setInterval(() => {
          if (document.visibilityState === "visible") refresh();
        }, 5000);
        const onVisible = () => {
          if (document.visibilityState === "visible") refresh();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, [open]);

      const listRef = React.useRef(null);
      const onListKeyDown = (/** @type {any} */ event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.panelStore.set(false);
          return;
        }
        const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
        if (!keys.includes(event.key)) return;
        const root = listRef.current;
        if (!root) return;
        const items = [...root.querySelectorAll("button:not([disabled])")];
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement);
        let next = 0;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else if (event.key === "ArrowDown")
          next = current < 0 ? 0 : Math.min(items.length - 1, current + 1);
        else next = current <= 0 ? 0 : current - 1;
        event.preventDefault();
        items[next].focus();
      };

      if (!open) return null;

      var doRestore = (/** @type {any} */ entryId, /** @type {any} */ sessionId) => {
        setBusyId(entryId);
        props
          .call("restore", { entryId: entryId })
          .then(() => {
            setBusyId(null);
            refresh();
            props.bump?.();
            props.onRestored?.(sessionId);
          })
          .catch((/** @type {any} */ reason) => {
            setBusyId(null);
            setError(errorText(reason));
          });
      };
      var doPurge = (/** @type {any} */ entryId, /** @type {any} */ sessionId) => {
        setBusyId(entryId);
        props
          .call("purge", { entryId: entryId })
          .then(() => {
            setBusyId(null);
            setConfirmPurge(null);
            refresh();
            props.bump?.();
            props.onPurged?.(sessionId);
          })
          .catch((/** @type {any} */ reason) => {
            setBusyId(null);
            setError(errorText(reason));
          });
      };

      var selectedEntryIds = Object.keys(selectedTrash).filter(
        (/** @type {string} */ entryId) => /** @type {any} */ (selectedTrash)[entryId],
      );
      var doBatchRestore = () => {
        if (selectedEntryIds.length === 0) return;
        setTrashBusy(true);
        setTrashMsg("");
        props
          .call("restoreMany", { entryIds: selectedEntryIds })
          .then((/** @type {any} */ result) => {
            setTrashBusy(false);
            setTrashMsg(props.t("batch.done", { ok: result.succeeded, total: result.total }));
            setSelectedTrash({});
            refresh();
            props.bump?.();
            for (const item of result.results) if (item.ok) props.onRestored?.(item.sessionId);
          })
          .catch((/** @type {any} */ reason) => {
            setTrashBusy(false);
            setTrashMsg(errorText(reason));
          });
      };
      var doBatchPurge = () => {
        if (selectedEntryIds.length === 0) return;
        setTrashBusy(true);
        setTrashMsg("");
        props
          .call("purgeMany", { entryIds: selectedEntryIds })
          .then((/** @type {any} */ result) => {
            setTrashBusy(false);
            setConfirmPurge(null);
            setTrashMsg(props.t("batch.done", { ok: result.succeeded, total: result.total }));
            setSelectedTrash({});
            refresh();
            props.bump?.();
            for (const item of result.results) if (item.ok) props.onPurged?.(undefined);
          })
          .catch((/** @type {any} */ reason) => {
            setTrashBusy(false);
            setTrashMsg(errorText(reason));
          });
      };

      var entries = data?.entries || [];
      var readOnly = !!health?.readOnly;
      var rowStyle = { borderTop: `1px solid ${T.border}`, padding: "10px 0" };

      var content = [];
      if (readOnly)
        content.push(
          h(
            "div",
            { key: "ro", style: { color: T.danger, marginBottom: "10px" } },
            props.t("panel.readOnly"),
          ),
        );
      if (error)
        content.push(
          h("div", { key: "err", style: { color: T.danger, marginBottom: "10px" } }, error),
        );
      content.push(
        h(
          "div",
          { key: "tabs", style: { display: "flex", gap: "8px", marginBottom: "12px" } },
          h(
            Btn,
            {
              onClick: () => {
                setTab("trash");
              },
            },
            props.t("panel.tabTrash") + (entries.length ? ` (${entries.length})` : ""),
          ),
          h(
            Btn,
            {
              onClick: () => {
                setTab("audit");
                loadAudit();
              },
            },
            props.t("panel.tabAudit"),
          ),
          h(
            Btn,
            {
              onClick: () => {
                setTab("health");
                loadHealth();
              },
            },
            props.t("panel.tabHealth"),
          ),
          h(
            Btn,
            {
              onClick: () => {
                setTab("receipts");
                loadReceipts();
              },
            },
            props.t("panel.tabReceipts"),
          ),
        ),
      );

      if (tab === "receipts") {
        if (!receipts || receipts.length === 0) {
          content.push(
            h(
              "div",
              { key: "receipts-empty", style: { color: T.dim, padding: "8px 0" } },
              props.t("receipts.empty"),
            ),
          );
        } else {
          receipts.forEach((/** @type {any} */ receipt, /** @type {any} */ index) => {
            const removed = receipt.removed || [];
            const okCount = removed.filter(
              (/** @type {any} */ item) => item.status === "ok",
            ).length;
            const detail =
              receipt.action === "trash"
                ? `${formatBytes(receipt.sizeBytes || 0)} · ${okCount}/${removed.length}`
                : receipt.action === "restore"
                  ? props.t("receipts.restored")
                  : receipt.action === "purge"
                    ? formatBytes(receipt.bytes || 0)
                    : String(receipt.total || 0);
            content.push(
              h(
                "div",
                {
                  key: `receipt-${index}`,
                  title: String(receipt.sessionId || ""),
                  style: {
                    borderTop: `1px solid ${T.border}`,
                    padding: "7px 0",
                    fontSize: "12px",
                    display: "flex",
                    alignItems: "baseline",
                    gap: "6px",
                  },
                },
                h(
                  "span",
                  { style: { color: T.faint, whiteSpace: "nowrap" } },
                  formatTime(receipt.at),
                ),
                h(
                  "span",
                  { style: { fontWeight: 600, whiteSpace: "nowrap" } },
                  String(receipt.action || ""),
                ),
                h(
                  "span",
                  {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      color: T.dim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  String(receipt.title || receipt.sessionId || "—"),
                ),
                h("span", { style: { color: T.faint, whiteSpace: "nowrap" } }, detail),
              ),
            );
          });
        }
      } else if (tab === "health") {
        if (scanError) {
          content.push(
            h("div", { key: "scan-err", style: { color: T.danger, padding: "8px 0" } }, scanError),
          );
        } else if (!scan) {
          content.push(
            h(
              "div",
              { key: "scan-loading", style: { color: T.dim, padding: "8px 0" } },
              props.t("health.loading"),
            ),
          );
        } else if (!scan.ok) {
          content.push(
            h(
              "div",
              { key: "scan-na", style: { color: T.dim, padding: "8px 0" } },
              props.t("health.unavailable", { reason: scan.reason || "" }),
            ),
          );
        } else {
          content.push(
            h(
              "div",
              { key: "scan-inventory", style: { color: T.dim, fontSize: "12px" } },
              props.t("health.inventory", scan.inventory || {}),
            ),
          );
          content.push(
            h(
              "div",
              { key: "scan-agent-tool", style: { color: T.dim, fontSize: "12px" } },
              props.t("health.agentTool", {
                state: scan.agentTool
                  ? props.t("health.agentToolOn")
                  : props.t("health.agentToolOff"),
              }),
            ),
          );
          if (scan.findings.length === 0) {
            content.push(
              h("div", { key: "scan-ok", style: { padding: "8px 0" } }, props.t("health.ok")),
            );
          }
          scan.findings.forEach((/** @type {any} */ finding, /** @type {any} */ index) => {
            content.push(
              h(
                "div",
                {
                  key: `finding-${index}`,
                  style: {
                    borderTop: `1px solid ${T.border}`,
                    padding: "8px 0",
                    color: finding.severity === "warn" ? T.text : T.dim,
                  },
                },
                h(
                  "div",
                  { style: { fontWeight: 600 } },
                  `${finding.label} · ${props.t("health.items", { n: finding.items.length })}`,
                ),
                h(
                  "div",
                  { style: { color: T.faint, fontSize: "12px", wordBreak: "break-all" } },
                  finding.items
                    .slice(0, 6)
                    .map((/** @type {any} */ item) =>
                      typeof item === "string" ? item : JSON.stringify(item),
                    )
                    .join(" · "),
                ),
              ),
            );
          });
          if (scan.cleanable && scan.cleanable.total > 0) {
            content.push(
              h(
                "div",
                {
                  key: "scan-clean",
                  style: { marginTop: "10px", display: "flex", gap: "8px", alignItems: "center" },
                },
                confirmPurge === "__health__"
                  ? h(
                      Btn,
                      {
                        danger: true,
                        disabled: cleaning,
                        onClick: () => {
                          setCleaning(true);
                          setCleanMsg("");
                          props
                            .call("cleanHealth", { classes: ["archived", "pinned", "workspace"] })
                            .then((/** @type {any} */ result) => {
                              setCleaning(false);
                              setConfirmPurge(null);
                              setCleanMsg(props.t("health.cleanDone", { n: result.total }));
                              loadHealth();
                              props.bump?.();
                            })
                            .catch((/** @type {any} */ reason) => {
                              setCleaning(false);
                              setCleanMsg(errorText(reason));
                            });
                        },
                      },
                      props.t("health.cleanConfirm", { n: scan.cleanable.total }),
                    )
                  : h(
                      Btn,
                      { onClick: () => setConfirmPurge("__health__") },
                      props.t("health.clean", { n: scan.cleanable.total }),
                    ),
              ),
            );
          }
          if (cleanMsg) {
            content.push(
              h(
                "div",
                { key: "scan-msg", style: { color: T.dim, marginTop: "8px", fontSize: "12px" } },
                cleanMsg,
              ),
            );
          }
        }
      } else if (tab === "trash") {
        if (entries.length === 0) {
          content.push(
            h(
              "div",
              { key: "empty", style: { color: T.dim, padding: "12px 0" } },
              props.t("panel.empty"),
            ),
          );
        } else {
          content.push(
            h(
              "div",
              {
                key: "trash-tools",
                style: {
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  marginBottom: "8px",
                  flexWrap: "wrap",
                },
              },
              h(
                Btn,
                {
                  onClick: () => {
                    /** @type {Record<string, boolean>} */
                    const all = {};
                    for (const item of entries) all[item.entryId] = true;
                    setSelectedTrash(all);
                  },
                  disabled: trashBusy,
                },
                props.t("trash.selectAll"),
              ),
              h(
                Btn,
                { onClick: () => setSelectedTrash({}), disabled: trashBusy },
                props.t("trash.clear"),
              ),
              h(
                Btn,
                {
                  disabled: trashBusy || selectedEntryIds.length === 0,
                  onClick: doBatchRestore,
                },
                props.t("trash.restoreMany", { n: selectedEntryIds.length }),
              ),
              confirmPurge === "__trashBatchPurge__"
                ? h(
                    Btn,
                    {
                      danger: true,
                      disabled: trashBusy || selectedEntryIds.length === 0,
                      onClick: doBatchPurge,
                    },
                    props.t("trash.purgeManyConfirm", { n: selectedEntryIds.length }),
                  )
                : h(
                    Btn,
                    {
                      danger: true,
                      disabled: trashBusy || selectedEntryIds.length === 0,
                      onClick: () => setConfirmPurge("__trashBatchPurge__"),
                    },
                    props.t("trash.purgeMany", { n: selectedEntryIds.length }),
                  ),
            ),
          );
          if (trashMsg) {
            content.push(
              h(
                "div",
                {
                  key: "trash-msg",
                  style: { color: T.dim, fontSize: "12px", marginBottom: "6px" },
                },
                trashMsg,
              ),
            );
          }
          entries.forEach((/** @type {any} */ entry) => {
            content.push(
              h(
                "div",
                { key: entry.entryId, style: rowStyle },
                h(
                  "label",
                  { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                  h("input", {
                    type: "checkbox",
                    checked: Boolean(/** @type {any} */ (selectedTrash)[entry.entryId]),
                    disabled: trashBusy,
                    onChange: () =>
                      setSelectedTrash((/** @type {any} */ current) => ({
                        ...current,
                        [entry.entryId]: !current[entry.entryId],
                      })),
                    style: { marginTop: "2px" },
                  }),
                  h("span", { style: { fontWeight: 600 } }, entry.title || entry.sessionId),
                ),
                h(
                  "div",
                  { style: { color: T.dim, fontSize: "12px" } },
                  props.t("panel.size", { size: formatBytes(entry.bytes) }) +
                    " · " +
                    props.t("panel.trashedAt", { time: formatTime(entry.trashedAt) }),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: "8px", marginTop: "6px" } },
                  h(
                    Btn,
                    {
                      onClick: () => {
                        doRestore(entry.entryId, entry.sessionId);
                      },
                      disabled: busyId === entry.entryId,
                    },
                    props.t("panel.restore"),
                  ),
                  confirmPurge === entry.entryId
                    ? h(
                        Btn,
                        {
                          onClick: () => {
                            doPurge(entry.entryId, entry.sessionId);
                          },
                          danger: true,
                          disabled: busyId === entry.entryId,
                        },
                        props.t("panel.purgeConfirm"),
                      )
                    : h(
                        Btn,
                        {
                          onClick: () => {
                            setConfirmPurge(entry.entryId);
                          },
                          danger: true,
                        },
                        props.t("panel.purge"),
                      ),
                ),
              ),
            );
          });
        }
      } else if ((audit || []).length === 0) {
        content.push(
          h(
            "div",
            { key: "ae", style: { color: T.dim, padding: "12px 0" } },
            props.t("panel.auditEmpty"),
          ),
        );
      } else {
        (audit || [])
          .slice()
          .reverse()
          .forEach((/** @type {any} */ entry, /** @type {any} */ index) => {
            content.push(
              h(
                "div",
                {
                  key: `audit-${index}`,
                  style: { borderTop: `1px solid ${T.border}`, padding: "6px 0", fontSize: "12px" },
                },
                h("span", { style: { color: T.faint } }, `${formatTime(entry.ts)} `),
                h("span", { style: { fontWeight: 600 } }, `${String(entry.action || "")} `),
                h(
                  "span",
                  { title: entry.sessionId || "", style: { color: T.dim } },
                  String(entry.result || "") +
                    (entry.sessionId ? ` · ${String(entry.sessionId).slice(0, 13)}…` : "") +
                    (entry.detail ? ` · ${entry.detail}` : ""),
                ),
              ),
            );
          });
      }

      if (data?.unknown && data.unknown.length > 0) {
        content.push(
          h(
            "div",
            { key: "unk", style: { color: T.faint, fontSize: "12px", marginTop: "10px" } },
            props.t("panel.unknown", { n: data.unknown.length }),
          ),
        );
      }
      if (data?.pending && data.pending.length > 0) {
        content.push(
          h(
            "div",
            { key: "pend", style: { color: T.faint, fontSize: "12px", marginTop: "6px" } },
            props.t("panel.pending", { n: data.pending.length }),
          ),
        );
      }

      return h(
        Dialog,
        {
          onClose: () => {
            props.panelStore.set(false);
          },
          closeLabel: props.t("panel.close"),
          title: props.t("panel.title"),
          footer: h(
            Btn,
            {
              autoFocus: true,
              onClick: () => {
                props.panelStore.set(false);
              },
            },
            props.t("panel.close"),
          ),
        },
        h(
          "div",
          { ref: listRef, onKeyDown: onListKeyDown, tabIndex: -1, style: { outline: "none" } },
          content,
        ),
      );
    }

    function TrashToast(/** @type {any} */ props) {
      var toastState = useStore(props.toastStore);
      var toast = toastState[0];
      var entryId = toast ? toast.entryId : null;
      var shownState = React.useState(false);
      var shown = shownState[0];
      var setShown = shownState[1];
      var restoreState = React.useState(false);
      var restoring = restoreState[0];
      var setRestoring = restoreState[1];

      React.useEffect(() => {
        if (!entryId) {
          setShown(false);
          return undefined;
        }
        var raise = setTimeout(() => {
          setShown(true);
        }, 10);
        var timer = setTimeout(() => {
          props.toastStore.set(null);
        }, 6000);
        return () => {
          clearTimeout(raise);
          clearTimeout(timer);
        };
      }, [entryId]);

      if (!toast) return null;
      return h(
        "div",
        {
          style: {
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 2147000000,
            background: T.toastBg,
            color: T.toastText,
            border: `1px solid ${T.border}`,
            borderRadius: "10px",
            padding: "10px 14px",
            fontSize: "13px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            opacity: shown ? 1 : 0,
            transform: shown ? "translateY(0)" : "translateY(8px)",
            transition: "opacity .18s ease, transform .18s ease",
          },
        },
        h("span", null, props.t("confirm.done")),
        h(
          Btn,
          {
            disabled: restoring,
            onClick: () => {
              setRestoring(true);
              props
                .call("restore", { entryId: toast.entryId })
                .then(() => {
                  setRestoring(false);
                  props.toastStore.set(null);
                })
                .catch(() => {
                  setRestoring(false);
                });
            },
          },
          props.t("confirm.undo"),
        ),
      );
    }

    /** 一个浮层里渲染确认框 + 面板 + toast，因为 shell.overlay 是单实例 slot。 */
    function SessionDeleteOverlay(/** @type {any} */ props) {
      return h(
        React.Fragment,
        null,
        h(
          DeleteConfirm,
          Object.assign({}, props, {
            requestStore: props.requestStore,
            call: props.call,
            onTrashed: props.onTrashed,
          }),
        ),
        h(
          TrashPanel,
          Object.assign({}, props, {
            panelStore: props.panelStore,
            call: props.call,
            onPurged: props.onPurged,
            onRestored: props.onRestored,
            tickStore: props.tickStore,
            bump: props.bump,
          }),
        ),
        h(TrashToast, Object.assign({}, props, { toastStore: props.toastStore, call: props.call })),
      );
    }

    exports.inject = ["slots", "locale", "connection"];
    exports.apply = function apply(/** @type {any} */ ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "session-delete: dictionaries");

      // 用真实的 :hover / :focus-visible 伪类，避免依赖 React 合成事件与内联样式。
      ctx.effect(() => {
        const style = document.createElement("style");
        // 标注归属：便于在 DevTools 里认出这段样式、也方便测试断言插件确实加载了。
        style.setAttribute("data-plugin", "@kangyishuai/dsh-session-delete");
        style.textContent = [
          ".dsh-sdel-btn{background:transparent;color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));transition:background-color 150ms ease,border-color 150ms ease,transform 80ms ease,color 150ms ease;}",
          ".dsh-sdel-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}",
          ".dsh-sdel-btn:active{transform:scale(.98);}",
          ".dsh-sdel-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px;}",
          ".dsh-sdel-btn--danger{color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-sdel-btn--danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(217,83,79,.16));}",
          ".dsh-sdel-footer{background:transparent;color:var(--dsw-alias-label-secondary,GrayText);border:1px solid transparent;border-radius:8px;transition:background-color 150ms ease,color 150ms ease;}",
          ".dsh-sdel-footer:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,inherit);}",
          ".dsh-sdel-footer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px;}",
        ].join("\n");
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-delete: styles");

      var requestStore = createStore(null);
      var panelStore = createStore(false);
      var toastStore = createStore(null);
      var tickStore = createStore(0);

      /**
       * 调宿主 sessionDelete 的 Remote 方法。走 /api 的普通 RPC 通道：
       * 无构建插件没有 typert 生成的客户端产物，不能用 ctx.reflect.get。
       * @param {string} method
       * @param {any} request
       * @returns {Promise<any>}
       */
      function call(method, request) {
        var rpc = ctx.connection?.rpc;
        if (!rpc || typeof rpc.call !== "function") {
          return Promise.reject(new Error("session-delete: no connection to the host"));
        }
        var payload = request === undefined ? { args: {} } : { args: { request: request } };
        return Promise.resolve(rpc.call("/api", `sessionDelete/${method}`, payload)).then(
          (/** @type {any} */ result) => {
            if (!result || typeof result !== "object") return result;
            if (result.ok === false) {
              const error = /** @type {any} */ (
                new Error(result.error?.message || "host rejected the call")
              );
              error.code = result.error?.code;
              throw error;
            }
            return "value" in result ? result.value : result;
          },
        );
      }

      // 宿主列表 = persistence ∪ live：刷新会把宿主内存里还没释放的会话折回来。
      // 所以删掉的 id 要记住，并在每次 refresh 后重放移除事件（参考实现同款做法）。
      const retired = new Set();
      const hostSessions = () => {
        try {
          return ctx.get ? ctx.get("sessions") : undefined;
        } catch (_error) {
          return undefined;
        }
      };
      const refreshRows = async (/** @type {any} */ retireId) => {
        if (retireId) retired.add(retireId);
        const sessions = hostSessions();
        if (!sessions) return;
        try {
          await sessions.refresh?.();
        } catch (_error) {
          /* 刷新失败不影响已经完成的删除 */
        }
        retired.forEach((id) => {
          try {
            sessions.handleSessionRemoved?.(id);
          } catch (_error) {
            /* 旧版本没有该通道时忽略 */
          }
        });
      };
      // 快捷键只做「打开回收站」这种非破坏性动作；删除始终需要菜单 + 确认框。
      window.addEventListener("keydown", (/** @type {any} */ event) => {
        if (!(event.metaKey || event.ctrlKey) || !event.altKey) return;
        if (event.key !== "t" && event.key !== "T") return;
        const target = /** @type {any} */ (event.target);
        const tag = target?.tagName ? String(target.tagName).toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
        event.preventDefault();
        panelStore.set(true);
      });

      const onTrashed = (/** @type {any} */ result) => {
        if (result?.entryId) {
          toastStore.set({ entryId: result.entryId, title: result.title || null });
        }
        void refreshRows(result?.sessionId ? result.sessionId : undefined);
        tickStore.set(tickStore.getSnapshot() + 1);
      };
      // 外部变更（agent 工具、另一个窗口、CLI）不会通知本页面，
      // 定期拉一次会话列表；页面重新可见时也立刻拉一次。
      ctx.effect(() => {
        const pull = () => {
          if (document.visibilityState === "visible") {
            void refreshRows(undefined);
            // 回收站条目也可能被 agent 工具/另一个窗口改变，顺带刷新页脚计数
            tickStore.set(tickStore.getSnapshot() + 1);
          }
        };
        const timer = setInterval(pull, 10_000);
        document.addEventListener("visibilitychange", pull);
        return () => {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", pull);
        };
      }, "session-delete: poll external session removals");

      const onPurged = (/** @type {any} */ sessionId) => {
        void refreshRows(sessionId || undefined);
      };
      const onRestored = (/** @type {any} */ sessionId) => {
        if (sessionId) retired.delete(sessionId);
        void refreshRows(undefined);
      };

      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
            ctx.slots.register(
              {
                name: "sidebar.workspaces.session.menu.item",
                id: "session-delete",
                order: 420,
                locale: NS,
                inject: () => ({
                  requestDelete: (/** @type {any} */ request) => {
                    requestStore.set(request);
                  },
                }),
              },
              DeleteSessionMenuItem,
            ),
          ),
        "session-delete: session menu item",
      );

      // 回收站入口固定在侧栏页脚，不出现在每个会话的「…」菜单里。
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.footer.action", () =>
            ctx.slots.register(
              {
                name: "sidebar.footer.action",
                id: "session-delete-trash",
                order: 100,
                locale: NS,
                inject: () => ({
                  panelStore: panelStore,
                  tickStore: tickStore,
                  call: call,
                  openPanel: () => {
                    panelStore.set(true);
                  },
                }),
              },
              TrashFooterButton,
            ),
          ),
        "session-delete: sidebar footer trash entry",
      );

      ctx.effect(
        () =>
          ctx.slots.inject("shell.overlay", () =>
            ctx.slots.register(
              { name: "shell.overlay", id: "session-delete", locale: NS },
              function OverlayHost(/** @type {any} */ props) {
                return h(
                  SessionDeleteOverlay,
                  Object.assign({}, props, {
                    requestStore: requestStore,
                    panelStore: panelStore,
                    toastStore: toastStore,
                    call: call,
                    onTrashed: onTrashed,
                    onPurged: onPurged,
                    onRestored: onRestored,
                    tickStore: tickStore,
                    bump: () => tickStore.set(tickStore.getSnapshot() + 1),
                  }),
                );
              },
            ),
          ),
        "session-delete: overlay (confirm + panel + toast)",
      );
    };

    return module.exports;
  },
});
