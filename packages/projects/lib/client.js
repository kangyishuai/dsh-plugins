// @ts-check
// client 半：classic script，以 __ModuleLoader__.load 注册 factory，不能使用 import。
// 注册面：侧栏全局面板入口（sidebar.panellist）+ 主面板（main keyed）+ 设置分节（settings.section）。
// 宿主调用走 ctx.connection.rpc.call("/api", "<service>/<method>", { args: {...} }) —— 无构建插件
// 没有 typert 生成的客户端产物，因此不能用 ctx.reflect.get("remote.xxx")
// （见 docs/runtime/0.2.1-rc.5.md §6.10）。
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-projects",
  factory(require) {
    var module = { exports: /** @type {any} */ ({}) };
    var exports = module.exports;

    /** @type {any} */
    var React = require("react");
    var h = React.createElement;
    var useEffect = React.useEffect;
    var useState = React.useState;
    var useCallback = React.useCallback;
    var useRef = React.useRef;

    var NS = "projects";
    // 运行时字典：无构建插件没有 typert 产物，必须在代码里注册（locale/*.json 只供插件管理器显示）。
    var ZH = {
      title: "项目",
      "panel.title": "项目",
      "panel.summary":
        "{projects} 个项目 · {active} 个活跃 · {threads} 个线程 · {attached} 个会话带上下文",
      "panel.empty": "还没有项目。建一个，把会话丢进去，下次就不用重复交代背景。",
      "panel.createPlaceholder": "项目名，例如 payments-api",
      "panel.create": "新建项目",
      "panel.creating": "正在新建…",
      "panel.refresh": "刷新",
      "panel.threads": "{count} 个线程",
      "panel.goalEmpty": "未设置目标",
      "panel.unavailable": "项目数据不可用：{reason}",
      "panel.errorCreate": "新建失败：{reason}",
      "panel.state.active": "活跃",
      "panel.state.archived": "已归档",
      "settings.section": "项目",
      "settings.dataRoot": "数据根目录",
      "settings.summary": "{count} 个项目",
      "settings.diag": "诊断",
      "settings.unavailable": "不可用",
      "settings.hint": "项目元数据与内容文件都在本机；不会写任何远端仓库。",
      "menu.attach": "归属到项目…",
      "menu.loading": "加载中…",
      "menu.empty": "还没有项目，先在项目面板里建一个",
      "detail.back": "返回",
      "detail.loading": "加载中…",
      "detail.tab.threads": "线程 ({count})",
      "detail.tab.memory": "记忆",
      "detail.tab.audit": "审计",
      "detail.threadsEmpty":
        "还没有线程。在上面输入一个任务就能新建线程；也可以回到会话行，用「…」菜单把已有会话归属到本项目。",
      "detail.noDirHint":
        "还没有绑定项目目录：线程会跑在插件的数据目录里（不隔离，也不便接手你的仓库）。建议先在上面「项目目录」里绑定一个 git 仓库，线程才会各占一个 worktree。",
      "detail.threadState": "状态：{state}",
      "detail.instructions": "常设规则（instructions.md）",
      "detail.memoryEdit": "编辑常设规则",
      "detail.memorySave": "保存规则",
      "detail.memorySaving": "保存中…",
      "detail.memorySaved": "已保存规则（{chars} 字符）",
      "detail.memoryCleared": "已清空规则",
      "detail.memorySaveFailed": "保存失败：{reason}",
      "detail.memoryAppendPlaceholder": "追加一条记忆（例如：这个仓库的测试用 pnpm test）",
      "detail.memoryAppend": "追加记忆",
      "detail.memoryAppended": "已追加记忆",
      "detail.memoryAppendDup": "这条已经记过了，没有重复写入",
      "detail.memoryIndex": "记忆索引（MEMORY.md）",
      "detail.emptyFile": "（空）",
      "detail.auditEmpty": "还没有审计记录。",
      "detail.state.waiting-user": "待你处理",
      "detail.state.failed": "失败",
      "detail.state.working": "进行中",
      "detail.state.done": "已完成",
      "detail.state.idle": "空闲",
      "detail.threadPlaceholder": "给这个线程一个任务，回车即建",
      "detail.threadCreate": "新建线程",
      "detail.threadCreating": "正在建…",
      "detail.dirLabel": "项目目录",
      "detail.dirPlaceholder": "绝对路径；线程会在这里建 worktree",
      "detail.dirSave": "绑定",
      "detail.dirGitHint": "这是 git 仓库：线程会在这里建独立 worktree（隔离）",
      "detail.dirSharedHint":
        "不是 git 仓库：线程会共享这个目录（没有 worktree 隔离，别让两个线程同时改同一批文件）",
      "detail.dirInvalidHint": "需要绝对路径（以 / 开头）；相对路径无法作为会话目录，已拒绝保存。",
      "detail.threadShared": "未隔离",
      "detail.threadWorktree": "目录：{path}",
      "detail.threadReclaim": "回收目录",
      "detail.threadReclaimed": "已回收 worktree（分支保留）",
      "detail.threadReclaimKept": "未回收：{reason}",
      "detail.threadRemove": "移除",
      "detail.threadRemoveConfirm": "确认移除追踪？",
      "detail.threadRemoved": "已移除追踪",
      "detail.threadActionFailed": "操作失败：{reason}",
      "detail.pause": "暂停项目",
      "detail.resume": "恢复项目",
      "detail.budget": "今日 {today} 个线程 · 进行中 {running}",
      "detail.delete": "删除项目",
      "detail.deleting": "正在删除…",
      "detail.deleteConfirm": "确认删除",
      "detail.deleteCancel": "取消",
      "detail.deleteDetails": "详情（路径与恢复位置）",
      "detail.deleteImpact": "{summary}",
      "notify.failed": "{count} 个线程失败",
      "notify.waiting": "{count} 个线程在等你",
      "detail.routePlaceholder": "按规则派活：输入一句话，由规则决定怎么做",
      "detail.routeDispatch": "按规则派活",
      "detail.routeBusy": "处理中…",
      "detail.routeDecision": "按 {by} → {action}",
      "detail.routeExecuted": "已执行",
      "detail.routeRejected": "被拦",
      "detail.routeAction.answer-inline": "直接回答",
      "detail.routeAction.propose": "给出方案",
      "detail.routeAction.new-thread": "新建线程",
      "detail.routeAction.reuse-thread": "复用现有线程",
      "detail.routeBy.rule": "按规则「{rule}」",
      "detail.routeBy.fallback": "按默认策略",
      "detail.routeOk": "{how}：{action}",
      "detail.routeBlocked":
        "{how}建议「{action}」，但当前自治等级（{level}）不允许自动执行，已拦下",
      "detail.routeBlockedHint": "可在设置里提高自治等级，或手动执行",
      "detail.approvalsTitle": "待你批准的动作",
      "detail.approve": "批准",
      "detail.reject": "拒绝",
      "settings.policyTitle": "项目策略（自治级别 / 人格 / 兜底）",
      "settings.noProjects": "还没有项目",
      "settings.autonomy": "自治级别",
      "settings.level.L0": "只观察",
      "settings.level.L1": "只提议（默认）",
      "settings.level.L2": "可代办",
      "settings.level.L3": "全权",
      "settings.persona": "人格（留空用默认）",
      "settings.fallback": "规则都不命中时允许模型兜底提议",
      "settings.dangerTitle": "危险动作开关（默认全关）",
      "settings.dangerHint": "打开任何一个开关都需要你明确同意；插件不会自行打开。",
      "settings.danger.forcePushOwnBranch.label": "允许覆盖插件自己创建的远端分支",
      "settings.danger.forcePushOwnBranch.risk":
        "只覆盖插件自己建的分支。覆盖前会核对远端版本：被别人改过、分支受保护、或版本对不上，就停下并把旧版本号记下来，方便恢复。",
      "settings.danger.pushProtectedBranch.label": "允许直接推送主干或受保护分支",
      "settings.danger.pushProtectedBranch.risk":
        "只对你在「仓库授权」里显式加过的仓库生效。推送前会检查该分支的保护规则：要求走 PR 的仓库会直接拒绝；每次都会记录，检测到多人协作会额外提醒。",
      "settings.danger.autoMerge.label": "允许自动合并 PR",
      "settings.danger.autoMerge.risk":
        "合并之后只能用 revert 回退，不能当作没发生。仍然要求：改动量在阈值内、CI 通过、人工批准数达标。",
      "settings.danger.trashAuto.label": "允许自动归档或删除到回收站",
      "settings.danger.trashAuto.risk": "内容会先移进回收站，之后还能恢复，但要花点时间找回。",
      "settings.danger.purgeAfterRetention.label": "允许清理过期的回收站条目",
      "settings.danger.purgeAfterRetention.risk":
        "只清理已在回收站、且超过保留期的条目。清理前先列出清单，默认只看不删，真删还要再确认一次。",
      "settings.danger.editProfile.label": "允许修改项目策略本身",
      "settings.danger.editProfile.risk":
        "协调器可能借此放宽对自己的限制——风险最高，建议保持关闭。",
      "detail.archive": "归档项目",
      "detail.unarchive": "取消归档",
      "detail.execute": "执行",
      "detail.executed": "已执行（结果见审计）",
      "detail.refused": "未执行：{reason}",
      "detail.configTitle": "高级设置（仓库授权 / 回收站）",
      "detail.grantsTitle": "仓库授权（直推保护分支用）",
      "detail.grantsEmpty": "尚未授权任何仓库；直推保护分支前必须在这里加 owner/repo",
      "detail.grantAdd": "添加",
      "detail.purgeTitle": "回收站清理",
      "detail.purgeHint":
        "只清理本项目回收站里超过保留期的条目；先预览，再确认。需要在上面的危险开关里打开「清理过期的回收站条目」。",
      "detail.purgePreview": "预览可清理项",
      "detail.trashTitle": "回收站（可恢复）",
      "detail.trashEmpty": "回收站是空的。删除项目会先放进这里，可以随时恢复。",
      "detail.trashRestore": "恢复",
      "detail.trashDelete": "彻底删除",
      "detail.trashDeleteConfirm": "确认彻底删除（{size}，不可恢复）",
      "detail.trashDeleted": "已彻底删除（{size}）",
      "detail.trashDeleteFailed": "彻底删除失败：{reason}",
      "detail.trashEmptyAll": "清空回收站",
      "detail.trashEmptyConfirm": "确认清空（{count} 项 / {size}，不可恢复）",
      "detail.trashEmptied": "已清空回收站（{count} 项）",
      "detail.trashRestored": "已恢复「{name}」（{count} 个线程）",
      "detail.trashFailed": "恢复失败：{reason}",
      "detail.purgeConfirm": "确认清理 {count} 项",
      "detail.purgeNothing": "没有超过保留期的条目",
      "panel.search": "搜索项目",
      "panel.searchClear": "清空搜索",
      "panel.searchEmpty": "没有匹配的项目",
      "panel.sort": "排序",
      "panel.sort.lastActive": "上次活跃",
      "panel.sort.created": "创建时间",
      "panel.sort.name": "名称",
      "panel.pin": "收藏",
      "panel.unpin": "取消收藏",
      "panel.pinned": "已收藏",
      "panel.rowMenu": "更多操作",
      "panel.rowEdit": "编辑详情",
      "panel.rowSave": "保存",
      "panel.rowArchive": "归档",
      "panel.rowUnarchive": "恢复",
      "panel.rowDelete": "删除…",
      "panel.rowDeleteTitle": "删除项目？",
      "panel.rowActionFailed": "操作失败：{reason}",
      "panel.pinFailed": "收藏没有保存：{reason}",
      "panel.toastClose": "关闭",
      "panel.toastCreated": "已创建「{name}」",
      "panel.toastUpdated": "已更新「{name}」",
      "panel.toastPinned": "已收藏「{name}」",
      "panel.toastUnpinned": "已取消收藏「{name}」",
      "panel.toastArchived": "已归档「{name}」（可恢复）",
      "panel.toastUnarchived": "已恢复「{name}」",
      "panel.toastDeleted": "已移入回收站：{name}",
      "panel.relative.now": "刚刚",
      "panel.relative.minutes": "{count} 分钟前",
      "panel.relative.hours": "{count} 小时前",
      "panel.relative.days": "{count} 天前",
      "panel.emptyHint": "建一个，把会话丢进去，下次就不用重复交代背景。",
      "panel.new.title": "新建项目",
      "panel.new.description":
        "用来承载长期工作的固定位置：上下文会在这里慢慢累积，文件和指令都留在你自己的目录里。",
      "panel.new.scratch": "从零开始",
      "panel.new.scratchHint": "新建一个文件夹，放指令和文件。",
      "panel.new.folder": "使用已有文件夹",
      "panel.new.folderHint": "把你已经在用的目录交给这个项目。",
      "panel.new.folderUnavailable":
        "这个版本没有给插件面板开放目录选择器，请直接填绝对路径（降级，不假装能选）。",
      "panel.new.nameLabel": "项目名",
      "panel.new.namePlaceholder": "项目名，例如 payments-api",
      "panel.new.goalLabel": "说明 / 目标",
      "panel.new.goalPlaceholder": "这个项目是做什么的（可选）",
      "panel.new.dirLabel": "项目目录（可选）",
      "panel.new.dirPlaceholder": "绝对路径；留空则先用插件数据目录",
      "panel.new.instructionsLabel": "指令（可选，先写后注入）",
      "panel.new.instructionsPlaceholder": "会话开始时会读到这些规则",
      "panel.new.memoryHint": "项目记忆默认开启：会话会读到 MEMORY.md 索引",
      "panel.new.create": "创建项目",
      "panel.new.creating": "正在创建…",
      "panel.new.cancel": "取消",
      "panel.new.back": "返回",
      "detail.cancel": "取消",
      "detail.section.instructions": "指令",
      "detail.section.memory": "记忆",
      "detail.section.context": "上下文",
      "detail.section.open": "打开",
      "detail.instructionsEdit": "编辑指令",
      "detail.instructionsEmpty": "还没有指令；点 ✎ 写一条。",
      "detail.memoryCount": "{count} 个条目",
      "detail.memoryIndexHint": "MEMORY.md 索引里有内容，会话会读到。",
      "detail.memoryEmptyHint": "还没有记忆；会话里说「记住…」就会写进来。",
      "detail.moreActions": "更多操作",
      "detail.projectState": "项目状态",
      "detail.purged": "已清理 {count} 项，清单已写入 trash/",
    };
    var EN = {
      title: "Projects",
      "panel.title": "Projects",
      "panel.summary":
        "{projects} projects · {active} active · {threads} threads · {attached} sessions with context",
      "panel.empty":
        "No projects yet. Create one, drop sessions into it, and stop restating the background.",
      "panel.createPlaceholder": "Project name, e.g. payments-api",
      "panel.create": "New project",
      "panel.creating": "Creating…",
      "panel.refresh": "Refresh",
      "panel.threads": "{count} threads",
      "panel.goalEmpty": "No goal set",
      "panel.unavailable": "Project data unavailable: {reason}",
      "panel.errorCreate": "Create failed: {reason}",
      "panel.state.active": "active",
      "panel.state.archived": "archived",
      "settings.section": "Projects",
      "settings.dataRoot": "Data root",
      "settings.summary": "{count} projects",
      "settings.diag": "Diagnostics",
      "settings.unavailable": "Unavailable",
      "settings.hint":
        "Project metadata and content files stay local; no remote repository is written.",
      "menu.attach": "Add to project…",
      "menu.loading": "Loading…",
      "menu.empty": "No projects yet — create one in the Projects panel first",
      "detail.back": "Back",
      "detail.loading": "Loading…",
      "detail.tab.threads": "Threads ({count})",
      "detail.tab.memory": "Memory",
      "detail.tab.audit": "Audit",
      "detail.threadsEmpty":
        "No sessions belong to this project yet. Use “Add to project…” in a session's … menu.",
      "detail.noDirHint":
        "No project directory bound yet: threads run inside the plugin’s data directory (no isolation, and they cannot work on your repo). Bind a git repository above first — then each thread gets its own worktree.",
      "detail.threadState": "state: {state}",
      "detail.instructions": "Standing rules (instructions.md)",
      "detail.memoryIndex": "Memory index (MEMORY.md)",
      "detail.emptyFile": "(empty)",
      "detail.auditEmpty": "No audit entries yet.",
      "detail.state.waiting-user": "Waiting on you",
      "detail.state.failed": "Failed",
      "detail.state.working": "Working",
      "detail.state.done": "Done",
      "detail.state.idle": "Idle",
      "detail.threadPlaceholder": "Describe a task for a new thread (Enter to create)",
      "detail.threadCreate": "New thread",
      "detail.threadCreating": "Creating…",
      "detail.dirLabel": "Project dir",
      "detail.dirPlaceholder": "Absolute path; threads create worktrees here",
      "detail.dirSave": "Bind",
      "detail.dirGitHint": "Git repo: each thread gets its own worktree (isolated)",
      "detail.dirSharedHint":
        "Not a git repo: threads share this directory (no worktree isolation — avoid two threads editing the same files)",
      "detail.threadShared": "not isolated",
      "detail.threadWorktree": "dir: {path}",
      "detail.threadReclaim": "Reclaim dir",
      "detail.threadReclaimed": "Worktree reclaimed (branch kept)",
      "detail.threadReclaimKept": "Not reclaimed: {reason}",
      "detail.threadRemove": "Remove",
      "detail.threadRemoveConfirm": "Remove tracking?",
      "detail.threadRemoved": "Tracking removed",
      "detail.threadActionFailed": "Action failed: {reason}",
      "detail.pause": "Pause project",
      "detail.resume": "Resume project",
      "detail.budget": "{today} threads today · {running} running",
      "detail.delete": "Delete project",
      "detail.deleting": "Deleting…",
      "detail.deleteConfirm": "Delete",
      "detail.deleteCancel": "Cancel",
      "detail.deleteDetails": "Details (path and restore location)",
      "detail.deleteImpact": "{summary}",
      "notify.failed": "{count} threads failed",
      "notify.waiting": "{count} threads waiting on you",
      "detail.routePlaceholder": "Dispatch by rule: describe the task and let rules decide",
      "detail.routeDispatch": "Dispatch by rule",
      "detail.routeBusy": "Working…",
      "detail.routeDecision": "by {by} → {action}",
      "detail.routeExecuted": "executed",
      "detail.routeRejected": "blocked",
      "detail.routeAction.answer-inline": "answer inline",
      "detail.routeAction.propose": "propose a plan",
      "detail.routeAction.new-thread": "start a new thread",
      "detail.routeAction.reuse-thread": "reuse an existing thread",
      "detail.routeBy.rule": "rule “{rule}”",
      "detail.routeBy.fallback": "the default policy",
      "detail.routeOk": "{how}: {action}",
      "detail.routeBlocked":
        "{how} suggests “{action}”, but autonomy level {level} does not allow it to run automatically — stopped",
      "detail.routeBlockedHint": "raise the autonomy level in settings, or run it yourself",
      "detail.approvalsTitle": "Actions waiting for your approval",
      "detail.approve": "Approve",
      "detail.reject": "Reject",
      "settings.policyTitle": "Project policy (autonomy / persona / fallback)",
      "settings.noProjects": "No projects yet",
      "settings.autonomy": "Autonomy",
      "settings.level.L0": "observe only",
      "settings.level.L1": "propose only (default)",
      "settings.level.L2": "may act",
      "settings.level.L3": "full",
      "settings.persona": "Persona (empty = built-in default)",
      "settings.fallback": "Allow the model to propose when no rule matches",
      "settings.dangerTitle": "Danger switches (all off by default)",
      "settings.dangerHint":
        "Every switch needs your explicit consent; the plugin never turns one on by itself.",
      "settings.danger.forcePushOwnBranch.label": "Allow force-pushing your own dsh/ branches",
      "settings.danger.forcePushOwnBranch.risk":
        "Uses --force-with-lease bound to the expected SHA; refuses when the remote moved, the branch is protected, or the old SHA is unknown, and records the old SHA for recovery.",
      "settings.danger.pushProtectedBranch.label":
        "Allow pushing directly to default/protected branches",
      "settings.danger.pushProtectedBranch.risk":
        "Requires a per-repo grant in the project policy; checks protection/rulesets first and refuses when the server requires a PR; every push is audited and multi-collaborator repos raise a warning.",
      "settings.danger.autoMerge.label": "auto-merge PRs",
      "settings.danger.autoMerge.risk":
        "merging is irreversible (revert only); still gated by diff limits and human approval",
      "settings.danger.trashAuto.label": "auto archive/delete into trash",
      "settings.danger.trashAuto.risk":
        "moves content into trash/; restorable from manifest, but not free",
      "settings.danger.purgeAfterRetention.label":
        "Allow purging the trash after the retention period",
      "settings.danger.purgeAfterRetention.risk":
        "Only touches entries already in the trash that exceed the retention period; writes a purge manifest first; dry-run by default, real deletion needs explicit confirmation.",
      "settings.danger.editProfile.label": "edit project policy itself",
      "settings.danger.editProfile.risk":
        "the coordinator could loosen its own limits; highest risk",
      "detail.archive": "Archive project",
      "detail.unarchive": "Unarchive project",
      "detail.execute": "Execute",
      "detail.executed": "Executed (see audit)",
      "detail.refused": "Not executed: {reason}",
      "detail.grantsTitle": "Repository grants (for pushing protected branches)",
      "detail.grantsEmpty":
        "No repository granted yet; add owner/repo before pushing a protected branch",
      "detail.grantAdd": "Add",
      "detail.purgeTitle": "Trash purge",
      "detail.purgeHint":
        "Only purges entries in this project's trash past the retention period; preview first, then confirm. Requires the “Clean up expired trash entries” switch above.",
      "detail.purgePreview": "Preview purgeable",
      "detail.trashTitle": "Trash (restorable)",
      "detail.trashEmpty": "Trash is empty. Deleted projects land here first and can be restored.",
      "detail.trashRestore": "Restore",
      "detail.trashDelete": "Delete forever",
      "detail.trashDeleteConfirm": "Confirm delete forever ({size}, irreversible)",
      "detail.trashDeleted": "Deleted forever ({size})",
      "detail.trashDeleteFailed": "Delete failed: {reason}",
      "detail.trashEmptyAll": "Empty trash",
      "detail.trashEmptyConfirm": "Confirm empty ({count} items / {size}, irreversible)",
      "detail.trashEmptied": "Trash emptied ({count} items)",
      "detail.trashRestored": "Restored “{name}” ({count} threads)",
      "detail.trashFailed": "Restore failed: {reason}",
      "detail.purgeConfirm": "Purge {count} entries",
      "detail.purgeNothing": "Nothing past the retention period",
      "panel.search": "Search projects",
      "panel.searchClear": "Clear search",
      "panel.searchEmpty": "No projects match",
      "panel.sort": "Sort",
      "panel.sort.lastActive": "Last updated",
      "panel.sort.created": "Date created",
      "panel.sort.name": "Alphabetical",
      "panel.pin": "Pin",
      "panel.unpin": "Unpin",
      "panel.pinned": "Pinned",
      "panel.rowMenu": "More actions",
      "panel.rowEdit": "Edit details",
      "panel.rowSave": "Save",
      "panel.rowArchive": "Archive",
      "panel.rowUnarchive": "Unarchive",
      "panel.rowDelete": "Delete…",
      "panel.rowDeleteTitle": "Delete project?",
      "panel.rowActionFailed": "Action failed: {reason}",
      "panel.pinFailed": "Pin not saved: {reason}",
      "panel.toastClose": "Dismiss",
      "panel.toastCreated": "Created “{name}”",
      "panel.toastUpdated": "Updated “{name}”",
      "panel.toastPinned": "Pinned “{name}”",
      "panel.toastUnpinned": "Unpinned “{name}”",
      "panel.toastArchived": "Archived “{name}” (restorable)",
      "panel.toastUnarchived": "Unarchived “{name}”",
      "panel.toastDeleted": "Moved to trash: {name}",
      "panel.relative.now": "just now",
      "panel.relative.minutes": "{count} min ago",
      "panel.relative.hours": "{count} h ago",
      "panel.relative.days": "{count} d ago",
      "panel.emptyHint": "Create one, drop sessions into it, and stop restating the background.",
      "panel.new.title": "Create a new project",
      "panel.new.description":
        "A dedicated place for ongoing work, where context builds over time. Files and instructions stay in a folder on your computer.",
      "panel.new.scratch": "Start from scratch",
      "panel.new.scratchHint": "Set up a new folder with instructions and files.",
      "panel.new.folder": "Use an existing folder",
      "panel.new.folderHint": "Give this project a folder you already work from.",
      "panel.new.folderUnavailable":
        "No folder picker is exposed to plugin panels in this build — type an absolute path instead (honest fallback).",
      "panel.new.nameLabel": "Name",
      "panel.new.namePlaceholder": "Project name, e.g. payments-api",
      "panel.new.goalLabel": "Description",
      "panel.new.goalPlaceholder": "What this project is for (optional)",
      "panel.new.dirLabel": "Project folder (optional)",
      "panel.new.dirPlaceholder": "Absolute path; empty means the plugin data dir",
      "panel.new.instructionsLabel": "Instructions (optional, written then injected)",
      "panel.new.instructionsPlaceholder": "Rules sessions should read first",
      "panel.new.memoryHint": "Memory is on: sessions read the MEMORY.md index",
      "panel.new.create": "Create project",
      "panel.new.creating": "Creating…",
      "panel.new.cancel": "Cancel",
      "panel.new.back": "Back",
      "detail.cancel": "Cancel",
      "detail.section.instructions": "Instructions",
      "detail.section.memory": "Memory",
      "detail.section.context": "Context",
      "detail.section.open": "Open",
      "detail.instructionsEdit": "Edit instructions",
      "detail.instructionsEmpty": "No instructions yet — use ✎ to write one.",
      "detail.memoryCount": "{count} entries",
      "detail.memoryIndexHint": "MEMORY.md has content; sessions read it.",
      "detail.memoryEmptyHint": "No memory yet — say “remember…” in a session and it lands here.",
      "detail.moreActions": "More actions",
      "detail.projectState": "Project state",
      "detail.purged": "Purged {count} entries; manifest written under trash/",
    };
    var PANEL_ID = "projects";
    var SERVICE = "projects";

    /** 设计变量：全部取自宿主主题 token，前景/底色成对（plugin-conventions §2）。
     *  Claude 那边的层次（画布 → 卡片 → 输入框 → hover）映射到宿主的 bg-base → layer-1/2/3 → interactive-bg-hover。 */
    var T = {
      bg: "var(--dsw-alias-bg-base, Canvas)",
      panel: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))",
      card: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.1))",
      field: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.16))",
      text: "var(--dsw-alias-label-primary, CanvasText)",
      dim: "var(--dsw-alias-label-secondary, GrayText)",
      faint: "var(--dsw-alias-label-tertiary, GrayText)",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
      borderSoft: "var(--dsw-alias-border-l1, rgba(128,128,128,0.22))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
      accent: "var(--dsw-alias-interactive-bg-hover-accent, rgba(59,130,246,0.16))",
      accentText: "var(--dsw-alias-label-primary-bluish, LinkText)",
      // 主按钮必须**成对**：底色 token ↔ 前景 token，写死白字在深色主题下会糊（0.6.1 踩过）
      primaryFill: "var(--dsw-alias-button-primary-fill, #407bd9)",
      onPrimary: "var(--dsw-alias-label-primary-foreground, Canvas)",
      danger: "var(--dsw-alias-state-error-primary, #d9534f)",
      success: "var(--dsw-alias-state-success-primary, #3fa14a)",
      shadow: "var(--dsw-shadow-lv2, 0 6px 20px rgba(0,0,0,0.18))",
    };

    /**
     * 把宿主的失败回执变成异常（保留 code，便于冒烟断言）。
     * @param {any} result
     * @returns {Error}
     */
    function hostError(result) {
      var error = /** @type {any} */ (
        new Error(result?.error?.message || "host rejected the call")
      );
      error.code = result?.error?.code;
      return error;
    }

    /**
     * 调宿主服务。方法签名是位置参数，走 Typert 网关时用**具名参数**（args 键名 = 形参名）。
     * @param {any} ctx
     * @param {string} method
     * @param {Record<string, unknown>} [args]
     */
    function call(ctx, method, args) {
      var rpc = ctx?.connection?.rpc;
      if (!rpc || typeof rpc.call !== "function") {
        return Promise.reject(new Error("projects: no connection to the host"));
      }
      return Promise.resolve(rpc.call("/api", `${SERVICE}/${method}`, { args: args || {} })).then(
        /** @param {any} result */
        (result) => {
          if (result && typeof result === "object" && result.ok === false) {
            throw hostError(result);
          }
          // 网关的一元回执把业务值放在 value 里（与 session-delete 同款解包）
          return result && typeof result === "object" && "value" in result ? result.value : result;
        },
      );
    }

    /** @param {any} t @param {string} key @param {Record<string, unknown>} [vars] */
    function text(t, key, vars) {
      var value = t(key);
      if (!vars || typeof value !== "string") return value;
      return value.replace(/\{(\w+)\}/gu, (match, name) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : match,
      );
    }

    var styles = {
      // —— 面板外框 / 列表页 ——
      root: {
        padding: 0,
        color: T.text,
        background: T.bg,
        height: "100%",
        overflow: "auto",
        fontSize: "13px",
      },
      page: {
        maxWidth: "960px",
        margin: "0 auto",
        padding: "20px 24px 32px",
        boxSizing: "border-box",
      },
      headRow: {
        display: "flex",
        alignItems: "flex-end",
        gap: "12px",
        flexWrap: "wrap",
        marginBottom: "14px",
      },
      pageTitle: {
        display: "block",
        fontSize: "22px",
        fontWeight: 500,
        lineHeight: 1.2,
        letterSpacing: "0.01em",
      },
      pageSummary: { display: "block", marginTop: "4px", color: T.dim, fontSize: "12px" },
      toolbar: { display: "flex", alignItems: "center", gap: "6px" },
      searchWrap: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "0 8px",
        borderRadius: "8px",
        background: T.field,
        color: T.dim,
        minWidth: "170px",
      },
      searchInput: {
        flex: "1 1 auto",
        minWidth: 0,
        width: "120px",
        border: "none",
        outline: "none",
        background: "transparent",
        color: T.text,
        fontSize: "13px",
        padding: "6px 0",
      },
      iconButton: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "28px",
        height: "28px",
        padding: 0,
        borderRadius: "6px",
        border: "none",
        background: "transparent",
        color: T.dim,
        cursor: "pointer",
      },
      primaryButton: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 12px",
        borderRadius: "8px",
        border: "none",
        background: T.primaryFill,
        color: T.onPrimary,
        fontSize: "13px",
        fontWeight: 500,
        cursor: "pointer",
      },
      secondaryButton: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 12px",
        borderRadius: "8px",
        border: `1px solid ${T.border}`,
        background: T.field,
        color: T.text,
        fontSize: "13px",
        cursor: "pointer",
      },
      list: { display: "flex", flexDirection: "column", gap: "2px" },
      // —— 列表行 ——
      row: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 12px",
        borderRadius: "10px",
        minHeight: "52px",
        cursor: "pointer",
        boxSizing: "border-box",
      },
      rowMain: {
        minWidth: 0,
        flex: "1 1 auto",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      },
      name: {
        fontWeight: 500,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      goal: {
        color: T.dim,
        fontSize: "12px",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      meta: {
        color: T.faint,
        fontSize: "12px",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      dirBadge: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        maxWidth: "200px",
        minWidth: 0,
        color: T.faint,
        fontSize: "12px",
        padding: "2px 8px",
        borderRadius: "6px",
        background: T.panel,
      },
      pinMark: { color: T.accentText, display: "inline-flex", alignItems: "center", width: "16px" },
      // —— 模态 / 弹层 ——
      backdrop: {
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
        padding: "24px",
      },
      backdropHidden: { display: "none" },
      dialog: {
        width: "100%",
        maxWidth: "520px",
        maxHeight: "80vh",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "16px",
        borderRadius: "12px",
        background: T.card,
        color: T.text,
        border: `1px solid ${T.borderSoft}`,
        boxShadow: T.shadow,
      },
      dialogHead: { display: "flex", alignItems: "center", gap: "8px" },
      dialogTitle: { flex: "1 1 auto", fontSize: "16px", fontWeight: 600 },
      fieldLabel: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
      entryCard: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        width: "100%",
        padding: "12px",
        borderRadius: "10px",
        cursor: "pointer",
        border: `1px solid ${T.borderSoft}`,
        background: "transparent",
        color: T.text,
        textAlign: "left",
        fontSize: "13px",
      },
      entryIcon: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "32px",
        height: "32px",
        borderRadius: "8px",
        background: T.field,
        color: T.dim,
      },
      popover: {
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        zIndex: 70,
        minWidth: "200px",
        padding: "4px",
        borderRadius: "10px",
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
        boxShadow: T.shadow,
      },
      toastStack: {
        position: "fixed",
        right: "24px",
        bottom: "24px",
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxWidth: "360px",
        pointerEvents: "auto",
      },
      toast: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 12px",
        borderRadius: "10px",
        background: T.card,
        color: T.text,
        fontSize: "13px",
        border: `1px solid ${T.borderSoft}`,
        boxShadow: T.shadow,
      },
      toastClose: {
        border: "none",
        background: "transparent",
        color: T.dim,
        cursor: "pointer",
        fontSize: "12px",
        padding: 0,
      },
      // —— 空态 ——
      empty: {
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        color: T.dim,
        marginTop: "12px",
        lineHeight: 1.6,
      },
      emptyTitle: { color: T.text, fontSize: "15px", fontWeight: 500 },
      emptyHint: { color: T.dim, fontSize: "13px", marginTop: "4px" },
      // —— 旧结构仍在用的键（详情页 / 回收站 / 设置分节） ——
      header: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "4px" },
      title: { fontSize: "15px", fontWeight: 500 },
      summary: { color: T.dim, fontSize: "12px" },
      input: {
        flex: "1 1 auto",
        minWidth: 0,
        padding: "6px 8px",
        borderRadius: "6px",
        border: `1px solid ${T.border}`,
        background: T.bg,
        color: T.text,
        fontSize: "13px",
      },
      button: {
        padding: "6px 12px",
        borderRadius: "6px",
        border: `1px solid ${T.border}`,
        background: T.hover,
        color: T.text,
        fontSize: "13px",
        cursor: "pointer",
      },
      error: { color: T.danger, fontSize: "12px", marginTop: "6px" },
      bar: { display: "flex", gap: "8px", marginTop: "12px", marginBottom: "12px" },
      // —— 详情页（两列：主列 + 右栏）——
      detailHead: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
      detailTitle: {
        flex: "1 1 auto",
        minWidth: 0,
        fontSize: "20px",
        fontWeight: 500,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      detailGrid: {
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 320px)",
        gap: "32px",
        alignItems: "start",
      },
      detailGridNarrow: { display: "flex", flexDirection: "column", gap: "24px" },
      mainCol: { minWidth: 0, display: "flex", flexDirection: "column", gap: "8px" },
      rail: { minWidth: 0, display: "flex", flexDirection: "column" },
      railSection: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px 0",
        borderTop: `1px solid ${T.borderSoft}`,
      },
      railHead: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
      railTitle: { flex: "1 1 auto", fontSize: "13px", fontWeight: 500, color: T.text },
      railBody: {
        color: T.dim,
        fontSize: "12px",
        lineHeight: 1.55,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      },
      railBodyFull: { color: T.dim, fontSize: "12px", lineHeight: 1.55 },
      pill: {
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 8px",
        borderRadius: "999px",
        background: T.panel,
        color: T.dim,
        fontSize: "11px",
        flex: "none",
      },
      dot: {
        width: "8px",
        height: "8px",
        borderRadius: "999px",
        display: "inline-block",
        flex: "none",
      },
      composerCard: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px",
        borderRadius: "10px",
        background: T.card,
        border: `1px solid ${T.borderSoft}`,
      },
    };

    /** 宿主组件库是**非文档化**接口（docs/runtime 未收录、无类型）：有则用，无则自绘兜底。
     *  沿用 session-delete / session-rewind 的写法——require 失败就当没有，绝不假设它存在。 */
    /** @type {Record<string, any>} */
    var primitives = {};
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
    } catch (_error) {
      primitives = {};
    }

    /**
     * 按候选名取宿主图标（不同版本导出名不一样）；一个都取不到返回 null。
     * @param {string[]} names
     */
    function hostIcon(names) {
      for (let index = 0; index < names.length; index += 1) {
        const picked = primitives[names[index]];
        if (typeof picked === "function") return picked;
      }
      return null;
    }

    var ICON = {
      search: hostIcon(["IconSearchOutlineRegular", "IconSearchRegular", "IconSearch"]),
      pin: hostIcon(["IconPinFillRegular", "IconPinFill", "IconPinSolid"]),
      unpin: hostIcon(["IconPinOutlineRegular", "IconPinOutline", "IconPin"]),
      folder: hostIcon(["IconFolderOpenRegular", "IconFolderRegular", "IconFolder"]),
      more: hostIcon(["IconEllipsisOutlineRegular", "IconEllipsisRegular", "IconEllipsis"]),
      sort: hostIcon(["IconSortOutlineRegular", "IconSortRegular", "IconArrowsUpDown"]),
      chevron: hostIcon(["IconChevronRightRegular", "IconChevronRight"]),
    };

    /**
     * 图标节点：宿主的 Icon* 跟随主题 icon set；取不到就用一行字形兜底（不引 SVG 资源）。
     * @param {string} kind @param {string} fallback @param {number} [size]
     */
    function uiIcon(kind, fallback, size) {
      var component = /** @type {any} */ (ICON)[kind];
      var px = size || 16;
      if (component) return h(component, { size: px, "aria-hidden": "true" });
      return h(
        "span",
        { style: { fontSize: `${px}px`, lineHeight: 1 }, "aria-hidden": "true" },
        fallback,
      );
    }

    /**
     * 目录 basename（列表行/右栏上下文都用它，附完整路径在 title 里）。
     * @param {any} path
     */
    function baseName(path) {
      var value = String(path ?? "").replace(/\/+$/u, "");
      var cut = value.lastIndexOf("/");
      return cut >= 0 ? value.slice(cut + 1) : value;
    }

    /**
     * 相对时间：只用持久化的 updatedAt 求值（E2：派生文案必须来自持久值，不能来自组件 state）。
     * @param {any} t @param {string} iso
     */
    function relativeLabel(t, iso) {
      var at = Date.parse(String(iso ?? ""));
      if (!Number.isFinite(at)) return "";
      var delta = Math.max(0, Date.now() - at);
      if (delta < 60_000) return text(t, "panel.relative.now");
      if (delta < 3_600_000)
        return text(t, "panel.relative.minutes", { count: Math.floor(delta / 60_000) });
      if (delta < 86_400_000)
        return text(t, "panel.relative.hours", { count: Math.floor(delta / 3_600_000) });
      return text(t, "panel.relative.days", { count: Math.floor(delta / 86_400_000) });
    }

    /**
     * 搜索：名称 / 目标说明 / 已绑目录，任一命中即保留。
     * @param {any} projects @param {any} query
     */
    function filterProjects(projects, query) {
      var needle = String(query ?? "")
        .trim()
        .toLocaleLowerCase();
      var list = Array.isArray(projects) ? projects : [];
      if (needle === "") return list.slice();
      return list.filter((/** @type {any} */ project) => {
        var haystack = [
          String(project.name ?? ""),
          String(project.goal ?? ""),
          ...(Array.isArray(project.dirs)
            ? project.dirs.map((/** @type {any} */ dir) => baseName(dir))
            : []),
        ]
          .join("\n")
          .toLocaleLowerCase();
        return haystack.includes(needle);
      });
    }

    /**
     * 排序：**收藏永远排最前**（同一次排序内），归档的排最后（归档=移出视线但仍可恢复，
     * 不允许因为排序把恢复入口藏没）。
     * @param {any[]} projects @param {string} key
     */
    function sortProjects(projects, key) {
      var list = Array.isArray(projects) ? projects.slice() : [];
      var rank = (/** @type {any} */ project) => (project.state === "archived" ? 2 : 0);
      /** @type {(field: string) => (left: any, right: any) => number} */
      var byTime = (field) => (left, right) =>
        String(right[field] ?? "").localeCompare(String(left[field] ?? ""));
      return list.sort((/** @type {any} */ left, /** @type {any} */ right) => {
        var pinned = (right.pinned === true ? 1 : 0) - (left.pinned === true ? 1 : 0);
        if (pinned !== 0) return pinned;
        var archived = rank(left) - rank(right);
        if (archived !== 0) return archived;
        if (key === "name") return String(left.name ?? "").localeCompare(String(right.name ?? ""));
        if (key === "created") return byTime("createdAt")(left, right);
        return byTime("updatedAt")(left, right);
      });
    }

    /**
     * 轻量弹层（菜单）：自绘 + 点外部关闭，**不压暗背景**（与模态区分注意力层级）。
     * @param {{open: boolean, onClose: () => void, anchor: any, menu: any, menuAttrs?: any}} props
     */
    function Popover(props) {
      var root = useRef(null);
      var open = props.open;
      var onClose = props.onClose;
      useEffect(() => {
        if (!open) return undefined;
        if (typeof document === "undefined") return undefined;
        var doc = document;
        var onDown = (/** @type {any} */ event) => {
          var box = root.current;
          if (box && !box.contains(event.target)) onClose();
        };
        var onKey = (/** @type {any} */ event) => {
          if (event.key === "Escape") onClose();
        };
        doc.addEventListener("mousedown", onDown);
        doc.addEventListener("keydown", onKey);
        return () => {
          doc.removeEventListener("mousedown", onDown);
          doc.removeEventListener("keydown", onKey);
        };
      }, [open, onClose]);
      return h(
        "span",
        { ref: root, style: { position: "relative", display: "inline-flex" } },
        props.anchor,
        open
          ? h(
              "div",
              { role: "menu", style: styles.popover, ...(props.menuAttrs || {}) },
              props.menu,
            )
          : null,
      );
    }

    var menuItemStyle = {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      width: "100%",
      padding: "8px 10px",
      borderRadius: "6px",
      border: "none",
      background: "transparent",
      color: T.text,
      fontSize: "13px",
      textAlign: "left",
      cursor: "pointer",
    };

    /**
     * toast 栈：面板内自绘（右下角），3.5s 自动消失、可点 × 关、最多 3 条。
     * 不依赖宿主未文档化的 Toast 服务——没有 primitives 也必须能工作。
     * @param {{items: any[], onDismiss: (id: string) => void, t: any}} props
     */
    function ToastStack(props) {
      var items = Array.isArray(props.items) ? props.items : [];
      var onDismiss = props.onDismiss;
      var t = props.t;
      useEffect(() => {
        if (items.length === 0) return undefined;
        var oldest = items[0];
        var timer = setTimeout(() => onDismiss(oldest.id), 3500);
        return () => clearTimeout(timer);
      }, [items, onDismiss]);
      if (items.length === 0) return null;
      return h(
        "div",
        { style: styles.toastStack, "data-projects-toast-stack": "" },
        items.slice(-3).map((/** @type {any} */ item) =>
          h(
            "div",
            { key: item.id, role: "status", "data-projects-toast": item.id, style: styles.toast },
            h("span", { style: { minWidth: 0, flex: "1 1 auto" } }, item.message),
            h(
              "button",
              {
                type: "button",
                style: styles.toastClose,
                "data-projects-toast-close": item.id,
                "aria-label": text(t, "panel.toastClose"),
                onClick: () => onDismiss(item.id),
              },
              "✕",
            ),
          ),
        ),
      );
    }

    /**
     * 新建项目模态。
     * **始终挂载、关闭时 display:none**：桌面只读回归会查 `[data-projects-create-input]`
     * 是否存在（它不点开模态），卸载会让那条断言变成假失败（锚点语义保留）。
     * @param {any} props
     */
    function NewProjectModal(props) {
      var t = props.t;
      var form = props.form;
      var setForm = props.setForm;
      var onSubmit = props.onSubmit;
      var nameRef = useRef(null);
      useEffect(() => {
        if (form.open && nameRef.current && typeof nameRef.current.focus === "function") {
          nameRef.current.focus();
        }
      }, [form.open, form.mode]);
      var patch = (/** @type {any} */ next) =>
        setForm((/** @type {any} */ prev) => ({ ...prev, ...next }));
      var close = () => patch({ open: false, mode: "" });
      var submit = () => onSubmit();
      var nameValue = String(form.name ?? "");
      var title = text(t, "panel.new.title");
      return h(
        "div",
        {
          style: form.open ? styles.backdrop : styles.backdropHidden,
          "data-projects-new-modal": form.open ? "open" : "closed",
          onMouseDown: (/** @type {any} */ event) => {
            if (event.target === event.currentTarget) close();
          },
          onKeyDownCapture: (/** @type {any} */ event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          },
        },
        h(
          "div",
          {
            ...(form.open ? { role: "dialog", "aria-modal": "true" } : { "aria-hidden": "true" }),
            "aria-label": title,
            "data-projects-new-dialog": "",
            style: styles.dialog,
          },
          h(
            "div",
            { style: styles.dialogHead },
            h("span", { style: styles.dialogTitle }, title),
            h(
              "button",
              {
                type: "button",
                style: styles.iconButton,
                "data-projects-new-close": "",
                "aria-label": text(t, "panel.new.cancel"),
                onClick: close,
              },
              "✕",
            ),
          ),
          h(
            "div",
            {
              style: {
                display: form.mode === "" ? "flex" : "none",
                flexDirection: "column",
                gap: "8px",
              },
            },
            h("span", { style: styles.meta }, text(t, "panel.new.description")),
            h(
              "button",
              {
                type: "button",
                "data-projects-new-scratch": "",
                style: styles.entryCard,
                onClick: () => patch({ mode: "scratch" }),
              },
              h(
                "span",
                { style: styles.entryIcon },
                h("span", { style: { fontSize: "16px", lineHeight: 1 } }, "＋"),
              ),
              h(
                "span",
                {
                  style: {
                    minWidth: 0,
                    flex: "1 1 auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  },
                },
                h("span", { style: styles.name }, text(t, "panel.new.scratch")),
                h("span", { style: styles.meta }, text(t, "panel.new.scratchHint")),
              ),
              h("span", { style: styles.meta }, "›"),
            ),
            h(
              "button",
              {
                type: "button",
                "data-projects-new-folder": "",
                style: styles.entryCard,
                onClick: () =>
                  patch({
                    mode: "folder",
                    // 宿主目录选择器只对会话/工作区暴露；插件面板没有注册点，
                    // 这里如实降级成手输绝对路径，不伪造系统选择器。
                  }),
              },
              h("span", { style: styles.entryIcon }, uiIcon("folder", "🗂", 16)),
              h(
                "span",
                {
                  style: {
                    minWidth: 0,
                    flex: "1 1 auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  },
                },
                h("span", { style: styles.name }, text(t, "panel.new.folder")),
                h("span", { style: styles.meta }, text(t, "panel.new.folderHint")),
              ),
              h("span", { style: styles.meta }, "›"),
            ),
          ),
          h(
            "div",
            {
              style: {
                display: form.mode === "" ? "none" : "flex",
                flexDirection: "column",
                gap: "8px",
              },
              "data-projects-new-form": form.mode === "" ? undefined : form.mode,
            },
            form.mode === "folder"
              ? h(
                  "span",
                  { style: { ...styles.meta, color: T.accentText } },
                  text(t, "panel.new.folderUnavailable"),
                )
              : null,
            h(
              "label",
              { style: styles.fieldLabel },
              h("span", { style: styles.meta }, text(t, "panel.new.nameLabel")),
              h("input", {
                ref: nameRef,
                style: styles.input,
                value: nameValue,
                placeholder: text(t, "panel.new.namePlaceholder"),
                "data-projects-create-input": "",
                "data-modal-autofocus": "",
                onChange: (/** @type {any} */ event) => patch({ name: event.target.value }),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event.key === "Enter") submit();
                },
              }),
            ),
            h(
              "label",
              { style: styles.fieldLabel },
              h("span", { style: styles.meta }, text(t, "panel.new.goalLabel")),
              h("input", {
                style: styles.input,
                value: String(form.goal ?? ""),
                placeholder: text(t, "panel.new.goalPlaceholder"),
                "data-projects-new-goal": "",
                onChange: (/** @type {any} */ event) => patch({ goal: event.target.value }),
              }),
            ),
            h(
              "label",
              { style: styles.fieldLabel },
              h("span", { style: styles.meta }, text(t, "panel.new.dirLabel")),
              h("input", {
                style: styles.input,
                value: String(form.dir ?? ""),
                placeholder: text(t, "panel.new.dirPlaceholder"),
                "data-projects-new-dir": "",
                onChange: (/** @type {any} */ event) => patch({ dir: event.target.value }),
              }),
            ),
            h(
              "label",
              { style: styles.fieldLabel },
              h("span", { style: styles.meta }, text(t, "panel.new.instructionsLabel")),
              h("textarea", {
                style: { ...styles.input, minHeight: "64px", resize: "vertical" },
                value: String(form.instructions ?? ""),
                placeholder: text(t, "panel.new.instructionsPlaceholder"),
                "data-projects-new-instructions": "",
                onChange: (/** @type {any} */ event) => patch({ instructions: event.target.value }),
              }),
            ),
            form.error ? h("span", { style: styles.error }, form.error) : null,
            h(
              "div",
              {
                style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" },
              },
              // 说明放页脚左侧（主行动在右侧）：按 Claude 表单的分工
              h(
                "span",
                { style: { ...styles.meta, color: T.accentText, minWidth: 0, flex: "1 1 auto" } },
                text(t, "panel.new.memoryHint"),
              ),
              h(
                "button",
                {
                  type: "button",
                  style: styles.secondaryButton,
                  "data-projects-new-back": "",
                  onClick: () => patch({ mode: "", error: "" }),
                },
                text(t, "panel.new.back"),
              ),
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "button",
                {
                  type: "button",
                  style:
                    nameValue.trim() === "" || form.busy
                      ? { ...styles.primaryButton, opacity: 0.5, cursor: "default" }
                      : styles.primaryButton,
                  "data-projects-create": "",
                  "data-projects-create-ready": nameValue.trim() === "" ? "no" : "yes",
                  disabled: nameValue.trim() === "" || form.busy,
                  onClick: submit,
                },
                form.busy ? text(t, "panel.new.creating") : text(t, "panel.new.create"),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * 主面板：标题 + 工具条（搜索 / 排序 / 新建）+ 项目列表。
     * @param {{api: any, t: any}} props
     */
    function ProjectsPanel(props) {
      var api = props.api;
      var t = props.t;
      var state = useState({ loading: true, error: null, projects: [], describe: null });
      var view = state[0];
      var setView = state[1];
      var queryState = useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var sortState = useState({ key: "lastActive", open: false });
      var sort = sortState[0];
      var setSort = sortState[1];
      var menuState = useState("");
      var openMenu = menuState[0];
      var setOpenMenu = menuState[1];
      var hoverState = useState("");
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      var selectedState = useState(null);
      var selectedId = selectedState[0];
      var setSelectedId = selectedState[1];
      var highlightState = useState("");
      var highlight = highlightState[0];
      var setHighlight = highlightState[1];
      var toastState = useState([]);
      var toasts = toastState[0];
      var setToasts = toastState[1];
      var createState = useState({
        open: false,
        mode: "",
        name: "",
        goal: "",
        dir: "",
        instructions: "",
        busy: false,
        error: "",
      });
      var createForm = createState[0];
      var setCreateForm = createState[1];
      var editState = useState({ project: null, name: "", goal: "", busy: false, error: "" });
      var editForm = editState[0];
      var setEditForm = editState[1];
      var deleteState = useState({ project: null, impact: null, busy: false, error: "" });
      var rowDelete = deleteState[0];
      var setRowDelete = deleteState[1];

      var dismissToast = useCallback((/** @type {string} */ id) => {
        setToasts((/** @type {any} */ prev) =>
          (Array.isArray(prev) ? prev : []).filter((/** @type {any} */ item) => item.id !== id),
        );
      }, []);

      var pushToast = useCallback(
        (/** @type {string} */ message) => {
          var id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          setToasts((/** @type {any} */ prev) =>
            [...(Array.isArray(prev) ? prev : []), { id, message }].slice(-3),
          );
        },
        [setToasts],
      );

      var refresh = useCallback(() => {
        setView((/** @type {any} */ prev) => ({
          loading: true,
          error: prev.error,
          projects: prev.projects,
          describe: prev.describe,
        }));
        return Promise.all([call(api.ctx, "listProjects"), call(api.ctx, "describe")]).then(
          (values) => {
            setView({
              loading: false,
              error: null,
              projects: values[0] || [],
              describe: values[1] || null,
            });
          },
          (error) => {
            setView({
              loading: false,
              error: String(error?.message ?? error),
              projects: [],
              describe: null,
            });
          },
        );
      }, [api]);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // 新建成功后的一行高亮：2.5s 后自动褪掉（只是视觉反馈，不承担任何状态）
      useEffect(() => {
        if (highlight === "") return undefined;
        var timer = setTimeout(() => setHighlight(""), 2500);
        return () => clearTimeout(timer);
      }, [highlight]);

      var projects = Array.isArray(view.projects) ? view.projects : [];

      /** 收藏：先乐观更新，失败回滚并弹 toast；成功后 refresh 回读持久值（E1 回读）。 */
      var togglePin = useCallback(
        (/** @type {any} */ project) => {
          var next = project.pinned !== true;
          var apply = (/** @type {boolean} */ pinned) =>
            setView((/** @type {any} */ prev) => ({
              ...prev,
              projects: (prev.projects || []).map((/** @type {any} */ item) =>
                item.id === project.id ? { ...item, pinned } : item,
              ),
            }));
          apply(next);
          setOpenMenu("");
          call(api.ctx, "setProjectPinned", { projectId: project.id, pinned: next }).then(
            () => {
              pushToast(
                text(t, next ? "panel.toastPinned" : "panel.toastUnpinned", { name: project.name }),
              );
              void refresh();
            },
            (error) => {
              apply(project.pinned === true);
              pushToast(text(t, "panel.pinFailed", { reason: String(error?.message ?? error) }));
            },
          );
        },
        [api, pushToast, refresh, setOpenMenu, setView, t],
      );

      var setArchived = useCallback(
        (/** @type {any} */ project, /** @type {boolean} */ archive) => {
          setOpenMenu("");
          call(api.ctx, archive ? "archiveProject" : "unarchiveProject", { id: project.id }).then(
            () => {
              pushToast(
                text(t, archive ? "panel.toastArchived" : "panel.toastUnarchived", {
                  name: project.name,
                }),
              );
              void refresh();
            },
            (error) => {
              pushToast(
                text(t, "panel.rowActionFailed", { reason: String(error?.message ?? error) }),
              );
            },
          );
        },
        [api, pushToast, refresh, setOpenMenu, t],
      );

      var askRowDelete = useCallback(
        (/** @type {any} */ project) => {
          setOpenMenu("");
          setRowDelete({ project, impact: null, busy: false, error: "" });
          call(api.ctx, "previewDeleteProject", { id: project.id }).then(
            (impact) =>
              setRowDelete((/** @type {any} */ prev) => ({ ...prev, impact: impact || null })),
            (error) =>
              setRowDelete((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              })),
          );
        },
        [api, setOpenMenu, setRowDelete],
      );

      var confirmRowDelete = useCallback(() => {
        var project = rowDelete.project;
        if (!project || rowDelete.busy) return;
        setRowDelete((/** @type {any} */ prev) => ({ ...prev, busy: true }));
        call(api.ctx, "deleteProject", { id: project.id }).then(
          () => {
            setRowDelete({ project: null, impact: null, busy: false, error: "" });
            pushToast(text(t, "panel.toastDeleted", { name: project.name }));
            void refresh();
          },
          (error) =>
            setRowDelete((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              error: String(error?.message ?? error),
            })),
        );
      }, [api, pushToast, refresh, rowDelete, setRowDelete, t]);

      var submitCreate = useCallback(() => {
        var value = String(createForm.name ?? "").trim();
        if (value === "" || createForm.busy) return;
        setCreateForm((/** @type {any} */ prev) => ({ ...prev, busy: true, error: "" }));
        var dir = String(createForm.dir ?? "").trim();
        var input = {
          goal: String(createForm.goal ?? "").trim(),
          dirs: dir === "" ? [] : [dir],
        };
        call(api.ctx, "createProject", { name: value, input })
          .then((created) => {
            var instructions = String(createForm.instructions ?? "").trim();
            if (instructions === "" || !created?.id) return created;
            // 指令先写后注入：走既有的 setProjectInstructions（写 instructions.md），
            // 失败不阻断建项目——项目已建成，只是没有初始指令（错误会显示在表单里）。
            return call(api.ctx, "setProjectInstructions", {
              options: { projectId: created.id, text: instructions },
            }).then(() => created);
          })
          .then((created) => {
            setCreateForm({
              open: false,
              mode: "",
              name: "",
              goal: "",
              dir: "",
              instructions: "",
              busy: false,
              error: "",
            });
            if (created?.id) setHighlight(String(created.id));
            pushToast(text(t, "panel.toastCreated", { name: value }));
            return refresh();
          })
          .catch((error) => {
            setCreateForm((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              error: text(t, "panel.errorCreate", {
                reason: String(error?.message ?? error),
              }),
            }));
          });
      }, [api, createForm, pushToast, refresh, setCreateForm, setHighlight, t]);

      var saveEdit = useCallback(() => {
        var target = editForm.project;
        if (!target || editForm.busy) return;
        var name = String(editForm.name ?? "").trim();
        if (name === "") return;
        setEditForm((/** @type {any} */ prev) => ({ ...prev, busy: true, error: "" }));
        call(api.ctx, "updateProject", {
          id: target.id,
          patch: { name, goal: String(editForm.goal ?? "") },
        }).then(
          () => {
            setEditForm({ project: null, name: "", goal: "", busy: false, error: "" });
            pushToast(text(t, "panel.toastUpdated", { name }));
            void refresh();
          },
          (error) =>
            setEditForm((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              error: String(error?.message ?? error),
            })),
        );
      }, [api, editForm, pushToast, refresh, setEditForm, t]);

      var describe = view.describe;
      var summaryText = describe
        ? text(t, "panel.summary", {
            projects: describe.projectCount,
            active: describe.activeCount,
            threads: projects.reduce(
              (/** @type {number} */ sum, /** @type {any} */ project) =>
                sum + Number(project.threadCount || 0),
              0,
            ),
            attached: describe.attachedSessions,
          })
        : "";

      var visible = sortProjects(filterProjects(projects, query), sort.key);
      var selectedProject = selectedId
        ? projects.find((/** @type {any} */ project) => project.id === selectedId)
        : null;

      /** 行内「⋯」菜单内容：编辑详情 / 归档（或恢复）/ 删除…（复用同一 handler）。 */
      var rowMenu = (/** @type {any} */ project) =>
        h(
          "div",
          {
            style: { display: "flex", flexDirection: "column", gap: "2px" },
            "data-projects-row-menu-list": project.id,
          },
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              style: menuItemStyle,
              "data-projects-row-menu-edit": project.id,
              onClick: () => {
                setOpenMenu("");
                setEditForm({
                  project,
                  name: String(project.name ?? ""),
                  goal: String(project.goal ?? ""),
                  busy: false,
                  error: "",
                });
              },
            },
            text(t, "panel.rowEdit"),
          ),
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              style: menuItemStyle,
              "data-projects-row-menu-archive": project.id,
              onClick: () => setArchived(project, project.state !== "archived"),
            },
            project.state === "archived"
              ? text(t, "panel.rowUnarchive")
              : text(t, "panel.rowArchive"),
          ),
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              style: { ...menuItemStyle, color: T.danger },
              "data-projects-row-menu-delete": project.id,
              onClick: () => askRowDelete(project),
            },
            text(t, "panel.rowDelete"),
          ),
        );

      var row = (/** @type {any} */ project) => {
        var archived = project.state === "archived";
        var pinned = project.pinned === true;
        var meta = [
          text(t, "panel.threads", { count: Number(project.threadCount || 0) }),
          relativeLabel(t, project.updatedAt),
          archived ? text(t, "panel.state.archived") : "",
        ]
          .filter((part) => part !== "")
          .join(" · ");
        return h(
          "div",
          {
            key: project.id,
            style: {
              ...styles.row,
              background:
                highlight === project.id || hovered === project.id ? T.hover : "transparent",
            },
            "data-projects-row": project.id,
            "data-project-id": project.id,
            "data-pinned": pinned ? "true" : "false",
            "data-projects-state": project.state,
            "data-row-state": archived ? "archived" : "active",
            onMouseEnter: () => setHovered(project.id),
            onMouseLeave: () => setHovered(""),
            onClick: () => setSelectedId(project.id),
          },
          pinned
            ? h(
                "span",
                { style: styles.pinMark, "data-projects-pin-mark": project.id },
                uiIcon("pin", "📌", 13),
              )
            : null,
          h(
            "div",
            { style: styles.rowMain },
            h(
              "span",
              { style: styles.name, "data-projects-row-name": project.id },
              project.name,
              h(
                "span",
                {
                  style: { ...styles.meta, marginLeft: "6px" },
                  "data-projects-row-id": project.id,
                },
                `#${String(project.id).slice(-6)}`,
              ),
            ),
            project.goal
              ? h(
                  "span",
                  { style: styles.goal, "data-projects-row-goal": project.id },
                  project.goal,
                )
              : null,
            h("span", { style: styles.meta, "data-projects-row-meta": project.id }, meta),
          ),
          Array.isArray(project.dirs) && project.dirs.length > 0
            ? h(
                "span",
                {
                  style: styles.dirBadge,
                  "data-projects-row-dir": project.id,
                  title: String(project.dirs[0]),
                },
                uiIcon("folder", "🗂", 13),
                h(
                  "span",
                  { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } },
                  baseName(project.dirs[0]),
                ),
              )
            : null,
          h(
            "button",
            {
              type: "button",
              style: {
                ...styles.iconButton,
                color: pinned ? T.accentText : T.dim,
              },
              "data-projects-pin": project.id,
              "data-pinned": pinned ? "true" : "false",
              "aria-label": text(t, pinned ? "panel.unpin" : "panel.pin"),
              "aria-pressed": pinned ? "true" : "false",
              onClick: (/** @type {any} */ event) => {
                event.stopPropagation();
                togglePin(project);
              },
            },
            uiIcon(pinned ? "pin" : "unpin", "📌", 14),
          ),
          h(Popover, {
            open: openMenu === project.id,
            onClose: () => setOpenMenu(""),
            anchor: h(
              "button",
              {
                type: "button",
                style: styles.iconButton,
                "data-projects-row-menu": project.id,
                "aria-label": text(t, "panel.rowMenu"),
                "aria-haspopup": "menu",
                "aria-expanded": openMenu === project.id ? "true" : "false",
                onClick: (/** @type {any} */ event) => {
                  event.stopPropagation();
                  setOpenMenu(openMenu === project.id ? "" : project.id);
                },
              },
              uiIcon("more", "⋯", 16),
            ),
            menu: rowMenu(project),
          }),
        );
      };

      return h(
        "section",
        {
          style: styles.root,
          "data-projects-panel": "",
          // 冒烟与排障用：把渲染状态挂成属性，断言不必猜 DOM 结构
          "data-projects-status": `${view.loading ? "loading" : "ready"}|${projects.length}|${
            view.error ? "error" : "ok"
          }|${describe ? describe.attachedSessions : "-"}`,
        },
        h(
          "div",
          { style: styles.page },
          h(
            "div",
            { style: styles.headRow },
            h(
              "div",
              { style: { minWidth: 0, flex: "1 1 auto" } },
              h(
                "span",
                { style: styles.pageTitle, "data-projects-title": "" },
                text(t, "panel.title"),
              ),
              h("span", { style: styles.pageSummary, "data-projects-summary": "" }, summaryText),
            ),
            h(
              "div",
              { style: styles.toolbar },
              h(
                "label",
                { style: styles.searchWrap },
                uiIcon("search", "⌕", 14),
                h("input", {
                  style: styles.searchInput,
                  value: query,
                  placeholder: text(t, "panel.search"),
                  "data-projects-search": "",
                  "aria-label": text(t, "panel.search"),
                  onChange: (/** @type {any} */ event) => setQuery(event.target.value),
                }),
                query === ""
                  ? null
                  : h(
                      "button",
                      {
                        type: "button",
                        style: styles.iconButton,
                        "data-projects-search-clear": "",
                        "aria-label": text(t, "panel.searchClear"),
                        onClick: () => setQuery(""),
                      },
                      "✕",
                    ),
              ),
              h(Popover, {
                open: sort.open,
                onClose: () => setSort((/** @type {any} */ prev) => ({ ...prev, open: false })),
                anchor: h(
                  "button",
                  {
                    type: "button",
                    style: {
                      ...styles.iconButton,
                      background: sort.open ? T.hover : "transparent",
                    },
                    "data-projects-sort": "",
                    "data-sort": sort.key,
                    "aria-label": text(t, "panel.sort"),
                    "aria-haspopup": "menu",
                    "aria-expanded": sort.open ? "true" : "false",
                    onClick: () =>
                      setSort((/** @type {any} */ prev) => ({ ...prev, open: !prev.open })),
                  },
                  uiIcon("sort", "↕", 16),
                ),
                menuAttrs: { "data-projects-sort-menu": "" },
                menu: h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "2px" } },
                  ["lastActive", "created", "name"].map((key) => {
                    var active = sort.key === key;
                    return h(
                      "button",
                      {
                        key: key,
                        type: "button",
                        role: "menuitemradio",
                        "aria-checked": active ? "true" : "false",
                        "data-projects-sort-option": key,
                        style: { ...menuItemStyle, color: active ? T.accentText : T.text },
                        onClick: () =>
                          setSort((/** @type {any} */ prev) => ({ ...prev, key, open: false })),
                      },
                      h(
                        "span",
                        { style: { minWidth: 0, flex: "1 1 auto" } },
                        text(t, `panel.sort.${key}`),
                      ),
                      active ? h("span", { "data-projects-sort-check": "" }, "✓") : null,
                    );
                  }),
                ),
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.primaryButton,
                  "data-projects-new": "",
                  onClick: () =>
                    setCreateForm((/** @type {any} */ prev) => ({
                      ...prev,
                      open: true,
                      mode: "",
                      error: "",
                    })),
                },
                text(t, "panel.create"),
              ),
            ),
          ),
          view.error
            ? h("div", { style: styles.error, "data-projects-error": "" }, view.error)
            : null,
          // 详情打开时列表必须卸载：否则同一批锚点（row / pin / row-menu）会出现两份，
          // 菜单和收藏就会被点到隐藏的那一份上。
          selectedProject
            ? null
            : projects.length === 0 && !view.loading
              ? h(
                  "div",
                  { style: styles.empty, "data-projects-empty": "" },
                  h("span", { style: styles.emptyTitle }, text(t, "panel.empty")),
                  h("span", { style: styles.emptyHint }, text(t, "panel.emptyHint")),
                  h(
                    "button",
                    {
                      type: "button",
                      style: { ...styles.primaryButton, marginTop: "10px" },
                      "data-projects-new": "",
                      onClick: () =>
                        setCreateForm((/** @type {any} */ prev) => ({
                          ...prev,
                          open: true,
                          mode: "",
                          error: "",
                        })),
                    },
                    text(t, "panel.create"),
                  ),
                )
              : visible.length === 0 && query !== ""
                ? h(
                    "div",
                    { style: styles.empty, "data-projects-search-empty": "" },
                    h("span", { style: styles.emptyHint }, text(t, "panel.searchEmpty")),
                  )
                : h("div", { style: styles.list, "data-projects-list": "" }, visible.map(row)),
          // 一个项目都没有时，详情页进不去——回收站必须在面板这层有出口，否则恢复入口自锁
          selectedProject ? null : h(PanelTrash, { api: api, t: t, onChanged: refresh }),
        ),
        selectedProject
          ? h(ProjectDetail, {
              api: api,
              t: t,
              project: selectedProject,
              onBack: () => {
                setSelectedId(null);
                // 详情页里建了线程/改了目录，回列表必须刷新，否则面板还显示旧线程数（走查发现）
                refresh();
              },
              onDeleted: () => {
                setSelectedId(null);
                refresh();
              },
              // 恢复/其它"改了项目集合"的操作：只刷新列表，不切换选中项
              onChanged: () => refresh(),
              onToast: pushToast,
              onEditDetails: (/** @type {any} */ target) =>
                setEditForm({
                  project: target,
                  name: String(target.name ?? ""),
                  goal: String(target.goal ?? ""),
                  busy: false,
                  error: "",
                }),
            })
          : null,
        h(NewProjectModal, {
          t: t,
          form: createForm,
          setForm: setCreateForm,
          onSubmit: submitCreate,
        }),
        editForm.project
          ? h(
              "div",
              {
                style: styles.backdrop,
                "data-projects-edit-details": editForm.project.id,
                onMouseDown: (/** @type {any} */ event) => {
                  if (event.target === event.currentTarget)
                    setEditForm({ project: null, name: "", goal: "", busy: false, error: "" });
                },
                onKeyDownCapture: (/** @type {any} */ event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setEditForm({ project: null, name: "", goal: "", busy: false, error: "" });
                  }
                },
              },
              h(
                "div",
                {
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-label": text(t, "panel.rowEdit"),
                  style: styles.dialog,
                },
                h(
                  "div",
                  { style: styles.dialogHead },
                  h("span", { style: styles.dialogTitle }, text(t, "panel.rowEdit")),
                ),
                h(
                  "label",
                  { style: styles.fieldLabel },
                  h("span", { style: styles.meta }, text(t, "panel.new.nameLabel")),
                  h("input", {
                    style: styles.input,
                    value: String(editForm.name ?? ""),
                    "data-projects-edit-name": "",
                    "data-modal-autofocus": "",
                    onChange: (/** @type {any} */ event) =>
                      setEditForm((/** @type {any} */ prev) => ({
                        ...prev,
                        name: event.target.value,
                      })),
                  }),
                ),
                h(
                  "label",
                  { style: styles.fieldLabel },
                  h("span", { style: styles.meta }, text(t, "panel.new.goalLabel")),
                  h("textarea", {
                    style: { ...styles.input, minHeight: "64px" },
                    value: String(editForm.goal ?? ""),
                    placeholder: text(t, "panel.new.goalPlaceholder"),
                    "data-projects-edit-goal": "",
                    onChange: (/** @type {any} */ event) =>
                      setEditForm((/** @type {any} */ prev) => ({
                        ...prev,
                        goal: event.target.value,
                      })),
                  }),
                ),
                editForm.error ? h("span", { style: styles.error }, editForm.error) : null,
                h(
                  "div",
                  { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
                  h(
                    "button",
                    {
                      type: "button",
                      style: styles.secondaryButton,
                      "data-projects-edit-cancel": "",
                      onClick: () =>
                        setEditForm({ project: null, name: "", goal: "", busy: false, error: "" }),
                    },
                    text(t, "detail.cancel"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: styles.primaryButton,
                      "data-projects-edit-save": "",
                      disabled: editForm.busy,
                      onClick: saveEdit,
                    },
                    text(t, "panel.rowSave"),
                  ),
                ),
              ),
            )
          : null,
        rowDelete.project
          ? h(
              "div",
              { style: styles.backdrop, "data-projects-row-delete-panel": rowDelete.project.id },
              h(
                "div",
                {
                  role: "alertdialog",
                  "aria-modal": "true",
                  "aria-label": text(t, "panel.rowDelete"),
                  style: { ...styles.dialog, maxWidth: "420px" },
                },
                h(
                  "div",
                  { style: styles.dialogHead },
                  h("span", { style: styles.dialogTitle }, text(t, "panel.rowDeleteTitle")),
                ),
                h(
                  "span",
                  {
                    style: { color: T.text, fontSize: "13px" },
                    "data-projects-row-delete-impact": "",
                  },
                  rowDelete.impact?.impact?.summary ?? rowDelete.error,
                ),
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      gap: "8px",
                      justifyContent: "flex-end",
                      marginTop: "8px",
                    },
                  },
                  h(
                    "button",
                    {
                      type: "button",
                      style: styles.secondaryButton,
                      "data-projects-row-delete-cancel": "",
                      "data-modal-autofocus": "",
                      onClick: () =>
                        setRowDelete({ project: null, impact: null, busy: false, error: "" }),
                    },
                    text(t, "detail.deleteCancel"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: {
                        ...styles.secondaryButton,
                        borderColor: T.danger,
                        color: T.danger,
                      },
                      "data-projects-row-delete-confirm": "",
                      disabled: rowDelete.busy,
                      onClick: confirmRowDelete,
                    },
                    rowDelete.busy ? text(t, "detail.deleting") : text(t, "detail.deleteConfirm"),
                  ),
                ),
              ),
            )
          : null,
        h(ToastStack, { items: toasts, onDismiss: dismissToast, t: t }),
      );
    }

    /**
     * 项目详情：线程 / 记忆 / 审计三个页签（conventions §7.3：页签 ≤3）。
     * 只读；写操作留给后续里程碑。
     * @param {{api: any, t: any, project: any, onBack: () => void, onDeleted?: () => void, onChanged?: () => void, onToast?: (message: string) => void, onEditDetails?: (project: any) => void}} props
     */
    /**
     * 面板级回收站（只在"一个项目都没有"时出现）。
     * 为什么需要它：回收站原先只挂在项目详情页里，删掉最后一个项目后就再也进不去详情页，
     * 恢复入口自锁——这是 0.6.0 验收时发现的死锁。这里给一条不依赖项目的出路。
     * @param {any} props
     */
    function PanelTrash(props) {
      const api = props.api;
      const t = props.t;
      const stateTuple = useState({ entries: [], loaded: false, message: "", pending: "" });
      const state = stateTuple[0];
      const setState = stateTuple[1];
      const size = (/** @type {number} */ bytes) => {
        const n = Number.isFinite(bytes) ? Math.max(0, Number(bytes)) : 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
      };
      const load = useCallback(() => {
        call(api.ctx, "listTrash", {}).then(
          (/** @type {any} */ result) =>
            setState((/** @type {any} */ prev) => ({
              ...prev,
              entries: Array.isArray(result?.entries) ? result.entries : [],
              loaded: true,
            })),
          (/** @type {any} */ error) =>
            setState((/** @type {any} */ prev) => ({
              ...prev,
              loaded: true,
              message: String(error?.message ?? error),
            })),
        );
      }, [api, setState]);
      useEffect(() => {
        if (!state.loaded) load();
      }, [load, state.loaded]);
      const restore = useCallback(
        (/** @type {any} */ entry) => {
          call(api.ctx, "restoreTrash", { entryId: entry.entryId }).then(
            (/** @type {any} */ result) => {
              setState({
                entries: [],
                loaded: false,
                message: text(t, "detail.trashRestored", {
                  name: result?.name ?? "",
                  count: result?.threadCount ?? 0,
                }),
                pending: "",
              });
              load();
              props.onChanged();
            },
            (/** @type {any} */ error) =>
              setState((/** @type {any} */ prev) => ({
                ...prev,
                message: text(t, "detail.trashFailed", { reason: String(error?.message ?? error) }),
              })),
          );
        },
        [api, load, props, setState, t],
      );
      const remove = useCallback(
        (/** @type {any} */ entry) => {
          if (state.pending !== entry.entryId) {
            setState((/** @type {any} */ prev) => ({ ...prev, pending: entry.entryId }));
            return;
          }
          call(api.ctx, "deleteTrashEntry", {
            options: { entryId: entry.entryId, confirm: true },
          }).then(
            (/** @type {any} */ result) => {
              setState((/** @type {any} */ prev) => ({
                ...prev,
                pending: "",
                entries: prev.entries.filter(
                  (/** @type {any} */ item) => item.entryId !== entry.entryId,
                ),
                message: text(t, "detail.trashDeleted", {
                  size: size(Number(result?.bytes ?? entry.sizeBytes)),
                }),
              }));
            },
            (/** @type {any} */ error) =>
              setState((/** @type {any} */ prev) => ({
                ...prev,
                message: text(t, "detail.trashDeleteFailed", {
                  reason: String(error?.message ?? error),
                }),
              })),
          );
        },
        [api, setState, state.pending, t],
      );
      if (state.entries.length === 0 && state.message === "") {
        return h(
          "div",
          { "data-projects-trash": "", style: { ...styles.meta, marginTop: "8px" } },
          text(t, "detail.trashEmpty"),
        );
      }
      return h(
        "div",
        {
          "data-projects-trash": "",
          style: {
            border: `1px solid ${T.border}`,
            borderRadius: "8px",
            padding: "8px 10px",
            marginTop: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          },
        },
        h("div", { style: styles.name }, text(t, "detail.trashTitle")),
        state.entries.map((/** @type {any} */ entry) =>
          h(
            "div",
            {
              key: entry.entryId,
              "data-projects-trash-row": entry.entryId,
              style: {
                display: "flex",
                gap: "8px",
                alignItems: "center",
                justifyContent: "space-between",
              },
            },
            h(
              "span",
              {
                style: {
                  ...styles.meta,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                },
              },
              `${entry.name} · ${entry.threadCount} 个线程 · ${size(entry.sizeBytes)}`,
            ),
            h(
              "div",
              { style: { display: "flex", gap: "6px" } },
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-trash-restore": entry.entryId,
                  onClick: () => restore(entry),
                },
                text(t, "detail.trashRestore"),
              ),
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.button, borderColor: T.danger, color: T.danger },
                  "data-projects-trash-delete": entry.entryId,
                  onClick: () => remove(entry),
                },
                state.pending === entry.entryId
                  ? text(t, "detail.trashDeleteConfirm", { size: size(entry.sizeBytes) })
                  : text(t, "detail.trashDelete"),
              ),
            ),
          ),
        ),
        state.message !== ""
          ? h("div", { style: styles.meta, "data-projects-trash-result": "" }, state.message)
          : null,
      );
    }

    /**
     * @param {{api: any, t: any, project: any, onBack: () => void, onDeleted?: () => void, onChanged?: () => void, onToast?: (message: string) => void, onEditDetails?: (project: any) => void}} props
     */
    function ProjectDetail(props) {
      const api = props.api;
      const t = props.t;
      const project = props.project;
      const tabState = useState("threads");
      const tab = tabState[0];
      const setTab = tabState[1];
      // 换项目/重进详情时回到「线程」：否则上次停在「审计」会让人误以为项目里没有线程
      useEffect(() => {
        setTab("threads");
      }, [project.id, setTab]);
      const dataState = useState({
        loading: true,
        error: "",
        threads: [],
        content: null,
        audit: [],
      });
      const data = dataState[0];
      const setData = dataState[1];

      const load = useCallback(() => {
        setData((/** @type {any} */ prev) => ({ ...prev, loading: true, error: "" }));
        Promise.all([
          call(api.ctx, "progress", { projectId: project.id }),
          call(api.ctx, "getProjectContent", { projectId: project.id }),
          call(api.ctx, "listAudit", { projectId: project.id }),
          call(api.ctx, "listApprovals", { projectId: project.id }),
        ]).then(
          (values) => {
            setData({
              loading: false,
              error: "",
              threads: Array.isArray(values[0]?.rows) ? values[0].rows : [],
              progress: values[0] || null,
              projectState: values[0]?.projectState ?? project.state,
              content: values[1] || null,
              audit: Array.isArray(values[2]) ? values[2] : [],
              approvals: Array.isArray(values[3]) ? values[3] : [],
            });
          },
          (error) => {
            setData({
              loading: false,
              error: String(error?.message ?? error),
              threads: [],
              content: null,
              audit: [],
            });
          },
        );
      }, [api, project.id]);
      const [threadAction, setThreadAction] = useState({ pending: "", message: "", ok: null });
      const reclaimDir = useCallback(
        (/** @type {string} */ sessionId) => {
          setThreadAction({ pending: sessionId, message: "", ok: null });
          call(api.ctx, "reclaimThread", { sessionId }).then(
            (/** @type {any} */ result) => {
              setThreadAction({
                pending: "",
                ok: result?.reclaimed === true,
                message:
                  result?.reclaimed === true
                    ? text(t, "detail.threadReclaimed")
                    : text(t, "detail.threadReclaimKept", {
                        reason: String(result?.reason ?? "?"),
                      }),
              });
              load();
            },
            (/** @type {any} */ error) =>
              setThreadAction({
                pending: "",
                ok: false,
                message: text(t, "detail.threadActionFailed", {
                  reason: String(error?.message ?? error),
                }),
              }),
          );
        },
        [api, load, setThreadAction, t],
      );
      const removeThread = useCallback(
        (/** @type {string} */ sessionId) => {
          if (threadAction.pending !== sessionId) {
            setThreadAction({ pending: sessionId, message: "", ok: null });
            return;
          }
          call(api.ctx, "detachThread", { sessionId }).then(
            () => {
              setThreadAction({ pending: "", ok: true, message: text(t, "detail.threadRemoved") });
              load();
              if (typeof props.onChanged === "function") props.onChanged();
            },
            (/** @type {any} */ error) =>
              setThreadAction({
                pending: "",
                ok: false,
                message: text(t, "detail.threadActionFailed", {
                  reason: String(error?.message ?? error),
                }),
              }),
          );
        },
        [api, load, props, setThreadAction, t, threadAction.pending],
      );
      const [mem, setMem] = useState({
        editing: false,
        draft: "",
        busy: false,
        message: "",
        append: "",
      });
      const saveInstructions = useCallback(() => {
        setMem((/** @type {any} */ prev) => ({ ...prev, busy: true }));
        call(api.ctx, "setProjectInstructions", {
          options: { projectId: project.id, text: mem.draft },
        }).then(
          (/** @type {any} */ result) => {
            setMem((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              editing: false,
              message:
                Number(result?.chars ?? 0) === 0
                  ? text(t, "detail.memoryCleared")
                  : text(t, "detail.memorySaved", { chars: Number(result?.chars ?? 0) }),
            }));
            if (typeof props.onChanged === "function") props.onChanged();
            load();
          },
          (/** @type {any} */ error) =>
            setMem((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              message: text(t, "detail.memorySaveFailed", {
                reason: String(error?.message ?? error),
              }),
            })),
        );
      }, [api, mem.draft, project.id, props, setMem, t]);
      const appendMemoryLine = useCallback(() => {
        const line = String(mem.append ?? "").trim();
        if (line === "") return;
        call(api.ctx, "appendMemory", { projectId: project.id, text: line }).then(
          (/** @type {any} */ result) => {
            setMem((/** @type {any} */ prev) => ({
              ...prev,
              append: "",
              message:
                result?.added === false
                  ? text(t, "detail.memoryAppendDup")
                  : text(t, "detail.memoryAppended"),
            }));
            load();
          },
          (/** @type {any} */ error) =>
            setMem((/** @type {any} */ prev) => ({
              ...prev,
              message: text(t, "detail.memorySaveFailed", {
                reason: String(error?.message ?? error),
              }),
            })),
        );
      }, [api, load, mem.append, project.id, setMem, t]);

      const draftState = useState("");
      const draft = draftState[0];
      const setDraft = draftState[1];
      const busyState = useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];

      const routeState = useState(null);
      const routeResult = routeState[0];
      const setRouteResult = routeState[1];
      const routeInput = useState("");
      const routeText = routeInput[0];
      const setRouteText = routeInput[1];
      const routeBusyState = useState(false);
      const routeBusy = routeBusyState[0];
      const setRouteBusy = routeBusyState[1];
      const dispatchRoute = useCallback(() => {
        const value = String(routeText).trim();
        if (value === "" || routeBusy) return;
        setRouteBusy(true);
        call(api.ctx, "route", { projectId: project.id, text: value }).then(
          (result) => {
            setRouteBusy(false);
            setRouteResult(result);
            load();
          },
          (error) => {
            setRouteBusy(false);
            setRouteResult({
              executed: false,
              reason: String(error?.message ?? error),
              decision: null,
            });
          },
        );
      }, [api, load, project.id, routeBusy, routeText, setRouteBusy, setRouteResult]);

      const deleteState = useState({ confirming: false, busy: false, impact: null });
      const del = deleteState[0];
      const setDel = deleteState[1];
      const resolveApproval = useCallback(
        (/** @type {any} */ requestId, /** @type {any} */ status) => {
          call(api.ctx, "resolveApproval", { requestId, status }).then(
            () => load(),
            (error) => {
              setData((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              }));
            },
          );
        },
        [api, load, setData],
      );

      const execState = useState({ busy: "", ok: null, message: "" });
      const exec = execState[0];
      const setExec = execState[1];
      // 执行一次已批准的申请：这是「批准 ≠ 可执行」里那独立的一步。
      // 服务端还会再过一遍开关/阈值/幂等，所以这里不做乐观判断——把真实结果回显出来。
      const executeApproval = useCallback(
        (/** @type {any} */ requestId) => {
          setExec({ busy: requestId, ok: null, message: "" });
          call(api.ctx, "executeApproval", { requestId }).then(
            (/** @type {any} */ result) => {
              const ok = result?.executed === true;
              setExec({
                busy: "",
                ok,
                message: ok
                  ? text(t, "detail.executed")
                  : text(t, "detail.refused", { reason: String(result?.reason ?? "?") }),
              });
              load();
            },
            (error) => {
              setExec({ busy: "", ok: false, message: String(error?.message ?? error) });
            },
          );
        },
        [api, load, setExec, t],
      );

      const grantsState = useState("");
      const grantsDraft = grantsState[0];
      const setGrantsDraft = grantsState[1];
      const grants = Object.keys(project?.policy?.repoGrants ?? {});
      const setGrants = useCallback(
        (/** @type {string[]} */ next) => {
          /** @type {Record<string, true>} */
          const map = {};
          for (const key of next) map[key] = true;
          const policy = { ...(project?.policy ?? {}), repoGrants: map };
          call(api.ctx, "updateProject", { id: project.id, patch: { policy } }).then(
            () => load(),
            (error) =>
              setData((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              })),
          );
        },
        [api, load, project?.policy, project.id, setData],
      );

      const purgeState = useState({ phase: "idle", eligible: 0, kept: 0, message: "" });
      const purge = purgeState[0];
      const setPurge = purgeState[1];
      /** 体积格式化（回收站行里用；host 侧的同名逻辑不跨进程，这里单独实现） */
      const formatBytes = (/** @type {number} */ bytes) => {
        const n = Number.isFinite(bytes) ? Math.max(0, Number(bytes)) : 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
      };
      const trashState = useState({ entries: [], loaded: false, message: "" });
      const trash = trashState[0];
      const setTrash = trashState[1];
      const loadTrash = useCallback(() => {
        call(api.ctx, "listTrash", {}).then(
          (/** @type {any} */ result) =>
            setTrash((/** @type {any} */ prev) => ({
              ...prev,
              entries: Array.isArray(result?.entries) ? result.entries : [],
              loaded: true,
            })),
          (/** @type {any} */ error) =>
            setTrash((/** @type {any} */ prev) => ({
              ...prev,
              loaded: true,
              message: String(error?.message ?? error),
            })),
        );
      }, [api, setTrash]);
      const [pendingDelete, setPendingDelete] = useState({ entryId: "", confirmAll: false });
      const deleteEntry = useCallback(
        (/** @type {any} */ entry) => {
          if (pendingDelete.entryId !== entry.entryId) {
            // 两步确认：第一次点只进入确认态，避免误触不可恢复操作
            setPendingDelete({ entryId: entry.entryId, confirmAll: false });
            return;
          }
          call(api.ctx, "deleteTrashEntry", {
            options: { entryId: entry.entryId, confirm: true },
          }).then(
            (/** @type {any} */ result) => {
              setPendingDelete({ entryId: "", confirmAll: false });
              setTrash((/** @type {any} */ prev) => ({
                ...prev,
                entries: prev.entries.filter(
                  (/** @type {any} */ item) => item.entryId !== entry.entryId,
                ),
                message: text(t, "detail.trashDeleted", {
                  size: formatBytes(Number(result?.bytes ?? entry.sizeBytes)),
                }),
              }));
              loadTrash();
            },
            (/** @type {any} */ error) =>
              setTrash((/** @type {any} */ prev) => ({
                ...prev,
                message: text(t, "detail.trashDeleteFailed", {
                  reason: String(error?.message ?? error),
                }),
              })),
          );
        },
        [api, loadTrash, pendingDelete.entryId, setPendingDelete, setTrash, t],
      );
      const emptyAll = useCallback(() => {
        if (pendingDelete.confirmAll !== true) {
          setPendingDelete({ entryId: "", confirmAll: true });
          return;
        }
        call(api.ctx, "emptyTrash", { options: { confirm: true } }).then(
          (/** @type {any} */ result) => {
            setPendingDelete({ entryId: "", confirmAll: false });
            setTrash({
              entries: [],
              loaded: false,
              message: text(t, "detail.trashEmptied", { count: Number(result?.count ?? 0) }),
            });
            loadTrash();
          },
          (/** @type {any} */ error) =>
            setTrash((/** @type {any} */ prev) => ({
              ...prev,
              message: text(t, "detail.trashDeleteFailed", {
                reason: String(error?.message ?? error),
              }),
            })),
        );
      }, [api, loadTrash, pendingDelete.confirmAll, setPendingDelete, setTrash, t]);
      const restoreEntry = useCallback(
        (/** @type {string} */ entryId) => {
          call(api.ctx, "restoreTrash", { entryId }).then(
            (/** @type {any} */ result) => {
              setTrash({
                entries: [],
                loaded: false,
                message: text(t, "detail.trashRestored", {
                  name: result?.name ?? "",
                  count: result?.threadCount ?? 0,
                }),
              });
              loadTrash();
              // 恢复的是"另一个"项目，必须刷新列表——否则用户看到"点了恢复但项目没回来"
              if (typeof props.onChanged === "function") props.onChanged();
            },
            (/** @type {any} */ error) =>
              setTrash((/** @type {any} */ prev) => ({
                ...prev,
                message: text(t, "detail.trashFailed", { reason: String(error?.message ?? error) }),
              })),
          );
        },
        [api, loadTrash, setTrash, t],
      );
      useEffect(() => {
        if (!trash.loaded) loadTrash();
      }, [trash.loaded, loadTrash]);

      const previewPurge = useCallback(() => {
        setPurge({ phase: "loading", eligible: 0, kept: 0, message: "" });
        call(api.ctx, "purgeTrash", { options: { dryRun: true, projectId: project.id } }).then(
          (/** @type {any} */ result) => {
            const eligible = Array.isArray(result?.eligible) ? result.eligible.length : 0;
            setPurge({
              phase: eligible > 0 ? "confirm" : "idle",
              eligible,
              kept: Number(result?.kept ?? 0),
              message: eligible > 0 ? "" : text(t, "detail.purgeNothing"),
            });
          },
          (error) =>
            setPurge({
              phase: "idle",
              eligible: 0,
              kept: 0,
              message: String(error?.message ?? error),
            }),
        );
      }, [api, project.id, setPurge, t]);
      const runPurge = useCallback(() => {
        setPurge((/** @type {any} */ prev) => ({ ...prev, phase: "loading" }));
        call(api.ctx, "purgeTrash", {
          options: { dryRun: false, confirm: "purge", projectId: project.id },
        }).then(
          (/** @type {any} */ result) => {
            const ok = result?.ok === true;
            setPurge({
              phase: "idle",
              eligible: 0,
              kept: Number(result?.kept ?? 0),
              message: ok
                ? text(t, "detail.purged", { count: (result?.purged ?? []).length })
                : text(t, "detail.refused", { reason: String(result?.reason ?? "?") }),
            });
          },
          (error) =>
            setPurge({
              phase: "idle",
              eligible: 0,
              kept: 0,
              message: String(error?.message ?? error),
            }),
        );
      }, [api, project.id, setPurge, t]);

      const askDelete = useCallback(() => {
        call(api.ctx, "previewDeleteProject", { id: project.id }).then(
          (preview) => setDel({ confirming: true, busy: false, impact: preview }),
          (error) =>
            setDel({
              confirming: true,
              busy: false,
              impact: { impact: { summary: String(error?.message ?? error) } },
            }),
        );
      }, [api, project.id, setDel]);
      const confirmDelete = useCallback(() => {
        setDel((/** @type {any} */ prev) => ({ ...prev, busy: true }));
        call(api.ctx, "deleteProject", { id: project.id }).then(
          () => {
            setDel({ confirming: false, busy: false, impact: null });
            if (typeof props.onDeleted === "function") props.onDeleted();
          },
          (error) => {
            setDel({ confirming: false, busy: false, impact: null });
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, project.id, props, setData, setDel]);

      const dirState = useState(
        project.dirs && project.dirs.length > 0 ? String(project.dirs[0]) : "",
      );
      const dirDraft = dirState[0];
      const setDirDraft = dirState[1];
      const dirInfoState = useState({ path: "", exists: false, isGit: false, writable: false });
      const dirInfo = dirInfoState[0];
      const setDirInfo = dirInfoState[1];
      const saveDir = useCallback(() => {
        const value = String(dirDraft).trim();
        // 相对路径/空值当场拒绝：以前会被静默存下来，直到建线程时才崩在宿主里，
        // 报错还是"cwd must be an absolute path"，用户根本对不上号（验收时踩到）
        if (value !== "" && !value.startsWith("/")) {
          setDirInfo({ path: value, exists: false, isGit: false, writable: false, invalid: true });
          return;
        }
        call(api.ctx, "updateProject", {
          id: project.id,
          patch: { dirs: value === "" ? [] : [value] },
        })
          .then(() => {
            // 绑完立刻探一次：非 git 目录意味着线程**不会隔离**，必须当场说清（走查发现静默降级）
            if (value === "") {
              setDirInfo({ path: "", exists: false, isGit: false, writable: false });
              return;
            }
            call(api.ctx, "inspectDir", { options: { path: value } }).then(
              (/** @type {any} */ info) => setDirInfo({ path: value, ...info }),
              () => setDirInfo({ path: value, exists: true, isGit: false, writable: true }),
            );
          })
          .then(() => load())
          .catch((/** @type {any} */ error) => {
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          });
      }, [api, dirDraft, load, project.id, setData, setDirInfo]);

      const createThread = useCallback(() => {
        const task = String(draft).trim();
        if (task === "" || busy) return;
        setBusy(true);
        call(api.ctx, "createThread", { projectId: project.id, task }).then(
          () => {
            setDraft("");
            setBusy(false);
            load();
          },
          (error) => {
            setBusy(false);
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, busy, draft, load, project.id, setBusy, setDraft, setData]);

      useEffect(() => {
        load();
      }, [load]);

      const tabs = [
        {
          id: "threads",
          label: text(t, "detail.tab.threads", {
            count: data.progress?.total ?? data.threads.length,
          }),
        },
        { id: "memory", label: text(t, "detail.tab.memory") },
        { id: "audit", label: text(t, "detail.tab.audit") },
      ];

      // —— 详情页新增的本地状态（两列布局 / ⋯ 菜单 / 收藏 / 窄窗）——
      const menuState = useState(false);
      const menuOpen = menuState[0];
      const setMenuOpen = menuState[1];
      const pinState = useState(null);
      const pinnedLocal = pinState[0];
      const setPinnedLocal = pinState[1];
      const gridRef = useRef(null);
      const narrowState = useState(false);
      const narrow = narrowState[0];
      const setNarrow = narrowState[1];
      const content = data.content || {};
      const counts = data.progress?.counts ?? {};
      const hasDir = Array.isArray(props.project?.dirs) && props.project.dirs.length > 0;
      const stateIsArchived = data.projectState === "archived";
      // 收藏状态优先读持久值（props.project 来自父级列表），本地只做乐观覆盖
      const pinned = pinnedLocal === null ? props.project?.pinned === true : pinnedLocal;
      // MEMORY.md 是索引文件；条目数按索引里「非空且不是标题行」的行计。
      // 没有更细的条目结构可读，所以这是一个**下界**而不是精确值（不编精确数字）。
      const memoryEntries = String(content.memoryIndex ?? "")
        .split("\n")
        .filter((/** @type {string} */ line) => {
          const value = line.trim();
          return value !== "" && !value.startsWith("#");
        }).length;

      useEffect(() => {
        setPinnedLocal(null);
        setMenuOpen(false);
      }, [project.id, setMenuOpen, setPinnedLocal]);

      // 窄窗（<760px）降为单列：右栏落到主列之后，不压缩线程列表
      useEffect(() => {
        const node = gridRef.current;
        if (!node || typeof ResizeObserver !== "function") return undefined;
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width ?? 0;
          if (width > 0) setNarrow(width < 760);
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, [setNarrow]);

      const togglePin = useCallback(() => {
        const next = !pinned;
        setPinnedLocal(next);
        call(api.ctx, "setProjectPinned", { projectId: project.id, pinned: next }).then(
          () => {
            if (typeof props.onToast === "function")
              props.onToast(
                text(t, next ? "panel.toastPinned" : "panel.toastUnpinned", { name: project.name }),
              );
            if (typeof props.onChanged === "function") props.onChanged();
          },
          (error) => {
            setPinnedLocal(!next);
            if (typeof props.onToast === "function")
              props.onToast(
                text(t, "panel.pinFailed", { reason: String(error?.message ?? error) }),
              );
          },
        );
      }, [api, pinned, project.id, project.name, props, setPinnedLocal, t]);

      const toggleArchive = useCallback(() => {
        setMenuOpen(false);
        const archive = data.projectState !== "archived";
        call(api.ctx, archive ? "archiveProject" : "unarchiveProject", { id: project.id }).then(
          () => {
            if (typeof props.onToast === "function")
              props.onToast(
                text(t, archive ? "panel.toastArchived" : "panel.toastUnarchived", {
                  name: project.name,
                }),
              );
            load();
            if (typeof props.onChanged === "function") props.onChanged();
          },
          (error) => {
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, data.projectState, load, project.id, project.name, props, setData, setMenuOpen, t]);

      const body = (() => {
        if (data.loading) return h("p", { style: styles.empty }, text(t, "detail.loading"));
        if (data.error !== "")
          return h("p", { style: styles.error, "data-projects-detail-error": "" }, data.error);
        if (tab === "threads") {
          const rows = data.progress?.rows ?? [];
          // composer / 派活输入 / 结果提示都已经在**主列顶部**（详情页两列布局）：
          // 页签体里只留线程行本身，否则同一批锚点会出现两份（菜单和输入会点到隐藏的那一份）。
          if (rows.length === 0)
            return h(
              "div",
              { "data-projects-threads": "", "data-projects-attention": "0" },
              h(
                "p",
                { style: styles.empty, "data-projects-threads-empty": "" },
                text(t, "detail.threadsEmpty"),
              ),
            );
          return h(
            "div",
            {
              "data-projects-threads": "",
              "data-projects-attention": String(data.progress?.attention ?? 0),
            },
            rows.map((/** @type {any} */ row) =>
              h(
                "div",
                {
                  key: row.sessionId,
                  style: {
                    ...styles.row,
                    padding: "8px 4px",
                    cursor: "default",
                    alignItems: "flex-start",
                  },
                  "data-projects-thread-row": row.sessionId,
                  "data-projects-thread-state": row.view.state,
                },
                // 状态点：颜色只表达状态，不承载信息（信息在胶囊与右侧摘要里）
                h("span", {
                  style: {
                    ...styles.dot,
                    marginTop: "5px",
                    background:
                      row.view.state === "failed"
                        ? T.danger
                        : row.view.state === "working"
                          ? T.accentText
                          : row.view.state === "waiting-user"
                            ? T.success
                            : T.faint,
                  },
                  "data-projects-thread-dot": row.view.state,
                  "aria-hidden": "true",
                }),
                h(
                  "div",
                  { style: styles.rowMain },
                  h(
                    "span",
                    {
                      style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
                      title: String(row.sessionId),
                    },
                    h(
                      "span",
                      { style: styles.name },
                      row.view.turn > 0
                        ? `turn ${row.view.turn} · ${row.branch ? String(row.branch) : String(row.sessionId).slice(0, 12)}`
                        : String(row.sessionId).slice(0, 20),
                    ),
                    h(
                      "span",
                      { style: styles.pill, "data-projects-thread-pill": row.view.state },
                      text(t, `detail.state.${row.view.state}`),
                    ),
                  ),
                  h(
                    "span",
                    { style: styles.meta },
                    [
                      row.branch && row.view.turn > 0 ? String(row.branch) : "",
                      row.isolated === false ? text(t, "detail.threadShared") : "",
                      row.view.turn > 0 ? `turn ${row.view.turn}` : "",
                    ]
                      .filter((part) => part !== "")
                      .join(" · ") || "—",
                  ),
                  // 可观测摘要（规格 §7.7.3）：步骤/工具/diff/tokens，缺失显式 n/a
                  row.summary
                    ? h(
                        "span",
                        { style: styles.meta, "data-projects-thread-stats": "" },
                        String(row.summary),
                      )
                    : null,
                  row.worktree
                    ? h(
                        "span",
                        {
                          style: {
                            ...styles.meta,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          },
                          "data-projects-thread-worktree": row.sessionId,
                          title: String(row.worktree),
                        },
                        text(t, "detail.threadWorktree", { path: String(row.worktree) }),
                      )
                    : null,
                  h(
                    "span",
                    { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                    row.worktree
                      ? h(
                          "button",
                          {
                            type: "button",
                            style: {
                              ...styles.secondaryButton,
                              padding: "2px 10px",
                              fontSize: "12px",
                            },
                            "data-projects-thread-reclaim": row.sessionId,
                            onClick: () => reclaimDir(row.sessionId),
                            disabled: threadAction.pending === row.sessionId,
                          },
                          text(t, "detail.threadReclaim"),
                        )
                      : null,
                    h(
                      "button",
                      {
                        type: "button",
                        style: {
                          ...styles.secondaryButton,
                          padding: "2px 10px",
                          fontSize: "12px",
                          color: T.danger,
                          borderColor: T.danger,
                        },
                        "data-projects-thread-remove": row.sessionId,
                        onClick: () => removeThread(row.sessionId),
                      },
                      threadAction.pending === row.sessionId
                        ? text(t, "detail.threadRemoveConfirm")
                        : text(t, "detail.threadRemove"),
                    ),
                  ),
                ),
              ),
            ),
          );
        }
        if (tab === "memory") {
          const content = data.content || {};
          return h(
            "div",
            { "data-projects-memory": "" },
            h("h3", { style: styles.name }, text(t, "detail.instructions")),
            // 走查发现这一页只读：用户看得到规则却写不进去。加编辑与追加两个入口。
            mem.editing
              ? h("textarea", {
                  style: { ...styles.input, minHeight: "140px", fontFamily: "inherit" },
                  value: mem.draft,
                  placeholder: text(t, "detail.memoryAppendPlaceholder"),
                  "data-projects-memory-editor": "",
                  onChange: (/** @type {any} */ event) =>
                    setMem((/** @type {any} */ prev) => ({ ...prev, draft: event.target.value })),
                })
              : h(
                  "pre",
                  {
                    style: { ...styles.meta, whiteSpace: "pre-wrap", margin: "4px 0 12px" },
                    "data-projects-instructions-full": "",
                  },
                  content.instructions || text(t, "detail.emptyFile"),
                ),
            h(
              "div",
              { style: { display: "flex", gap: "8px", alignItems: "center", margin: "0 0 12px" } },
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-memory-edit": "",
                  onClick: () =>
                    setMem((/** @type {any} */ prev) => ({
                      ...prev,
                      editing: !prev.editing,
                      draft: prev.editing ? prev.draft : String(content.instructions ?? ""),
                      message: "",
                    })),
                },
                mem.editing ? text(t, "detail.cancel") : text(t, "detail.memoryEdit"),
              ),
              mem.editing
                ? h(
                    "button",
                    {
                      type: "button",
                      style: styles.button,
                      "data-projects-memory-save": "",
                      onClick: saveInstructions,
                      disabled: mem.busy,
                    },
                    mem.busy ? text(t, "detail.memorySaving") : text(t, "detail.memorySave"),
                  )
                : null,
            ),
            h(
              "div",
              { style: { display: "flex", gap: "8px", margin: "0 0 12px" } },
              h("input", {
                style: styles.input,
                value: mem.append,
                placeholder: text(t, "detail.memoryAppendPlaceholder"),
                "data-projects-memory-append-input": "",
                onChange: (/** @type {any} */ event) =>
                  setMem((/** @type {any} */ prev) => ({ ...prev, append: event.target.value })),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event.key === "Enter") appendMemoryLine();
                },
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-memory-append": "",
                  onClick: appendMemoryLine,
                },
                text(t, "detail.memoryAppend"),
              ),
            ),
            mem.message !== ""
              ? h("div", { style: styles.meta, "data-projects-memory-result": "" }, mem.message)
              : null,
            h("h3", { style: styles.name }, text(t, "detail.memoryIndex")),
            h(
              "pre",
              {
                style: { ...styles.meta, whiteSpace: "pre-wrap", margin: "4px 0" },
                "data-projects-memory-index": "",
              },
              content.memoryIndex || text(t, "detail.emptyFile"),
            ),
          );
        }
        if (data.audit.length === 0)
          return h(
            "p",
            { style: styles.empty, "data-projects-audit-empty": "" },
            text(t, "detail.auditEmpty"),
          );
        return h(
          "div",
          { "data-projects-audit": "" },
          data.audit.map((/** @type {any} */ entry, /** @type {any} */ index) =>
            h(
              "div",
              { key: String(index), style: styles.row },
              h(
                "div",
                { style: styles.rowMain },
                h("span", { style: styles.name }, String(entry.action || entry.kind || "?")),
                h("span", { style: styles.meta }, String(entry.at || "")),
              ),
            ),
          ),
        );
      })();

      return h(
        "div",
        {
          "data-projects-detail": project.id,
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            padding: "16px 16px 24px",
            boxSizing: "border-box",
          },
        },
        // —— 头部：返回 / 标题 / 收藏 / ⋯（编辑详情 · 归档 · 删除）——
        h(
          "div",
          {
            style: styles.detailHead,
            "data-projects-detail-head": "",
            "data-projects-state-actions": "",
          },
          h(
            "button",
            {
              type: "button",
              style: styles.iconButton,
              "data-projects-detail-back": "",
              "aria-label": text(t, "detail.back"),
              onClick: () => props.onBack(),
            },
            "‹",
          ),
          h("span", { style: styles.detailTitle, "data-projects-detail-title": "" }, project.name),
          h(
            "button",
            {
              type: "button",
              style: { ...styles.iconButton, color: pinned ? T.accentText : T.dim },
              "data-projects-pin": "",
              "data-pinned": pinned ? "true" : "false",
              "aria-label": text(t, pinned ? "panel.unpin" : "panel.pin"),
              "aria-pressed": pinned ? "true" : "false",
              onClick: togglePin,
            },
            uiIcon(pinned ? "pin" : "unpin", "📌", 15),
          ),
          h(Popover, {
            open: menuOpen,
            onClose: () => setMenuOpen(false),
            anchor: h(
              "button",
              {
                type: "button",
                style: styles.iconButton,
                "data-projects-row-menu": "",
                "aria-label": text(t, "detail.moreActions"),
                "aria-haspopup": "menu",
                "aria-expanded": menuOpen ? "true" : "false",
                onClick: () => setMenuOpen(!menuOpen),
              },
              uiIcon("more", "⋯", 16),
            ),
            menu: h(
              "div",
              {
                style: { display: "flex", flexDirection: "column", gap: "2px" },
                "data-projects-row-menu-list": project.id,
              },
              h(
                "button",
                {
                  type: "button",
                  role: "menuitem",
                  style: menuItemStyle,
                  "data-projects-row-menu-edit": "",
                  onClick: () => {
                    setMenuOpen(false);
                    if (typeof props.onEditDetails === "function") props.onEditDetails(project);
                  },
                },
                text(t, "panel.rowEdit"),
              ),
              h(
                "button",
                {
                  type: "button",
                  role: "menuitem",
                  style: menuItemStyle,
                  "data-projects-toggle-archive": "",
                  onClick: toggleArchive,
                },
                stateIsArchived ? text(t, "detail.unarchive") : text(t, "panel.rowArchive"),
              ),
              h(
                "button",
                {
                  type: "button",
                  role: "menuitem",
                  style: { ...menuItemStyle, color: T.danger },
                  "data-projects-delete": "",
                  disabled: del.busy,
                  onClick: () => {
                    setMenuOpen(false);
                    askDelete();
                  },
                },
                text(t, "detail.delete"),
              ),
            ),
          }),
        ),
        h(
          "span",
          { style: { ...styles.meta, display: "block" }, "data-projects-detail-goal": "" },
          project.goal || text(t, "panel.goalEmpty"),
        ),
        h(
          "div",
          {
            ref: gridRef,
            style: narrow ? styles.detailGridNarrow : styles.detailGrid,
            "data-projects-detail-grid": "",
          },
          // —— 主列：composer 卡 → 页签 → 线程列表 ——
          h(
            "div",
            { style: styles.mainCol, "data-projects-detail-main": "" },
            threadAction.message !== ""
              ? h(
                  "div",
                  {
                    style: {
                      ...styles.meta,
                      color: threadAction.ok === false ? T.danger : T.text,
                    },
                    "data-projects-thread-action-result": "",
                  },
                  threadAction.message,
                )
              : null,
            !hasDir
              ? h(
                  "div",
                  { style: styles.meta, "data-projects-no-dir-hint": "" },
                  text(t, "detail.noDirHint"),
                )
              : null,
            h(
              "div",
              { style: styles.composerCard, "data-projects-composer": "" },
              h("input", {
                style: {
                  ...styles.input,
                  border: "none",
                  background: "transparent",
                  padding: "2px 0",
                  fontSize: "14px",
                },
                value: draft,
                placeholder: text(t, "detail.threadPlaceholder"),
                "data-projects-thread-input": "",
                onChange: (/** @type {any} */ event) => setDraft(event.target.value),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event.key === "Enter") createThread();
                },
                disabled: busy,
              }),
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "8px" } },
                h("span", { style: { flex: "1 1 auto" } }),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.primaryButton,
                    "data-projects-thread-create": "",
                    onClick: createThread,
                    disabled: busy,
                  },
                  busy ? text(t, "detail.threadCreating") : text(t, "detail.threadCreate"),
                ),
              ),
            ),
            // 按规则派活：保留既有语义（一句话决定怎么做），锚点与旧 UI 一致
            h(
              "div",
              { style: { display: "flex", gap: "8px", alignItems: "center" } },
              h("input", {
                style: styles.input,
                value: routeText,
                placeholder: text(t, "detail.routePlaceholder"),
                "data-projects-route-input": "",
                onChange: (/** @type {any} */ event) => setRouteText(event.target.value),
                onKeyDown: (/** @type {any} */ event) => {
                  if (event.key === "Enter") dispatchRoute();
                },
                disabled: routeBusy,
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.secondaryButton,
                  "data-projects-route-dispatch": "",
                  "data-projects-route-run": "",
                  onClick: dispatchRoute,
                  disabled: routeBusy,
                },
                routeBusy ? text(t, "detail.routeBusy") : text(t, "detail.routeDispatch"),
              ),
            ),
            routeResult
              ? h(
                  "div",
                  {
                    style: styles.meta,
                    "data-projects-route-result": "",
                    "data-projects-route-executed": routeResult.executed ? "yes" : "no",
                    title: routeResult.decision
                      ? `by=${String(routeResult.decision.by)} action=${String(routeResult.decision.action)}${routeResult.decision.ruleId ? ` rule=${String(routeResult.decision.ruleId)}` : ""}${routeResult.decision.blockedReason ? ` reason=${String(routeResult.decision.blockedReason)}` : ""}`
                      : "",
                  },
                  (() => {
                    const decision = routeResult.decision;
                    if (!decision) return routeResult.reason ? String(routeResult.reason) : "";
                    const action = String(decision.action);
                    const actionText = text(t, `detail.routeAction.${action}`);
                    const how =
                      decision.ruleId && decision.by !== "fallback"
                        ? text(t, "detail.routeBy.rule", { rule: String(decision.ruleId) })
                        : text(t, "detail.routeBy.fallback");
                    if (routeResult.executed)
                      return text(t, "detail.routeOk", { how, action: actionText });
                    // 被拦下的情况：说清"想做什么、为什么没做、可以怎么办"
                    const level = String(decision.blockedReason ?? "").replace(/^autonomy\//u, "");
                    const head = text(t, "detail.routeBlocked", {
                      how,
                      action: actionText,
                      level: level || "?",
                    });
                    return `${head}（${text(t, "detail.routeBlockedHint")}）`;
                  })(),
                )
              : null,
            h(
              "div",
              { style: styles.meta, "data-projects-counts": "" },
              ["waiting-user", "failed", "working", "done", "idle"]
                .filter((state) => (counts[state] ?? 0) > 0)
                .map((state) => `${text(t, `detail.state.${state}`)} ${counts[state]}`)
                .join(" · "),
            ),
            (() => {
              const all = Array.isArray(data.approvals) ? data.approvals : [];
              const pending = all.filter((/** @type {any} */ item) => item.status === "pending");
              // 已批准但还没执行：这才是「批准 ≠ 可执行」里那独立的一步，必须有入口
              const runnable = all.filter(
                (/** @type {any} */ item) =>
                  item.status === "approved" &&
                  !(typeof item.executedAt === "string" && item.executedAt !== ""),
              );
              if (pending.length === 0 && runnable.length === 0) return null;
              const row = (/** @type {any} */ item, /** @type {any} */ actions) =>
                h(
                  "div",
                  {
                    key: item.requestId,
                    style: { display: "flex", gap: "8px", alignItems: "center" },
                    "data-projects-approval-row": item.requestId,
                  },
                  h(
                    "span",
                    { style: { ...styles.meta, flex: 1, minWidth: 0 } },
                    `${item.action} · ${item.reason}`,
                  ),
                  ...actions,
                );
              return h(
                "div",
                {
                  "data-projects-approvals": "",
                  style: {
                    border: `1px solid ${T.borderSoft}`,
                    borderRadius: "10px",
                    padding: "10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                  },
                },
                h("div", { style: styles.name }, text(t, "detail.approvalsTitle")),
                pending.map((/** @type {any} */ item) =>
                  row(item, [
                    h(
                      "button",
                      {
                        key: "approve",
                        type: "button",
                        style: styles.secondaryButton,
                        "data-projects-approval-approve": item.requestId,
                        onClick: () => resolveApproval(item.requestId, "approved"),
                      },
                      text(t, "detail.approve"),
                    ),
                    h(
                      "button",
                      {
                        key: "reject",
                        type: "button",
                        style: { ...styles.secondaryButton, color: T.danger },
                        "data-projects-approval-reject": item.requestId,
                        onClick: () => resolveApproval(item.requestId, "rejected"),
                      },
                      text(t, "detail.reject"),
                    ),
                  ]),
                ),
                runnable.map((/** @type {any} */ item) =>
                  row(item, [
                    h(
                      "button",
                      {
                        key: "execute",
                        type: "button",
                        style: styles.secondaryButton,
                        disabled: exec.busy === item.requestId,
                        "data-projects-approval-execute": item.requestId,
                        onClick: () => executeApproval(item.requestId),
                      },
                      text(t, "detail.execute"),
                    ),
                  ]),
                ),
              );
            })(),
            exec.message !== ""
              ? h(
                  "div",
                  {
                    style: { ...styles.meta, color: exec.ok === false ? T.danger : T.text },
                    "data-projects-approval-exec-result": "",
                  },
                  exec.message,
                )
              : null,
            h(
              "div",
              { style: { display: "flex", gap: "6px", marginTop: "4px" }, role: "tablist" },
              tabs.map((/** @type {any} */ item) =>
                h(
                  "button",
                  {
                    type: "button",
                    key: item.id,
                    role: "tab",
                    "aria-selected": tab === item.id ? "true" : "false",
                    "data-projects-tab": item.id,
                    style: {
                      ...styles.button,
                      borderColor: tab === item.id ? T.accentText : T.border,
                      color: tab === item.id ? T.accentText : T.text,
                    },
                    onClick: () => setTab(item.id),
                  },
                  item.label,
                ),
              ),
            ),
            body,
          ),
          // —— 右栏：指令 / 记忆 / 上下文（常驻，可截图对照 Claude 的项目主页）——
          h(
            "aside",
            { style: styles.rail, "data-projects-config": "", "data-projects-rail": "" },
            h(
              "section",
              {
                style: { ...styles.railSection, borderTop: "none" },
                "data-projects-rail-instructions": "",
              },
              h(
                "div",
                { style: styles.railHead },
                h("span", { style: styles.railTitle }, text(t, "detail.section.instructions")),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.iconButton,
                    "data-projects-instructions-edit": "",
                    "aria-label": text(t, "detail.instructionsEdit"),
                    onClick: () => {
                      setTab("memory");
                      setMem((/** @type {any} */ prev) => ({
                        ...prev,
                        editing: true,
                        draft: String(data.content?.instructions ?? ""),
                        message: "",
                      }));
                    },
                  },
                  "✎",
                ),
              ),
              h(
                "div",
                {
                  style: content.instructions ? styles.railBody : styles.railBody,
                  "data-projects-instructions": "",
                  title: String(content.instructions ?? ""),
                },
                content.instructions || text(t, "detail.instructionsEmpty"),
              ),
            ),
            h(
              "section",
              { style: styles.railSection, "data-projects-rail-memory": "" },
              h(
                "div",
                { style: styles.railHead },
                h("span", { style: styles.railTitle }, text(t, "detail.section.memory")),
                h(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                    "data-projects-memory-open": "",
                    onClick: () => setTab("memory"),
                  },
                  `${text(t, "detail.section.open")} ›`,
                ),
              ),
              h(
                "div",
                { style: styles.railBodyFull, "data-projects-memory-count": "" },
                text(t, "detail.memoryCount", { count: memoryEntries }),
              ),
              h(
                "div",
                { style: styles.railBodyFull, "data-projects-memory-status": "" },
                data.content?.memoryIndex
                  ? text(t, "detail.memoryIndexHint")
                  : text(t, "detail.memoryEmptyHint"),
              ),
            ),
            h(
              "section",
              { style: styles.railSection, "data-projects-rail-context": "" },
              h(
                "div",
                { style: styles.railHead },
                h("span", { style: styles.railTitle }, text(t, "detail.section.context")),
                h(
                  "span",
                  { style: styles.meta, "data-projects-budget": "" },
                  data.progress?.budget
                    ? text(t, "detail.budget", {
                        today: data.progress.budget.used?.today ?? 0,
                        running: data.progress.budget.used?.running ?? 0,
                      })
                    : "",
                ),
              ),
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
                h(
                  "span",
                  { style: { ...styles.meta, flex: "1 1 auto" } },
                  text(t, "detail.projectState"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                    "data-projects-toggle-pause": "",
                    onClick: () => {
                      const next =
                        data.projectState === "paused" ? "resumeProject" : "pauseProject";
                      call(api.ctx, next, { id: project.id }).then(
                        () => load(),
                        (error) => {
                          setData((/** @type {any} */ prev) => ({
                            ...prev,
                            error: String(error?.message ?? error),
                          }));
                        },
                      );
                    },
                  },
                  data.projectState === "paused"
                    ? text(t, "detail.resume")
                    : text(t, "detail.pause"),
                ),
              ),
              // 项目目录：绑定入口与「是 git 仓库 / 只是共享目录」的当场说明
              h(
                "div",
                { style: { display: "flex", gap: "6px", alignItems: "center" } },
                h("input", {
                  style: { ...styles.input, fontSize: "12px" },
                  value: dirDraft,
                  placeholder: text(t, "detail.dirPlaceholder"),
                  "data-projects-dir-input": "",
                  onChange: (/** @type {any} */ event) => setDirDraft(event.target.value),
                  onKeyDown: (/** @type {any} */ event) => {
                    if (event.key === "Enter") saveDir();
                  },
                }),
                h(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.secondaryButton, padding: "4px 10px", fontSize: "12px" },
                    "data-projects-dir-save": "",
                    onClick: saveDir,
                  },
                  text(t, "detail.dirSave"),
                ),
              ),
              dirInfo.path !== ""
                ? h(
                    "div",
                    {
                      style: {
                        ...styles.meta,
                        color: dirInfo.invalid ? T.danger : dirInfo.isGit ? T.text : T.accentText,
                      },
                      "data-projects-dir-info": dirInfo.invalid
                        ? "invalid"
                        : dirInfo.isGit
                          ? "git"
                          : "shared",
                    },
                    dirInfo.invalid
                      ? text(t, "detail.dirInvalidHint")
                      : dirInfo.isGit
                        ? text(t, "detail.dirGitHint")
                        : text(t, "detail.dirSharedHint"),
                  )
                : null,
              // 仓库授权（直推保护分支的 per-repo 首次授予）
              h(
                "div",
                {
                  "data-projects-grants": "",
                  style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" },
                },
                h("div", { style: styles.meta }, text(t, "detail.grantsTitle")),
                h(
                  "div",
                  { style: styles.meta },
                  grants.length > 0 ? grants.join(" · ") : text(t, "detail.grantsEmpty"),
                ),
                h(
                  "div",
                  { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  h("input", {
                    value: grantsDraft,
                    placeholder: "owner/repo",
                    "data-projects-grant-input": "",
                    style: { ...styles.input, flex: 1, minWidth: 0, fontSize: "12px" },
                    onInput: (/** @type {any} */ event) => setGrantsDraft(event.target.value),
                  }),
                  h(
                    "button",
                    {
                      type: "button",
                      style: { ...styles.secondaryButton, padding: "4px 10px", fontSize: "12px" },
                      "data-projects-grant-add": "",
                      onClick: () => {
                        const slug = String(grantsDraft).trim();
                        if (!/^[\w.-]+\/[\w.-]+$/u.test(slug)) return;
                        setGrants([...grants, slug]);
                        setGrantsDraft("");
                      },
                    },
                    text(t, "detail.grantAdd"),
                  ),
                ),
                grants.length > 0
                  ? h(
                      "div",
                      { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                      ...grants.map((/** @type {string} */ slug) =>
                        h(
                          "button",
                          {
                            key: slug,
                            type: "button",
                            style: { ...styles.button, fontSize: "11px" },
                            "data-projects-grant-remove": slug,
                            onClick: () => setGrants(grants.filter((item) => item !== slug)),
                          },
                          `${slug} ✕`,
                        ),
                      ),
                    )
                  : null,
              ),
              // 回收站清理：先预览再确认（dry-run 默认）
              h(
                "div",
                {
                  "data-projects-purge": "",
                  style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" },
                },
                h("div", { style: styles.meta }, text(t, "detail.purgeTitle")),
                h(
                  "div",
                  { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  h(
                    "button",
                    {
                      type: "button",
                      style: { ...styles.secondaryButton, padding: "4px 10px", fontSize: "12px" },
                      disabled: purge.phase === "loading",
                      "data-projects-purge-preview": "",
                      onClick: previewPurge,
                    },
                    text(t, "detail.purgePreview"),
                  ),
                  purge.phase === "confirm"
                    ? h(
                        "button",
                        {
                          type: "button",
                          style: {
                            ...styles.secondaryButton,
                            color: T.danger,
                            padding: "4px 10px",
                            fontSize: "12px",
                          },
                          "data-projects-purge-confirm": "",
                          onClick: runPurge,
                        },
                        text(t, "detail.purgeConfirm", { count: purge.eligible }),
                      )
                    : null,
                ),
                purge.message !== ""
                  ? h(
                      "div",
                      { style: styles.meta, "data-projects-purge-result": "" },
                      purge.message,
                    )
                  : null,
              ),
              // 回收站（可恢复）：删除承诺"可恢复"，就必须给得出恢复入口（P0-2）
              h(
                "div",
                {
                  "data-projects-trash": "",
                  style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" },
                },
                h("div", { style: styles.meta }, text(t, "detail.trashTitle")),
                trash.entries.length === 0
                  ? h(
                      "div",
                      { style: styles.meta, "data-projects-trash-empty": "" },
                      text(t, "detail.trashEmpty"),
                    )
                  : h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                      trash.entries.slice(0, 8).map((/** @type {any} */ entry) =>
                        h(
                          "div",
                          {
                            key: entry.entryId,
                            "data-projects-trash-row": entry.entryId,
                            style: {
                              display: "flex",
                              gap: "6px",
                              alignItems: "center",
                              justifyContent: "space-between",
                              flexWrap: "wrap",
                            },
                          },
                          h(
                            "span",
                            {
                              style: {
                                ...styles.meta,
                                minWidth: 0,
                                flex: "1 1 120px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              },
                            },
                            `${entry.name} · ${entry.threadCount} 个线程 · ${formatBytes(entry.sizeBytes)}`,
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              style: { ...styles.button, fontSize: "11px" },
                              "data-projects-trash-restore": entry.entryId,
                              onClick: () => restoreEntry(entry.entryId),
                              disabled: entry.restorable !== true,
                            },
                            text(t, "detail.trashRestore"),
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              style: {
                                ...styles.button,
                                fontSize: "11px",
                                borderColor: T.danger,
                                color: T.danger,
                              },
                              "data-projects-trash-delete": entry.entryId,
                              onClick: () => deleteEntry(entry),
                            },
                            pendingDelete.entryId === entry.entryId
                              ? text(t, "detail.trashDeleteConfirm", {
                                  size: formatBytes(entry.sizeBytes),
                                })
                              : text(t, "detail.trashDelete"),
                          ),
                        ),
                      ),
                    ),
                trash.entries.length > 0
                  ? h(
                      "div",
                      { style: { display: "flex", justifyContent: "flex-end" } },
                      h(
                        "button",
                        {
                          type: "button",
                          style: {
                            ...styles.button,
                            fontSize: "11px",
                            borderColor: T.danger,
                            color: T.danger,
                          },
                          "data-projects-trash-empty": "",
                          onClick: emptyAll,
                        },
                        pendingDelete.confirmAll
                          ? text(t, "detail.trashEmptyConfirm", {
                              count: trash.entries.length,
                              size: formatBytes(
                                trash.entries.reduce(
                                  (/** @type {number} */ sum, /** @type {any} */ item) =>
                                    sum + Number(item.sizeBytes ?? 0),
                                  0,
                                ),
                              ),
                            })
                          : text(t, "detail.trashEmptyAll"),
                      ),
                    )
                  : null,
                trash.message !== ""
                  ? h(
                      "div",
                      { style: styles.meta, "data-projects-trash-result": "" },
                      trash.message,
                    )
                  : null,
              ),
              // 危险开关：宿主设置页在未登录 profile 里不渲染插件分节（验收发现），
              // 而这些都是 per-project 策略，放在项目自己的上下文里更合理。
              h(DangerSwitches, {
                t: t,
                policy: project.policy,
                onChange: (/** @type {any} */ patch) =>
                  call(api.ctx, "updateProject", {
                    id: project.id,
                    patch: { policy: { ...project.policy, ...patch } },
                  }).then(() => {
                    load();
                    // 复选框的 checked 来自 props.project.policy（父级列表数据），
                    // 不刷新父级就会「勾了又弹回」——用户以为没生效（走查发现）
                    if (typeof props.onChanged === "function") props.onChanged();
                  }),
              }),
            ),
          ),
        ),
        del.confirming
          ? h(
              "div",
              {
                role: "alertdialog",
                "aria-label": text(t, "detail.delete"),
                style: {
                  border: `1px solid ${T.danger}`,
                  borderRadius: "10px",
                  padding: "10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                },
                "data-projects-delete-confirm-panel": "",
              },
              h(
                "div",
                { style: { color: T.text }, "data-projects-delete-impact": "" },
                del.impact?.impact?.summary ?? "",
              ),
              h(
                "details",
                { style: { ...styles.meta } },
                h("summary", null, text(t, "detail.deleteDetails")),
                h(
                  "code",
                  { style: { ...styles.meta, whiteSpace: "pre-wrap" } },
                  String(del.impact?.contentDir ?? ""),
                ),
              ),
              h(
                "div",
                { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-delete-cancel": "",
                    onClick: () => setDel({ confirming: false, busy: false, impact: null }),
                  },
                  text(t, "detail.deleteCancel"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.secondaryButton, borderColor: T.danger, color: T.danger },
                    "data-projects-delete-confirm": "",
                    "data-modal-autofocus": "",
                    onClick: confirmDelete,
                    disabled: del.busy,
                  },
                  del.busy ? text(t, "detail.deleting") : text(t, "detail.deleteConfirm"),
                ),
              ),
            )
          : null,
      );
    }

    /**
     * 渲染护栏：把渲染期异常变成可见文本，而不是让整个应用白屏。
     * 直接以函数调用子组件，让 hooks 归属本组件、异常可被 try/catch 捕获。
     * @param {any} props
     */
    function ProjectsPanelSafe(props) {
      try {
        return ProjectsPanel(props);
      } catch (error) {
        return h(
          "pre",
          {
            "data-projects-crash": "",
            style: { color: T.danger, whiteSpace: "pre-wrap", fontSize: "12px" },
          },
          String(/** @type {any} */ (error)?.stack || error),
        );
      }
    }

    /**
     * 会话行「…」菜单里的一项：把该会话归属到某个项目。
     * slot 契约：renderSlot(slot, target.value, { hookContext })，target.value 里带会话标识。
     * 刻意用内联展开而不是弹窗：菜单里再弹 modal 会叠两层焦点陷阱。
     * @param {any} props
     */
    function AttachToProjectMenu(props) {
      const expanded = useState(false);
      const open = expanded[0];
      const setOpen = expanded[1];
      const state = useState({ loading: false, error: "", projects: [] });
      const view = state[0];
      const setView = state[1];
      const t = props.api.t;
      const api = props.api;

      const sessionId =
        props.sessionId ||
        props.session?.id ||
        props.target?.sessionId ||
        props.value?.sessionId ||
        props.id ||
        "";

      const load = useCallback(() => {
        setView((/** @type {any} */ prev) => ({
          loading: true,
          error: prev.error,
          projects: prev.projects,
        }));
        call(api.ctx, "listProjects").then(
          (projects) => {
            setView({
              loading: false,
              error: "",
              projects: Array.isArray(projects) ? projects : [],
            });
          },
          (error) => {
            setView({ loading: false, error: String(error?.message ?? error), projects: [] });
          },
        );
      }, [api]);

      const attach = useCallback(
        (/** @type {any} */ projectId) => {
          if (String(sessionId) === "") return;
          call(api.ctx, "attachThread", { sessionId: String(sessionId), projectId }).then(
            () => {
              const hook = props.hookContext;
              if (Array.isArray(hook) && typeof hook[1] === "function") hook[1](false);
            },
            (error) => {
              setView((/** @type {any} */ prev) => ({
                loading: false,
                error: String(error?.message ?? error),
                projects: prev.projects,
              }));
            },
          );
        },
        [api, props, sessionId],
      );

      if (String(sessionId) === "") return null;

      return h(
        "div",
        { "data-projects-attach": sessionId },
        h(
          "button",
          {
            type: "button",
            style: { ...styles.button, width: "100%", textAlign: "left", marginTop: "4px" },
            "data-projects-attach-open": "",
            onClick: () => {
              setOpen(!open);
              if (!open) load();
            },
          },
          text(t, "menu.attach"),
        ),
        open
          ? h(
              "div",
              {
                style: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "2px" },
                "data-projects-attach-list": "",
              },
              view.loading ? h("span", { style: styles.meta }, text(t, "menu.loading")) : null,
              view.error ? h("span", { style: styles.error }, view.error) : null,
              view.projects.length === 0 && !view.loading
                ? h(
                    "span",
                    { style: styles.meta, "data-projects-attach-empty": "" },
                    text(t, "menu.empty"),
                  )
                : view.projects.map((/** @type {any} */ project) =>
                    h(
                      "button",
                      {
                        type: "button",
                        key: project.id,
                        style: { ...styles.button, textAlign: "left" },
                        "data-projects-attach-option": project.id,
                        onClick: () => attach(project.id),
                      },
                      project.threadCount > 0
                        ? `${project.name} · ${text(t, "panel.threads", { count: project.threadCount })}`
                        : project.name,
                    ),
                  ),
            )
          : null,
      );
    }

    /**
     * 全局通知：轮询各活跃项目的线程状态，新出现「失败 / 等你」时弹一条应用内 toast。
     * 不依赖浏览器 Notification（那条需要用户手势授权，默认不开）。
     * @param {{api: any, t: any, onOpen?: () => void}} props
     */
    function ProjectsNotifier(props) {
      const api = props.api;
      const t = props.t;
      const state = useState(null);
      const notice = state[0];
      const setNotice = state[1];
      const previous = React.useRef({ threads: {}, projects: [] });

      useEffect(() => {
        let cancelled = false;
        const tick = () => {
          // 页面在后台时不轮询：每 5s 一次 listProjects + 每项目 progress，
          // 在用户没看的时候纯属浪费（而且没人能看见 toast）。
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          call(api.ctx, "listProjects").then(
            (projects) => {
              if (cancelled || !Array.isArray(projects)) return;
              const active = projects.filter(
                (/** @type {any} */ project) => project.state === "active",
              );
              Promise.all(
                active.map((/** @type {any} */ project) =>
                  call(api.ctx, "progress", { projectId: project.id }).then(
                    (value) => ({ projectId: project.id, value }),
                    () => null,
                  ),
                ),
              ).then((results) => {
                if (cancelled) return;
                /** @type {Record<string, {state: string, projectId?: string}>} */
                const threads = {};
                for (const result of results) {
                  if (!result?.value) continue;
                  for (const row of result.value.rows ?? []) {
                    threads[row.sessionId] = {
                      state: row.view?.state ?? "idle",
                      projectId: result.projectId,
                    };
                  }
                }
                const next = {
                  threads,
                  projects: active.map((/** @type {any} */ project) => project.id),
                };
                const items = diffAttention(previous.current, next);
                previous.current = next;
                const counts = summarize(items);
                const parts = [];
                if (counts.failed > 0)
                  parts.push(text(t, "notify.failed", { count: counts.failed }));
                if (counts.waiting > 0)
                  parts.push(text(t, "notify.waiting", { count: counts.waiting }));
                const line = parts.join(" · ");
                if (line !== "") setNotice({ text: line, at: Date.now() });
              });
            },
            () => {},
          );
        };
        tick();
        const timer = setInterval(tick, 5000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [api]);

      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 8000);
        return () => clearTimeout(timer);
      }, [notice]);

      return h(
        "div",
        { "data-projects-notifier": "", style: { display: "contents" } },
        notice
          ? h(
              "div",
              {
                role: "status",
                "data-projects-toast": "",
                style: {
                  position: "fixed",
                  right: "16px",
                  bottom: "16px",
                  zIndex: 60,
                  maxWidth: "320px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: `1px solid ${T.border}`,
                  background: T.bg,
                  color: T.text,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
                  fontSize: "13px",
                  cursor: "pointer",
                },
                onClick: () => {
                  setNotice(null);
                  if (typeof props.onOpen === "function") props.onOpen();
                },
              },
              notice.text,
            )
          : null,
      );
    }

    /** 与 lib/notify.js 同源的实现（client 半不能 import，逻辑保持逐行一致）。 */
    /**
     * @param {any} previous @param {any} next
     */
    function diffAttention(previous, next) {
      const before = previous?.threads ?? {};
      const after = next?.threads ?? {};
      const out = [];
      for (const sessionId of Object.keys(after)) {
        const entry = after[sessionId];
        const was = before[sessionId]?.state;
        if (entry.state === "failed" && was !== "failed") {
          out.push({ kind: "failed", projectId: String(entry.projectId || ""), sessionId });
        } else if (entry.state === "waiting-user" && was !== "waiting-user") {
          out.push({ kind: "waiting-user", projectId: String(entry.projectId || ""), sessionId });
        }
      }
      return out;
    }

    /**
     * 只统计条数；文案由调用方用 locale 拼（client 半不应出现硬编码语言文案）。
     * @param {any[]} items
     */
    function summarize(items) {
      const list = Array.isArray(items) ? items : [];
      return {
        failed: list.filter((item) => item.kind === "failed").length,
        waiting: list.filter((item) => item.kind === "waiting-user").length,
      };
    }

    /** 侧栏图标入口：宿主会传 {size, active}。 */
    /** @param {any} props */
    function ProjectsPanelIcon(props) {
      var size = props?.size ? props.size : 16;
      return h(
        "span",
        {
          "data-projects-nav-icon": "",
          style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: size,
            height: size,
            fontSize: size - 2,
            lineHeight: 1,
            color: props?.active ? T.accentText : "inherit",
          },
          "aria-hidden": "true",
        },
        "▦",
      );
    }

    /**
     * 设置分节：诊断 + 数据根。
     * @param {{api: any, t: any}} props
     */
    /** 六个危险开关的键（与 lib/store.js 的 DEFAULT_DANGER 一致）。 */
    var DANGER_KEYS = [
      "forcePushOwnBranch",
      "pushProtectedBranch",
      "autoMerge",
      "trashAuto",
      "purgeAfterRetention",
      "editProfile",
    ];

    /**
     * 危险开关：默认全关，每项带一句风险说明。打开需要用户明确勾选。
     * @param {{t: any, policy: any, onChange: (patch: any) => void}} props
     */
    function DangerSwitches(/** @type {any} */ props) {
      const t = props.t;
      const danger = props.policy?.danger ?? {};
      return h(
        "details",
        { "data-projects-policy-danger": "" },
        h(
          "summary",
          { style: { cursor: "pointer", color: T.dim } },
          text(t, "settings.dangerTitle"),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" } },
          h("div", { style: { color: T.faint, fontSize: "12px" } }, text(t, "settings.dangerHint")),
          DANGER_KEYS.map((key) =>
            h(
              "label",
              {
                key: key,
                style: { display: "flex", gap: "6px", alignItems: "flex-start", color: T.dim },
              },
              h("input", {
                type: "checkbox",
                checked: danger[key] === true,
                "data-projects-danger-switch": key,
                onChange: (/** @type {any} */ event) =>
                  props.onChange({ danger: { ...danger, [key]: event.target.checked } }),
              }),
              h(
                "span",
                null,
                text(t, `settings.danger.${key}.label`) +
                  " — " +
                  text(t, `settings.danger.${key}.risk`),
              ),
            ),
          ),
        ),
      );
    }

    function ProjectsSettings(/** @type {any} */ props) {
      var api = props.api;
      var t = props.t;
      var state = useState({
        loading: true,
        describe: null,
        error: null,
        projects: [],
        selectedId: "",
      });
      var view = state[0];
      var setView = state[1];

      var reload = useCallback(() => {
        Promise.all([call(api.ctx, "describe"), call(api.ctx, "listProjects")]).then(
          (values) => {
            var projects = Array.isArray(values[1]) ? values[1] : [];
            setView((/** @type {any} */ prev) => ({
              loading: false,
              describe: values[0] || null,
              error: null,
              projects: projects,
              selectedId: prev.selectedId || (projects[0] ? projects[0].id : ""),
            }));
          },
          (error) => {
            setView((/** @type {any} */ prev) => ({
              ...prev,
              loading: false,
              describe: null,
              error: String(error?.message ?? error),
            }));
          },
        );
      }, [api, setView]);

      useEffect(() => {
        reload();
      }, [reload]);

      var applyPolicy = useCallback(
        (/** @type {any} */ patch) => {
          var selected = view.projects.find(
            (/** @type {any} */ project) => project.id === view.selectedId,
          );
          if (!selected) return;
          var nextPolicy = { ...selected.policy, ...patch };
          call(api.ctx, "updateProject", { id: selected.id, patch: { policy: nextPolicy } }).then(
            () => reload(),
            (error) =>
              setView((/** @type {any} */ prev) => ({
                ...prev,
                error: String(error?.message ?? error),
              })),
          );
        },
        [api, reload, setView, view.projects, view.selectedId],
      );

      var describe = view.describe;
      return h(
        "div",
        { style: { color: T.text, fontSize: "13px" }, "data-projects-settings": "" },
        h(
          "div",
          { style: styles.summary, "data-projects-settings-summary": "" },
          describe
            ? text(t, "settings.summary", { count: describe.projectCount })
            : text(t, "settings.unavailable"),
        ),
        view.error ? h("div", { style: styles.error }, view.error) : null,
        describe
          ? h(
              "div",
              { style: { marginTop: "6px", color: T.dim }, "data-projects-settings-root": "" },
              `${text(t, "settings.dataRoot")}: ${describe.dataRoot}`,
            )
          : null,
        h("div", { style: { marginTop: "6px", color: T.faint } }, text(t, "settings.hint")),
        (() => {
          var selectedForDanger = view.projects.find(
            (/** @type {any} */ project) => project.id === view.selectedId,
          );
          if (!selectedForDanger) return null;
          return h(DangerSwitches, {
            t: t,
            policy: selectedForDanger.policy,
            onChange: applyPolicy,
          });
        })(),

        h(
          "details",
          { style: { marginTop: "8px" }, "data-projects-policy": "" },
          h(
            "summary",
            { style: { cursor: "pointer", color: T.dim } },
            text(t, "settings.policyTitle"),
          ),
          view.projects.length === 0
            ? h("div", { style: { color: T.faint } }, text(t, "settings.noProjects"))
            : h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" },
                },
                h(
                  "select",
                  {
                    style: styles.input,
                    value: view.selectedId,
                    "data-projects-policy-project": "",
                    onChange: (/** @type {any} */ event) =>
                      setView((/** @type {any} */ prev) => ({
                        ...prev,
                        selectedId: event.target.value,
                      })),
                  },
                  view.projects.map((/** @type {any} */ project) =>
                    h("option", { key: project.id, value: project.id }, project.name),
                  ),
                ),
                (() => {
                  var selected = view.projects.find(
                    (/** @type {any} */ project) => project.id === view.selectedId,
                  );
                  if (!selected) return null;
                  return h(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                    h(
                      "label",
                      { style: { display: "flex", gap: "8px", alignItems: "center" } },
                      h(
                        "span",
                        { style: { color: T.dim, flex: "none" } },
                        text(t, "settings.autonomy"),
                      ),
                      h(
                        "select",
                        {
                          style: styles.input,
                          value: selected.policy?.autonomy ?? "L1",
                          "data-projects-policy-autonomy": "",
                          onChange: (/** @type {any} */ event) =>
                            applyPolicy({ autonomy: event.target.value }),
                        },
                        ["L0", "L1", "L2", "L3"].map((level) =>
                          h(
                            "option",
                            { key: level, value: level },
                            `${level} — ${text(t, `settings.level.${level}`)}`,
                          ),
                        ),
                      ),
                    ),
                    h("input", {
                      style: styles.input,
                      value: selected.policy?.persona ?? "",
                      placeholder: text(t, "settings.persona"),
                      "data-projects-policy-persona": "",
                      // 非受控输入：切换项目时必须重挂载，否则显示的是上一个项目的人格
                      key: `persona-${selected.id}`,
                      // 不逐字提交：每敲一个字符就写一次 projects.json，
                      // 输入长人格时会触发几十次磁盘写。改成失焦/回车时才提交。
                      defaultValue: selected.policy?.persona ?? "",
                      onBlur: (/** @type {any} */ event) => {
                        if (event.target.value !== (selected.policy?.persona ?? "")) {
                          applyPolicy({ persona: event.target.value });
                        }
                      },
                      onKeyDown: (/** @type {any} */ event) => {
                        if (event.key === "Enter") event.target.blur();
                      },
                    }),
                    h(
                      "label",
                      {
                        style: { display: "flex", gap: "6px", alignItems: "center", color: T.dim },
                      },
                      h("input", {
                        type: "checkbox",
                        checked: selected.policy?.routing?.fallback !== false,
                        "data-projects-policy-fallback": "",
                        onChange: (/** @type {any} */ event) =>
                          applyPolicy({
                            routing: {
                              ...(selected.policy?.routing ?? {}),
                              fallback: event.target.checked,
                            },
                          }),
                      }),
                      text(t, "settings.fallback"),
                    ),
                  );
                })(),
              ),
        ),
      );
    }

    exports.inject = ["slots", "locale", "connection"];
    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      var c = /** @type {any} */ (ctx);
      c.effect(() => c.locale.register(NS, { zh: ZH, en: EN }), "projects: dictionaries");
      var t = c.locale.bind(NS);
      /** 给组件用的句柄：组件里拿不到 ctx，统一从这里取。 */
      var api = { ctx: c, t: t };

      c.effect(
        () =>
          c.slots.inject("main", () =>
            c.slots.register(
              {
                name: "main",
                key: PANEL_ID,
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              ProjectsPanelSafe,
            ),
          ),
        "projects: main panel",
      );

      c.effect(
        () =>
          c.slots.inject("sidebar.panellist", () =>
            c.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 10,
                label: () => text(t, "panel.title"),
                locale: NS,
              },
              ProjectsPanelIcon,
            ),
          ),
        "projects: nav entry",
      );

      c.effect(
        () =>
          c.slots.inject("sidebar.workspaces.session.menu.item", () =>
            c.slots.register(
              {
                name: "sidebar.workspaces.session.menu.item",
                id: PANEL_ID,
                order: 430,
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              AttachToProjectMenu,
            ),
          ),
        "projects: session menu",
      );

      c.effect(
        () =>
          c.slots.inject("shell.overlay", () =>
            c.slots.register(
              {
                name: "shell.overlay",
                id: "projects-notifier",
                order: 60,
                locale: NS,
                inject: () => ({ api: api, t: t, onOpen: () => c.selectPanel(PANEL_ID) }),
              },
              ProjectsNotifier,
            ),
          ),
        "projects: notifier",
      );

      c.effect(
        () =>
          c.slots.inject("settings.section", () =>
            c.slots.register(
              {
                name: "settings.section",
                id: PANEL_ID,
                order: 93,
                label: () => text(t, "settings.section"),
                locale: NS,
                inject: () => ({ api: api, t: t }),
              },
              ProjectsSettings,
            ),
          ),
        "projects: settings card",
      );
    };

    return module.exports;
  },
});
