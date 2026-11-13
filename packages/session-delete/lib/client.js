// @ts-check
// client 半：classic script，以 __ModuleLoader__.load 注册 factory，不能使用 import。
// 注册面：会话「…」菜单项 + 侧栏页脚回收站入口 + shell.overlay（确认框 / 回收站面板 / toast）
//          + 设置页「会话回收站」分节。
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
    var PrimitiveCheckbox = primitives.Checkbox;
    var PrimitiveSwitch = primitives.Switch;

    /** 设计变量（宿主主题 token）：深色/浅色自动跟随。 */
    var T = {
      bg: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, Canvas))",
      bgBase: "var(--dsw-alias-bg-base, Canvas)",
      text: "var(--dsw-alias-label-primary, CanvasText)",
      dim: "var(--dsw-alias-label-secondary, GrayText)",
      faint: "var(--dsw-alias-label-tertiary, GrayText)",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
      hoverDanger: "var(--dsw-alias-interactive-bg-hover-danger, rgba(217,83,79,0.16))",
      danger: "var(--dsw-alias-state-error-primary, #d9534f)",
      // 与 danger 成对：反色实心填充必须配宿主的前景色 token，不能写死白。
      // 深色主题下宿主 error 是浅红 #f25a5a，白字只有 3.29:1；配 label-primary-foreground 是 5.75:1。
      dangerText: "var(--dsw-alias-label-primary-foreground, #fff)",
      mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))",
      toastBg: "var(--dsw-alias-toast-bg, Canvas)",
      toastText: "var(--dsw-alias-toast-label, CanvasText)",
      brand: "var(--dsw-alias-brand-primary, #4f7cff)",
      radius: "10px",
    };

    /** locale 命名空间；必须与 locale/*.json 顶层键一致。 */
    var NS = "sessionDelete";

    /**
     * 简体中文词典（键集的事实来源）。
     * 精简原则：确认框正文只讲「删什么、多大、能不能恢复」，
     * 技术细节（引用清单、回收站路径、子会话标题）一律进「详情」。
     */
    var zh = {
      "menu.delete": "删除会话…",
      "menu.trash": "回收站…",
      "footer.trash": "回收站",
      "confirm.title": "删除会话？",
      "confirm.desc": "移入本机回收站，可以恢复。",
      "confirm.loading": "正在读取影响面…",
      "confirm.size": "约 {size}",
      "confirm.live": "正在运行，会先停止",
      "confirm.children": "{n} 个子会话",
      "confirm.cascade": "同时删除这 {n} 个子会话（各自进回收站，需分别恢复）",
      "confirm.refs": "将清理 {n} 处引用",
      "confirm.details": "详情",
      "confirm.detail.refs": "引用：{list}",
      "confirm.detail.children": "子会话：{list}",
      "confirm.detail.trashPath": "回收站：{path}",
      "confirm.detail.recoverable": "可恢复：删除后从回收站还原到原位置",
      "confirm.blocked": "暂时无法删除：{reason}",
      "confirm.cancel": "取消",
      "confirm.confirm": "移入回收站",
      "confirm.pending": "正在移入回收站…",
      "confirm.done": "已移入回收站",
      "confirm.undo": "撤销",
      "panel.title": "会话回收站",
      "panel.empty": "回收站是空的。",
      "panel.restore": "恢复",
      "panel.purge": "彻底删除",
      "panel.purgeConfirm": "不可恢复，确认",
      "panel.cancelConfirm": "取消",
      "panel.size": "{size}",
      "panel.trashedAt": "{time}",
      "panel.unknown": "{n} 个无法识别的目录已保留",
      "panel.pending": "{n} 个未完成的操作",
      "panel.readOnly": "只读模式：当前 DSH 版本缺少依赖接口，删除功能已禁用。",
      "panel.close": "关闭",
      "trash.selectAll": "全选",
      "trash.selectCount": "已选 {n}/{total}",
      "trash.restoreMany": "恢复（{n}）",
      "trash.purgeMany": "彻底删除（{n}）",
      "trash.purgeManyConfirm": "彻底删除 {n} 个？不可恢复",
      "batch.progress": "处理中 {done}/{total}",
      "batch.stop": "停止",
      "batch.done": "完成：{ok}/{total} 成功",
      "batch.failed": "{n} 个失败，已保留选中",
      "toast.failed": "操作失败：{message}",
      "settings.nav": "会话回收站",
      "settings.group.delete": "删除偏好",
      "settings.cascade.title": "记住「同时删除子会话」",
      "settings.cascade.desc": "下次打开删除确认框时沿用上次的勾选状态。",
      "settings.cascade.reset": "重置为默认（不勾选）",
      "settings.cascade.resetDone": "已重置",
      "settings.group.trash": "回收站",
      "settings.trash.summary": "{n} 个会话 · 占用 {size}",
      "settings.trash.open": "打开回收站",
      "settings.group.maintenance": "维护",
      "settings.health.title": "体检",
      "settings.health.desc": "检查指向已不存在会话的登记条目（只读）。",
      "settings.health.ok": "未发现失效引用。",
      "settings.health.items": "{n} 条待清理",
      "settings.health.unavailable": "无法体检：{reason}",
      "settings.health.clean": "清理 {n} 条",
      "settings.health.cleanConfirm": "确认清理 {n} 条？只动登记表，不碰会话文件",
      "settings.health.cleaned": "已清理 {n} 条",
      "settings.receipts.title": "操作回执",
      "settings.receipts.empty": "还没有操作回执。",
      "settings.audit.title": "审计日志",
      "settings.audit.empty": "还没有审计记录。",
      "settings.audit.path": "日志文件：{path}",
      "settings.loading": "读取中…",
    };

    /** English dictionary（键集与 zh 完全一致）。 */
    var en = {
      "menu.delete": "Delete session…",
      "menu.trash": "Trash…",
      "footer.trash": "Trash",
      "confirm.title": "Delete session?",
      "confirm.desc": "Moves to the local trash and can be restored.",
      "confirm.loading": "Reading what will be removed…",
      "confirm.size": "about {size}",
      "confirm.live": "running; its work stops first",
      "confirm.children": "{n} subagent session(s)",
      "confirm.cascade": "Also delete these {n} child session(s) (each goes to trash separately)",
      "confirm.refs": "Cleans {n} reference(s)",
      "confirm.details": "Details",
      "confirm.detail.refs": "References: {list}",
      "confirm.detail.children": "Child sessions: {list}",
      "confirm.detail.trashPath": "Trash: {path}",
      "confirm.detail.recoverable":
        "Recoverable: restore from the trash back to its original place",
      "confirm.blocked": "Cannot delete right now: {reason}",
      "confirm.cancel": "Cancel",
      "confirm.confirm": "Move to trash",
      "confirm.pending": "Moving to trash…",
      "confirm.done": "Moved to trash",
      "confirm.undo": "Undo",
      "panel.title": "Session trash",
      "panel.empty": "The trash is empty.",
      "panel.restore": "Restore",
      "panel.purge": "Delete for good",
      "panel.purgeConfirm": "Cannot be undone — confirm",
      "panel.cancelConfirm": "Cancel",
      "panel.size": "{size}",
      "panel.trashedAt": "{time}",
      "panel.unknown": "{n} unrecognized director(ies) kept",
      "panel.pending": "{n} unfinished operation(s)",
      "panel.readOnly":
        "Read-only: this DSH version is missing required APIs; deletion is disabled.",
      "panel.close": "Close",
      "trash.selectAll": "Select all",
      "trash.selectCount": "{n}/{total} selected",
      "trash.restoreMany": "Restore ({n})",
      "trash.purgeMany": "Delete {n} permanently",
      "trash.purgeManyConfirm": "Permanently delete {n}? This cannot be undone",
      "batch.progress": "{done}/{total} done",
      "batch.stop": "Stop",
      "batch.done": "Done: {ok}/{total} succeeded",
      "batch.failed": "{n} failed; kept selected",
      "toast.failed": "Operation failed: {message}",
      "settings.nav": "Session trash",
      "settings.group.delete": "Deletion preferences",
      "settings.cascade.title": 'Remember "also delete child sessions"',
      "settings.cascade.desc": "The next delete confirmation starts from your last choice.",
      "settings.cascade.reset": "Reset to default (unchecked)",
      "settings.cascade.resetDone": "Reset",
      "settings.group.trash": "Trash",
      "settings.trash.summary": "{n} session(s) · {size}",
      "settings.trash.open": "Open trash",
      "settings.group.maintenance": "Maintenance",
      "settings.health.title": "Health",
      "settings.health.desc":
        "Checks bookkeeping that points at sessions that no longer exist (read-only).",
      "settings.health.ok": "No dangling references found.",
      "settings.health.items": "{n} to clean",
      "settings.health.unavailable": "Cannot run the check: {reason}",
      "settings.health.clean": "Clean {n}",
      "settings.health.cleanConfirm": "Clean {n} dangling reference(s)? Bookkeeping only.",
      "settings.health.cleaned": "Cleaned {n}",
      "settings.receipts.title": "Receipts",
      "settings.receipts.empty": "No operation receipts yet.",
      "settings.audit.title": "Audit log",
      "settings.audit.empty": "No audit entries yet.",
      "settings.audit.path": "Log file: {path}",
      "settings.loading": "Loading…",
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

    /** 主题化按钮：hover / active / focus-visible 由注入的 CSS 类提供，不依赖合成事件。 */
    /** 主题化按钮：hover / active / focus-visible 由注入的 CSS 类提供，不依赖合成事件。 */
    function Btn(/** @type {any} */ props) {
      var variant = props.variant === "danger" ? " dsh-sdel-btn--danger" : "";
      var quiet = props.variant === "quiet" ? " dsh-sdel-btn--quiet" : "";
      return h(
        "button",
        {
          type: "button",
          ref: props.innerRef,
          disabled: props.disabled,
          title: props.title,
          "aria-label": props.ariaLabel,
          "data-modal-autofocus": props.modalAutofocus ? "" : undefined,
          onClick: props.onClick,
          className: `dsh-sdel-btn${variant}${quiet}${props.tight ? " dsh-sdel-btn--tight" : ""}`,
          style: {
            padding: props.tight ? "2px 8px" : "6px 14px",
            borderRadius: "8px",
            fontSize: props.tight ? "12px" : "13px",
            cursor: props.disabled ? "not-allowed" : "pointer",
            opacity: props.disabled ? 0.45 : 1,
          },
        },
        props.children,
      );
    }

    /** 复选框：优先宿主原语（尺寸/焦点环与设置页一致），缺失时回退到原生 input。 */
    function Check(/** @type {any} */ props) {
      if (typeof PrimitiveCheckbox === "function") {
        return h(PrimitiveCheckbox, {
          checked: props.checked === true,
          disabled: props.disabled === true,
          label: props.label,
          onChange: props.onChange,
        });
      }
      return h(
        "label",
        { style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
        h("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (/** @type {any} */ event) => props.onChange?.(event.target.checked),
        }),
        props.label ? h("span", null, props.label) : null,
      );
    }

    /** 开关：优先宿主原语，缺失时回退到复选框。 */
    function Toggle(/** @type {any} */ props) {
      if (typeof PrimitiveSwitch === "function") {
        return h(PrimitiveSwitch, {
          checked: props.checked === true,
          disabled: props.disabled === true,
          label: props.label,
          onChange: props.onChange,
        });
      }
      return h(Check, props);
    }

    /** 折叠三角：纯文本字形，避免依赖宿主图标名（缺失时不会变成空白）。 */
    function Caret(/** @type {any} */ props) {
      return h(
        "span",
        {
          "aria-hidden": "true",
          style: {
            display: "inline-block",
            width: "10px",
            color: T.faint,
            transform: props.open ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
            fontSize: "10px",
          },
        },
        "▶",
      );
    }

    /** 一行可折叠的「标题 + 说明 + 右侧控件」。 */
    function SettingRow(/** @type {any} */ props) {
      return h(
        "div",
        { className: "dsh-sdel-setting-row" },
        h(
          "div",
          { className: "dsh-sdel-setting-text" },
          h("div", { className: "dsh-sdel-setting-title" }, props.title),
          props.description
            ? h("div", { className: "dsh-sdel-setting-desc" }, props.description)
            : null,
          props.children,
        ),
        props.action ? h("div", { className: "dsh-sdel-setting-action" }, props.action) : null,
      );
    }

    /** 折叠区：默认关闭，展开后限高滚动 —— 长列表不会把弹窗/设置页撑长。 */
    function Disclosure(/** @type {any} */ props) {
      var state = React.useState(false);
      var open = state[0];
      var setOpen = state[1];
      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            type: "button",
            className: "dsh-sdel-disclosure",
            "aria-expanded": open ? "true" : "false",
            onClick: () => setOpen(!open),
          },
          h(Caret, { open: open }),
          h("span", null, props.label),
          props.meta ? h("span", { className: "dsh-sdel-disclosure-meta" }, props.meta) : null,
        ),
        open
          ? h(
              "div",
              {
                style: {
                  maxHeight: props.maxHeight || "220px",
                  overflowY: "auto",
                  padding: "2px 0 8px 16px",
                  color: T.dim,
                  fontSize: "12px",
                  lineHeight: 1.7,
                },
              },
              props.children,
            )
          : null,
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
          h(Reveal, null, props.children),
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
          // macOS 上覆盖页头的浮层必须显式声明窗口拖动排除，否则拖动会变成拖窗口。
          "data-window-drag-exclude": "",
          onClick: props.onClose,
        },
        h(
          Reveal,
          { style: { width: "min(480px, 92vw)" } },
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

    /**
     * 中文/英文共用的列表连接符：把数组拼成一行，超过 max 条时补省略号。
     * @param {any[]} items
     * @param {number} [max]
     * @returns {string}
     */
    function joinList(items, max = 6) {
      var list = (Array.isArray(items) ? items : []).map((/** @type {any} */ item) =>
        String(
          item && typeof item === "object" ? (item.label ?? item.title ?? item.id ?? "") : item,
        ),
      );
      var shown = list.slice(0, max);
      return shown.join(" · ") + (list.length > max ? " …" : "");
    }

    /**
     * 把数组切成固定大小的批次：回收站 80 条时一次 RPC 会被宿主上限拒绝，
     * 界面必须分批并把进度显示出来（0.4.x 的 bug：整单被拒，看起来像没反应）。
     * @param {any[]} items
     * @param {number} size
     * @returns {any[][]}
     */
    function chunk(items, size) {
      var step = Math.max(1, Math.floor(size) || 1);
      /** @type {any[][]} */
      var out = [];
      for (let index = 0; index < (items || []).length; index += step) {
        out.push(items.slice(index, index + step));
      }
      return out;
    }

    /**
     * 确认框正文的一行影响面：只拼成立的事实，用 `·` 分隔。
     * 空值不进数组 —— 这是「不显示占位行」这条规则的单点实现。
     * @param {{ sizeBytes?: number, live?: boolean, children?: any[] }} plan
     * @param {(key: string, values?: any) => string} t
     * @returns {string}
     */
    function impactLine(plan, t) {
      /** @type {string[]} */
      var facts = [];
      if (plan && typeof plan.sizeBytes === "number") {
        facts.push(t("confirm.size", { size: formatBytes(plan.sizeBytes) }));
      }
      var children = Array.isArray(plan?.children) ? plan.children.length : 0;
      if (children > 0) facts.push(t("confirm.children", { n: children }));
      if (plan?.live) facts.push(t("confirm.live"));
      return facts.join(" · ");
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
          className: "dsh-sdel-btn dsh-sdel-btn--danger",
          style: { display: "block", width: "100%", textAlign: "left", padding: "6px 12px" },
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
                  color: T.dangerText,
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

    /**
     * 删除确认框：三行正文（标题 / 影响面 / 引用）+ 一行级联勾选 + 折叠详情。
     * 默认焦点在「移入回收站」上（回车即生效），Esc 取消；不可删除时焦点回落到「取消」。
     */
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
      var confirmRef = React.useRef(null);
      var cancelRef = React.useRef(null);

      /** 偏好只决定「初值」：用户这次勾了什么，下次就带过来。 */
      var rememberCascade = (/** @type {any} */ next) => {
        setCascade(next);
        props.prefsStore.set({ cascadeChildren: next });
        props.call("setPrefs", { cascadeChildren: next }).catch(() => {});
      };

      React.useEffect(() => {
        if (!requestId) {
          setPlan(null);
          setError(null);
          setBusy(false);
          return undefined;
        }
        var alive = true;
        setPlan(null);
        setError(null);
        setCascade(props.prefsStore.getSnapshot()?.cascadeChildren === true);
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

      // hooks 必须在任何 return 之前：确认框组件常驻挂载，提前 return 会让 hook 数量在
      // 「有请求 / 无请求」两种渲染之间变化，React 会直接抛 rendered more hooks 错误。
      var blocked = (plan?.blockers?.length ?? 0) > 0;
      var children = plan && Array.isArray(plan.children) ? plan.children : [];
      var removes = plan && Array.isArray(plan.removes) ? plan.removes : [];
      var canConfirm = !!plan && !blocked && !busy;

      /** 焦点策略：可确认时落在破坏性按钮（回车即删），否则落在「取消」。 */
      React.useEffect(() => {
        if (!request) return;
        var target = canConfirm ? confirmRef.current : cancelRef.current;
        if (target && typeof target.focus === "function") target.focus();
      }, [canConfirm, plan, request]);

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

      var body = h(
        React.Fragment,
        null,
        request.title
          ? h(
              "div",
              {
                className: "dsh-sdel-truncate",
                style: { fontWeight: 600, marginBottom: "4px" },
                title: request.title,
              },
              request.title,
            )
          : null,
        plan
          ? h(
              "div",
              { style: { color: T.dim } },
              impactLine(plan, props.t) || props.t("confirm.size", { size: "?" }),
            )
          : h("div", { style: { color: T.dim } }, props.t("confirm.loading")),
        removes.length > 0
          ? h(
              "div",
              { style: { color: T.faint, fontSize: "12px", marginTop: "2px" } },
              props.t("confirm.refs", { n: removes.length }),
            )
          : null,
        children.length > 0
          ? h(
              "div",
              { style: { marginTop: "10px" } },
              h(Check, {
                checked: cascade,
                disabled: busy,
                label: props.t("confirm.cascade", { n: children.length }),
                onChange: rememberCascade,
              }),
            )
          : null,
        blocked
          ? h(
              "div",
              { style: { color: T.danger, marginTop: "10px" }, role: "alert" },
              props.t("confirm.blocked", { reason: plan.blockers[0].message }),
            )
          : null,
        error ? h("div", { style: { color: T.danger, marginTop: "8px" } }, error) : null,
        plan
          ? h(
              "div",
              { style: { marginTop: "10px" } },
              h(
                Disclosure,
                { label: props.t("confirm.details"), meta: null, maxHeight: "180px" },
                removes.length > 0
                  ? h("div", null, props.t("confirm.detail.refs", { list: joinList(removes) }))
                  : null,
                children.length > 0
                  ? h("div", null, props.t("confirm.detail.children", { list: joinList(children) }))
                  : null,
                plan.trashPath
                  ? h("div", null, props.t("confirm.detail.trashPath", { path: plan.trashPath }))
                  : null,
                h("div", null, props.t("confirm.detail.recoverable")),
              ),
            )
          : null,
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
            h(
              Btn,
              { innerRef: cancelRef, onClick: close, disabled: busy },
              props.t("confirm.cancel"),
            ),
            h(
              Btn,
              {
                innerRef: confirmRef,
                modalAutofocus: true,
                onClick: confirm,
                variant: "danger",
                disabled: !canConfirm,
              },
              busy ? props.t("confirm.pending") : props.t("confirm.confirm"),
            ),
          ),
        },
        body,
      );
    }

    /**
     * 回收站面板：只有一件事 —— 看列表、选条目、恢复或彻底删除。
     * 批量条固定在列表上方（不随内容滚动），80 条时也不会「找不到按钮」。
     */
    function TrashPanel(/** @type {any} */ props) {
      var panelState = useStore(props.panelStore);
      var open = panelState[0];
      var dataState = React.useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyIdState = React.useState(null);
      var busyId = busyIdState[0];
      var setBusyId = busyIdState[1];
      var confirmPurgeState = React.useState(null);
      var confirmPurge = confirmPurgeState[0];
      var setConfirmPurge = confirmPurgeState[1];
      var selectedState = React.useState({});
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var batchState = React.useState(null);
      var batch = batchState[0];
      var setBatch = batchState[1];
      var readOnlyState = React.useState(false);
      var readOnly = readOnlyState[0];
      var setReadOnly = readOnlyState[1];
      var batchControl = React.useRef({ stop: false });

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
            setReadOnly(value?.readOnly === true);
          })
          .catch(() => {});
        // 面板打开期间自动同步：agent 工具、另一个窗口都可能改动回收站。
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

      if (!open) return null;

      var entries = data?.entries || [];
      var selectedIds = Object.keys(selected).filter(
        (/** @type {string} */ entryId) => selected[entryId],
      );
      var allSelected = entries.length > 0 && selectedIds.length === entries.length;
      var batchRunning = batch?.running === true;

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

      /**
       * 分批执行批量动作。宿主单次上限是防御性的硬上限，界面按 BATCH_CHUNK 切块，
       * 每块之间让出一帧：进度可见、可中途停止、部分失败不中断其余批次。
       * @param {string[]} ids
       * @param {"purge" | "restore"} kind
       */
      var runBatch = (ids, kind) => {
        if (ids.length === 0 || batchRunning) return;
        batchControl.current = { stop: false };
        /** @type {any[]} */
        var failures = [];
        var done = 0;
        setBatch({ kind: kind, running: true, done: 0, total: ids.length, failures: [] });
        var groups = chunk(ids, BATCH_CHUNK);
        (async () => {
          for (let index = 0; index < groups.length; index += 1) {
            if (batchControl.current.stop) break;
            const group = groups[index];
            try {
              const result = await props.call(kind === "purge" ? "purgeMany" : "restoreMany", {
                entryIds: group,
              });
              for (let itemIndex = 0; itemIndex < (result?.results || []).length; itemIndex += 1) {
                const item = result.results[itemIndex];
                if (!item.ok) failures.push(item);
                else if (kind === "restore" && item.sessionId) props.onRestored?.(item.sessionId);
              }
            } catch (reason) {
              for (let groupIndex = 0; groupIndex < group.length; groupIndex += 1) {
                failures.push({ entryId: group[groupIndex], ok: false, error: errorText(reason) });
              }
            }
            done += group.length;
            setBatch({
              kind: kind,
              running: done < ids.length,
              done: done,
              total: ids.length,
              failures: failures.slice(),
            });
            // 让出一帧：让「处理中 n/total」和「停止」真的可见、可点。
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          setSelected((/** @type {any} */ current) => {
            /** @type {Record<string, boolean>} */
            var keep = {};
            for (let index2 = 0; index2 < failures.length; index2 += 1) {
              if (current[failures[index2].entryId]) keep[failures[index2].entryId] = true;
            }
            return keep;
          });
          setConfirmPurge(null);
          setBatch({
            kind: kind,
            running: false,
            done: done,
            total: ids.length,
            failures: failures.slice(),
          });
          refresh();
          props.bump?.();
          if (kind === "purge") props.onPurged?.(undefined);
        })();
      };

      var toolbar = h(
        "div",
        { className: "dsh-sdel-toolbar" },
        h(Check, {
          checked: allSelected,
          disabled: batchRunning || entries.length === 0,
          label:
            selectedIds.length > 0
              ? props.t("trash.selectCount", { n: selectedIds.length, total: entries.length })
              : props.t("trash.selectAll"),
          onChange: (/** @type {any} */ next) => {
            /** @type {Record<string, boolean>} */
            var map = {};
            if (next) {
              for (let index = 0; index < entries.length; index += 1) {
                map[entries[index].entryId] = true;
              }
            }
            setSelected(map);
          },
        }),
        h("span", { style: { flex: 1 } }),
        h(
          Btn,
          {
            disabled: batchRunning || selectedIds.length === 0,
            onClick: () => runBatch(selectedIds, "restore"),
          },
          props.t("trash.restoreMany", { n: selectedIds.length }),
        ),
        h(
          Btn,
          {
            variant: "danger",
            disabled: batchRunning || selectedIds.length === 0,
            onClick: () => setConfirmPurge("__batch__"),
          },
          props.t("trash.purgeMany", { n: selectedIds.length }),
        ),
      );

      var batchLine = batch
        ? h(
            "div",
            { className: "dsh-sdel-batch" },
            h(
              "span",
              { role: "status" },
              batch.running
                ? props.t("batch.progress", { done: batch.done, total: batch.total })
                : props.t("batch.done", {
                    ok: batch.total - batch.failures.length,
                    total: batch.total,
                  }),
            ),
            batch.failures.length > 0
              ? h(
                  "span",
                  { style: { color: T.danger } },
                  props.t("batch.failed", { n: batch.failures.length }),
                )
              : null,
            batch.running
              ? h(
                  Btn,
                  {
                    tight: true,
                    onClick: () => {
                      batchControl.current.stop = true;
                    },
                  },
                  props.t("batch.stop"),
                )
              : null,
          )
        : null;

      var confirmLine =
        confirmPurge === "__batch__"
          ? h(
              "div",
              { className: "dsh-sdel-confirm" },
              h("span", null, props.t("trash.purgeManyConfirm", { n: selectedIds.length })),
              h(
                Btn,
                {
                  tight: true,
                  variant: "danger",
                  onClick: () => runBatch(selectedIds, "purge"),
                },
                props.t("panel.purge"),
              ),
              h(
                Btn,
                { tight: true, onClick: () => setConfirmPurge(null) },
                props.t("panel.cancelConfirm"),
              ),
            )
          : null;

      var rows = [];
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex];
        const confirmThis = confirmPurge === entry.entryId;
        rows.push(
          h(
            "div",
            { key: entry.entryId, className: "dsh-sdel-row" },
            h(Check, {
              checked: Boolean(selected[entry.entryId]),
              disabled: batchRunning,
              onChange: () =>
                setSelected((/** @type {any} */ current) => ({
                  ...current,
                  [entry.entryId]: !current[entry.entryId],
                })),
            }),
            h(
              "span",
              {
                className: "dsh-sdel-row-title dsh-sdel-truncate",
                title: entry.title || entry.sessionId,
              },
              entry.title || entry.sessionId,
            ),
            h(
              "span",
              { className: "dsh-sdel-row-meta" },
              `${props.t("panel.size", { size: formatBytes(entry.bytes) })} · ${props.t("panel.trashedAt", { time: formatTime(entry.trashedAt) })}`,
            ),
            confirmThis
              ? h(
                  "span",
                  { className: "dsh-sdel-row-actions dsh-sdel-row-actions--open" },
                  h(
                    Btn,
                    {
                      tight: true,
                      variant: "danger",
                      onClick: () => doPurge(entry.entryId, entry.sessionId),
                    },
                    props.t("panel.purgeConfirm"),
                  ),
                  h(
                    Btn,
                    { tight: true, onClick: () => setConfirmPurge(null) },
                    props.t("panel.cancelConfirm"),
                  ),
                )
              : h(
                  "span",
                  { className: "dsh-sdel-row-actions" },
                  h(
                    Btn,
                    {
                      tight: true,
                      disabled: busyId === entry.entryId || batchRunning,
                      onClick: () => doRestore(entry.entryId, entry.sessionId),
                    },
                    props.t("panel.restore"),
                  ),
                  h(
                    Btn,
                    {
                      tight: true,
                      variant: "danger",
                      disabled: busyId === entry.entryId || batchRunning,
                      onClick: () => setConfirmPurge(entry.entryId),
                    },
                    props.t("panel.purge"),
                  ),
                ),
          ),
        );
      }

      var body = h(
        React.Fragment,
        null,
        readOnly
          ? h(
              "div",
              { style: { color: T.danger, marginBottom: "10px" } },
              props.t("panel.readOnly"),
            )
          : null,
        error ? h("div", { style: { color: T.danger, marginBottom: "10px" } }, error) : null,
        entries.length === 0
          ? h("div", { style: { color: T.dim, padding: "12px 0" } }, props.t("panel.empty"))
          : h(
              "div",
              { className: "dsh-sdel-panel" },
              toolbar,
              confirmLine,
              batchLine,
              h("div", { className: "dsh-sdel-list" }, rows),
            ),
        (data?.unknown?.length ?? 0) > 0
          ? h(
              "div",
              { style: { color: T.faint, fontSize: "12px", marginTop: "8px" } },
              props.t("panel.unknown", { n: data.unknown.length }),
            )
          : null,
        (data?.pending?.length ?? 0) > 0
          ? h(
              "div",
              { style: { color: T.faint, fontSize: "12px", marginTop: "4px" } },
              props.t("panel.pending", { n: data.pending.length }),
            )
          : null,
      );

      return h(
        Dialog,
        {
          onClose: () => {
            if (batchRunning) return;
            props.panelStore.set(false);
          },
          closeLabel: props.t("panel.close"),
          title: props.t("panel.title"),
          footer: h(
            Btn,
            {
              onClick: () => {
                props.panelStore.set(false);
              },
              disabled: batchRunning,
            },
            props.t("panel.close"),
          ),
        },
        body,
      );
    }

    /**
     * 设置页「会话回收站」：偏好 + 回收站概览 + 维护（体检/回执/审计）。
     * 原来这四块是回收站面板里的四个页签，搬到这里后主面板只剩一件事。
     */
    function SettingsSection(/** @type {any} */ props) {
      var prefsState = useStore(props.prefsStore);
      var prefs = prefsState[0];
      var infoState = React.useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var healthState = React.useState(null);
      var health = healthState[0];
      var setHealth = healthState[1];
      var healthErrorState = React.useState(null);
      var healthError = healthErrorState[0];
      var setHealthError = healthErrorState[1];
      var receiptsState = React.useState(null);
      var receipts = receiptsState[0];
      var setReceipts = receiptsState[1];
      var auditState = React.useState(null);
      var audit = auditState[0];
      var setAudit = auditState[1];
      var cleaningState = React.useState(false);
      var cleaning = cleaningState[0];
      var setCleaning = cleaningState[1];
      var confirmCleanState = React.useState(false);
      var confirmClean = confirmCleanState[0];
      var setConfirmClean = confirmCleanState[1];
      var msgState = React.useState("");
      var message = msgState[0];
      var setMessage = msgState[1];

      React.useEffect(() => {
        var alive = true;
        props
          .call("list")
          .then((/** @type {any} */ value) => {
            if (alive) setInfo(value);
          })
          .catch(() => {});
        props
          .call("healthScan")
          .then((/** @type {any} */ value) => {
            if (alive) setHealth(value);
          })
          .catch((/** @type {any} */ reason) => {
            if (alive) setHealthError(errorText(reason));
          });
        props
          .call("receipts", { limit: 50 })
          .then((/** @type {any} */ value) => {
            if (alive) setReceipts(value?.entries || []);
          })
          .catch(() => {});
        props
          .call("audit", { limit: 100 })
          .then((/** @type {any} */ value) => {
            if (alive) setAudit(value?.entries || []);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      var entries = info?.entries || [];
      var totalBytes = 0;
      for (let index = 0; index < entries.length; index += 1) {
        totalBytes += Number(entries[index].bytes) || 0;
      }
      var cascade = prefs ? prefs.cascadeChildren === true : false;

      var setCascade = (/** @type {any} */ next) => {
        props.prefsStore.set({ cascadeChildren: next });
        props.call("setPrefs", { cascadeChildren: next }).catch(() => {});
      };

      var cleanable = health?.ok ? health.cleanable : null;
      var cleanRows = [];
      if (confirmClean && cleanable && cleanable.total > 0) {
        cleanRows.push(
          h(
            "div",
            { key: "confirm", style: { display: "flex", gap: "8px", alignItems: "center" } },
            h(
              "span",
              { style: { color: T.danger, fontSize: "12px" } },
              props.t("settings.health.cleanConfirm", { n: cleanable.total }),
            ),
            h(
              Btn,
              {
                tight: true,
                variant: "danger",
                disabled: cleaning,
                onClick: () => {
                  setCleaning(true);
                  props
                    .call("cleanHealth", { classes: ["archived", "pinned", "workspace"] })
                    .then((/** @type {any} */ result) => {
                      setCleaning(false);
                      setConfirmClean(false);
                      setMessage(props.t("settings.health.cleaned", { n: result.total }));
                    })
                    .catch((/** @type {any} */ reason) => {
                      setCleaning(false);
                      setMessage(errorText(reason));
                    });
                },
              },
              props.t("settings.health.clean", { n: cleanable.total }),
            ),
            h(
              Btn,
              { tight: true, onClick: () => setConfirmClean(false) },
              props.t("confirm.cancel"),
            ),
          ),
        );
      }

      return h(
        "div",
        { className: "dsh-sdel-settings" },
        h("div", { className: "dsh-sdel-group" }, props.t("settings.group.delete")),
        h(SettingRow, {
          title: props.t("settings.cascade.title"),
          description: props.t("settings.cascade.desc"),
          action: h(Toggle, {
            checked: cascade,
            label: props.t("settings.cascade.title"),
            onChange: setCascade,
          }),
        }),
        h(SettingRow, {
          title: "",
          description: null,
          action: h(
            Btn,
            {
              tight: true,
              disabled: !cascade,
              onClick: () => {
                setCascade(false);
                setMessage(props.t("settings.cascade.resetDone"));
              },
            },
            props.t("settings.cascade.reset"),
          ),
        }),
        h("div", { className: "dsh-sdel-group" }, props.t("settings.group.trash")),
        h(SettingRow, {
          title: props.t("settings.trash.summary", {
            n: entries.length,
            size: formatBytes(totalBytes),
          }),
          description: info ? info.trashRoot : null,
          action: h(
            Btn,
            {
              tight: true,
              onClick: () => {
                props.close?.();
                props.panelStore.set(true);
              },
            },
            props.t("settings.trash.open"),
          ),
        }),
        h("div", { className: "dsh-sdel-group" }, props.t("settings.group.maintenance")),
        h(SettingRow, {
          title: props.t("settings.health.title"),
          description: props.t("settings.health.desc"),
          action:
            cleanable && cleanable.total > 0
              ? h(
                  Btn,
                  { tight: true, disabled: cleaning, onClick: () => setConfirmClean(true) },
                  props.t("settings.health.items", { n: cleanable.total }),
                )
              : null,
          children: healthError
            ? h(
                "div",
                { style: { color: T.danger, fontSize: "12px" } },
                props.t("settings.health.unavailable", { reason: healthError }),
              )
            : !health
              ? h(
                  "div",
                  { style: { color: T.faint, fontSize: "12px" } },
                  props.t("settings.loading"),
                )
              : !health.ok
                ? h(
                    "div",
                    { style: { color: T.dim, fontSize: "12px" } },
                    props.t("settings.health.unavailable", { reason: health.reason || "" }),
                  )
                : health.findings && health.findings.length === 0
                  ? h(
                      "div",
                      { style: { color: T.dim, fontSize: "12px" } },
                      props.t("settings.health.ok"),
                    )
                  : h(
                      "div",
                      { style: { color: T.dim, fontSize: "12px" } },
                      joinList(
                        (health.findings || []).map((/** @type {any} */ finding) => finding.label),
                        4,
                      ),
                    ),
        }),
        cleanRows.length > 0 ? h("div", { style: { padding: "0 0 12px" } }, cleanRows) : null,
        h(
          "div",
          { className: "dsh-sdel-setting-row dsh-sdel-setting-row--stack" },
          h(
            Disclosure,
            {
              label: props.t("settings.receipts.title"),
              meta: receipts ? String(receipts.length) : "",
            },
            !receipts || receipts.length === 0
              ? h("div", null, props.t("settings.receipts.empty"))
              : receipts.map((/** @type {any} */ receipt, /** @type {any} */ receiptIndex) =>
                  h(
                    "div",
                    { key: `receipt-${receiptIndex}`, className: "dsh-sdel-truncate" },
                    `${formatTime(receipt.at)} · ${String(receipt.action || "")} · ${String(receipt.title || receipt.sessionId || "")}`,
                  ),
                ),
          ),
        ),
        h(
          "div",
          { className: "dsh-sdel-setting-row dsh-sdel-setting-row--stack" },
          h(
            Disclosure,
            { label: props.t("settings.audit.title"), meta: audit ? String(audit.length) : "" },
            !audit || audit.length === 0
              ? h("div", null, props.t("settings.audit.empty"))
              : audit
                  .slice()
                  .reverse()
                  .map((/** @type {any} */ entry, /** @type {any} */ auditIndex) =>
                    h(
                      "div",
                      { key: `audit-${auditIndex}`, className: "dsh-sdel-truncate" },
                      `${formatTime(entry.ts)} · ${String(entry.action || "")} · ${String(entry.result || "")}${entry.detail ? ` · ${entry.detail}` : ""}`,
                    ),
                  ),
          ),
        ),
        message
          ? h("div", { style: { color: T.dim, fontSize: "12px", paddingTop: "8px" } }, message)
          : null,
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
            prefsStore: props.prefsStore,
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

    /** 单批条目数：既让「处理中 n/total」有节奏，也避免一次 RPC 太久没有反馈。 */
    var BATCH_CHUNK = 20;

    exports.inject = ["slots", "locale", "connection"];
    exports.apply = function apply(/** @type {any} */ ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "session-delete: dictionaries");

      /** @type {(key: string) => string} */
      var translate;
      var fallbackTranslate = (/** @type {string} */ key) =>
        /** @type {Record<string, string>} */ (zh)[key] || key;
      try {
        translate =
          ctx.locale && typeof ctx.locale.bind === "function"
            ? ctx.locale.bind(NS)
            : fallbackTranslate;
      } catch (_error) {
        translate = fallbackTranslate;
      }

      // 用真实的 :hover / :focus-visible 伪类，避免依赖 React 合成事件与内联样式。
      // 原则：控件外观只调宿主 token；行高与间距对齐设置页（16px 竖向留白、.5px 分隔线）。
      ctx.effect(() => {
        const style = document.createElement("style");
        // 标注归属：便于在 DevTools 里认出这段样式、也方便测试断言插件确实加载了。
        style.setAttribute("data-plugin", "@kangyishuai/dsh-session-delete");
        style.textContent = [
          ".dsh-sdel-btn{background:transparent;color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));transition:background-color 150ms ease,border-color 150ms ease,transform 80ms ease,color 150ms ease;white-space:nowrap;}",
          ".dsh-sdel-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}",
          ".dsh-sdel-btn:active:enabled{transform:scale(.98);}",
          ".dsh-sdel-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px;}",
          ".dsh-sdel-btn--danger{color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-sdel-btn--danger:hover:enabled{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(217,83,79,.16));}",
          ".dsh-sdel-btn--quiet{border-color:transparent;}",
          ".dsh-sdel-btn--tight{padding:2px 8px;border-radius:6px;font-size:12px;}",
          ".dsh-sdel-footer{background:transparent;color:var(--dsw-alias-label-secondary,GrayText);border:1px solid transparent;border-radius:8px;transition:background-color 150ms ease,color 150ms ease;}",
          ".dsh-sdel-footer:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,inherit);}",
          ".dsh-sdel-footer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px;}",
          ".dsh-sdel-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
          ".dsh-sdel-panel{display:flex;flex-direction:column;gap:8px;min-height:0;}",
          ".dsh-sdel-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
          ".dsh-sdel-list{max-height:min(56vh,520px);overflow-y:auto;border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));}",
          ".dsh-sdel-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));}",
          ".dsh-sdel-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}",
          ".dsh-sdel-row-title{flex:1;font-size:13px;}",
          ".dsh-sdel-row-meta{color:var(--dsw-alias-label-tertiary,GrayText);font-size:11px;white-space:nowrap;}",
          ".dsh-sdel-row-actions{display:flex;gap:6px;opacity:0;transition:opacity 120ms ease;}",
          ".dsh-sdel-row:hover .dsh-sdel-row-actions,.dsh-sdel-row:focus-within .dsh-sdel-row-actions,.dsh-sdel-row-actions--open{opacity:1;}",
          ".dsh-sdel-batch{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,GrayText);}",
          ".dsh-sdel-confirm{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(217,83,79,.12));font-size:12px;color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-sdel-disclosure{display:flex;align-items:center;gap:6px;background:transparent;border:none;padding:2px 0;cursor:pointer;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;font-family:inherit;}",
          ".dsh-sdel-disclosure:hover{color:var(--dsw-alias-label-primary,inherit);}",
          ".dsh-sdel-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:2px;border-radius:4px;}",
          ".dsh-sdel-disclosure-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary,GrayText);}",
          ".dsh-sdel-settings{display:flex;flex-direction:column;width:100%;}",
          ".dsh-sdel-group{color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;font-weight:600;padding:20px 0 4px;}",
          ".dsh-sdel-setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));}",
          ".dsh-sdel-setting-row--stack{display:block;}",
          ".dsh-sdel-setting-text{min-width:0;flex:1;}",
          ".dsh-sdel-setting-title{color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:22px;}",
          ".dsh-sdel-setting-desc{color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;line-height:18px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
          ".dsh-sdel-setting-action{display:flex;align-items:center;gap:8px;flex:none;}",
        ].join("\n");
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-delete: styles");

      var requestStore = createStore(null);
      var panelStore = createStore(false);
      var toastStore = createStore(null);
      var tickStore = createStore(0);
      var prefsStore = createStore(null);

      /**
       * 调宿主 sessionDelete 的 Remote 方法。走 /api 的普通 RPC 通道：
       * 无构建插件没有 typert 生成的客户端产物，不能用 ctx.reflect.get。
       * @param {string} method
       * @param {any} [request]
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

      /** 偏好只加载一次：确认框与设置页共享同一份快照。 */
      var loadPrefs = () => {
        call("getPrefs")
          .then((/** @type {any} */ value) => {
            prefsStore.set(value || { cascadeChildren: false });
          })
          .catch(() => {
            prefsStore.set({ cascadeChildren: false });
          });
      };
      loadPrefs();

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

      // 设置页分节：偏好 + 回收站概览 + 维护（体检/回执/审计）。
      // 宿主没有 settings.section 的版本会静默跳过，不影响主流程。
      try {
        ctx.effect(
          () =>
            ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                {
                  name: "settings.section",
                  id: "session-delete",
                  order: 90,
                  label: () => translate("settings.nav"),
                  locale: NS,
                  inject: () => ({
                    prefsStore: prefsStore,
                    panelStore: panelStore,
                    call: call,
                  }),
                },
                SettingsSection,
              ),
            ),
          "session-delete: settings section",
        );
      } catch (error) {
        ctx.logger?.warn?.(`session-delete: settings section unavailable: ${errorText(error)}`);
      }

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
                    prefsStore: prefsStore,
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

    // 供 node:vm 单测读取的内部出口（非枚举，不影响运行时）。
    Object.defineProperty(exports, "__test", {
      value: Object.freeze({
        tokens: T,
        chunk: chunk,
        joinList: joinList,
        impactLine: impactLine,
        batchChunk: BATCH_CHUNK,
        // 词典也暴露出来：单测要比对「内联词典 / locale/*.json」的键集，防止两处漂移。
        zh: zh,
        en: en,
      }),
    });

    return module.exports;
  },
});
