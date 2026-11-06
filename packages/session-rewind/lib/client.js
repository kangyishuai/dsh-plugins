// @ts-check
// client 半：classic script，以 window.__ModuleLoader__.load 注册 factory，不能使用 import。
// 功能：
// ① 聊天快照可见性层（把每次回溯的 [target,marker] 区间节点标记 hidden）；
// ② 每条用户消息旁的 ↶ 按钮；③ 连按两次 Esc 打开回溯对话框；
// ④ shell.overlay 里的候选列表（分页 + 搜索）、确认浮层（预览影响面 + 模式二选一）与 toast；
// ⑤ 回溯成功后把目标消息与图片回填输入框，并刷新对话；
// ⑥ 回溯抽屉（已撤回 / 回溯记录 / 救援点 / 设置+诊断），入口是会话头部图标和 toast「查看」；
// ⑦ /rewind 命令装饰（候选弹层）与本地偏好（localStorage）。
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
      "dialog.confirm": "开始回退",
      "dialog.executing": "正在回退…",
      "dialog.loading": "正在读取…",
      "dialog.empty": "没有可回溯的消息。",
      "dialog.previewLoading": "正在计算影响面…",
      "dialog.previewFailed": "无法获取预览：{message}",
      "dialog.previewUnavailable": "预览不可用，将按「仅回退对话」执行。",
      "button.rewind": "回退到此处",
      "confirm.summary": "将撤回 {n} 条消息（约 {tokens} token）",
      "confirm.modeTitle": "回退范围",
      "confirm.modeChat": "仅回退对话",
      "confirm.modeChatHint": "只截断上下文，不动工作区文件",
      "confirm.modeBoth": "回退对话和文件",
      "confirm.modeBothHint": "截断上下文，并还原工作区文件",
      "confirm.filesNone": "无文件变更",
      "confirm.filesConflicts": "有 {n} 个文件与预期不一致，无法执行文件回退",
      "confirm.filesUnavailable": "当前无法回退文件",
      "confirm.fileSummary": "将还原 {restored} 个文件、移入回收站 {trashed} 个",
      "confirm.pathsMore": "展开全部 {n} 个路径",
      "confirm.pathsLess": "收起路径",
      "confirm.skipped": "{n} 个文件被跳过",
      "confirm.conflictsTitle": "冲突文件（前 5 个）",
      "confirm.busy": "当前回合仍在运行，请先停止后再回退",
      "confirm.openToolCall": "目标之后有未完成的工具调用，回溯会截断它",
      "toast.done": "已回退到此处，原消息已放回输入框",
      "toast.draft": "已回退；输入框已有内容，未覆盖",
      "toast.noComposer": "已回退，但未找到输入框",
      "toast.rewound": "已回退 {n} 条消息（约 {tokens} token）",
      "toast.rewoundFiles": "，还原 {restored} 个文件、移入回收站 {trashed} 个",
      "toast.rewoundFailed": "，{n} 个文件处理失败",
      "toast.draftKept": "；输入框已有内容，未覆盖",
      "toast.noComposerSuffix": "；未找到输入框",
      "toast.view": "查看",
      "toast.copied": "已复制",
      "toast.copyFailed": "复制失败",
      "toast.refilled": "已放回输入框",
      "toast.refillDraft": "输入框已有内容，未覆盖",
      "toast.refillNoComposer": "未找到输入框",
      "toast.rescueDone": "已从救援点恢复 {restored} 个文件",
      "toast.rescuePartial": "已恢复 {restored} 个文件，{failed} 个失败",
      "list.search": "搜索消息…",
      "list.searchEmpty": "没有匹配的消息。",
      "list.loadOlder": "加载更早",
      "list.filesBadge": "{n} 个文件",
      "drawer.title": "回溯面板",
      "drawer.close": "关闭",
      "drawer.refresh": "刷新",
      "drawer.openAria": "打开回溯面板",
      "drawer.tab.ghost": "已撤回",
      "drawer.tab.audit": "回溯记录",
      "drawer.tab.rescues": "救援点",
      "drawer.tab.settings": "设置",
      "ghost.empty": "还没有撤回记录",
      "ghost.cutMeta": "撤回 {n} 条消息",
      "ghost.search": "搜索已撤回内容…",
      "ghost.loadOlder": "加载更早",
      "ghost.copy": "复制",
      "ghost.refill": "放回输入框",
      "ghost.noText": "（无文本）",
      "ghost.loadFailed": "无法加载已撤回内容：{message}",
      "ghost.mode.chat": "仅对话",
      "ghost.mode.both": "对话+文件",
      "audit.empty": "还没有回溯记录",
      "audit.meta": "{mode} · {n} 条 · 约 {tokens} token",
      "audit.files": "文件：还原 {restored}、回收站 {trashed}、跳过 {skipped}、失败 {failed}",
      "audit.paths": "查看 {n} 个路径",
      "audit.pathsLess": "收起路径",
      "audit.copyJson": "复制 JSON",
      "audit.loadFailed": "无法加载回溯记录：{message}",
      "audit.rescueId": "救援点 {id}",
      "rescues.empty": "还没有救援点",
      "rescues.meta": "目标 @{seq} · {n} 个文件",
      "rescues.restore": "恢复这些文件",
      "rescues.confirm": "恢复 {n} 个文件？当前内容会先另存为新的救援点。",
      "rescues.cancel": "取消",
      "rescues.restoring": "正在恢复…",
      "rescues.completed": "已完成",
      "rescues.incomplete": "未完成",
      "rescues.loadFailed": "无法加载救援点：{message}",
      "settings.defaultMode": "默认回退范围",
      "settings.pageSize": "候选每页数量",
      "settings.confirmOnList": "从候选列表选择时先确认",
      "settings.confirmOnListHint": "关闭后，默认「仅回退对话」时会直接执行；文件模式始终先确认。",
      "settings.saved": "已保存",
      "settings.healthTitle": "诊断",
      "settings.healthRefresh": "刷新",
      "settings.healthLoading": "正在检查…",
      "settings.healthFailed": "诊断失败：{message}",
      "settings.healthOk": "正常",
      "settings.healthBad": "异常",
      "settings.usage": "占用 {bytes} · {entries} 条记录 · {sessions} 个会话 · {blobs} 个内容块",
      "settings.dataRoot": "数据目录",
      "settings.version": "版本",
      "error.busy": "请先停止当前回合（Esc）再回溯",
      "error.notFound": "会话不存在",
      "error.inert": "子代理会话不支持回溯",
      "error.badTarget": "无法定位这条消息",
      "error.notOnSurface": "这条消息已被压缩摘要遮蔽，无法回溯",
      "error.failed": "回溯失败",
      "error.filesConflict": "文件与预期不一致，未做任何修改",
      "error.filesUnavailable": "当前无法回退文件",
      "error.filesRescueFailed": "创建救援点失败，未做任何修改",
      "error.filesFailed": "部分文件处理失败",
      "error.rescueNotFound": "救援点不存在",
      "error.storageUnavailable": "存储不可用",
      "error.configInvalid": "配置无效",
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
      "dialog.confirm": "Start rewind",
      "dialog.executing": "Rewinding…",
      "dialog.loading": "Loading…",
      "dialog.empty": "No messages to rewind to.",
      "dialog.previewLoading": "Computing the impact…",
      "dialog.previewFailed": "Could not fetch the preview: {message}",
      "dialog.previewUnavailable": "Preview unavailable; this will rewind the conversation only.",
      "button.rewind": "Rewind to here",
      "confirm.summary": "This withdraws {n} message(s) (about {tokens} tokens).",
      "confirm.modeTitle": "Scope",
      "confirm.modeChat": "Rewind conversation only",
      "confirm.modeChatHint": "Truncates context; workspace files stay untouched",
      "confirm.modeBoth": "Rewind conversation and files",
      "confirm.modeBothHint": "Truncates context and restores workspace files",
      "confirm.filesNone": "No file changes",
      "confirm.filesConflicts":
        "{n} file(s) differ from the expected state; file rewind is unavailable",
      "confirm.filesUnavailable": "File rewind is unavailable",
      "confirm.fileSummary": "Restore {restored} file(s), move {trashed} new file(s) to trash",
      "confirm.pathsMore": "Show all {n} paths",
      "confirm.pathsLess": "Hide paths",
      "confirm.skipped": "{n} file(s) skipped",
      "confirm.conflictsTitle": "Conflicting files (first 5)",
      "confirm.busy": "The turn is still running; stop it before rewinding.",
      "confirm.openToolCall": "An unfinished tool call follows the target; rewinding truncates it.",
      "toast.done": "Rewound. The original message is back in the composer.",
      "toast.draft": "Rewound. The composer already had content, so it was kept.",
      "toast.noComposer": "Rewound, but no composer was found.",
      "toast.rewound": "Rewound {n} message(s) (about {tokens} tokens)",
      "toast.rewoundFiles": "; restored {restored} file(s), trashed {trashed}",
      "toast.rewoundFailed": "; {n} file(s) failed",
      "toast.draftKept": "; the composer already had content, so it was kept",
      "toast.noComposerSuffix": "; no composer was found",
      "toast.view": "View",
      "toast.copied": "Copied",
      "toast.copyFailed": "Copy failed",
      "toast.refilled": "Put back in the composer",
      "toast.refillDraft": "The composer already had content, so it was kept",
      "toast.refillNoComposer": "No composer was found",
      "toast.rescueDone": "Restored {restored} file(s) from the rescue point",
      "toast.rescuePartial": "Restored {restored} file(s); {failed} failed",
      "list.search": "Search messages…",
      "list.searchEmpty": "No matching messages.",
      "list.loadOlder": "Load older",
      "list.filesBadge": "{n} file(s)",
      "drawer.title": "Rewind panel",
      "drawer.close": "Close",
      "drawer.refresh": "Refresh",
      "drawer.openAria": "Open the rewind panel",
      "drawer.tab.ghost": "Withdrawn",
      "drawer.tab.audit": "History",
      "drawer.tab.rescues": "Rescue points",
      "drawer.tab.settings": "Settings",
      "ghost.empty": "No withdrawn messages yet",
      "ghost.cutMeta": "{n} message(s) withdrawn",
      "ghost.search": "Search withdrawn messages…",
      "ghost.loadOlder": "Load older",
      "ghost.copy": "Copy",
      "ghost.refill": "Put in composer",
      "ghost.noText": "(no text)",
      "ghost.loadFailed": "Could not load withdrawn messages: {message}",
      "ghost.mode.chat": "Conversation",
      "ghost.mode.both": "Conversation + files",
      "audit.empty": "No rewind history yet",
      "audit.meta": "{mode} · {n} message(s) · about {tokens} tokens",
      "audit.files":
        "Files: {restored} restored, {trashed} trashed, {skipped} skipped, {failed} failed",
      "audit.paths": "Show {n} path(s)",
      "audit.pathsLess": "Hide paths",
      "audit.copyJson": "Copy JSON",
      "audit.loadFailed": "Could not load rewind history: {message}",
      "audit.rescueId": "Rescue {id}",
      "rescues.empty": "No rescue points yet",
      "rescues.meta": "Target @{seq} · {n} file(s)",
      "rescues.restore": "Restore these files",
      "rescues.confirm":
        "Restore {n} file(s)? The current content is saved as a new rescue point first.",
      "rescues.cancel": "Cancel",
      "rescues.restoring": "Restoring…",
      "rescues.completed": "Complete",
      "rescues.incomplete": "Incomplete",
      "rescues.loadFailed": "Could not load rescue points: {message}",
      "settings.defaultMode": "Default scope",
      "settings.pageSize": "Candidates per page",
      "settings.confirmOnList": "Confirm before executing from the list",
      "settings.confirmOnListHint":
        "When off, the default conversation-only mode runs directly; file mode always asks first.",
      "settings.saved": "Saved",
      "settings.healthTitle": "Diagnostics",
      "settings.healthRefresh": "Refresh",
      "settings.healthLoading": "Checking…",
      "settings.healthFailed": "Diagnostics failed: {message}",
      "settings.healthOk": "OK",
      "settings.healthBad": "Problem",
      "settings.usage": "{bytes} used · {entries} entries · {sessions} sessions · {blobs} blobs",
      "settings.dataRoot": "Data root",
      "settings.version": "Version",
      "error.busy": "Stop the current turn first (Esc), then rewind.",
      "error.notFound": "Session not found.",
      "error.inert": "Subagent sessions cannot be rewound.",
      "error.badTarget": "That message could not be located.",
      "error.notOnSurface":
        "That message was shadowed by a compaction summary and cannot be rewound.",
      "error.failed": "Rewind failed.",
      "error.filesConflict": "Files differ from the expected state; nothing was changed.",
      "error.filesUnavailable": "File rewind is unavailable.",
      "error.filesRescueFailed": "Could not create the rescue point; nothing was changed.",
      "error.filesFailed": "Some files could not be processed.",
      "error.rescueNotFound": "Rescue point not found.",
      "error.storageUnavailable": "Storage unavailable.",
      "error.configInvalid": "Invalid configuration.",
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
        case "files-conflict":
          return "error.filesConflict";
        case "files-unavailable":
          return "error.filesUnavailable";
        case "files-rescue-failed":
          return "error.filesRescueFailed";
        case "files-failed":
          return "error.filesFailed";
        case "rescue-not-found":
          return "error.rescueNotFound";
        case "storage-unavailable":
          return "error.storageUnavailable";
        case "config-invalid":
          return "error.configInvalid";
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
    // 客户端偏好 / 预览 / 抽屉数据的纯函数（vm 单测通过 exports.__test 覆盖）
    // ------------------------------------------------------------------

    /** localStorage 偏好键；版本化，方便未来迁移。 */
    let PREF_STORAGE_KEY = "dsh-session-rewind.prefs.v1";

    /** 客户端偏好默认值：默认仅回退对话、每页 100 条、列表选择先确认。 */
    let PREF_DEFAULTS = Object.freeze({
      defaultMode: "chat",
      pageSize: 100,
      confirmOnList: true,
    });

    /** 候选每页数量的合法范围。 */
    let PAGE_SIZE_MIN = 20;
    let PAGE_SIZE_MAX = 500;

    /** 抽屉的四个 tab（顺序即渲染顺序）。 */
    let DRAWER_TABS = ["ghost", "audit", "rescues", "settings"];

    /** 图片 media type → 文件扩展名（与宿主 composer 的图片白名单一致）。 */
    /** @type {Record<string, string>} */
    let IMAGE_EXTENSIONS = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };

    /** 把任意值收成 [min, max] 内的整数；无效值用 fallback。 */
    function clampInt(
      /** @type {any} */ value,
      /** @type {any} */ min,
      /** @type {any} */ max,
      /** @type {any} */ fallback,
    ) {
      let n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      let rounded = Math.round(n);
      if (rounded < min) return min;
      if (rounded > max) return max;
      return rounded;
    }

    /**
     * 规整客户端偏好（localStorage 里可能是旧版本、脏数据或非对象）。
     * @param {any} raw
     * @returns {{ defaultMode: "chat" | "both", pageSize: number, confirmOnList: boolean }}
     */
    function sanitizePrefs(raw) {
      let source = raw && typeof raw === "object" ? raw : {};
      return {
        defaultMode: source.defaultMode === "both" ? "both" : "chat",
        pageSize: clampInt(source.pageSize, PAGE_SIZE_MIN, PAGE_SIZE_MAX, PREF_DEFAULTS.pageSize),
        confirmOnList: source.confirmOnList !== false,
      };
    }

    /** 千分位整数（token 估算展示用）。 */
    function formatCount(/** @type {any} */ value) {
      let n =
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
      let text = String(n);
      let out = "";
      for (let i = 0; i < text.length; i += 1) {
        let remaining = text.length - i;
        if (i > 0 && remaining % 3 === 0) out += ",";
        out += text[i];
      }
      return out;
    }

    /** 人类可读的字节数（1 位小数，>=10 时取整）。 */
    function formatBytes(/** @type {any} */ value) {
      let n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
      if (n < 1024) return `${Math.round(n)} B`;
      let units = ["KB", "MB", "GB", "TB"];
      let size = n / 1024;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10} ${units[index]}`;
    }

    /** 时刻 → `HH:MM`（本地时区；无效值返回空串）。 */
    function formatClock(/** @type {any} */ time) {
      if (typeof time !== "number" || !Number.isFinite(time)) return "";
      let date = new Date(time);
      if (Number.isNaN(date.getTime())) return "";
      let hours = String(date.getHours()).padStart(2, "0");
      let minutes = String(date.getMinutes()).padStart(2, "0");
      return `${hours}:${minutes}`;
    }

    /** 时刻 → `MM-DD HH:MM`（本地时区；无效值返回空串）。 */
    function formatDateTime(/** @type {any} */ time) {
      if (typeof time !== "number" || !Number.isFinite(time)) return "";
      let date = new Date(time);
      if (Number.isNaN(date.getTime())) return "";
      let month = String(date.getMonth() + 1).padStart(2, "0");
      let day = String(date.getDate()).padStart(2, "0");
      return `${month}-${day} ${formatClock(time)}`;
    }

    /** 统一 path 列表：接受字符串数组或 `{path, bytes, reason}` 对象数组。 */
    function normalizePathList(/** @type {any} */ raw) {
      /** @type {any[]} */
      let out = [];
      if (!Array.isArray(raw)) return out;
      for (let i = 0; i < raw.length; i += 1) {
        let item = raw[i];
        if (typeof item === "string") {
          out.push({ path: item, bytes: 0, reason: "" });
          continue;
        }
        if (item && typeof item === "object" && typeof item.path === "string") {
          out.push({
            path: item.path,
            bytes: typeof item.bytes === "number" ? item.bytes : 0,
            reason: typeof item.reason === "string" ? item.reason : "",
          });
        }
      }
      return out;
    }

    /**
     * preview.files 的归一化形状（任何字段缺失都退化为空/0）。
     * @param {any} value
     * @returns {any}
     */
    function normalizeFiles(value) {
      let source = value && typeof value === "object" ? value : {};
      return {
        available: source.available === true,
        tracked: source.tracked === true,
        totalBytes: typeof source.totalBytes === "number" ? source.totalBytes : 0,
        restore: normalizePathList(source.restore),
        trash: normalizePathList(source.trash),
        skipped: normalizePathList(source.skipped),
        conflicts: normalizePathList(source.conflicts),
      };
    }

    /**
     * `sessionRewind/preview` 响应 → 客户端使用的稳定形状。
     * 未知/缺字段一律退化，保证 RPC 升级期也渲染得出来。
     * @param {any} value
     * @returns {any}
     */
    function normalizePreview(value) {
      let source = value && typeof value === "object" ? value : {};
      let target = source.target && typeof source.target === "object" ? source.target : {};
      let chat = source.chat && typeof source.chat === "object" ? source.chat : {};
      let targetSeq =
        typeof target.seq === "number"
          ? target.seq
          : typeof source.targetSeq === "number"
            ? source.targetSeq
            : null;
      /** @type {any[]} */
      let warnings = [];
      if (Array.isArray(source.warnings)) {
        for (let i = 0; i < source.warnings.length; i += 1) {
          let warning = source.warnings[i];
          if (!warning || typeof warning !== "object") continue;
          let message = typeof warning.message === "string" ? warning.message : "";
          if (message === "") continue;
          warnings.push({
            code: typeof warning.code === "string" ? warning.code : "",
            message: message,
          });
        }
      }
      return {
        sessionId: typeof source.sessionId === "string" ? source.sessionId : null,
        targetSeq: targetSeq,
        target: {
          seq: targetSeq,
          time: typeof target.time === "number" ? target.time : null,
          preview: typeof target.preview === "string" ? target.preview : "",
          text: typeof target.text === "string" ? target.text : "",
          images: normalizeImages(target.images),
        },
        chat: {
          removedCount: typeof chat.removedCount === "number" ? chat.removedCount : 0,
          tokens: typeof chat.tokens === "number" ? chat.tokens : 0,
          crossesOpenToolCall: chat.crossesOpenToolCall === true,
          reachable: chat.reachable !== false,
        },
        files: normalizeFiles(source.files),
        warnings: warnings,
      };
    }

    /**
     * 文件模式的可用性：不可用时给出禁用的文案键与参数。
     * @param {any} preview 归一化后的 preview（null 表示还没拿到）
     * @returns {{ available: boolean, reasonKey: string | null, reasonParams: any }}
     */
    function fileModeState(preview) {
      if (!preview?.files) {
        return { available: false, reasonKey: "confirm.filesUnavailable", reasonParams: {} };
      }
      let files = preview.files;
      if (files.conflicts.length > 0) {
        return {
          available: false,
          reasonKey: "confirm.filesConflicts",
          reasonParams: { n: files.conflicts.length },
        };
      }
      if (!files.available) {
        let warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
        let blocking = warnings.some((/** @type {any} */ warning) => {
          let code = warning && typeof warning.code === "string" ? warning.code : "";
          return (
            code === "tracking-disabled" ||
            code === "cwd-missing" ||
            code === "files-unavailable" ||
            code === "storage-unavailable"
          );
        });
        return {
          available: false,
          reasonKey: blocking || files.tracked ? "confirm.filesUnavailable" : "confirm.filesNone",
          reasonParams: {},
        };
      }
      if (files.restore.length + files.trash.length === 0) {
        return { available: false, reasonKey: "confirm.filesNone", reasonParams: {} };
      }
      return { available: true, reasonKey: null, reasonParams: {} };
    }

    /** 偏好里的默认模式 → 本次真正可用的模式（文件不可用时退回 chat）。 */
    function effectiveMode(/** @type {any} */ prefMode, /** @type {any} */ preview) {
      if (prefMode === "both" && fileModeState(preview).available) return "both";
      return "chat";
    }

    /** 从预览或错误 details 里取出冲突路径。 */
    function conflictPathsOf(/** @type {any} */ source) {
      if (!source || typeof source !== "object") return [];
      let raw = Array.isArray(source.conflicts)
        ? source.conflicts
        : source.files && Array.isArray(source.files.conflicts)
          ? source.files.conflicts
          : [];
      return normalizePathList(raw).map((item) => item.path);
    }

    /** 从错误 details 里取出失败路径（details.failed 或 details.files.failed）。 */
    function failedPathsOf(/** @type {any} */ details) {
      if (!details || typeof details !== "object") return [];
      let raw = Array.isArray(details.failed)
        ? details.failed
        : details.files && Array.isArray(details.files.failed)
          ? details.files.failed
          : [];
      return normalizePathList(raw).map((item) => item.path);
    }

    /**
     * `sessionRewind/candidates` 响应 → { sessionId, candidates, nextCursor }。
     * @param {any} value
     * @returns {any}
     */
    function normalizeCandidatePage(value) {
      let source = value && typeof value === "object" ? value : {};
      /** @type {any[]} */
      let candidates = [];
      if (Array.isArray(source.candidates)) {
        for (let i = 0; i < source.candidates.length; i += 1) {
          let item = source.candidates[i];
          if (!item || typeof item !== "object" || typeof item.seq !== "number") continue;
          candidates.push({
            seq: item.seq,
            index: typeof item.index === "number" ? item.index : i,
            time: typeof item.time === "number" ? item.time : null,
            preview: typeof item.preview === "string" ? item.preview : "",
            text: typeof item.text === "string" ? item.text : "",
            hasFiles: item.hasFiles === true,
            fileCount: typeof item.fileCount === "number" ? item.fileCount : 0,
            reachable: item.reachable !== false,
          });
        }
      }
      let cursor = null;
      if (typeof source.nextCursor === "number") cursor = source.nextCursor;
      else if (typeof source.nextCursor === "string" && source.nextCursor !== "")
        cursor = source.nextCursor;
      return {
        sessionId: typeof source.sessionId === "string" ? source.sessionId : null,
        candidates: candidates,
        nextCursor: cursor,
      };
    }

    /** 把更早一页合并进已有列表（按 seq 去重，保持原顺序）。 */
    function mergeCandidatePages(/** @type {any} */ existing, /** @type {any} */ page) {
      /** @type {any[]} */
      let out = Array.isArray(existing) ? existing.slice() : [];
      let seen = new Set();
      for (let i = 0; i < out.length; i += 1) seen.add(out[i].seq);
      let next = Array.isArray(page) ? page : [];
      for (let j = 0; j < next.length; j += 1) {
        let candidate = next[j];
        if (!candidate || seen.has(candidate.seq)) continue;
        seen.add(candidate.seq);
        out.push(candidate);
      }
      return out;
    }

    /** candidates RPC 的分页参数：limit 来自偏好，q 去掉空白并截断。 */
    function pageParamsOf(
      /** @type {any} */ prefs,
      /** @type {any} */ cursor,
      /** @type {any} */ q,
    ) {
      let safe = sanitizePrefs(prefs);
      /** @type {any} */
      let params = { limit: safe.pageSize };
      if (typeof cursor === "number") params.cursor = cursor;
      let query = typeof q === "string" ? q.trim().slice(0, 200) : "";
      if (query !== "") params.q = query;
      return params;
    }

    /** 已撤回消息条目。 */
    function normalizeGhostItem(/** @type {any} */ value) {
      let item = value && typeof value === "object" ? value : {};
      let kind = item.kind === "user" || item.kind === "assistant" ? item.kind : "tool";
      return {
        seq: typeof item.seq === "number" ? item.seq : null,
        kind: kind,
        time: typeof item.time === "number" ? item.time : null,
        text: typeof item.text === "string" ? item.text : "",
        messageId: typeof item.messageId === "string" ? item.messageId : "",
      };
    }

    /**
     * `sessionRewind/ghost` 响应 → { cuts, nextCursor }。
     * @param {any} value
     * @returns {any}
     */
    function normalizeGhost(value) {
      let source = value && typeof value === "object" ? value : {};
      /** @type {any[]} */
      let cuts = [];
      if (Array.isArray(source.cuts)) {
        for (let i = 0; i < source.cuts.length; i += 1) {
          let cut = source.cuts[i];
          if (!cut || typeof cut !== "object" || typeof cut.targetSeq !== "number") continue;
          /** @type {any[]} */
          let items = [];
          if (Array.isArray(cut.items)) {
            for (let j = 0; j < cut.items.length; j += 1)
              items.push(normalizeGhostItem(cut.items[j]));
          }
          cuts.push({
            targetSeq: cut.targetSeq,
            markerSeq: typeof cut.markerSeq === "number" ? cut.markerSeq : null,
            time: typeof cut.time === "number" ? cut.time : null,
            mode: cut.mode === "both" ? "both" : "chat",
            removedCount: typeof cut.removedCount === "number" ? cut.removedCount : items.length,
            items: items,
          });
        }
      }
      let cursor = null;
      if (typeof source.nextCursor === "number") cursor = source.nextCursor;
      else if (typeof source.nextCursor === "string" && source.nextCursor !== "")
        cursor = source.nextCursor;
      return { cuts: cuts, nextCursor: cursor };
    }

    /** ghost cut 的稳定键（markerSeq 缺失时退化为 targetSeq）。 */
    function ghostCutKey(/** @type {any} */ cut) {
      let marker = typeof cut.markerSeq === "number" ? cut.markerSeq : -1;
      return `${cut.targetSeq}:${marker}`;
    }

    /** 合并更早一页的已撤回分组（按 key 去重）。 */
    function mergeGhostCuts(/** @type {any} */ existing, /** @type {any} */ page) {
      /** @type {any[]} */
      let out = Array.isArray(existing) ? existing.slice() : [];
      let seen = new Set();
      for (let i = 0; i < out.length; i += 1) seen.add(ghostCutKey(out[i]));
      let next = Array.isArray(page) ? page : [];
      for (let j = 0; j < next.length; j += 1) {
        let cut = next[j];
        if (!cut || seen.has(ghostCutKey(cut))) continue;
        seen.add(ghostCutKey(cut));
        out.push(cut);
      }
      return out;
    }

    /** rewind / audit 里的文件回执；null 表示没有文件动作。 */
    function filesReceiptOf(/** @type {any} */ value) {
      if (!value || typeof value !== "object") return null;
      let restored = normalizePathList(value.restored).map((item) => item.path);
      let trashed = normalizePathList(value.trashed).map((item) => item.path);
      return {
        restored: restored,
        trashed: trashed,
        skipped: normalizePathList(value.skipped),
        failed: normalizePathList(value.failed),
        rescueId: typeof value.rescueId === "string" ? value.rescueId : null,
      };
    }

    /** 一条审计记录。 */
    function normalizeAuditEntry(/** @type {any} */ value) {
      let entry = value && typeof value === "object" ? value : {};
      let id =
        typeof entry.id === "string"
          ? entry.id
          : typeof entry.id === "number"
            ? String(entry.id)
            : "";
      return {
        id: id,
        time: typeof entry.time === "number" ? entry.time : null,
        targetSeq: typeof entry.targetSeq === "number" ? entry.targetSeq : null,
        markerSeq: typeof entry.markerSeq === "number" ? entry.markerSeq : null,
        mode: entry.mode === "both" ? "both" : "chat",
        removedCount: typeof entry.removedCount === "number" ? entry.removedCount : 0,
        tokens: typeof entry.tokens === "number" ? entry.tokens : 0,
        files: filesReceiptOf(entry.files),
        rescueId: typeof entry.rescueId === "string" ? entry.rescueId : null,
      };
    }

    /** `sessionRewind/audit` 响应 → 审计记录数组。 */
    function normalizeAuditEntries(/** @type {any} */ value) {
      let source = value && typeof value === "object" ? value : {};
      /** @type {any[]} */
      let out = [];
      if (!Array.isArray(source.entries)) return out;
      for (let i = 0; i < source.entries.length; i += 1) {
        let entry = normalizeAuditEntry(source.entries[i]);
        if (entry.id === "") continue;
        out.push(entry);
      }
      return out;
    }

    /** 救援点里的单个路径。 */
    function normalizeRescuePaths(/** @type {any} */ raw) {
      /** @type {any[]} */
      let out = [];
      if (!Array.isArray(raw)) return out;
      for (let i = 0; i < raw.length; i += 1) {
        let item = raw[i];
        if (typeof item === "string") {
          out.push({ path: item, existed: true, bytes: 0 });
          continue;
        }
        if (item && typeof item === "object" && typeof item.path === "string") {
          out.push({
            path: item.path,
            existed: item.existed !== false,
            bytes: typeof item.bytes === "number" ? item.bytes : 0,
          });
        }
      }
      return out;
    }

    /** `sessionRewind/rescues` 响应 → 救援点数组。 */
    function normalizeRescues(/** @type {any} */ value) {
      let source = value && typeof value === "object" ? value : {};
      /** @type {any[]} */
      let out = [];
      if (!Array.isArray(source.rescues)) return out;
      for (let i = 0; i < source.rescues.length; i += 1) {
        let item = source.rescues[i];
        if (!item || typeof item !== "object") continue;
        let id =
          typeof item.id === "string"
            ? item.id
            : typeof item.id === "number"
              ? String(item.id)
              : "";
        if (id === "") continue;
        out.push({
          id: id,
          time: typeof item.time === "number" ? item.time : null,
          targetSeq: typeof item.targetSeq === "number" ? item.targetSeq : null,
          paths: normalizeRescuePaths(item.paths),
          completed: item.completed === true,
        });
      }
      return out;
    }

    /** `sessionRewind/restoreRescue` 响应 → { restored, failed }。 */
    function normalizeRescueResult(/** @type {any} */ value) {
      let source = value && typeof value === "object" ? value : {};
      return {
        restored: normalizePathList(source.restored).map((item) => item.path),
        failed: normalizePathList(source.failed),
      };
    }

    /** `sessionRewind/health` 响应 → 诊断视图模型。 */
    function normalizeHealth(/** @type {any} */ value) {
      let source = value && typeof value === "object" ? value : {};
      /** @type {any[]} */
      let checks = [];
      if (Array.isArray(source.checks)) {
        for (let i = 0; i < source.checks.length; i += 1) {
          let check = source.checks[i];
          if (!check || typeof check !== "object") continue;
          if (typeof check.name !== "string") continue;
          checks.push({
            name: check.name,
            ok: check.ok === true,
            detail: typeof check.detail === "string" ? check.detail : "",
          });
        }
      }
      let usage = source.usage && typeof source.usage === "object" ? source.usage : {};
      let version = "";
      if (typeof source.version === "string") version = source.version;
      else if (typeof source.version === "number") version = String(source.version);
      return {
        ok: source.ok === true,
        version: version,
        dataRoot: typeof source.dataRoot === "string" ? source.dataRoot : "",
        checks: checks,
        usage: {
          bytes: typeof usage.bytes === "number" ? usage.bytes : 0,
          entries: typeof usage.entries === "number" ? usage.entries : 0,
          sessions: typeof usage.sessions === "number" ? usage.sessions : 0,
          blobs: typeof usage.blobs === "number" ? usage.blobs : 0,
        },
      };
    }

    /** 图片引用数组（preview.target.images / rewind.target.images）。 */
    function normalizeImages(/** @type {any} */ value) {
      /** @type {any[]} */
      let out = [];
      if (!Array.isArray(value)) return out;
      for (let i = 0; i < value.length; i += 1) {
        let item = value[i];
        if (!item || typeof item !== "object") continue;
        if (typeof item.attachmentId !== "string") continue;
        let mediaType = typeof item.mediaType === "string" ? item.mediaType : "";
        if (mediaType === "") continue;
        out.push({
          attachmentId: item.attachmentId,
          mediaType: mediaType,
          bytes: typeof item.bytes === "number" ? item.bytes : 0,
          width: typeof item.width === "number" ? item.width : 0,
          height: typeof item.height === "number" ? item.height : 0,
          name: typeof item.name === "string" ? item.name : "",
        });
      }
      return out;
    }

    /** 从 rewind 响应里取目标消息的图片引用（新形状 target.images，旧形状 images）。 */
    function imageRefsOf(/** @type {any} */ value) {
      if (!value || typeof value !== "object") return [];
      let target = value.target && typeof value.target === "object" ? value.target : {};
      if (Array.isArray(target.images)) return normalizeImages(target.images);
      return normalizeImages(value.images);
    }

    /** media type → 扩展名；未知类型返回 undefined（跳过该图）。 */
    function mediaExtensionOf(/** @type {any} */ mediaType) {
      if (typeof mediaType !== "string") return undefined;
      let extension = IMAGE_EXTENSIONS[mediaType];
      return typeof extension === "string" ? extension : undefined;
    }

    /** 构造回填 composer 的 File 名（宿主按扩展名识别图片）。 */
    function imageFileName(/** @type {any} */ ref, /** @type {any} */ index) {
      if (ref && typeof ref.name === "string" && ref.name !== "") return ref.name;
      let extension = mediaExtensionOf(ref ? ref.mediaType : undefined) || "img";
      return `image-${(typeof index === "number" ? index : 0) + 1}.${extension}`;
    }

    /**
     * `sessionRewind/rewind` 响应 → 回执视图模型（新旧字段都兼容）。
     * @param {any} value
     * @returns {any}
     */
    function rewindSummaryOf(value) {
      let source = value && typeof value === "object" ? value : {};
      let target = source.target && typeof source.target === "object" ? source.target : {};
      let targetSeq =
        typeof source.targetSeq === "number"
          ? source.targetSeq
          : typeof target.seq === "number"
            ? target.seq
            : null;
      let text = typeof target.text === "string" ? target.text : "";
      if (text === "" && typeof source.text === "string") text = source.text;
      return {
        targetSeq: targetSeq,
        markerSeq: typeof source.markerSeq === "number" ? source.markerSeq : targetSeq,
        removedCount: typeof source.removedCount === "number" ? source.removedCount : 0,
        tokens: typeof source.tokens === "number" ? source.tokens : 0,
        text: text,
        images: imageRefsOf(source),
        files: filesReceiptOf(source.files),
      };
    }

    /** 抽屉 tab 名归一化（未知值落到「已撤回」）。 */
    function normalizeTab(/** @type {any} */ value) {
      return typeof value === "string" && DRAWER_TABS.indexOf(value) !== -1 ? value : "ghost";
    }

    /** 回溯模式的文案键。 */
    function modeLabelKey(/** @type {any} */ mode) {
      return mode === "both" ? "ghost.mode.both" : "ghost.mode.chat";
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
    // 浮层 UI（候选列表 / 确认框 / 回溯抽屉 / toast）
    // ------------------------------------------------------------------

    function Btn(/** @type {any} */ props) {
      let className = props.primary ? "dsh-srw-btn dsh-srw-btn-primary" : "dsh-srw-btn";
      if (props.small) className += " dsh-srw-btn-sm";
      return h(
        "button",
        {
          type: "button",
          className: className,
          disabled: props.disabled,
          onClick: props.onClick,
          title: props.title,
        },
        props.children,
      );
    }

    /** 行内文字按钮（复制 / 展开 / 放回输入框这类非主要动作）。 */
    function LinkBtn(/** @type {any} */ props) {
      return h(
        "button",
        {
          type: "button",
          className: "dsh-srw-link",
          disabled: props.disabled,
          onClick: props.onClick,
          title: props.title,
        },
        props.children,
      );
    }

    /** 时间文案（相对时间；抽屉里用绝对时间更直观）。 */
    function relativeText(/** @type {any} */ t, /** @type {any} */ time) {
      let relative = relativeOf(time, Date.now());
      return t(relative.key, relative.params);
    }

    /** 单选：回退范围（仅对话 / 对话+文件）。文件不可用时禁用并给出原因。 */
    function ModePicker(/** @type {any} */ props) {
      let t = props.t;
      let mode = props.mode;
      let fileState = props.fileState;
      let onChange = props.onChange;

      function option(
        /** @type {any} */ value,
        /** @type {any} */ labelKey,
        /** @type {any} */ hintKey,
        /** @type {any} */ disabled,
        /** @type {any} */ reasonKey,
        /** @type {any} */ reasonParams,
      ) {
        let active = mode === value;
        return h(
          "label",
          {
            key: value,
            className: "dsh-srw-option",
            "data-active": active ? "true" : undefined,
            "data-disabled": disabled ? "true" : undefined,
          },
          h("input", {
            type: "radio",
            name: "dsh-srw-mode",
            value: value,
            checked: active,
            disabled: disabled,
            onChange: () => {
              if (!disabled) onChange(value);
            },
          }),
          h(
            "span",
            { className: "dsh-srw-option-body" },
            h("span", { className: "dsh-srw-option-label" }, t(labelKey)),
            h("span", { className: "dsh-srw-option-hint" }, t(hintKey)),
            disabled && reasonKey
              ? h("span", { className: "dsh-srw-option-reason" }, t(reasonKey, reasonParams || {}))
              : null,
          ),
        );
      }

      return h(
        "div",
        { className: "dsh-srw-group" },
        h("div", { className: "dsh-srw-group-title" }, t("confirm.modeTitle")),
        option("chat", "confirm.modeChat", "confirm.modeChatHint", false, null, null),
        option(
          "both",
          "confirm.modeBoth",
          "confirm.modeBothHint",
          !fileState.available,
          fileState.reasonKey,
          fileState.reasonParams,
        ),
      );
    }

    /** 文件影响摘要：还原/回收站数量 + 前 5 个路径（可展开全部）。 */
    function FileSummary(/** @type {any} */ props) {
      let t = props.t;
      let files = props.files;
      let expanded = props.expanded;
      let onToggle = props.onToggle;
      /** @type {any[]} */
      let entries = [];
      for (let i = 0; i < files.restore.length; i += 1) {
        entries.push({
          kind: "restore",
          path: files.restore[i].path,
          bytes: files.restore[i].bytes,
          reason: "",
        });
      }
      for (let j = 0; j < files.trash.length; j += 1) {
        entries.push({
          kind: "trash",
          path: files.trash[j].path,
          bytes: files.trash[j].bytes,
          reason: "",
        });
      }
      for (let k = 0; k < files.skipped.length; k += 1) {
        entries.push({
          kind: "skipped",
          path: files.skipped[k].path,
          bytes: files.skipped[k].bytes,
          reason: files.skipped[k].reason,
        });
      }
      let visible = expanded ? entries : entries.slice(0, 5);
      let rows = visible.map((/** @type {any} */ entry) =>
        h(
          "div",
          {
            key: `${entry.kind}:${entry.path}`,
            className: "dsh-srw-path",
            "data-kind": entry.kind,
          },
          h("span", { className: "dsh-srw-path-name", title: entry.path }, entry.path),
          entry.reason ? h("span", { className: "dsh-srw-path-reason" }, entry.reason) : null,
          h("span", { className: "dsh-srw-path-bytes" }, formatBytes(entry.bytes)),
        ),
      );
      let more =
        entries.length > 5
          ? h(
              LinkBtn,
              { onClick: onToggle },
              expanded ? t("confirm.pathsLess") : t("confirm.pathsMore", { n: entries.length }),
            )
          : null;
      return h(
        "div",
        { className: "dsh-srw-files" },
        h(
          "div",
          { className: "dsh-srw-files-title" },
          t("confirm.fileSummary", {
            restored: files.restore.length,
            trashed: files.trash.length,
          }),
        ),
        h("div", { className: "dsh-srw-paths" }, rows),
        more,
        files.skipped.length > 0 && !expanded
          ? h(
              "div",
              { className: "dsh-srw-dim dsh-srw-skipped" },
              t("confirm.skipped", { n: files.skipped.length }),
            )
          : null,
      );
    }

    /** 冲突 / 失败路径列表（最多 5 条）。 */
    function PathList(/** @type {any} */ props) {
      let paths = Array.isArray(props.paths) ? props.paths.slice(0, 5) : [];
      if (paths.length === 0) return null;
      return h(
        "div",
        { className: "dsh-srw-paths dsh-srw-paths-error" },
        paths.map((/** @type {any} */ path) =>
          h(
            "div",
            { key: String(path), className: "dsh-srw-path", "data-kind": "conflict" },
            h("span", { className: "dsh-srw-path-name" }, String(path)),
          ),
        ),
      );
    }

    /** 确认框主体：目标消息 + 影响面预览 + 模式 + 文件摘要 + 警告 + busy/错误。 */
    function ConfirmBody(/** @type {any} */ props) {
      let state = props.state;
      let api = props.api;
      let t = props.t;
      let target = state.target || {};
      let preview = state.preview;
      /** @type {any[]} */
      let blocks = [];

      blocks.push(
        h(
          "div",
          { key: "target", className: "dsh-srw-target" },
          h("span", { className: "dsh-srw-preview" }, target.preview || target.text || ""),
          h("span", { className: "dsh-srw-time" }, relativeText(t, target.time)),
        ),
      );

      if (state.previewLoading) {
        blocks.push(h("div", { key: "pl", className: "dsh-srw-dim" }, t("dialog.previewLoading")));
      } else if (state.previewErrorKey) {
        blocks.push(
          h(
            "div",
            { key: "pe", className: "dsh-srw-error" },
            t("dialog.previewFailed", {
              message: t(state.previewErrorKey, state.previewErrorParams || {}),
            }),
          ),
        );
      } else if (!preview) {
        blocks.push(
          h("div", { key: "pu", className: "dsh-srw-dim" }, t("dialog.previewUnavailable")),
        );
      } else {
        blocks.push(
          h(
            "div",
            { key: "sum", className: "dsh-srw-summary" },
            t("confirm.summary", {
              n: preview.chat.removedCount,
              tokens: formatCount(preview.chat.tokens),
            }),
          ),
        );
        if (preview.chat.crossesOpenToolCall) {
          blocks.push(
            h("div", { key: "tool", className: "dsh-srw-warn" }, t("confirm.openToolCall")),
          );
        }
        blocks.push(
          h(ModePicker, {
            key: "modes",
            t: t,
            mode: state.rewindMode,
            fileState: fileModeState(preview),
            onChange: api.setRewindMode,
          }),
        );
        if (
          preview.files.tracked &&
          preview.files.restore.length + preview.files.trash.length > 0
        ) {
          blocks.push(
            h(FileSummary, {
              key: "files",
              t: t,
              files: preview.files,
              expanded: state.showAllPaths === true,
              onToggle: api.togglePathList,
            }),
          );
        }
        if (preview.warnings.length > 0) {
          blocks.push(
            h(
              "div",
              { key: "warn", className: "dsh-srw-warn-list" },
              preview.warnings.map((/** @type {any} */ warning, /** @type {any} */ index) =>
                h(
                  "div",
                  { key: `${warning.code}:${index}`, className: "dsh-srw-warn" },
                  warning.message,
                ),
              ),
            ),
          );
        }
        if (preview.files.conflicts.length > 0) {
          blocks.push(
            h(
              "div",
              { key: "conflicts", className: "dsh-srw-warn-list" },
              h("div", { className: "dsh-srw-warn-title" }, t("confirm.conflictsTitle")),
              h(PathList, {
                paths: preview.files.conflicts.map((/** @type {any} */ item) => item.path),
              }),
            ),
          );
        }
      }

      if (state.busy) {
        blocks.push(h("div", { key: "busy", className: "dsh-srw-warn" }, t("confirm.busy")));
      }
      if (state.errorKey) {
        blocks.push(
          h(
            "div",
            { key: "err", className: "dsh-srw-error" },
            h("div", null, t(state.errorKey, state.errorParams || {})),
            h(PathList, { paths: state.errorPaths || [] }),
          ),
        );
      }
      return h("div", { className: "dsh-srw-body" }, blocks);
    }

    /** 候选列表主体：搜索框 + 列表 + 加载更早。 */
    function CandidateList(/** @type {any} */ props) {
      let state = props.state;
      let api = props.api;
      let t = props.t;
      let search = h("input", {
        type: "search",
        className: "dsh-srw-search",
        placeholder: t("list.search"),
        value: state.listSearch || "",
        "aria-label": t("list.search"),
        onChange: (/** @type {any} */ event) => {
          if (event?.target) api.setListSearch(String(event.target.value || ""));
        },
      });

      let body;
      if (state.listLoading && state.candidates.length === 0) {
        body = h("div", { className: "dsh-srw-dim" }, t("dialog.loading"));
      } else if (state.listErrorKey) {
        body = h(
          "div",
          { className: "dsh-srw-error" },
          t(state.listErrorKey, state.listErrorParams || {}),
        );
      } else {
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
                onClick: () => api.openConfirm(candidate, state.sessionId, "list"),
              },
              h(
                "span",
                { className: "dsh-srw-preview" },
                candidate.preview || candidate.text || "",
              ),
              candidate.hasFiles
                ? h(
                    "span",
                    {
                      className: "dsh-srw-badge",
                      title: t("list.filesBadge", { n: candidate.fileCount }),
                    },
                    t("list.filesBadge", { n: candidate.fileCount }),
                  )
                : null,
              h("span", { className: "dsh-srw-time" }, relativeText(t, candidate.time)),
            );
          },
        );
        if (rows.length === 0) {
          rows = [
            h(
              "div",
              { key: "empty", className: "dsh-srw-dim" },
              state.listSearch ? t("list.searchEmpty") : t("dialog.empty"),
            ),
          ];
        }
        body = h("div", { className: "dsh-srw-list" }, rows);
      }

      return h(
        "div",
        { className: "dsh-srw-body" },
        search,
        body,
        state.listCursor !== null && state.listCursor !== undefined
          ? h(
              "div",
              { className: "dsh-srw-load-older" },
              h(
                LinkBtn,
                { disabled: state.listLoadingOlder === true, onClick: api.loadOlderCandidates },
                state.listLoadingOlder ? t("dialog.loading") : t("list.loadOlder"),
              ),
            )
          : null,
      );
    }

    function RewindDialog(/** @type {any} */ props) {
      let state = props.state;
      let api = props.api;
      let t = props.t;
      let confirmMode = state.mode === "confirm";
      let title = confirmMode ? t("dialog.titleConfirm") : t("dialog.title");
      let desc = confirmMode ? t("dialog.descConfirm") : t("dialog.desc");
      let body = confirmMode
        ? h(ConfirmBody, { state: state, api: api, t: t })
        : h(CandidateList, { state: state, api: api, t: t });

      let footer;
      if (confirmMode) {
        let disabled =
          state.busy === true || state.executing === true || state.previewLoading === true;
        let executing = state.executing === true || state.loading === true;
        footer = h(
          Fragment,
          null,
          h(Btn, { onClick: () => api.cancelDialog() }, t("dialog.cancel")),
          h(
            Btn,
            {
              primary: true,
              disabled: disabled,
              onClick: () => api.doRewind(),
            },
            executing ? t("dialog.executing") : t("dialog.confirm"),
          ),
        );
      } else {
        footer = h(Btn, { onClick: () => api.close() }, t("dialog.cancel"));
      }

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
      let t = props.t;
      let text = typeof toast.text === "string" ? toast.text : t(toast.key, toast.params || {});
      let action = toast.action
        ? h(
            "button",
            {
              type: "button",
              className: "dsh-srw-link dsh-srw-toast-action",
              onClick: toast.action.onClick,
            },
            t(toast.action.labelKey),
          )
        : null;
      return h(
        "div",
        { className: "dsh-srw-toast", role: "status" },
        h("span", { className: "dsh-srw-toast-text" }, text),
        action,
      );
    }

    // ---- 回溯抽屉 ----

    /** 已撤回 tab：按回溯分组，搜索交给宿主 ghost 的 q。 */
    function GhostTab(/** @type {any} */ props) {
      let data = props.data;
      let api = props.api;
      let t = props.t;
      let body;
      if (data.loading && data.cuts.length === 0) {
        body = h("div", { className: "dsh-srw-dim" }, t("dialog.loading"));
      } else if (data.errorKey) {
        body = h(
          "div",
          { className: "dsh-srw-error" },
          t("ghost.loadFailed", { message: t(data.errorKey, data.errorParams || {}) }),
        );
      } else if (data.cuts.length === 0) {
        body = h("div", { className: "dsh-srw-dim" }, t("ghost.empty"));
      } else {
        body = h(
          "div",
          { className: "dsh-srw-cuts" },
          data.cuts.map((/** @type {any} */ cut) =>
            h(
              "div",
              { key: ghostCutKey(cut), className: "dsh-srw-cut" },
              h(
                "div",
                { className: "dsh-srw-cut-head" },
                h(
                  "span",
                  { className: "dsh-srw-strong" },
                  t("ghost.cutMeta", { n: cut.removedCount }),
                ),
                h("span", { className: "dsh-srw-badge" }, t(modeLabelKey(cut.mode))),
                h("span", { className: "dsh-srw-time" }, formatDateTime(cut.time)),
              ),
              cut.items.map((/** @type {any} */ item, /** @type {any} */ index) =>
                h(
                  "div",
                  {
                    key: `${cut.targetSeq}:${item.seq ?? index}`,
                    className: "dsh-srw-item",
                    "data-kind": item.kind,
                  },
                  h("span", { className: "dsh-srw-kind", "data-kind": item.kind }, item.kind),
                  h(
                    "span",
                    { className: "dsh-srw-item-text", title: item.text },
                    item.text || t("ghost.noText"),
                  ),
                  h(
                    "span",
                    { className: "dsh-srw-item-actions" },
                    h(LinkBtn, { onClick: () => api.copyText(item.text) }, t("ghost.copy")),
                    item.kind === "user"
                      ? h(LinkBtn, { onClick: () => api.refillGhostItem(item) }, t("ghost.refill"))
                      : null,
                  ),
                ),
              ),
            ),
          ),
        );
      }
      return h(
        "div",
        { className: "dsh-srw-tab-body" },
        h("input", {
          type: "search",
          className: "dsh-srw-search",
          placeholder: t("ghost.search"),
          value: data.q || "",
          "aria-label": t("ghost.search"),
          onChange: (/** @type {any} */ event) => {
            if (event?.target) api.searchGhost(String(event.target.value || ""));
          },
        }),
        body,
        data.nextCursor !== null && data.nextCursor !== undefined
          ? h(
              "div",
              { className: "dsh-srw-load-older" },
              h(
                LinkBtn,
                { disabled: data.loadingOlder === true, onClick: api.loadOlderGhost },
                data.loadingOlder ? t("dialog.loading") : t("ghost.loadOlder"),
              ),
            )
          : null,
      );
    }

    /** 回溯记录 tab：audit 列表 + 可展开路径 + 复制 JSON。 */
    function AuditTab(/** @type {any} */ props) {
      let data = props.data;
      let api = props.api;
      let t = props.t;
      if (data.loading && data.entries.length === 0) {
        return h("div", { className: "dsh-srw-dim" }, t("dialog.loading"));
      }
      if (data.errorKey) {
        return h(
          "div",
          { className: "dsh-srw-error" },
          t("audit.loadFailed", { message: t(data.errorKey, data.errorParams || {}) }),
        );
      }
      if (data.entries.length === 0) {
        return h("div", { className: "dsh-srw-dim" }, t("audit.empty"));
      }
      return h(
        "div",
        { className: "dsh-srw-cuts" },
        data.entries.map((/** @type {any} */ entry) => {
          let expanded = data.expanded && data.expanded[entry.id] === true;
          let files = entry.files;
          /** @type {any[]} */
          let pathGroups = [];
          if (files) {
            if (files.restored.length > 0)
              pathGroups.push({ kind: "restore", paths: files.restored });
            if (files.trashed.length > 0) pathGroups.push({ kind: "trash", paths: files.trashed });
            if (files.skipped.length > 0)
              pathGroups.push({
                kind: "skipped",
                paths: files.skipped.map((/** @type {any} */ item) => item.path),
              });
            if (files.failed.length > 0)
              pathGroups.push({
                kind: "conflict",
                paths: files.failed.map((/** @type {any} */ item) => item.path),
              });
          }
          let pathCount = pathGroups.reduce(
            (/** @type {any} */ sum, /** @type {any} */ group) => sum + group.paths.length,
            0,
          );
          return h(
            "div",
            { key: entry.id, className: "dsh-srw-cut" },
            h(
              "div",
              { className: "dsh-srw-cut-head" },
              h("span", { className: "dsh-srw-strong" }, formatDateTime(entry.time) || entry.id),
              h("span", { className: "dsh-srw-badge" }, t(modeLabelKey(entry.mode))),
              h(
                "span",
                { className: "dsh-srw-time" },
                t("audit.meta", {
                  mode: t(modeLabelKey(entry.mode)),
                  n: entry.removedCount,
                  tokens: formatCount(entry.tokens),
                }),
              ),
            ),
            files
              ? h(
                  "div",
                  { className: "dsh-srw-audit-files" },
                  t("audit.files", {
                    restored: files.restored.length,
                    trashed: files.trashed.length,
                    skipped: files.skipped.length,
                    failed: files.failed.length,
                  }),
                )
              : null,
            files?.rescueId
              ? h("div", { className: "dsh-srw-dim" }, t("audit.rescueId", { id: files.rescueId }))
              : null,
            h(
              "div",
              { className: "dsh-srw-item-actions dsh-srw-audit-actions" },
              pathCount > 0
                ? h(
                    LinkBtn,
                    { onClick: () => api.toggleAuditPaths(entry.id) },
                    expanded ? t("audit.pathsLess") : t("audit.paths", { n: pathCount }),
                  )
                : null,
              h(LinkBtn, { onClick: () => api.copyJson(entry) }, t("audit.copyJson")),
            ),
            expanded
              ? h(
                  "div",
                  { className: "dsh-srw-paths" },
                  pathGroups.map((/** @type {any} */ group) =>
                    group.paths.map((/** @type {any} */ path) =>
                      h(
                        "div",
                        {
                          key: `${group.kind}:${path}`,
                          className: "dsh-srw-path",
                          "data-kind": group.kind,
                        },
                        h("span", { className: "dsh-srw-path-name", title: path }, path),
                      ),
                    ),
                  ),
                )
              : null,
          );
        }),
      );
    }

    /** 救援点 tab：列表 + 二次确认 + restoreRescue。 */
    function RescuesTab(/** @type {any} */ props) {
      let data = props.data;
      let api = props.api;
      let t = props.t;
      if (data.loading && data.list.length === 0) {
        return h("div", { className: "dsh-srw-dim" }, t("dialog.loading"));
      }
      if (data.errorKey) {
        return h(
          "div",
          { className: "dsh-srw-error" },
          t("rescues.loadFailed", { message: t(data.errorKey, data.errorParams || {}) }),
        );
      }
      if (data.list.length === 0) {
        return h("div", { className: "dsh-srw-dim" }, t("rescues.empty"));
      }
      return h(
        "div",
        { className: "dsh-srw-cuts" },
        data.list.map((/** @type {any} */ rescue) => {
          let pending = data.pendingId === rescue.id;
          let executing = data.executingId === rescue.id;
          return h(
            "div",
            { key: rescue.id, className: "dsh-srw-cut" },
            h(
              "div",
              { className: "dsh-srw-cut-head" },
              h("span", { className: "dsh-srw-strong" }, formatDateTime(rescue.time) || rescue.id),
              h(
                "span",
                { className: "dsh-srw-badge" },
                rescue.completed ? t("rescues.completed") : t("rescues.incomplete"),
              ),
              h(
                "span",
                { className: "dsh-srw-time" },
                t("rescues.meta", {
                  seq: rescue.targetSeq === null ? "?" : rescue.targetSeq,
                  n: rescue.paths.length,
                }),
              ),
            ),
            h(
              "div",
              { className: "dsh-srw-paths" },
              rescue.paths.slice(0, 5).map((/** @type {any} */ item) =>
                h(
                  "div",
                  {
                    key: item.path,
                    className: "dsh-srw-path",
                    "data-kind": item.existed ? "restore" : "trash",
                  },
                  h("span", { className: "dsh-srw-path-name", title: item.path }, item.path),
                  h("span", { className: "dsh-srw-path-bytes" }, formatBytes(item.bytes)),
                ),
              ),
            ),
            pending
              ? h(
                  "div",
                  { className: "dsh-srw-confirm-row" },
                  h(
                    "div",
                    { className: "dsh-srw-warn" },
                    t("rescues.confirm", { n: rescue.paths.length }),
                  ),
                  h(
                    "div",
                    { className: "dsh-srw-item-actions" },
                    h(Btn, { small: true, onClick: api.cancelRescue }, t("rescues.cancel")),
                    h(
                      Btn,
                      {
                        small: true,
                        primary: true,
                        disabled: executing,
                        onClick: api.confirmRescue,
                      },
                      executing ? t("rescues.restoring") : t("rescues.restore"),
                    ),
                  ),
                )
              : h(
                  "div",
                  { className: "dsh-srw-item-actions" },
                  h(
                    LinkBtn,
                    { disabled: executing, onClick: () => api.setPendingRescue(rescue.id) },
                    executing ? t("rescues.restoring") : t("rescues.restore"),
                  ),
                ),
          );
        }),
      );
    }

    /** 设置 tab：本地偏好 + 诊断。 */
    function SettingsTab(/** @type {any} */ props) {
      let data = props.data;
      let prefs = data.prefs;
      let api = props.api;
      let t = props.t;
      let health = data.health || { loading: false, errorKey: null, data: null };

      let modeRow = h(
        "label",
        {
          className: "dsh-srw-option",
          "data-active": prefs.defaultMode === "chat" ? "true" : undefined,
        },
        h("input", {
          type: "radio",
          name: "dsh-srw-default-mode",
          checked: prefs.defaultMode === "chat",
          onChange: () => api.updatePrefs({ defaultMode: "chat" }),
        }),
        h(
          "span",
          { className: "dsh-srw-option-body" },
          h("span", { className: "dsh-srw-option-label" }, t("confirm.modeChat")),
        ),
      );
      let modeRowBoth = h(
        "label",
        {
          className: "dsh-srw-option",
          "data-active": prefs.defaultMode === "both" ? "true" : undefined,
        },
        h("input", {
          type: "radio",
          name: "dsh-srw-default-mode",
          checked: prefs.defaultMode === "both",
          onChange: () => api.updatePrefs({ defaultMode: "both" }),
        }),
        h(
          "span",
          { className: "dsh-srw-option-body" },
          h("span", { className: "dsh-srw-option-label" }, t("confirm.modeBoth")),
        ),
      );

      let pageRow = h(
        "label",
        { className: "dsh-srw-setting" },
        h("span", { className: "dsh-srw-setting-label" }, t("settings.pageSize")),
        h("input", {
          type: "number",
          className: "dsh-srw-input",
          min: PAGE_SIZE_MIN,
          max: PAGE_SIZE_MAX,
          step: 10,
          value: prefs.pageSize,
          onChange: (/** @type {any} */ event) => {
            if (event?.target) api.updatePrefs({ pageSize: Number(event.target.value) });
          },
        }),
      );

      let confirmRow = h(
        "div",
        { className: "dsh-srw-setting" },
        h(
          "label",
          { className: "dsh-srw-check" },
          h("input", {
            type: "checkbox",
            checked: prefs.confirmOnList !== false,
            onChange: (/** @type {any} */ event) => {
              if (event?.target) api.updatePrefs({ confirmOnList: event.target.checked === true });
            },
          }),
          h("span", null, t("settings.confirmOnList")),
        ),
        h("div", { className: "dsh-srw-option-hint" }, t("settings.confirmOnListHint")),
      );

      let healthBlock;
      if (health.loading) {
        healthBlock = h("div", { className: "dsh-srw-dim" }, t("settings.healthLoading"));
      } else if (health.errorKey) {
        healthBlock = h(
          "div",
          { className: "dsh-srw-error" },
          t("settings.healthFailed", { message: t(health.errorKey, health.errorParams || {}) }),
        );
      } else if (health.data) {
        let view = health.data;
        healthBlock = h(
          "div",
          { className: "dsh-srw-health" },
          h(
            "div",
            { className: "dsh-srw-health-head" },
            h(
              "span",
              { className: "dsh-srw-badge", "data-ok": view.ok ? "true" : "false" },
              view.ok ? t("settings.healthOk") : t("settings.healthBad"),
            ),
            view.version
              ? h("span", { className: "dsh-srw-dim" }, `${t("settings.version")} ${view.version}`)
              : null,
          ),
          view.dataRoot
            ? h(
                "div",
                { className: "dsh-srw-dim dsh-srw-break", title: view.dataRoot },
                `${t("settings.dataRoot")}: ${view.dataRoot}`,
              )
            : null,
          h(
            "div",
            { className: "dsh-srw-dim" },
            t("settings.usage", {
              bytes: formatBytes(view.usage.bytes),
              entries: formatCount(view.usage.entries),
              sessions: formatCount(view.usage.sessions),
              blobs: formatCount(view.usage.blobs),
            }),
          ),
          h(
            "div",
            { className: "dsh-srw-checks" },
            view.checks.map((/** @type {any} */ check, /** @type {any} */ index) =>
              h(
                "div",
                {
                  key: `${check.name}:${index}`,
                  className: "dsh-srw-check-row",
                  "data-ok": check.ok ? "true" : "false",
                },
                h("span", { className: "dsh-srw-check-mark" }, check.ok ? "✓" : "✗"),
                h("span", { className: "dsh-srw-check-name" }, check.name),
                check.detail
                  ? h("span", { className: "dsh-srw-dim dsh-srw-check-detail" }, check.detail)
                  : null,
              ),
            ),
          ),
        );
      } else {
        healthBlock = h("div", { className: "dsh-srw-dim" }, t("settings.healthLoading"));
      }

      return h(
        "div",
        { className: "dsh-srw-tab-body" },
        h(
          "div",
          { className: "dsh-srw-group" },
          h("div", { className: "dsh-srw-group-title" }, t("settings.defaultMode")),
          modeRow,
          modeRowBoth,
        ),
        pageRow,
        confirmRow,
        data.saved === true
          ? h("div", { className: "dsh-srw-dim dsh-srw-saved" }, t("settings.saved"))
          : null,
        h(
          "div",
          { className: "dsh-srw-group dsh-srw-health-group" },
          h(
            "div",
            { className: "dsh-srw-group-title" },
            h("span", null, t("settings.healthTitle")),
            h(LinkBtn, { onClick: api.loadHealth }, t("settings.healthRefresh")),
          ),
          healthBlock,
        ),
      );
    }

    function RewindDrawer(/** @type {any} */ props) {
      let state = props.state;
      let drawer = state.drawer;
      let api = props.api;
      let t = props.t;
      if (drawer?.open !== true) return null;
      let tab = drawer.tab;
      let body = null;
      if (tab === "ghost") body = h(GhostTab, { data: drawer.ghost, api: api, t: t });
      else if (tab === "audit") body = h(AuditTab, { data: drawer.audit, api: api, t: t });
      else if (tab === "rescues") body = h(RescuesTab, { data: drawer.rescues, api: api, t: t });
      else body = h(SettingsTab, { data: drawer.settings, api: api, t: t });

      return h(
        "div",
        { className: "dsh-srw-drawer-mask", onClick: () => api.closeDrawer() },
        h(
          "aside",
          {
            className: "dsh-srw-drawer",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": t("drawer.title"),
            onClick: (/** @type {any} */ event) => {
              if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            },
          },
          h(
            "div",
            { className: "dsh-srw-drawer-head" },
            h("span", { className: "dsh-srw-title dsh-srw-drawer-title" }, t("drawer.title")),
            h(
              "span",
              { className: "dsh-srw-drawer-actions" },
              h(LinkBtn, { onClick: api.refreshDrawer }, t("drawer.refresh")),
              h(LinkBtn, { onClick: api.closeDrawer }, t("drawer.close")),
            ),
          ),
          h(
            "div",
            { className: "dsh-srw-tabs", role: "tablist" },
            DRAWER_TABS.map((/** @type {any} */ name) =>
              h(
                "button",
                {
                  key: name,
                  type: "button",
                  role: "tab",
                  className: "dsh-srw-tab",
                  "data-active": tab === name ? "true" : undefined,
                  "aria-selected": tab === name ? "true" : "false",
                  onClick: () => api.setDrawerTab(name),
                },
                t(`drawer.tab.${name}`),
              ),
            ),
          ),
          body,
        ),
      );
    }

    /** 全局键盘：对话框（↑↓/Enter/Esc）与抽屉（Esc）。 */
    function handleOverlayKey(
      /** @type {any} */ event,
      /** @type {any} */ store,
      /** @type {any} */ api,
    ) {
      let state = store.getSnapshot();
      if (!state) return;
      if (state.mode) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          api.cancelDialog();
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
          if (!state.busy && !state.executing && !state.previewLoading) api.doRewind();
        }
        return;
      }
      let drawer = state.drawer;
      if (drawer && drawer.open === true && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (drawer.rescues.pendingId) api.cancelRescue();
        else api.closeDrawer();
      }
    }

    function RewindOverlay(/** @type {any} */ props) {
      let state = useStore(props.store);
      let store = props.store;
      let api = props.api;
      let overlayOpen = !!state.mode || (state.drawer && state.drawer.open === true);
      React.useEffect(() => {
        if (!overlayOpen) return undefined;
        let onKey = (/** @type {any} */ event) => handleOverlayKey(event, store, api);
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [overlayOpen]);
      React.useEffect(() => {
        if (!state.toast) return undefined;
        let hasAction = !!state.toast.action;
        let timer = setTimeout(
          () => {
            api.clearToast();
          },
          hasAction ? 6000 : 3200,
        );
        return () => clearTimeout(timer);
      }, [state.toast]);

      let dialog = state.mode ? h(RewindDialog, { state: state, api: api, t: props.t }) : null;
      let drawer = h(RewindDrawer, { state: state, api: api, t: props.t });
      let toast = state.toast ? h(ToastLine, { toast: state.toast, t: props.t }) : null;
      return h(Fragment, null, dialog, drawer, toast);
    }

    /** 会话头部动作区：拉一次宿主 cuts（可见性兜底）+ 打开回溯抽屉的图标按钮。 */
    function SessionHeaderActions(/** @type {any} */ props) {
      let api = props.api;
      let t = props.t;
      let sessionId = props.sessionId;
      React.useEffect(() => {
        if (sessionId && api) api.seedCuts(sessionId);
      }, [sessionId]);
      let label = t("drawer.openAria");
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
        h("path", { d: "M2.5 8a5.5 5.5 0 1 0 1.7-4" }),
        h("path", { d: "M2.2 1.3v3h3" }),
        h("path", { d: "M8 5.2v3.2l2 1.4" }),
      );
      let button = h(
        "button",
        {
          type: "button",
          className: "dsh-srw-action",
          title: label,
          "aria-label": label,
          onClick: () => {
            if (typeof sessionId === "string") api.openDrawer(sessionId, "ghost");
          },
        },
        icon,
      );
      if (typeof Tooltip === "function")
        return h(Tooltip, { label: label, side: "bottom" }, button);
      return button;
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

      /** @type {any} */
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
          ".dsh-srw-toast{position:fixed;bottom:24px;right:24px;z-index:2147000000;background:var(--dsw-alias-toast-bg,Canvas);color:var(--dsw-alias-toast-label,CanvasText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:10px 14px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center;max-width:min(520px,90vw);}",
          ".dsh-srw-toast-text{flex:1;min-width:0;}",
          ".dsh-srw-toast-action{white-space:nowrap;}",
          ".dsh-srw-body{display:flex;flex-direction:column;gap:10px;}",
          ".dsh-srw-search{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-size:13px;margin-bottom:6px;}",
          ".dsh-srw-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px;}",
          ".dsh-srw-summary{font-weight:600;}",
          ".dsh-srw-group{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;padding:10px 12px;}",
          ".dsh-srw-group-title{display:flex;justify-content:space-between;align-items:center;font-weight:600;color:var(--dsw-alias-label-secondary,GrayText);font-size:12px;}",
          ".dsh-srw-option{display:flex;gap:8px;align-items:flex-start;cursor:pointer;border-radius:6px;padding:4px 6px;}",
          ".dsh-srw-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
          ".dsh-srw-option[data-disabled=true]{opacity:.55;cursor:not-allowed;}",
          ".dsh-srw-option input{margin-top:3px;}",
          ".dsh-srw-option-body{display:flex;flex-direction:column;gap:1px;min-width:0;}",
          ".dsh-srw-option-label{font-weight:500;}",
          ".dsh-srw-option-hint{color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px;}",
          ".dsh-srw-option-reason{color:var(--dsw-alias-state-error-primary,#d9534f);font-size:12px;}",
          ".dsh-srw-files{display:flex;flex-direction:column;gap:4px;}",
          ".dsh-srw-files-title{font-weight:500;}",
          ".dsh-srw-paths{display:flex;flex-direction:column;gap:2px;font-size:12px;}",
          ".dsh-srw-path{display:flex;gap:8px;align-items:baseline;padding:2px 0;min-width:0;}",
          ".dsh-srw-path-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);}",
          ".dsh-srw-path[data-kind=restore] .dsh-srw-path-name{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
          ".dsh-srw-path[data-kind=trash] .dsh-srw-path-name{color:var(--dsw-alias-state-warning-primary,#c08a2e);}",
          ".dsh-srw-path[data-kind=conflict] .dsh-srw-path-name,.dsh-srw-path[data-kind=skipped] .dsh-srw-path-name{color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-srw-path-bytes,.dsh-srw-path-reason{color:var(--dsw-alias-label-tertiary,GrayText);white-space:nowrap;}",
          ".dsh-srw-warn{color:var(--dsw-alias-state-warning-primary,#c08a2e);}",
          ".dsh-srw-warn-list{display:flex;flex-direction:column;gap:3px;}",
          ".dsh-srw-warn-title{font-weight:600;color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-srw-badge{font-size:11px;color:var(--dsw-alias-label-tertiary,GrayText);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:999px;padding:0 7px;white-space:nowrap;}",
          ".dsh-srw-badge[data-ok=true]{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
          ".dsh-srw-badge[data-ok=false]{color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-srw-load-older{display:flex;justify-content:center;padding-top:8px;}",
          ".dsh-srw-link{background:none;border:none;padding:0 2px;color:var(--dsw-alias-brand-primary,#4f7cff);cursor:pointer;font-size:12px;}",
          ".dsh-srw-link:hover{text-decoration:underline;}",
          ".dsh-srw-link:disabled{opacity:.5;cursor:not-allowed;text-decoration:none;}",
          ".dsh-srw-btn-sm{padding:3px 10px;font-size:12px;}",
          ".dsh-srw-drawer-mask{position:fixed;inset:0;z-index:2147000000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));display:flex;justify-content:flex-end;}",
          ".dsh-srw-drawer{width:min(520px,94vw);height:100%;overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Canvas));color:var(--dsw-alias-label-primary,CanvasText);border-left:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));padding:16px 18px;font-size:13px;line-height:1.6;box-shadow:-16px 0 48px rgba(0,0,0,.3);}",
          ".dsh-srw-drawer-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;}",
          ".dsh-srw-drawer-title{margin-bottom:0;}",
          ".dsh-srw-drawer-actions{display:flex;gap:10px;}",
          ".dsh-srw-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));margin-bottom:12px;}",
          ".dsh-srw-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,GrayText);padding:6px 10px;font-size:13px;cursor:pointer;}",
          ".dsh-srw-tab[data-active=true]{color:var(--dsw-alias-label-primary,inherit);border-bottom-color:var(--dsw-alias-brand-primary,#4f7cff);}",
          ".dsh-srw-tab-body{display:flex;flex-direction:column;gap:10px;}",
          ".dsh-srw-cuts{display:flex;flex-direction:column;gap:12px;}",
          ".dsh-srw-cut{display:flex;flex-direction:column;gap:4px;}",
          ".dsh-srw-cut-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;}",
          ".dsh-srw-strong{font-weight:600;}",
          ".dsh-srw-item{display:flex;gap:8px;align-items:baseline;padding:4px 6px;border-radius:6px;}",
          ".dsh-srw-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}",
          ".dsh-srw-kind{font-size:11px;color:var(--dsw-alias-label-tertiary,GrayText);min-width:58px;}",
          ".dsh-srw-item-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
          ".dsh-srw-item-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
          ".dsh-srw-audit-actions{padding:2px 0;}",
          ".dsh-srw-audit-files{font-size:12px;color:var(--dsw-alias-label-secondary,GrayText);}",
          ".dsh-srw-confirm-row{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-state-warning-primary,#c08a2e);border-radius:8px;padding:8px 10px;}",
          ".dsh-srw-setting{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}",
          ".dsh-srw-setting-label{min-width:150px;color:var(--dsw-alias-label-secondary,GrayText);}",
          ".dsh-srw-check{display:flex;gap:8px;align-items:center;cursor:pointer;}",
          ".dsh-srw-input{width:90px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;font-size:13px;}",
          ".dsh-srw-health-group{margin-top:4px;}",
          ".dsh-srw-health{display:flex;flex-direction:column;gap:4px;}",
          ".dsh-srw-health-head{display:flex;gap:10px;align-items:center;}",
          ".dsh-srw-checks{display:flex;flex-direction:column;gap:2px;font-size:12px;}",
          ".dsh-srw-check-row{display:flex;gap:8px;align-items:baseline;}",
          ".dsh-srw-check-row[data-ok=false]{color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-srw-check-mark{width:14px;text-align:center;}",
          ".dsh-srw-check-name{font-weight:500;}",
          ".dsh-srw-paths-error .dsh-srw-path-name{color:var(--dsw-alias-state-error-primary,#d9534f);}",
          ".dsh-srw-check-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
          ".dsh-srw-break{word-break:break-all;}",
          ".dsh-srw-saved{padding-top:0;}",
          ".dsh-srw-skipped{padding-top:0;}",
        ].join("\n");
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-rewind: styles");

      let cutStore = createCutStore();

      /** 读客户端偏好（localStorage 缺失/脏数据都退回默认值）。 */
      function readPrefs() {
        try {
          let raw = window.localStorage ? window.localStorage.getItem(PREF_STORAGE_KEY) : null;
          if (!raw) return sanitizePrefs(null);
          return sanitizePrefs(JSON.parse(raw));
        } catch (_error) {
          return sanitizePrefs(null);
        }
      }

      /** 写客户端偏好（写不进去只影响持久化，不影响本次会话）。 */
      function writePrefs(/** @type {any} */ next) {
        try {
          if (window.localStorage)
            window.localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(next));
        } catch (_error) {
          /* 存储不可用时只保存在内存里 */
        }
      }

      let prefs = readPrefs();

      function emptyTabState() {
        return { loading: false, errorKey: null, errorParams: null };
      }

      function createDrawerState() {
        return {
          open: false,
          sessionId: null,
          tab: "ghost",
          ghost: Object.assign(emptyTabState(), {
            cuts: [],
            nextCursor: null,
            q: "",
            loadingOlder: false,
          }),
          audit: Object.assign(emptyTabState(), { entries: [], expanded: {} }),
          rescues: Object.assign(emptyTabState(), {
            list: [],
            pendingId: null,
            executingId: null,
          }),
          settings: Object.assign(emptyTabState(), {
            prefs: prefs,
            health: { loading: false, errorKey: null, errorParams: null, data: null },
            saved: false,
          }),
        };
      }

      let store = createStore({
        mode: null,
        origin: null,
        sessionId: null,
        // 候选列表
        candidates: [],
        selected: 0,
        listLoading: false,
        listLoadingOlder: false,
        listCursor: null,
        listSearch: "",
        listErrorKey: null,
        listErrorParams: null,
        // 确认框
        target: null,
        preview: null,
        previewLoading: false,
        previewErrorKey: null,
        previewErrorParams: null,
        rewindMode: "chat",
        showAllPaths: false,
        busy: false,
        executing: false,
        loading: false,
        errorKey: null,
        errorParams: null,
        errorPaths: [],
        // 抽屉
        drawer: createDrawerState(),
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
              let error = /** @type {Error & { code?: string, details?: any }} */ (
                new Error(result.error?.message || "host rejected the call")
              );
              error.code = result.error ? result.error.code : undefined;
              error.details =
                result.error && typeof result.error === "object" ? result.error.details : undefined;
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

      /** 更新抽屉（section 为空 = 更新抽屉顶层字段）。 */
      function patchDrawer(/** @type {any} */ section, /** @type {any} */ partial) {
        patch((/** @type {any} */ state) => {
          let drawer = state.drawer;
          if (!drawer) return {};
          let nextDrawer = Object.assign({}, drawer);
          if (section) {
            nextDrawer[section] = Object.assign(
              {},
              drawer[section],
              typeof partial === "function" ? partial(drawer[section]) : partial,
            );
          } else {
            Object.assign(nextDrawer, typeof partial === "function" ? partial(drawer) : partial);
          }
          return { drawer: nextDrawer };
        });
      }

      /**
       * @param {any} toast { key?, params?, text?, action? }
       */
      function showToast(toast) {
        patch({ toast: toast || null });
      }

      function showToastKey(/** @type {any} */ key, /** @type {any} */ params = {}) {
        showToast({ key: key, params: params || {} });
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

      /** 把 RPC 失败转成 store 里的错误字段。 */
      function errorStateOf(/** @type {any} */ error) {
        return {
          errorKey: errorTextKey(error?.code),
          errorParams: { message: String(error?.message || error) },
        };
      }

      /** 候选列表：重置并拉第一页（游标为空）。 */
      function openList(/** @type {any} */ sessionId) {
        patch({
          mode: "list",
          origin: "list",
          sessionId: sessionId,
          candidates: [],
          selected: 0,
          listLoading: true,
          listLoadingOlder: false,
          listCursor: null,
          listSearch: "",
          listErrorKey: null,
          listErrorParams: null,
          target: null,
          preview: null,
          previewLoading: false,
          previewErrorKey: null,
          previewErrorParams: null,
          busy: false,
          executing: false,
          loading: false,
          errorKey: null,
          errorParams: null,
          errorPaths: [],
        });
        fetchCandidates(sessionId, { reset: true, q: "" });
      }

      /** 拉一页候选（reset=true 覆盖，false 追加更早一页）。 */
      function fetchCandidates(/** @type {any} */ sessionId, /** @type {any} */ options) {
        let reset = options && options.reset === true;
        let cursor = reset ? null : store.getSnapshot().listCursor;
        let query = typeof options?.q === "string" ? options.q : store.getSnapshot().listSearch;
        let params = pageParamsOf(prefs, cursor, query);
        patch(reset ? { listLoading: true } : { listLoadingOlder: true });
        call("candidates", Object.assign({ sessionId: sessionId }, params))
          .then((/** @type {any} */ value) => {
            let page = normalizeCandidatePage(value);
            patch((/** @type {any} */ state) => {
              if (state.mode !== "list" || state.sessionId !== sessionId) return {};
              let candidates = reset
                ? page.candidates
                : mergeCandidatePages(state.candidates, page.candidates);
              return {
                candidates: candidates,
                selected: reset ? 0 : Math.max(0, Math.min(candidates.length - 1, state.selected)),
                listCursor: page.nextCursor,
                listLoading: false,
                listLoadingOlder: false,
                listErrorKey: null,
                listErrorParams: null,
              };
            });
          })
          .catch((/** @type {any} */ error) => {
            let failure = errorStateOf(error);
            patch((/** @type {any} */ state) =>
              state.mode === "list" && state.sessionId === sessionId
                ? Object.assign({}, failure, { listLoading: false, listLoadingOlder: false })
                : {},
            );
          });
      }

      /** 搜索框：防抖后按 q 重新拉第一页。 */
      function setListSearch(/** @type {any} */ value) {
        let sessionId = store.getSnapshot().sessionId;
        let query = typeof value === "string" ? value : "";
        patch({ listSearch: query });
        if (listSearchTimer !== null) clearTimeout(listSearchTimer);
        listSearchTimer = setTimeout(() => {
          listSearchTimer = null;
          if (!sessionId) return;
          fetchCandidates(sessionId, { reset: true, q: query });
        }, 300);
      }

      /** 候选列表「加载更早」。 */
      function loadOlderCandidates() {
        let state = store.getSnapshot();
        if (state.mode !== "list" || !state.sessionId) return;
        if (state.listCursor === null || state.listCursor === undefined) return;
        if (state.listLoading || state.listLoadingOlder) return;
        fetchCandidates(state.sessionId, { reset: false });
      }

      /**
       * 打开确认框：先用 preview RPC 取影响面（失败也允许按仅对话执行）。
       * 偏好里关掉「列表先确认」且默认仅对话时，从列表选择直接执行。
       * @param {any} candidate 目标消息
       * @param {any} sessionId 会话 id
       * @param {any} [origin] "list" | "row" | "command"
       */
      function openConfirm(/** @type {any} */ candidate, /** @type {any} */ sessionId, origin) {
        if (!candidate || typeof candidate.seq !== "number") return;
        let from = typeof origin === "string" ? origin : "row";
        if (from === "list" && prefs.confirmOnList === false && prefs.defaultMode !== "both") {
          executeRewind(sessionId, candidate, "chat", from);
          return;
        }
        let snapshot = sessionSnapshotOf(sessionId);
        let busy = snapshot ? snapshot.running !== false : false;
        patch({
          mode: "confirm",
          origin: from,
          sessionId: sessionId,
          target: candidate,
          preview: null,
          previewLoading: true,
          previewErrorKey: null,
          previewErrorParams: null,
          rewindMode: effectiveMode(prefs.defaultMode, null),
          showAllPaths: false,
          busy: busy,
          executing: false,
          loading: false,
          errorKey: null,
          errorParams: null,
          errorPaths: [],
        });
        call("preview", { sessionId: sessionId, targetSeq: candidate.seq })
          .then((/** @type {any} */ value) => {
            let preview = normalizePreview(value);
            patch((/** @type {any} */ state) => {
              if (state.mode !== "confirm" || state.sessionId !== sessionId) return {};
              if (!state.target || state.target.seq !== candidate.seq) return {};
              return {
                preview: preview,
                previewLoading: false,
                previewErrorKey: null,
                previewErrorParams: null,
                rewindMode: effectiveMode(prefs.defaultMode, preview),
              };
            });
          })
          .catch((/** @type {any} */ error) => {
            let failure = errorStateOf(error);
            patch((/** @type {any} */ state) =>
              state.mode === "confirm" &&
              state.sessionId === sessionId &&
              state.target &&
              state.target.seq === candidate.seq
                ? Object.assign({}, failure, {
                    previewLoading: false,
                    previewErrorKey: failure.errorKey,
                    previewErrorParams: failure.errorParams,
                    preview: null,
                    rewindMode: "chat",
                  })
                : {},
            );
          });
      }

      /** 确认框里切换回退范围。 */
      function setRewindMode(/** @type {any} */ mode) {
        patch({ rewindMode: mode === "both" ? "both" : "chat" });
      }

      /** 确认框里展开/收起完整路径列表。 */
      function togglePathList() {
        patch((/** @type {any} */ state) => ({ showAllPaths: !state.showAllPaths }));
      }

      /** 取消对话框：列表里打开的退回列表，其它直接关闭。 */
      function cancelDialog() {
        let state = store.getSnapshot();
        if (state && state.mode === "confirm" && state.origin === "list") {
          back();
          return;
        }
        close();
      }

      function back() {
        patch({
          mode: "list",
          preview: null,
          previewLoading: false,
          previewErrorKey: null,
          previewErrorParams: null,
          busy: false,
          executing: false,
          loading: false,
          errorKey: null,
          errorParams: null,
          errorPaths: [],
        });
      }

      function close() {
        patch({
          mode: null,
          origin: null,
          target: null,
          preview: null,
          previewLoading: false,
          previewErrorKey: null,
          previewErrorParams: null,
          busy: false,
          executing: false,
          loading: false,
          errorKey: null,
          errorParams: null,
          errorPaths: [],
        });
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
        if (candidate) openConfirm(candidate, state.sessionId, "list");
      }

      // ---- 执行回溯 ----

      /** 搜索/保存提示用的一次性定时器。 @type {any} */
      let listSearchTimer = null;
      /** @type {any} */
      let ghostSearchTimer = null;
      /** @type {any} */
      let prefsSavedTimer = null;
      /** `/rewind` 命令装饰最近一次列出的候选（onSelect 用它回查时间/预览）。 @type {any[]} */
      let commandCandidates = [];

      /**
       * 执行一次回溯；成功/失败都回到 store（失败在有对话框时留在对话框里展示）。
       * @param {any} sessionId 会话 id
       * @param {any} target { seq, time, preview?, text? }
       * @param {any} mode "chat" | "both"
       * @param {any} origin 打开来源
       */
      function executeRewind(
        /** @type {any} */ sessionId,
        /** @type {any} */ target,
        /** @type {any} */ mode,
        /** @type {any} */ origin,
      ) {
        if (!sessionId || !target || typeof target.seq !== "number") return;
        let state = store.getSnapshot();
        if (state?.executing) return;
        let wasConfirm = state?.mode === "confirm";
        /** @type {any} */
        let busyState = {
          origin: origin,
          sessionId: sessionId,
          target: target,
          executing: true,
          loading: true,
          errorKey: null,
          errorParams: null,
          errorPaths: [],
        };
        if (wasConfirm) busyState.mode = "confirm";
        patch(busyState);
        call("rewind", {
          sessionId: sessionId,
          targetSeq: target.seq,
          mode: mode === "both" ? "both" : "chat",
        })
          .then((/** @type {any} */ value) => {
            handleRewindSuccess(sessionId, target, value);
          })
          .catch((/** @type {any} */ error) => {
            handleRewindFailure(sessionId, target, origin, wasConfirm, error);
          });
      }

      /** 成功：更新 cut、重建 chat、回填文本+图片、刷新抽屉、toast。 */
      function handleRewindSuccess(
        /** @type {any} */ sessionId,
        /** @type {any} */ target,
        /** @type {any} */ value,
      ) {
        let summary = rewindSummaryOf(value);
        cutStore.add(sessionId, {
          targetSeq: summary.targetSeq === null ? target.seq : summary.targetSeq,
          markerSeq: summary.markerSeq === null ? target.seq : summary.markerSeq,
        });
        rebuildSessionById(sessionId);
        let outcome = fillComposer(sessionId, summary.text || target.text || "");
        let text = t("toast.rewound", {
          n: summary.removedCount,
          tokens: formatCount(summary.tokens),
        });
        if (summary.files) {
          text += t("toast.rewoundFiles", {
            restored: summary.files.restored.length,
            trashed: summary.files.trashed.length,
          });
          if (summary.files.failed.length > 0) {
            text += t("toast.rewoundFailed", { n: summary.files.failed.length });
          }
        }
        if (outcome === "draft") text += t("toast.draftKept");
        else if (outcome === "none") text += t("toast.noComposerSuffix");
        patch({
          mode: null,
          origin: null,
          target: null,
          preview: null,
          previewLoading: false,
          previewErrorKey: null,
          previewErrorParams: null,
          busy: false,
          executing: false,
          loading: false,
          errorKey: null,
          errorParams: null,
          errorPaths: [],
        });
        showToast({
          text: text,
          action: {
            labelKey: "toast.view",
            onClick: () => openDrawer(sessionId, "ghost"),
          },
        });
        if (summary.images.length > 0) restoreImages(sessionId, summary.images);
        refreshOpenDrawer(sessionId);
      }

      /** 失败：文件冲突/失败把路径列出来，其余按错误码显示文案。 */
      function handleRewindFailure(
        /** @type {any} */ sessionId,
        /** @type {any} */ target,
        /** @type {any} */ origin,
        /** @type {any} */ wasConfirm,
        /** @type {any} */ error,
      ) {
        let state = store.getSnapshot();
        let failure = errorStateOf(error);
        if (wasConfirm !== true) {
          // 从列表直接执行（偏好关掉了确认）时失败：只弹 toast，保留候选列表。
          patch({
            executing: false,
            loading: false,
            busy: false,
            errorKey: null,
            errorParams: null,
            errorPaths: [],
          });
          showToastKey(failure.errorKey, failure.errorParams);
          return;
        }
        let details = error?.details;
        let paths = conflictPathsOf(details).concat(failedPathsOf(details));
        patch({
          mode: "confirm",
          origin: origin === "list" || (state && state.origin === "list") ? "list" : "row",
          sessionId: sessionId,
          target: target,
          executing: false,
          loading: false,
          previewLoading: false,
          busy: false,
          errorKey: failure.errorKey,
          errorParams: failure.errorParams,
          errorPaths: paths,
        });
      }

      /** 确认框「开始回退」；busy / 执行中 / 预览加载中都不允许。 */
      function doRewind() {
        let state = store.getSnapshot();
        if (state?.mode !== "confirm" || !state.target) return;
        if (state.executing === true || state.busy === true || state.previewLoading === true)
          return;
        executeRewind(state.sessionId, state.target, state.rewindMode, state.origin || "row");
      }

      // ---- 抽屉：已撤回 / 回溯记录 / 救援点 / 设置 ----

      /** 打开抽屉（默认已撤回 tab）；已有其它会话的抽屉状态则重置。 */
      function openDrawer(/** @type {any} */ sessionId, /** @type {any} */ tab) {
        if (!sessionId) return;
        let nextTab = normalizeTab(tab);
        patch((/** @type {any} */ state) => {
          let current = state.drawer;
          let reuse =
            current && current.open === true && current.sessionId === sessionId ? current : null;
          let base = reuse || createDrawerState();
          return {
            mode: null,
            origin: null,
            drawer: Object.assign({}, base, {
              open: true,
              sessionId: sessionId,
              tab: nextTab,
            }),
          };
        });
        loadDrawerTab(sessionId, nextTab, false);
      }

      function closeDrawer() {
        patchDrawer(null, { open: false, sessionId: null });
        patchDrawer("rescues", { pendingId: null, executingId: null });
      }

      function setDrawerTab(/** @type {any} */ tab) {
        let state = store.getSnapshot();
        let drawer = state.drawer;
        if (!drawer?.sessionId) return;
        let nextTab = normalizeTab(tab);
        patchDrawer(null, { tab: nextTab });
        loadDrawerTab(drawer.sessionId, nextTab, false);
      }

      function refreshDrawer() {
        let drawer = store.getSnapshot().drawer;
        if (!drawer?.open || !drawer.sessionId) return;
        loadDrawerTab(drawer.sessionId, drawer.tab, true);
      }

      /** 回溯成功后，抽屉正开着就刷新当前 tab。 */
      function refreshOpenDrawer(/** @type {any} */ sessionId) {
        let drawer = store.getSnapshot().drawer;
        if (drawer?.open !== true || drawer.sessionId !== sessionId) return;
        loadDrawerTab(sessionId, drawer.tab, true);
      }

      /** 按 tab 加载数据（force=false 时已有数据就只静默刷新）。 */
      function loadDrawerTab(
        /** @type {any} */ sessionId,
        /** @type {any} */ tab,
        /** @type {any} */ force,
      ) {
        if (tab === "ghost") loadGhost(sessionId, { reset: true, force: force });
        else if (tab === "audit") loadAudit(sessionId);
        else if (tab === "rescues") loadRescues(sessionId);
        else loadHealth(sessionId);
      }

      /** 已撤回内容（宿主 ghost RPC；q 交给宿主做包含匹配）。 */
      function loadGhost(/** @type {any} */ sessionId, /** @type {any} */ options) {
        let reset = options?.reset !== false;
        let drawer = store.getSnapshot().drawer;
        let previous = drawer?.ghost ? drawer.ghost : { q: "", nextCursor: null };
        let query = options && typeof options.q === "string" ? options.q : previous.q;
        let cursor = reset ? null : previous.nextCursor;
        if (!reset && (cursor === null || cursor === undefined)) return;
        patchDrawer(
          "ghost",
          reset ? { loading: true, loadingOlder: false } : { loadingOlder: true },
        );
        /** @type {any} */
        let request = { sessionId: sessionId, limit: 200 };
        if (typeof cursor === "number") request.cursor = cursor;
        if (query) request.q = query;
        call("ghost", request)
          .then((/** @type {any} */ value) => {
            let page = normalizeGhost(value);
            patchDrawer("ghost", (/** @type {any} */ state) => ({
              loading: false,
              loadingOlder: false,
              errorKey: null,
              errorParams: null,
              cuts: reset ? page.cuts : mergeGhostCuts(state.cuts, page.cuts),
              nextCursor: page.nextCursor,
              q: query,
            }));
          })
          .catch((/** @type {any} */ error) => {
            let failure = errorStateOf(error);
            patchDrawer(
              "ghost",
              Object.assign({}, failure, { loading: false, loadingOlder: false }),
            );
          });
      }

      /** 已撤回搜索框：防抖后按 q 重新拉第一页。 */
      function searchGhost(/** @type {any} */ value) {
        let sessionId = store.getSnapshot().drawer?.sessionId;
        let query = typeof value === "string" ? value : "";
        patchDrawer("ghost", { q: query });
        if (ghostSearchTimer !== null) clearTimeout(ghostSearchTimer);
        ghostSearchTimer = setTimeout(() => {
          ghostSearchTimer = null;
          if (sessionId) loadGhost(sessionId, { reset: true, q: query });
        }, 300);
      }

      function loadOlderGhost() {
        let drawer = store.getSnapshot().drawer;
        if (!drawer?.sessionId || !drawer.ghost) return;
        if (drawer.ghost.loading || drawer.ghost.loadingOlder) return;
        if (drawer.ghost.nextCursor === null || drawer.ghost.nextCursor === undefined) return;
        loadGhost(drawer.sessionId, { reset: false, q: drawer.ghost.q });
      }

      /** 回溯记录（audit RPC，倒序）。 */
      function loadAudit(/** @type {any} */ sessionId) {
        patchDrawer("audit", { loading: true });
        call("audit", { sessionId: sessionId, limit: 50 })
          .then((/** @type {any} */ value) => {
            patchDrawer("audit", {
              loading: false,
              errorKey: null,
              errorParams: null,
              entries: normalizeAuditEntries(value),
            });
          })
          .catch((/** @type {any} */ error) => {
            patchDrawer("audit", Object.assign({}, errorStateOf(error), { loading: false }));
          });
      }

      /** 展开/收起一条审计记录的路径清单。 */
      function toggleAuditPaths(/** @type {any} */ id) {
        patchDrawer("audit", (/** @type {any} */ state) => {
          /** @type {any} */
          let expanded = Object.assign({}, state.expanded);
          if (expanded[id] === true) delete expanded[id];
          else expanded[id] = true;
          return { expanded: expanded };
        });
      }

      /** 救援点列表。 */
      function loadRescues(/** @type {any} */ sessionId) {
        patchDrawer("rescues", { loading: true });
        call("rescues", { sessionId: sessionId })
          .then((/** @type {any} */ value) => {
            patchDrawer("rescues", {
              loading: false,
              errorKey: null,
              errorParams: null,
              list: normalizeRescues(value),
            });
          })
          .catch((/** @type {any} */ error) => {
            patchDrawer("rescues", Object.assign({}, errorStateOf(error), { loading: false }));
          });
      }

      function setPendingRescue(/** @type {any} */ id) {
        patchDrawer("rescues", { pendingId: typeof id === "string" ? id : null });
      }

      function cancelRescue() {
        patchDrawer("rescues", { pendingId: null });
      }

      /** 二次确认后恢复救援点（安全由宿主负责：先另存新救援点再写回）。 */
      function confirmRescue() {
        let drawer = store.getSnapshot().drawer;
        let sessionId = drawer?.sessionId;
        let rescueId = drawer?.rescues?.pendingId ?? null;
        if (!sessionId || !rescueId) return;
        patchDrawer("rescues", { executingId: rescueId });
        call("restoreRescue", { sessionId: sessionId, rescueId: rescueId })
          .then((/** @type {any} */ value) => {
            let result = normalizeRescueResult(value);
            patchDrawer("rescues", { pendingId: null, executingId: null });
            if (result.failed.length > 0) {
              showToastKey("toast.rescuePartial", {
                restored: result.restored.length,
                failed: result.failed.length,
              });
            } else {
              showToastKey("toast.rescueDone", { restored: result.restored.length });
            }
            loadRescues(sessionId);
            loadAudit(sessionId);
          })
          .catch((/** @type {any} */ error) => {
            patchDrawer("rescues", { executingId: null });
            let failure = errorStateOf(error);
            showToastKey(failure.errorKey, failure.errorParams);
          });
      }

      /** 诊断（health RPC）。 */
      function loadHealth(/** @type {any} */ sessionId) {
        let target = sessionId || store.getSnapshot().drawer?.sessionId;
        patchDrawer("settings", {
          health: { loading: true, errorKey: null, errorParams: null, data: null },
        });
        call("health", target ? { sessionId: target } : {})
          .then((/** @type {any} */ value) => {
            patchDrawer("settings", {
              health: {
                loading: false,
                errorKey: null,
                errorParams: null,
                data: normalizeHealth(value),
              },
            });
          })
          .catch((/** @type {any} */ error) => {
            let failure = errorStateOf(error);
            patchDrawer("settings", {
              health: {
                loading: false,
                errorKey: failure.errorKey,
                errorParams: failure.errorParams,
                data: null,
              },
            });
          });
      }

      /** 设置项：写入 localStorage 并立刻生效。 */
      function updatePrefs(/** @type {any} */ partial) {
        prefs = sanitizePrefs(Object.assign({}, prefs, partial));
        writePrefs(prefs);
        patchDrawer("settings", { prefs: prefs, saved: true });
        if (prefsSavedTimer !== null) clearTimeout(prefsSavedTimer);
        prefsSavedTimer = setTimeout(() => {
          prefsSavedTimer = null;
          patchDrawer("settings", { saved: false });
        }, 2000);
      }

      /** 复制文本到剪贴板（best-effort）。 */
      function copyText(/** @type {any} */ text) {
        let value = typeof text === "string" ? text : "";
        let clipboard;
        try {
          clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
        } catch (_error) {
          clipboard = undefined;
        }
        if (clipboard && typeof clipboard.writeText === "function") {
          Promise.resolve(clipboard.writeText(value))
            .then(() => showToastKey("toast.copied"))
            .catch(() => showToastKey("toast.copyFailed"));
          return;
        }
        showToastKey("toast.copyFailed");
      }

      /** 复制一条审计记录的 JSON。 */
      function copyJson(/** @type {any} */ entry) {
        let text;
        try {
          text = JSON.stringify(entry, null, 2);
        } catch (_error) {
          showToastKey("toast.copyFailed");
          return;
        }
        copyText(text);
      }

      /** 把一条已撤回的用户消息放回输入框（不恢复上下文）。 */
      function refillGhostItem(/** @type {any} */ item) {
        let sessionId = store.getSnapshot().drawer?.sessionId;
        if (!sessionId || !item || item.kind !== "user") return;
        let outcome = fillComposer(sessionId, item.text || "");
        if (outcome === "draft") showToastKey("toast.refillDraft");
        else if (outcome === "none") showToastKey("toast.refillNoComposer");
        else showToastKey("toast.refilled");
      }

      /**
       * 图片回填：把 rewind 响应 target.images 里的持久附件放回 composer。
       * best-effort：任何一步失败只跳过图片，绝不影响已经完成的回溯。
       * @param {any} sessionId 会话 id
       * @param {any} images normalizeImages 的产物
       */
      function restoreImages(/** @type {any} */ sessionId, /** @type {any} */ images) {
        let refs = Array.isArray(images) ? images : [];
        if (refs.length === 0) return Promise.resolve(undefined);
        let conversation = safeGet(ctx, "conversation");
        let binding = bindingOf(sessionId);
        let session = binding?.session;
        let scope;
        try {
          scope =
            ctx.sessions && typeof ctx.sessions.scope === "function"
              ? ctx.sessions.scope(sessionId)
              : undefined;
        } catch (_error) {
          scope = undefined;
        }
        if (
          !session ||
          typeof session.readAttachment !== "function" ||
          !conversation ||
          !conversation.input ||
          typeof conversation.input.for !== "function" ||
          typeof conversation.createDrafts !== "function" ||
          scope === undefined
        ) {
          return Promise.resolve(undefined);
        }
        /** @type {File[]} */
        let files = [];
        let chain = Promise.resolve();
        for (let index = 0; index < refs.length; index += 1) {
          let ref = refs[index];
          chain = chain.then(() => {
            if (!mediaExtensionOf(ref.mediaType)) return undefined;
            if (!(ref.bytes > 0) || !(ref.width > 0) || !(ref.height > 0)) {
              return undefined;
            }
            /** @type {any} */
            let request = {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
            };
            if (ref.name) request.name = ref.name;
            return Promise.resolve(session.readAttachment(request))
              .then((/** @type {any} */ result) => {
                if (result?.ok !== true || !result?.value?.data) {
                  return undefined;
                }
                try {
                  files.push(
                    new File([result.value.data], imageFileName(ref, index), {
                      type: ref.mediaType,
                    }),
                  );
                } catch (_error) {
                  /* 单张图片失败不影响其它 */
                }
                return undefined;
              })
              .catch(() => undefined);
          });
        }
        return chain
          .then(() => {
            if (files.length === 0) return undefined;
            try {
              let snapshot = sessionSnapshotOf(sessionId);
              let uploadImages =
                !snapshot || snapshot.subagent === null || snapshot.subagent === undefined;
              let drafts = conversation.createDrafts(sessionId, files, uploadImages);
              let facade = conversation.input.for(scope);
              let admitted =
                typeof facade.addAttachments === "function"
                  ? facade.addAttachments(drafts.map((/** @type {any} */ draft) => draft.id))
                  : false;
              if (
                admitted === false &&
                typeof conversation.releaseDraftAttachments === "function"
              ) {
                conversation.releaseDraftAttachments(drafts);
              }
            } catch (_error) {
              /* 图片回填失败只影响图片 */
            }
            return undefined;
          })
          .catch(() => undefined);
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
        cancelDialog: cancelDialog,
        back: back,
        close: close,
        move: move,
        pick: pick,
        doRewind: doRewind,
        setRewindMode: setRewindMode,
        togglePathList: togglePathList,
        setListSearch: setListSearch,
        loadOlderCandidates: loadOlderCandidates,
        seedCuts: seedCuts,
        clearToast: clearToast,
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,
        setDrawerTab: setDrawerTab,
        refreshDrawer: refreshDrawer,
        searchGhost: searchGhost,
        loadOlderGhost: loadOlderGhost,
        toggleAuditPaths: toggleAuditPaths,
        copyText: copyText,
        copyJson: copyJson,
        refillGhostItem: refillGhostItem,
        loadHealth: loadHealth,
        updatePrefs: updatePrefs,
        setPendingRescue: setPendingRescue,
        cancelRescue: cancelRescue,
        confirmRescue: confirmRescue,
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

      // 会话头部动作区：挂载时拉一次宿主 cuts（可见性兜底）+ 打开回溯抽屉的图标。
      ctx.effect(
        () =>
          ctx.slots.inject("conversation.session.header.actions", () =>
            ctx.slots.register(
              {
                name: "conversation.session.header.actions",
                id: "session-rewind-header",
                order: 1000,
                locale: NS,
              },
              (/** @type {any} */ props) =>
                h(SessionHeaderActions, Object.assign({}, props, { api: api, t: props.t || t })),
            ),
          ),
        "session-rewind: header actions",
      );

      // /rewind 命令装饰：宿主 popupSelect 列出候选，选中后打开确认框。
      // 参数形式 /rewind @<seq> [chat|both] 由 host 命令直接执行，这里不实现。
      try {
        let commandUi = safeGet(ctx, "commandUi");
        if (commandUi && typeof commandUi.decorate === "function") {
          ctx.effect(
            () =>
              commandUi.decorate({
                name: "rewind",
                ui: {
                  kind: "popupSelect",
                  options: (/** @type {any} */ session) => {
                    let sessionId =
                      session && typeof session.sessionId === "string"
                        ? session.sessionId
                        : undefined;
                    if (!sessionId) return Promise.resolve([]);
                    return call(
                      "candidates",
                      Object.assign({ sessionId: sessionId }, pageParamsOf(prefs, null, "")),
                    )
                      .then((/** @type {any} */ value) => {
                        let page = normalizeCandidatePage(value);
                        commandCandidates = page.candidates;
                        return page.candidates.map((/** @type {any} */ candidate) => ({
                          id: String(candidate.seq),
                          label: candidate.preview || candidate.text || String(candidate.seq),
                          detail: formatClock(candidate.time),
                        }));
                      })
                      .catch(() => []);
                  },
                  onSelect: (/** @type {any} */ option, /** @type {any} */ session) => {
                    let sessionId =
                      session && typeof session.sessionId === "string"
                        ? session.sessionId
                        : undefined;
                    let seq = option ? Number(option.id) : NaN;
                    if (!sessionId || !Number.isFinite(seq)) return;
                    let candidate = commandCandidates.find(
                      (/** @type {any} */ item) => item.seq === seq,
                    );
                    if (candidate) openConfirm(candidate, sessionId, "command");
                  },
                },
              }),
            "session-rewind: command decoration",
          );
        }
      } catch (_error) {
        /* commandUi 缺失时降级：只有按钮/Esc Esc 入口 */
      }
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
        // v2：偏好 / 预览 / 候选分页 / 抽屉数据 / 图片回填
        PREF_DEFAULTS: PREF_DEFAULTS,
        PREF_STORAGE_KEY: PREF_STORAGE_KEY,
        PAGE_SIZE_MIN: PAGE_SIZE_MIN,
        PAGE_SIZE_MAX: PAGE_SIZE_MAX,
        DRAWER_TABS: DRAWER_TABS,
        clampInt: clampInt,
        sanitizePrefs: sanitizePrefs,
        formatCount: formatCount,
        formatBytes: formatBytes,
        formatClock: formatClock,
        formatDateTime: formatDateTime,
        normalizePathList: normalizePathList,
        normalizeFiles: normalizeFiles,
        normalizePreview: normalizePreview,
        fileModeState: fileModeState,
        effectiveMode: effectiveMode,
        conflictPathsOf: conflictPathsOf,
        failedPathsOf: failedPathsOf,
        normalizeCandidatePage: normalizeCandidatePage,
        mergeCandidatePages: mergeCandidatePages,
        pageParamsOf: pageParamsOf,
        normalizeGhostItem: normalizeGhostItem,
        normalizeGhost: normalizeGhost,
        ghostCutKey: ghostCutKey,
        mergeGhostCuts: mergeGhostCuts,
        filesReceiptOf: filesReceiptOf,
        normalizeAuditEntry: normalizeAuditEntry,
        normalizeAuditEntries: normalizeAuditEntries,
        normalizeRescuePaths: normalizeRescuePaths,
        normalizeRescues: normalizeRescues,
        normalizeRescueResult: normalizeRescueResult,
        normalizeHealth: normalizeHealth,
        normalizeImages: normalizeImages,
        imageRefsOf: imageRefsOf,
        mediaExtensionOf: mediaExtensionOf,
        imageFileName: imageFileName,
        rewindSummaryOf: rewindSummaryOf,
        normalizeTab: normalizeTab,
        modeLabelKey: modeLabelKey,
        dictionaries: Object.freeze({ zh: zh, en: en }),
      }),
    });

    return module.exports;
  },
});
