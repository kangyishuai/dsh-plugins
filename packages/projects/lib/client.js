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
      "panel.empty": "还没有项目。",
      "panel.createPlaceholder": "项目名，例如 payments-api",
      "panel.retry": "重试",
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
      "settings.nav.general": "通用",
      "settings.nav.memory": "记忆",
      "settings.nav.usage": "用量",
      "settings.nav.debug": "调试",
      "settings.sectionTitle": "设置分区",
      "settings.budget": "预算（日线程 / 并发 / 步数 / token）",
      "settings.autoRetry": "失败自动重试（最多 2 次）",
      "settings.autoRetryHint":
        "线程以失败结束时，60 秒后自动再发一句「继续」；累计最多 2 次（不因中间恢复清零）。这不是「用量恢复续跑」。",
      "settings.budgetSave": "保存预算",
      "settings.budgetSaved": "预算已保存：{budget}",
      "settings.budgetUnlimited": "不限",
      "settings.memoryTitle": "记忆与指令",
      "settings.memoryInstructions": "指令 {used}/{limit}「更新于 {updated}」",
      "settings.memoryIndexUpdated": "记忆索引更新于 {updated}",
      "settings.memoryNever": "从未",
      "settings.memoryFilesEmpty": "记忆目录里还没有文件",
      "settings.memoryCounts":
        "指令 {instructions} 字符 · 记忆索引 {memory} 字符 · 碎片 {fragments} 个",
      "settings.memoryTemplate": "补全项目模板（AGENTS.md 受管区块）",
      "settings.memoryTemplateDone": "模板已写入：{path}",
      "settings.usageTitle": "用量",
      "settings.usageNote": "宿主没有价目 API：这里只统计 token 与上下文占用，不显示金额。",
      "settings.usageTokens": "今日 {today} tokens · 近 7 天 {total} tokens",
      "settings.usageContext":
        "上下文：指令 {instructions} 字符 · 记忆 {memory} 字符 · 碎片 {fragments} 个",
      "settings.usageThreads":
        "线程 {total} 个 · 今日新建 {today} 个 · 在跑 {working} · 等你 {waiting}",
      "settings.usageEmpty": "还没有可统计的用量。",
      "settings.debugTitle": "Debug access",
      "settings.debugRows": "项目 {projects} · 活跃 {active} · 已挂上下文 {attached} 个会话",
      "settings.auditTitle": "审计（最近 {count} 条）",
      "settings.ghCheck": "检查 GitHub 连接",
      "settings.ghChecking": "检查中…",
      "settings.ghOk": "GitHub：{message}",
      "settings.ghFail": "GitHub：{message}（{hint}）",
      "settings.notifyTitle": "通知（按项目）",
      "settings.notifyFailed": "失败",
      "settings.notifyWaiting": "等你",
      "settings.notifyCompleted": "完成",
      "settings.notifyTier.all": "全部（含每条线程回复）",
      "settings.notifyTier.coordinator": "协调者与 @提及（默认）",
      "settings.notifyTier.waiting": "仅等我处理的",
      "settings.notifyTier.none": "不通知",
      "settings.notifyTier.custom": "自定义",
      "settings.notifyTierHint": "「全部」会包含每条线程的回复，通知会更频繁。",
      "settings.notifySaved": "通知开关已保存",
      "detail.goalCounter": "{count} / 8,000",
      "detail.fragmentsTitle": "记忆碎片（独立文件）",
      "detail.fragmentAdd": "新增碎片",
      "detail.fragmentTitlePlaceholder": "碎片标题，例如 部署注意事项",
      "detail.fragmentTextPlaceholder": "写一段就够：模型需要细节时会读这个文件",
      "detail.fragmentAdded": "已新增碎片 {slug}",
      "detail.fragmentForget": "忘掉",
      "detail.fragmentForgotten": "已忘掉",
      "detail.fragmentPreview": "预览",
      "detail.fragmentEmpty": "还没有碎片。加一条，让记忆从「一段话」变成「可检索的文件」。",
      "detail.entriesTitle": "记忆条目",
      "detail.entriesEmpty": "还没有记忆条目。",
      "detail.entryForget": "忘掉这条",
      "b3.envMachine": "运行位置：{value}",
      "b3.envMachineLocal": "本机（线程各有隔离 worktree）",
      "b3.envMachineNoDir": "本机（还没有绑定项目目录）",
      "b3.envRepos": "仓库：{count} 个",
      "b3.envAllowed": "免询问文件夹：{count} 个（{names}）",
      "b3.envAllowedEmpty": "免询问文件夹：还没有（授权卡里选「设为默认」才会进这个名单）",
      "b3.folderTitle": "本地文件夹授权",
      "b3.folderCopy": "Claude 可以在你选择的文件夹里运行命令，不再逐次询问。",
      "b3.folderDeny": "拒绝",
      "b3.folderDefault": "设为默认目录",
      "b3.folderOnce": "允许一次",
      "b3.folderUnset": "还没授权",
      "b3.folderDefaultTag": "默认目录",
      "b3.folderDeniedTag": "已拒绝",
      "b3.folderOnceUsed": "一次性凭据已用掉",
      "b3.folderSaved": "已记录：{decision}",
      "b3.folderNoDir": "先在「项目目录」里绑定一个文件夹，再授权。",
      "b3.folderAdd": "添加目录",
      "b3.folderAddHint": "在「项目目录」里新增一个工作目录",
      "b3.modelTitle": "线程默认模型",
      "b3.coordinatorTitle": "协调者默认模型",
      "b3.coordinatorModel": "协调者模型",
      "b3.coordinatorEffort": "协调者推理强度",
      "b3.coordinatorSaved": "协调者默认模型已保存",

      "b3.model": "线程模型",
      "b3.effort": "推理强度",
      "b3.modelInherit": "继承宿主默认",
      "b3.modelSave": "保存默认",
      "b3.modelSaved": "线程默认模型已保存",
      "b3.modelUnavailable": "宿主没有暴露模型目录",
      "b3.modelManual": "provider|model（手填）",
      "b3.effortManual": "effort（手填）",
      "b3.modelManualToggle": "手填模型 / effort",
      "b3.modelManualHint": "目录不可用时手填；保存写的就是这两个值。",
      "b3.sessionsTitle": "从会话开线程",
      "b3.sessionsLoad": "列出最近会话",
      "b3.sessionsAttach": "挂为线程",
      "b3.sessionsEmpty": "没有可挂的最近会话。",
      "b3.sessionsAttached": "已挂为线程：{id}",
      "b3.mentionTitle": "@ 提及",
      "b3.mentionRegistered": "@ 源已注册（列本项目的线程与项目名）",
      "b3.mentionUnavailable": "@ 源不可用（本部署没有 inputTriggers）",
      "b3.fragAdd": "新增碎片",
      "b3.fragTitlePh": "碎片标题",
      "b3.fragTextPh": "写一段就够；模型需要细节时会读这个文件",
      "b3.fragAdded": "已新增碎片：{slug}",
      "b3.fragForget": "忘掉",
      "b3.fragPreview": "预览",
      "b3.fragEmpty": "还没有碎片。",
      "b3.fragLimit": "{count} / {limit} 个碎片",
      "b3.entriesTitle": "索引条目（MEMORY.md）",
      "b3.entriesEmpty": "还没有索引条目。",
      "b3.entryForget": "忘掉这条",
      "b3.threadActions": "线程动作",
      "b3.actionRename": "重命名",
      "b3.actionUnread": "标记未读",
      "b3.actionResolve": "解决",
      "b3.actionReopen": "重开",
      "b3.actionCopy": "复制 ID",
      "b3.actionReclaim": "回收目录",
      "b3.actionDetach": "移除追踪",
      "b3.renamePlaceholder": "线程标题",
      "b3.renameSave": "保存",
      "b3.renamed": "已重命名",
      "b3.copied": "已复制 ID",
      "b3.actionDone": "已完成",
      "notify.completed": "{count} 个线程完成了",
      "detail.coordinator": "协调者",
      "detail.coordinatorEmpty": "还没有对话。线程跑完后它会在这里向你汇报。",
      "detail.coordinatorPlaceholder": "跟协调者说一句话，例如「帮我看下 CI 为什么红」",
      "detail.coordinatorSend": "发送",
      "detail.coordinatorSending": "发送中…",
      "detail.coordinatorRestart": "重开会话",
      "detail.coordinatorRestarted": "已重开会话（旧会话保留，可追溯）",
      "detail.coordinatorCreate": "建协调者",
      "detail.coordinatorCreated": "协调者会话已就绪",
      "detail.coordinatorMsgSent": "已发送给协调者",
      "detail.coordinatorFold": "更早的 {count} 条协调者消息",
      "detail.coordinatorFoldHide": "收起更早的消息",
      "detail.coordinatorConclusion": "结论",
      "detail.coordinatorCompactionYes": "自动压缩可用（{mode}）",
      "detail.coordinatorCompactionNo":
        "本部署没有 compaction：协调者上下文不会自动压缩（会一直累积）",
      "detail.threadExpand": "展开",
      "detail.threadCollapse": "收起",
      "detail.tasks": "任务",
      "detail.tasksNone": "还没有任务清单（模型写 todo 后出现）",
      "detail.tasksCount": "{done}/{total}",
      "detail.steer": "插话",
      "detail.steerPlaceholder": "给这个线程插一句（steering）",
      "detail.steered": "已插话（线程在跑，立即生效）",
      "detail.steeredQueued": "已插话（线程没在跑，宿主会排队）",
      "detail.model": "模型",
      "detail.modelNone": "这个部署没暴露模型目录",
      "detail.modelSave": "应用",
      "detail.modelSaved": "已切到 {model}",
      "detail.modelSavedEffort": "已切到 {model} / effort {effort}",
      "detail.effort": "推理强度",
      "detail.effortInherit": "继承默认",
      "detail.modelSelection": "宿主回读：{selection}",
      "detail.threadConflict": "这个会话已经在别的项目里：先从这个项目移除，再挂到目标项目。",
      "detail.autofix": "修一轮 CI",
      "detail.autofixHint": "只在 CI 失败时可用；只改本地 worktree，不 push、不开 PR。",
      "detail.autofixDisabled": "当前没有失败的 CI，无需手动修。",
      "detail.autofixRunning": "正在投递修复任务…",
      "detail.autofixStarted": "已投递修复任务（第 {round} 轮，结论回读 {reason}）",
      "detail.autofixStopped": "没有继续修：{reason}",
      "detail.prBarDismiss": "收起创建 PR 条",
      "detail.prCreate": "创建 PR",
      "detail.prCreating": "正在开 PR…",
      "detail.prCreated": "已开 PR #{number}",
      "detail.prFailed": "开 PR 失败：{reason}",
      "detail.prBranch": "分支 {branch}",
      "detail.prCi": "CI {state}",
      "detail.noBranch": "还没有分支（线程还没产出提交）",
      "detail.ci.passing": "通过",
      "detail.ci.failing": "失败",
      "detail.ci.pending": "进行中",
      "detail.ci.none": "无检查",
      "detail.paramIsolated": "隔离 worktree",
      "detail.paramShared": "共享目录",
      "detail.paramNoDir": "未绑定目录",
      "detail.approvalHint": "审批在协调器/线程里产生；这条线程的申请会出现在对话流上方的审批区。",
      "settings.restartRow": "重开协调器会话",
      "settings.restartHint":
        "丢掉当前协调器会话并重开一个（旧会话保留可追溯）；当前那条回复会丢。",
      "settings.restartDone": "已重开（旧会话 {previous}…）",
      "settings.realtimeCi": "实时监听 CI/PR（未实现）",
      "settings.realtimeCiHint":
        "未实现：需要 `gh webhook forward`（gh-webhook 扩展）与仓库管理员权限，并要校验 webhook 签名；当前只有 30–90s 轮询，开关不会启动任何东西。",
      "settings.realtimeCiOn": "未实现（不会建 webhook）",
      "settings.realtimeCiOff": "未实现，只有默认轮询",
      "settings.pollState": "PR 轮询：{state} · 上次 {at} · 间隔 {delay}s",
      "settings.pollRunning": "运行中",
      "settings.pollStopped": "已停",
      "menu.attach": "归属到项目…",
      "menu.loading": "加载中…",
      "menu.empty": "还没有项目，先在项目面板里建一个",
      "detail.back": "返回",
      "detail.loading": "加载中…",
      "detail.tab.threads": "线程 ({count})",
      "detail.tab.memory": "记忆",
      "detail.tab.library": "Library",
      "detail.tab.views": "视图",
      "views.title": "视图可见性",
      "views.hint": "关掉不需要的视图，右栏就只显示你常用的那几个。",
      "views.savedTitle": "已保存的筛选视图",
      "views.savedEmpty": "还没有保存的视图。用一个筛选条件 + 名字就能存一个。",
      "views.apply": "套用",
      "views.delete": "删除",
      "views.addHint": "保存的是「状态筛选 + 关键词」，不是结果快照。",

      "detail.threadsEmpty":
        "在下面输入框派个任务，回车即可新建线程；也可以用「…」菜单把已有会话归属进来。",
      "detail.noDirHint":
        "还没有绑定项目目录：线程会跑在插件的数据目录里（不隔离，也不便接手你的仓库）。建议先在「项目设置 → 环境 → 项目目录」里绑定一个 git 仓库，线程才会各占一个 worktree。",
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
      "detail.rowSub.using": "✓✓✓ 使用 {tool}",
      "detail.rowSub.action": "正在：{text}",
      "detail.working.verbs": "酝酿中|推进中|梳理中|核对中|起草中|推演中",
      "detail.rowSub.working": "正在处理…",
      "detail.rowSub.question": "等你回复：{text}",
      "detail.rowSub.result": "已完成",
      "detail.rowSub.failed": "上一轮失败了，点开看原因",
      "detail.rowSub.review": "等你审阅",
      "detail.rowSub.archived": "已归档",
      "detail.state.waiting-user": "待你处理",
      "detail.state.failed": "失败",
      "detail.state.working": "进行中",
      "detail.state.done": "已完成",
      "detail.state.idle": "空闲",
      "detail.diag.workspaceBound": "工作区已绑定",
      "detail.diag.workspaceUnbound": "工作区未绑定",
      "detail.diag.coordinatorReady": "协调者在线",
      "detail.diag.coordinatorEmpty": "协调者未建",
      "detail.diag.pollRunning": "PR 轮询中",
      "detail.diag.pollStopped": "PR 轮询停",
      "detail.diag.details": "详情",
      "detail.mainWelcomeTitle": "欢迎回来。",
      "detail.mainWelcomeBody":
        "把项目当成一段持续对话：直接问、让它协调几条线程并行推进；线程跑完会把结论汇报到这里。",
      "detail.composerHintCoordinator": "回车发送给协调者",
      "detail.composer.targetThread": "新线程",
      "detail.composer.targetCoordinator": "协调者",
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
      "detail.threadRemovedWithWorktree": "已移除追踪（worktree 仍在磁盘：{path}）",
      "detail.threadPromptFailed": "线程已建，但首条任务没送达：{reason}",
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
      "detail.routeToggle": "按规则派活",
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
        "只清理本项目回收站里超过保留期的条目；先预览，再确认。需要在「项目设置 → 调试 → 危险动作开关」里打开「清理过期的回收站条目」。",
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
      "routines.freq.manual": "手动（不自动跑）",
      "routines.freq.hourly": "每小时",
      "routines.freq.daily": "每天",
      "routines.freq.weekdays": "工作日（周一至周五）",
      "routines.freq.weekly": "每周",
      "routines.freq.monthly": "每月",
      "routines.weekday.sun": "周日",
      "routines.weekday.mon": "周一",
      "routines.weekday.tue": "周二",
      "routines.weekday.wed": "周三",
      "routines.weekday.thu": "周四",
      "routines.weekday.fri": "周五",
      "routines.weekday.sat": "周六",
      "routines.formTitle": "新建定时任务",
      "routines.name": "名字",
      "routines.namePlaceholder": "例如：每日站会摘要",
      "routines.instructions": "指令",
      "routines.instructionsLabel": "指令（到点后作为提示词投递，会跑一次模型）",
      "routines.instructionsPlaceholder": "例如：总结昨天合并的 PR，列出需要我确认的点。",
      "routines.frequency": "频率",
      "routines.time": "时间（HH:mm）",
      "routines.weekday": "星期几",
      "routines.dayOfMonth": "每月几号（1–28）",
      "routines.create": "创建",
      "routines.creating": "正在创建…",
      "routines.manualHint": "手动档：只有点 Run now 才跑（也会花一次模型调用）",
      "routines.autoHint": "自动投递：到点会跑一次模型",
      "routines.costHint": "每次到点投递都会跑一次模型（会花 token）。",
      "routines.empty": "还没有定时任务。用上面的表单建一个；手动档不会自己跑。",
      "routines.scheduleUnavailablePrefix": "宿主的 schedule 服务不可用（",
      "routines.scheduleUnavailableSuffix": "），定时任务无法创建。",
      "routines.trigger": "触发",
      "routines.runsOn": "运行于",
      "routines.edit": "编辑",
      "routines.disabled": "已停用",
      "routines.detail": "详情",
      "routines.retention": "宿主保留：{days} 天 / {records} 条",
      "routines.retentionDays": " 天",
      "routines.retentionRecords": " 条",
      "routines.deliveryNote": "会真的投递一次（= 一次模型调用）",
      "routines.historyEmpty": "还没有投递过",
      "routines.historyNone": "宿主侧还没有投递记录（History 只显示真实的投递）。",
      "routines.enable": "启用",
      "routines.disable": "停用",
      "routines.switch": "切换",
      "routines.delete": "删除",
      "routines.save": "保存",
      "routines.update": "更新",
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
      "detail.autoResolve": "自动 resolve",
      "detail.autoResolveOff": "关",
      "detail.autoResolveDays": "{days} 天无活动",
      "detail.projectState": "项目状态",
      "detail.save": "保存",
      "detail.edit": "编辑",
      "detail.none": "未设置",
      "detail.trashCount": "{count} 项",
      "detail.trashNone": "空",
      "detail.grantsLabel": "仓库授权",
      "detail.purgeLabel": "清理",
      "detail.trashLabel": "回收站",
      "detail.projectState.active": "进行中",
      "detail.projectState.paused": "已暂停",
      "detail.projectState.archived": "已归档",
      "detail.purged": "已清理 {count} 项，清单已写入 trash/",
      "detail.archivedLabel": "归档时间",
      "detail.carousel": "{index}–{total} of {total}",
      "detail.carouselPreview": "预览",
      "detail.carouselPreviewHint": "展开当前这条线程",
      "detail.carouselNext": "下一条",
      "detail.carouselPrev": "上一条",
      "detail.dirLimit": "最多 {count} 个目录（已加 {used} 个）",
      "detail.dirRemove": "移除目录",
      "detail.durationDays": "{days} 天",
      "detail.durationHours": "{hours} 小时",
      "detail.durationMinutes": "{minutes} 分钟",
      "detail.panelSearch": "搜索线程",
      "detail.emptySearch": "没有匹配的线程。",
      "detail.emptyOverview": "没有在等你的事。",
      "detail.groupCollapseAll": "全部折叠",
      "detail.addView": "新增视图",
      "detail.today": "今天",
      "detail.threadTask": "任务：{task}",
      "detail.threadRemind": "加一个提醒（30 分钟后）",
      "detail.threadReminderText": "回看线程：{title}",
      "detail.threadReminderAdded": "已加提醒：30 分钟后",
      "detail.threadReminderFailed": "加提醒失败：{reason}",
      "detail.slash.memory": "打开记忆",
      "detail.slash.routines": "打开定时任务",
      "detail.slash.settings": "打开项目设置",
      "detail.slash.clear": "清除筛选与搜索",
      "detail.workingLine": "{count} 个线程在跑，完成后协调者会在这里汇报。",
      "detail.settingsPane.general": "通用",
      "detail.settingsPane.memory": "记忆",
      "detail.settingsPane.environment": "环境",
      "detail.settingsPane.usage": "用量",
      "detail.settingsPane.debug": "调试",
      "detail.settingsEnvHint":
        "环境设置（项目目录 / 仓库授权 / 本地文件夹授权 / 清理）已在本分区。",
      "detail.settingsDebugHint":
        "更细的调试项（危险动作开关 / 线程权限 / 审计）已在本分区；完整设置的「项目 → 调试」里还有更多。",
      "detail.settingsOpenFull": "打开完整设置",

      "detail.prCard.merge": "合并 ⏎",
      "detail.prCard.mergeArmed": "再点一次确认合并",
      "detail.prCard.mergeHint": "点两次确认（squash + 删除分支）",
      "detail.prCard.mergeOff": "需要先打开「允许自动合并 PR」危险开关",
      "detail.prCard.mergeOk": "已合并 #{number}",
      "detail.prCard.mergeFail": "合并失败：{reason}",
      "detail.prCard.copy": "复制链接",
      "detail.prCard.copied": "PR 链接已复制",
      "detail.prCard.loading": "读取 PR 信息…",
      "detail.prCard.unavailable": "读不到 PR",
      "detail.prCard.actionsMissing": "Review 打开外链不可用；Merge 需先在危险开关里开启",
      "detail.prOpen": "已开",
      "artifacts.viewerOpen": "查看",
      "artifacts.viewerClose": "关闭",
      "artifacts.viewerLoading": "读取产物内容…",
      "artifacts.viewerError": "读不到产物内容",
      "library.artifactPinHint": "钉住（待接入）",
      "library.artifactMenuHint": "更多（待接入）",
      "detail.groupReorderHint": "拖拽排序（待接入）",
      "detail.composerAttach": "添加附件（待接入）",
      "detail.composerMic": "语音输入（待接入）",
      "detail.composerModel": "模型：{model}",
      "detail.composerHint": "输入「/」调出命令",
      "detail.composerModelHint": "改的是项目的线程默认模型（等同设置里的「线程默认模型」）",
      "detail.composerModelMenuTitle": "线程默认模型",
      "detail.coordinatorModelHint": "协调者默认模型（与线程默认独立）",
      "detail.coordinatorModelMenuTitle": "协调者默认模型",
      "detail.effortPlaceholder": "推理强度（可空）",
      "detail.composerModelSave": "保存",
      "detail.composerModelInherit": "继承宿主默认",
      "detail.settingsOpen": "项目设置",
      "detail.settingsTitle": "项目设置",
      "detail.settingsClose": "关闭设置",
      "detail.addViewHint": "把当前筛选条件保存成视图",
      "detail.viewNamePlaceholder": "视图名（例如「在跑」）",
      "detail.viewSave": "保存",
      "detail.viewCancel": "取消",
      "detail.viewDelete": "删除这个视图",
      "detail.viewSaveFailed": "保存视图失败：{reason}",
      "detail.groupExpandAll": "全部展开",
      "detail.groupMenu": "分组操作",
      "detail.groupOnly": "只看这一组",
      "detail.markRead": "标记已读",
      "detail.markUnread": "标记未读",
      "detail.notificationCount": "{count} 条待处理",
      "detail.overview": "总览",
      "detail.bellTitle": "{count} 条需要你处理（等你/失败）",
      "detail.pillAll": "全部",
      "detail.pillClear": "清除过滤",
      "detail.pillWorkingEta": "~{minutes}m",
      "detail.prBadge": "#{number}",
      "detail.remove": "移除",
      "detail.reopen": "重开",
      "detail.reopened": "已重开",
      "detail.reposLabel": "关联仓库",
      "detail.resolve": "标记已解决",
      "detail.resolved": "已标记解决（可重开）",
      "detail.settings": "项目设置",
      "detail.settingsHint": "插件设置入口在宿主「设置 → 插件 → 项目」里。",
      "detail.sparkCaption": "近 7 天",
      "detail.sparkHint": "最近 7 天的 token 用量",
      "detail.steps": "{done}/{total}",
      "detail.tasksPopover": "任务 · {done}/{total}",
      "detail.tasksPopoverMore": "还有 {count} 条",
      "detail.rowArtifacts": "产物",
      "detail.rowArtifactsMore": "+{count}",
      "detail.stepsHint": "这个线程还没有任务清单（todo）；没有就不显示比例。",
      "detail.stepsNone": "—",
      "detail.switch": "切换项目",
      "detail.switchEmpty": "没有其它项目",
      "detail.welcome": "欢迎回来，{name}。",
      "detail.welcomeAnon": "欢迎回来。",
      "detail.welcomeCta": "派一件事",
      "detail.welcomeEmpty": "还没有线程",
      "detail.welcomeIdle": "没有在等你的事。",
      "detail.welcomeWaiting": "有 {count} 个线程在等你。",
      "detail.welcomeWorking": "有 {count} 个线程在跑。",
      "panel.archivedAt": "已归档 · {date}",
      "panel.firstRun.bullet1": "一段对话可以分叉成多条线程，各自独立推进。",
      "panel.firstRun.bullet2": "线程知道你的仓库、目录和常设指令，不用重复交代。",
      "panel.firstRun.bullet3": "后台线程会继续跑，你回来看结果就行。",
      "panel.firstRun.bullet4": "线程也可以跑在本机目录里，改的代码留在你的机器上。",
      "panel.firstRun.cta": "开始使用",
      "panel.firstRun.dismiss": "稍后再说",
      "panel.firstRun.title": "项目现在是一段对话",
      "panel.firstRun.intro":
        "每次回到这个项目，都是接着上一次的对话继续。需要并行推进时，就从对话里开几条线程。",
      "panel.firstRun.cloudNote": "（云端执行）",
      "panel.new.contextCount": "{dirs} 个目录 · {repos} 个仓库",
      "panel.new.contextLabel": "Context（目录 / 仓库）",
      "panel.new.contextLimit": "最多 {count} 个",
      "panel.new.dirAdd": "添加目录",
      "panel.new.iconLabel": "图标（可选）",
      "panel.new.invalidRepo": "仓库要写成 owner/repo",
      "panel.new.repoAdd": "添加仓库",
      "panel.new.repoPlaceholder": "owner/repo，例如 acme/api",
      "panel.rowUnread": "未读",
      "panel.unread": "{count} 条未读",
      "panel.waiting": "{count} 个在等你",
      "panel.working": "{count} 个在跑",
      "detail.state.resolved": "待你确认",
      "detail.state.archived": "已归档",
      "detail.pill.waiting-user": "等你",
      "detail.pill.failed": "失败",
      "detail.pill.working": "在跑",
      "detail.pill.resolved": "待你确认",
      "detail.pill.idle": "空闲",
      "detail.group.waiting-user": "等你",
      "detail.group.working": "在跑",
      "detail.group.resolved": "待你确认",
      "detail.group.idle": "空闲",
      "detail.group.archived": "已归档",
      "library.title": "产物库",
      "library.meter": "{count} 个产物 · {bytes}",
      "library.openPanel": "打开产物库",
      "library.openPanelHint": "用右侧的 artifacts 面板打开这个项目的产物库",
      "library.openPanelUnavailable": "打开失败：宿主未提供右栏面板服务（sidebarRight）。",
      "library.artifactsMissing": "产物库需要 dsh-artifacts 0.2；当前不可用，下面只列项目文件。",
      "library.artifactsTitle": "产物",
      "library.artifactsEmpty": "这个项目还没有产物。",
      "library.artifactMeta": "{kind} · v{version} · {when}",
      "library.artifactMetaNoTime": "{kind} · v{version}",
      "library.provenance": "来自会话 {session} · 调用 {call}",
      "library.timeUnknown": "时间未知",
      "library.kind.html": "页面",
      "library.kind.markdown": "Markdown",
      "library.kind.json": "JSON",
      "library.kind.csv": "CSV",
      "library.kind.image": "图片",
      "library.threadArtifacts": "这个线程的产物",
      "library.threadArtifactsMissing":
        "artifacts 未安装/版本不兼容：缩略图与预览不可用，只显示本地记录。",
      "library.filesTitle": "项目文件",
      "library.filesCount": "{count} 个文件",
      "library.colName": "名称",
      "library.colType": "类型",
      "library.colSize": "大小",
      "library.colUpdated": "更新",
      "library.filesEmpty": "这个目录里还没有文件。",
      "library.filesNoDir": "这个项目还没有绑定目录：先在「项目目录」里绑定一个文件夹，再看文件。",
      "library.filesNoSession":
        "还没有项目线程会话：文件面由宿主 workspaceFiles 按会话作用域提供，建一个线程或归属一个会话后才有。",
      "library.filesHostUnavailable":
        "这个部署没有 workspaceFiles 服务：文件面不可用（不伪造文件列表）。",
      "library.searchByNameOnly":
        "搜索只匹配文件名 / 路径，不搜正文（宿主 workspaceFiles.search 的边界）。",
      "library.searchPlaceholder": "按文件名搜索…",
      "library.search": "搜索",
      "library.searching": "搜索中…",
      "library.searchEmpty": "没有匹配的文件名。",
      "library.searchFailed": "搜索失败",
      "library.truncated": "已截断",
      "library.railOpen": "打开产物库",
      "library.railBack": "返回线程列表",
      "library.railHint": "项目文件与产物都在这里；搜索只匹配文件名，不搜正文。",
      "library.railSummary": "{files} 个文件 · {artifacts} 个产物",
      "library.railLoading": "打开查看",
      "b3.folderWorktreeHint":
        "merge 在项目目录里跑；push-branch 在线程 worktree 里跑——worktree 继承它所属项目目录的授权。",
    };
    var EN = {
      title: "Projects",
      "panel.title": "Projects",
      "panel.summary":
        "{projects} projects · {active} active · {threads} threads · {attached} sessions with context",
      "panel.empty": "No projects yet.",
      "panel.createPlaceholder": "Project name, e.g. payments-api",
      "panel.retry": "Retry",
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
      "detail.coordinator": "Coordinator",
      "detail.coordinatorEmpty": "No conversation yet. It reports here after a thread finishes.",
      "detail.coordinatorPlaceholder": 'Say one line to the coordinator, e.g. "why is CI red?"',
      "detail.coordinatorSend": "Send",
      "detail.coordinatorSending": "Sending…",
      "detail.coordinatorRestart": "Restart",
      "detail.coordinatorRestarted": "Session restarted (the old one is kept for audit)",
      "detail.coordinatorCreate": "Create coordinator",
      "detail.coordinatorCreated": "Coordinator session is ready",
      "detail.coordinatorMsgSent": "Sent to the coordinator",
      "detail.coordinatorFold": "{count} earlier coordinator messages",
      "detail.coordinatorFoldHide": "Hide earlier messages",
      "detail.coordinatorConclusion": "Conclusion",
      "detail.coordinatorCompactionYes": "Auto-compaction available ({mode})",
      "detail.coordinatorCompactionNo":
        "No compaction in this deployment: coordinator context will keep growing",
      "detail.threadExpand": "Expand",
      "detail.threadCollapse": "Collapse",
      "detail.tasks": "Tasks",
      "detail.tasksNone": "No task list yet (appears once the model writes todos)",
      "detail.tasksCount": "{done}/{total}",
      "detail.steer": "Steer",
      "detail.steerPlaceholder": "Steer this thread with one line",
      "detail.steered": "Steered (thread running, applied immediately)",
      "detail.steeredQueued": "Steered (thread idle, the host will queue it)",
      "detail.model": "Model",
      "detail.modelNone": "This deployment exposes no model catalog",
      "detail.modelSave": "Apply",
      "detail.modelSaved": "Switched to {model}",
      "detail.modelSavedEffort": "Switched to {model} / effort {effort}",
      "detail.effort": "effort",
      "detail.effortInherit": "inherit",
      "detail.modelSelection": "Host readback: {selection}",
      "detail.threadConflict":
        "This thread already belongs to another project. Remove it from that project first, then attach it here.",
      "detail.autofix": "Fix CI round",
      "detail.autofixHint":
        "Only when CI is failing; touches only the local worktree — no push, no PR.",
      "detail.autofixDisabled": "No failing CI right now, nothing to fix.",
      "detail.autofixRunning": "Queueing the fix task…",
      "detail.autofixStarted": "Fix task queued (round {round}, readback {reason})",
      "detail.autofixStopped": "Stopped fixing: {reason}",
      "detail.prBarDismiss": "Hide the create-PR bar",
      "detail.prCreate": "Create PR",
      "detail.prCreating": "Creating PR…",
      "detail.prCreated": "Opened PR #{number}",
      "detail.prFailed": "Create PR failed: {reason}",
      "detail.prBranch": "Branch {branch}",
      "detail.prCi": "CI {state}",
      "detail.noBranch": "No branch yet (no commits from this thread)",
      "detail.ci.passing": "passing",
      "detail.ci.failing": "failing",
      "detail.ci.pending": "pending",
      "detail.ci.none": "no checks",
      "detail.paramIsolated": "isolated worktree",
      "detail.paramShared": "shared dir",
      "detail.paramNoDir": "no dir",
      "detail.approvalHint":
        "Approvals are produced by the coordinator/thread; this thread's requests show up in the approval queue above.",
      "settings.restartRow": "Restart coordinator session",
      "settings.restartHint":
        "Drop the current coordinator session and open a new one (the old one is kept for audit); the reply in flight is lost.",
      "settings.restartDone": "Restarted (previous {previous}…)",
      "settings.realtimeCi": "Realtime CI/PR watch (not implemented)",
      "settings.realtimeCiHint":
        "Not implemented: it needs `gh webhook forward` (gh-webhook extension), repo admin rights and webhook signature checks; only the 30–90s poll exists, so this switch starts nothing.",
      "settings.realtimeCiOn": "Not implemented (creates no webhook)",
      "settings.realtimeCiOff": "Not implemented, polling only",
      "settings.pollState": "PR poll: {state} · last {at} · interval {delay}s",
      "settings.pollRunning": "running",
      "settings.pollStopped": "stopped",
      "menu.attach": "Add to project…",
      "menu.loading": "Loading…",
      "menu.empty": "No projects yet — create one in the Projects panel first",
      "detail.back": "Back",
      "detail.loading": "Loading…",
      "detail.tab.threads": "Threads ({count})",
      "detail.tab.memory": "Memory",
      "detail.tab.library": "Library",
      "detail.tab.views": "Views",
      "views.title": "Visible views",
      "views.hint": "Hide the views you don't need; the panel shows only the ones you use.",
      "views.savedTitle": "Saved filter views",
      "views.savedEmpty": "No saved views yet. Save one with a filter and a name.",
      "views.apply": "Apply",
      "views.delete": "Delete",
      "views.addHint": "A saved view stores the state filter and keyword, not a result snapshot.",

      "detail.threadsEmpty":
        "Type a task below and press Enter to start a thread; or use a session’s … menu to add it here.",
      "detail.noDirHint":
        "No project directory bound yet: threads run inside the plugin’s data directory (no isolation, and they cannot work on your repo). Bind a git repository above first — then each thread gets its own worktree.",
      "detail.threadState": "state: {state}",
      "detail.instructions": "Standing rules (instructions.md)",
      "detail.memoryIndex": "Memory index (MEMORY.md)",
      "detail.emptyFile": "(empty)",
      "detail.auditEmpty": "No audit entries yet.",
      "detail.rowSub.using": "✓✓✓ Using {tool}",
      "detail.rowSub.action": "Working: {text}",
      "detail.working.verbs": "Ruminating|Billowing|Moonwalking|Pondering|Drafting|Sifting",
      "detail.rowSub.working": "Working…",
      "detail.rowSub.question": "Waiting on you: {text}",
      "detail.rowSub.result": "Done",
      "detail.rowSub.failed": "Last turn failed — open for details",
      "detail.rowSub.review": "Waiting for your review",
      "detail.rowSub.archived": "Archived",
      "detail.state.waiting-user": "Waiting on you",
      "detail.state.failed": "Failed",
      "detail.state.working": "Working",
      "detail.state.done": "Done",
      "detail.state.idle": "Idle",
      "detail.diag.workspaceBound": "Workspace bound",
      "detail.diag.workspaceUnbound": "No workspace yet",
      "detail.diag.coordinatorReady": "coordinator online",
      "detail.diag.coordinatorEmpty": "no coordinator",
      "detail.diag.pollRunning": "PR polling on",
      "detail.diag.pollStopped": "PR polling off",
      "detail.diag.details": "Details",
      "detail.mainWelcomeTitle": "Welcome back.",
      "detail.mainWelcomeBody":
        "Treat a project as one long conversation: ask directly, or let it coordinate several threads in parallel; each thread reports back here.",
      "detail.composerHintCoordinator": "Enter to send to coordinator",
      "detail.composer.targetThread": "New thread",
      "detail.composer.targetCoordinator": "Coordinator",
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
      "detail.threadRemovedWithWorktree": "Tracking removed (worktree still on disk: {path})",
      "detail.threadPromptFailed": "Thread created, but the first task was not delivered: {reason}",
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
      "detail.routeToggle": "Dispatch by rules",
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
      "routines.freq.manual": "Manual (no auto-run)",
      "routines.freq.hourly": "Hourly",
      "routines.freq.daily": "Daily",
      "routines.freq.weekdays": "Weekdays (Mon–Fri)",
      "routines.freq.weekly": "Weekly",
      "routines.freq.monthly": "Monthly",
      "routines.weekday.sun": "Sun",
      "routines.weekday.mon": "Mon",
      "routines.weekday.tue": "Tue",
      "routines.weekday.wed": "Wed",
      "routines.weekday.thu": "Thu",
      "routines.weekday.fri": "Fri",
      "routines.weekday.sat": "Sat",
      "routines.formTitle": "New routine",
      "routines.name": "Name",
      "routines.namePlaceholder": "e.g. Daily standup summary",
      "routines.instructions": "Instructions",
      "routines.instructionsLabel":
        "Instructions (sent as the prompt when it fires; one model call)",
      "routines.instructionsPlaceholder":
        "e.g. Summarise yesterday’s merged PRs and list what needs my confirmation.",
      "routines.frequency": "Frequency",
      "routines.time": "Time (HH:mm)",
      "routines.weekday": "Weekday",
      "routines.dayOfMonth": "Day of month (1–28)",
      "routines.create": "Create",
      "routines.creating": "Creating…",
      "routines.manualHint": "Manual: only runs when you click Run now (still one model call)",
      "routines.autoHint": "Automatic: fires one model call at the scheduled time",
      "routines.costHint": "Every delivery runs one model call (uses tokens).",
      "routines.empty": "No routines yet. Create one above; manual mode never runs by itself.",
      "routines.scheduleUnavailablePrefix": "Host schedule service unavailable (",
      "routines.scheduleUnavailableSuffix": ") — routines cannot be created.",
      "routines.trigger": "Trigger",
      "routines.runsOn": "Runs on",
      "routines.edit": "Edit",
      "routines.disabled": "disabled",
      "routines.detail": "Details",
      "routines.retention": "Host keeps {days} days / {records} records",
      "routines.retentionDays": " days",
      "routines.retentionRecords": " records",
      "routines.deliveryNote": "This really delivers once (= one model call)",
      "routines.historyEmpty": "No deliveries yet",
      "routines.historyNone":
        "No delivery records on the host yet (History only shows real deliveries).",
      "routines.enable": "Enable",
      "routines.disable": "Disable",
      "routines.switch": "Switch",
      "routines.delete": "Delete",
      "routines.save": "Save",
      "routines.update": "Update",
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
      "detail.autoResolve": "Auto-resolve",
      "detail.autoResolveOff": "Off",
      "detail.autoResolveDays": "{days} days idle",
      "detail.projectState": "Project state",
      "detail.save": "Save",
      "detail.edit": "Edit",
      "detail.none": "Not set",
      "detail.trashCount": "{count} items",
      "detail.trashNone": "Empty",
      "detail.grantsLabel": "Repo grants",
      "detail.purgeLabel": "Purge",
      "detail.trashLabel": "Trash",
      "detail.projectState.active": "Active",
      "detail.projectState.paused": "Paused",
      "detail.projectState.archived": "Archived",
      "detail.purged": "Purged {count} entries; manifest written under trash/",
      "detail.archivedLabel": "Archived at",
      "detail.carousel": "{index}–{total} of {total}",
      "detail.carouselPreview": "Preview",
      "detail.carouselPreviewHint": "Expand the focused thread",
      "detail.carouselNext": "Next",
      "detail.carouselPrev": "Previous",
      "detail.dirLimit": "Up to {count} folders ({used} added)",
      "detail.dirRemove": "Remove folder",
      "detail.durationDays": "{days} d",
      "detail.durationHours": "{hours} h",
      "detail.durationMinutes": "{minutes} min",
      "detail.panelSearch": "Search threads",
      "detail.emptySearch": "No matching threads.",
      "detail.emptyOverview": "Nothing is waiting on you.",
      "detail.groupCollapseAll": "Collapse all",
      "detail.addView": "Add view",
      "detail.today": "Today",
      "detail.threadTask": "Task: {task}",
      "detail.threadRemind": "Add a reminder (in 30 min)",
      "detail.threadReminderText": "Revisit thread: {title}",
      "detail.threadReminderAdded": "Reminder added: in 30 minutes",
      "detail.threadReminderFailed": "Could not add the reminder: {reason}",
      "detail.slash.memory": "Open memory",
      "detail.slash.routines": "Open routines",
      "detail.slash.settings": "Open project settings",
      "detail.slash.clear": "Clear filters and search",
      "detail.workingLine": "{count} thread(s) working; the coordinator will report back here.",
      "detail.settingsPane.general": "General",
      "detail.settingsPane.memory": "Memory",
      "detail.settingsPane.environment": "Environment",
      "detail.settingsPane.usage": "Usage",
      "detail.settingsPane.debug": "Debug access",
      "detail.settingsEnvHint":
        "Environment settings (project folder / repo grants / local folder access / cleanup) are in this section.",
      "detail.settingsDebugHint":
        "Danger switches / thread permissions / audit are in this section; full settings → Projects → Debug has more.",
      "detail.settingsOpenFull": "Open full settings",

      "detail.prCard.merge": "Merge ⏎",
      "detail.prCard.mergeArmed": "Click again to confirm",
      "detail.prCard.mergeHint": "Two clicks to confirm (squash + delete branch)",
      "detail.prCard.mergeOff": 'Turn on the "auto-merge PRs" danger switch first',
      "detail.prCard.mergeOk": "Merged #{number}",
      "detail.prCard.mergeFail": "Merge failed: {reason}",
      "detail.prCard.copy": "Copy link",
      "detail.prCard.copied": "PR link copied",
      "detail.prCard.loading": "Loading PR…",
      "detail.prCard.unavailable": "PR unavailable",
      "detail.prCard.actionsMissing":
        "Opening Review in a browser is unavailable; Merge needs the danger switch on",
      "detail.prOpen": "open",
      "artifacts.viewerOpen": "View",
      "artifacts.viewerClose": "Close",
      "artifacts.viewerLoading": "Loading artifact…",
      "artifacts.viewerError": "Cannot read artifact content",
      "library.artifactPinHint": "Pin (not yet available)",
      "library.artifactMenuHint": "More (not yet available)",
      "detail.groupReorderHint": "Reorder by drag (not yet available)",
      "detail.composerAttach": "Attach (not yet available)",
      "detail.composerMic": "Voice input (not yet available)",
      "detail.composerModel": "Model: {model}",
      "detail.composerHint": "Type “/” for commands",
      "detail.composerModelHint":
        "Edits the project thread default (same as Thread defaults in settings)",
      "detail.composerModelMenuTitle": "Thread default model",
      "detail.coordinatorModelHint": "Coordinator default model (independent of thread defaults)",
      "detail.coordinatorModelMenuTitle": "Coordinator default model",
      "detail.effortPlaceholder": "Reasoning effort (optional)",
      "detail.composerModelSave": "Save",
      "detail.composerModelInherit": "Host default",
      "detail.settingsOpen": "Project settings",
      "detail.settingsTitle": "Project settings",
      "detail.settingsClose": "Close settings",
      "detail.addViewHint": "Save the current filter as a view",
      "detail.viewNamePlaceholder": "View name (e.g. Working)",
      "detail.viewSave": "Save",
      "detail.viewCancel": "Cancel",
      "detail.viewDelete": "Delete this view",
      "detail.viewSaveFailed": "Could not save the view: {reason}",
      "detail.groupExpandAll": "Expand all",
      "detail.groupMenu": "Group actions",
      "detail.groupOnly": "Only this group",
      "detail.markRead": "Mark read",
      "detail.markUnread": "Mark unread",
      "detail.notificationCount": "{count} pending",
      "detail.overview": "Overview",
      "detail.bellTitle": "{count} item(s) need you (waiting / failed)",
      "detail.pillAll": "All",
      "detail.pillClear": "Clear filter",
      "detail.pillWorkingEta": "~{minutes}m",
      "detail.prBadge": "#{number}",
      "detail.remove": "Remove",
      "detail.reopen": "Reopen",
      "detail.reopened": "Reopened",
      "detail.reposLabel": "Repos",
      "detail.resolve": "Mark resolved",
      "detail.resolved": "Marked resolved (reopenable)",
      "detail.settings": "Project settings",
      "detail.settingsHint": "Plugin settings live under Settings → Plugins → Projects.",
      "detail.sparkCaption": "last 7 days",
      "detail.sparkHint": "Tokens used in the last 7 days",
      "detail.steps": "{done}/{total}",
      "detail.tasksPopover": "Tasks · {done}/{total}",
      "detail.tasksPopoverMore": "{count} more",
      "detail.rowArtifacts": "Artifacts",
      "detail.rowArtifactsMore": "+{count}",
      "detail.stepsHint": "This thread has no todo list yet, so no step count is shown.",
      "detail.stepsNone": "—",
      "detail.switch": "Switch project",
      "detail.switchEmpty": "No other projects",
      "detail.welcome": "Welcome back, {name}.",
      "detail.welcomeAnon": "Welcome back.",
      "detail.welcomeCta": "Start a thread",
      "detail.welcomeEmpty": "No threads yet",
      "detail.welcomeIdle": "Nothing is waiting on you.",
      "detail.welcomeWaiting": "{count} threads are waiting on you.",
      "detail.welcomeWorking": "{count} threads are running.",
      "panel.archivedAt": "Archived · {date}",
      "panel.firstRun.bullet1":
        "One conversation can branch into multiple threads that move independently.",
      "panel.firstRun.bullet2":
        "Threads know your repos, folders and standing instructions, so you never repeat yourself.",
      "panel.firstRun.bullet3": "Background threads keep running; come back and read the result.",
      "panel.firstRun.bullet4":
        "Threads can run in local folders too — your code stays on your machine.",
      "panel.firstRun.cta": "Get started",
      "panel.firstRun.dismiss": "Later",
      "panel.firstRun.title": "A project is now a conversation",
      "panel.firstRun.intro":
        "Coming back to a project continues the same conversation. When work needs to run in parallel, branch it into threads.",
      "panel.firstRun.cloudNote": "(cloud)",
      "panel.new.contextCount": "{dirs} folders · {repos} repos",
      "panel.new.contextLabel": "Context (folders / repos)",
      "panel.new.contextLimit": "Up to {count}",
      "panel.new.dirAdd": "Add folder",
      "panel.new.iconLabel": "Icon (optional)",
      "panel.new.invalidRepo": "Repos must be written as owner/repo",
      "panel.new.repoAdd": "Add repo",
      "panel.new.repoPlaceholder": "owner/repo, e.g. acme/api",
      "panel.rowUnread": "Unread",
      "panel.unread": "{count} unread",
      "panel.waiting": "{count} waiting on you",
      "panel.working": "{count} running",
      "detail.state.resolved": "Ready for review",
      "detail.state.archived": "Archived",
      "detail.pill.waiting-user": "Needs you",
      "detail.pill.failed": "Failed",
      "detail.pill.working": "Working",
      "detail.pill.resolved": "Review",
      "detail.pill.idle": "Idle",
      "detail.group.waiting-user": "Needs you",
      "detail.group.working": "Working",
      "detail.group.resolved": "Ready for review",
      "detail.group.idle": "Idle",
      "detail.group.archived": "Archived",

      "settings.nav.general": "General",
      "settings.nav.memory": "Memory",
      "settings.nav.usage": "Usage",
      "settings.nav.debug": "Debug",
      "settings.sectionTitle": "Settings sections",
      "settings.budget": "Budget (threads/day / concurrent / steps / tokens)",
      "settings.autoRetry": "Auto-retry on failure (max 2)",
      "settings.autoRetryHint":
        'When a thread ends failed, it re-sends "continue" after 60s; at most 2 tries per thread, never reset. Not the same as resuming after a usage limit.',
      "settings.budgetSave": "Save budget",
      "settings.budgetSaved": "Budget saved: {budget}",
      "settings.budgetUnlimited": "unlimited",
      "settings.memoryTitle": "Memory and instructions",
      "settings.memoryInstructions": "Instructions {used}/{limit} · updated {updated}",
      "settings.memoryIndexUpdated": "Memory index updated {updated}",
      "settings.memoryNever": "never",
      "settings.memoryFilesEmpty": "No files in the memory folder yet",
      "settings.memoryCounts":
        "Instructions {instructions} chars · memory index {memory} chars · {fragments} fragments",
      "settings.memoryTemplate": "Fill in project template (managed AGENTS.md block)",
      "settings.memoryTemplateDone": "Template written: {path}",
      "settings.usageTitle": "Usage",
      "settings.usageNote":
        "The host exposes no pricing API: this counts tokens and context usage only, never money.",
      "settings.usageTokens": "Today {today} tokens · last 7 days {total} tokens",
      "settings.usageContext":
        "Context: instructions {instructions} chars · memory {memory} chars · {fragments} fragments",
      "settings.usageThreads":
        "{total} threads · {today} created today · {working} running · {waiting} waiting on you",
      "settings.usageEmpty": "No usage to report yet.",
      "settings.debugTitle": "Debug access",
      "settings.debugRows":
        "{projects} projects · {active} active · {attached} sessions with context",
      "settings.auditTitle": "Audit (latest {count})",
      "settings.ghCheck": "Check GitHub connection",
      "settings.ghChecking": "Checking…",
      "settings.ghOk": "GitHub: {message}",
      "settings.ghFail": "GitHub: {message} ({hint})",
      "settings.notifyTitle": "Notifications (per project)",
      "settings.notifyFailed": "Failed",
      "settings.notifyWaiting": "Waiting on you",
      "settings.notifyCompleted": "Completed",
      "settings.notifyTier.all": "Everything (includes replies in every thread)",
      "settings.notifyTier.coordinator": "Coordinator and @mentions (default)",
      "settings.notifyTier.waiting": "Only what waits on me",
      "settings.notifyTier.none": "Nothing",
      "settings.notifyTier.custom": "Custom",
      "settings.notifyTierHint":
        '"Everything" includes replies in every thread, so it is much noisier.',
      "settings.notifySaved": "Notification switches saved",
      "detail.goalCounter": "{count} / 8,000",
      "detail.fragmentsTitle": "Memory fragments (separate files)",
      "detail.fragmentAdd": "Add fragment",
      "detail.fragmentTitlePlaceholder": "Fragment title, e.g. deployment notes",
      "detail.fragmentTextPlaceholder":
        "One paragraph is enough: the model reads this file when it needs details",
      "detail.fragmentAdded": "Fragment added: {slug}",
      "detail.fragmentForget": "Forget",
      "detail.fragmentForgotten": "Forgotten",
      "detail.fragmentPreview": "Preview",
      "detail.fragmentEmpty":
        "No fragments yet. Add one to turn memory from a paragraph into searchable files.",
      "detail.entriesTitle": "Memory entries",
      "detail.entriesEmpty": "No memory entries yet.",
      "detail.entryForget": "Forget this entry",
      "b3.envMachine": "Runs on: {value}",
      "b3.envMachineLocal": "your computer (each thread has an isolated worktree)",
      "b3.envMachineNoDir": "your computer (no project folder bound yet)",
      "b3.envRepos": "Repositories: {count}",
      "b3.envAllowed": "Folders without asking: {count} ({names})",
      "b3.envAllowedEmpty":
        'Folders without asking: none yet (choose "Set as default" on a folder card)',
      "b3.folderTitle": "Local folder access",
      "b3.folderCopy": "Commands can run in the folder you choose without asking every time.",
      "b3.folderDeny": "Deny",
      "b3.folderDefault": "Set as default folder",
      "b3.folderOnce": "Allow once",
      "b3.folderUnset": "Not granted yet",
      "b3.folderDefaultTag": "Default folder",
      "b3.folderDeniedTag": "Denied",
      "b3.folderOnceUsed": "One-time grant already used",
      "b3.folderSaved": "Recorded: {decision}",
      "b3.folderNoDir": "Bind a folder under “project directories” first, then grant access.",
      "b3.folderAdd": "Add folder",
      "b3.folderAddHint": "Add a working folder in Project folder",
      "b3.modelTitle": "Thread default model",
      "b3.coordinatorTitle": "Coordinator defaults",
      "b3.coordinatorModel": "Coordinator model",
      "b3.coordinatorEffort": "Coordinator effort",
      "b3.coordinatorSaved": "Coordinator defaults saved",
      "b3.model": "Thread model",
      "b3.effort": "Thread effort",
      "b3.modelInherit": "Inherit host default",
      "b3.modelSave": "Save defaults",
      "b3.modelSaved": "Thread default model saved",
      "b3.modelUnavailable": "The host exposes no model catalog",
      "b3.modelManual": "provider|model (manual)",
      "b3.effortManual": "effort (manual)",
      "b3.modelManualToggle": "Type model / effort manually",
      "b3.modelManualHint":
        "Type these when no catalog is available; Save writes exactly these values.",
      "b3.sessionsTitle": "Start a thread from a session",
      "b3.sessionsLoad": "List recent sessions",
      "b3.sessionsAttach": "Attach as thread",
      "b3.sessionsEmpty": "No recent sessions to attach.",
      "b3.sessionsAttached": "Attached as thread: {id}",
      "b3.mentionTitle": "@ mention",
      "b3.mentionRegistered": "@ source registered (lists this project's threads and project name)",
      "b3.mentionUnavailable": "@ source unavailable (this deployment has no inputTriggers)",
      "b3.fragAdd": "Add fragment",
      "b3.fragTitlePh": "Fragment title",
      "b3.fragTextPh": "One paragraph is enough; the model reads this file when it needs details",
      "b3.fragAdded": "Fragment added: {slug}",
      "b3.fragForget": "Forget",
      "b3.fragPreview": "Preview",
      "b3.fragEmpty": "No fragments yet.",
      "b3.fragLimit": "{count} / {limit} fragments",
      "b3.entriesTitle": "Index entries (MEMORY.md)",
      "b3.entriesEmpty": "No index entries yet.",
      "b3.entryForget": "Forget this entry",
      "b3.threadActions": "Thread actions",
      "b3.actionRename": "Rename",
      "b3.actionUnread": "Mark unread",
      "b3.actionResolve": "Resolve",
      "b3.actionReopen": "Reopen",
      "b3.actionCopy": "Copy ID",
      "b3.actionReclaim": "Reclaim directory",
      "b3.actionDetach": "Stop tracking",
      "b3.renamePlaceholder": "Thread title",
      "b3.renameSave": "Save",
      "b3.renamed": "Renamed",
      "b3.copied": "ID copied",
      "b3.actionDone": "Done",
      "notify.completed": "{count} threads completed",
      "detail.memoryEdit": "Edit standing rules",
      "detail.memorySave": "Save rules",
      "detail.memorySaving": "Saving…",
      "detail.memorySaved": "Rules saved ({chars} chars)",
      "detail.memoryCleared": "Rules cleared",
      "detail.memorySaveFailed": "Save failed: {reason}",
      "detail.memoryAppendPlaceholder":
        "Append a memory (e.g. this repo's tests run with pnpm test)",
      "detail.memoryAppend": "Append memory",
      "detail.memoryAppended": "Memory appended",
      "detail.memoryAppendDup": "Already remembered; nothing was written twice",
      "detail.dirInvalidHint":
        "An absolute path is required (starting with /); relative paths cannot be a session directory, so the save was rejected.",
      "detail.configTitle": "Advanced settings (repository access / trash)",
      "library.title": "Library",
      "library.meter": "{count} artifacts · {bytes}",
      "library.openPanel": "Open artifact library",
      "library.openPanelHint": "Open this project's artifacts in the right-side artifacts panel",
      "library.openPanelUnavailable":
        "Could not open: the host did not provide the right-side panel service (sidebarRight).",
      "library.artifactsMissing":
        "The artifact library needs dsh-artifacts 0.2; it is unavailable, so only project files are listed below.",
      "library.artifactsTitle": "Artifacts",
      "library.artifactsEmpty": "This project has no artifacts yet.",
      "library.artifactMeta": "{kind} · v{version} · {when}",
      "library.artifactMetaNoTime": "{kind} · v{version}",
      "library.provenance": "from session {session} · call {call}",
      "library.timeUnknown": "time unknown",
      "library.kind.html": "page",
      "library.kind.markdown": "Markdown",
      "library.kind.json": "JSON",
      "library.kind.csv": "CSV",
      "library.kind.image": "image",
      "library.threadArtifacts": "Artifacts from this thread",
      "library.threadArtifactsMissing":
        "artifacts is not installed or its contract differs: thumbnails and previews are unavailable, showing local records only.",
      "library.filesTitle": "Project files",
      "library.filesCount": "{count} files",
      "library.colName": "Name",
      "library.colType": "Type",
      "library.colSize": "Size",
      "library.colUpdated": "Updated",
      "library.filesEmpty": "No files in this folder yet.",
      "library.filesNoDir":
        'This project has no folder bound yet: bind one under "project folders" to see files.',
      "library.filesNoSession":
        "No project thread session yet: the file view comes from the host workspaceFiles session scope, so create or attach a session first.",
      "library.filesHostUnavailable":
        "This deployment has no workspaceFiles service: the file view is unavailable (no invented file list).",
      "library.searchByNameOnly":
        "Search matches file names / paths only, not file contents (the workspaceFiles.search boundary).",
      "library.searchPlaceholder": "Search by file name…",
      "library.search": "Search",
      "library.searching": "Searching…",
      "library.searchEmpty": "No matching file names.",
      "library.searchFailed": "Search failed",
      "library.truncated": "truncated",
      "library.railOpen": "Open Library",
      "library.railBack": "Back to threads",
      "library.railHint":
        "Project files and artifacts in one place; search matches file names only.",
      "library.railSummary": "{files} files · {artifacts} artifacts",
      "library.railLoading": "Open to view",
      "b3.folderWorktreeHint":
        "merge runs in the project folder; push-branch runs in the thread worktree, which inherits the authorization of the project folder it came from.",
    };
    var PANEL_ID = "projects";
    var SERVICE = "projects";
    /** F35：项目目录上限（前后端各拦一道：宿主 store 也会拒 >10）。 */
    var MAX_CONTEXT_DIRS = 10;
    /** F2：关联仓库上限。 */
    var MAX_CONTEXT_REPOS = 10;

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
      // Claude 的"选中"是紫蓝强调色；宿主 token 在深色主题下 button-primary-fill 接近白色，
      // 所以这里用品牌色常量（深浅主题都可读）。
      brand: "#6f5bf5",
      onBrand: "#ffffff",
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

    /**
     * 把 attachThread 的冲突错误本地化（B2 复审 P2）。
     * 服务端抛的是内部串 `thread already belongs to project …`，直接透出去是英文内部实现细节。
     * @param {any} t @param {any} error
     * @returns {string}
     */
    function threadErrorText(t, error) {
      var raw = String(error?.message || error || "");
      if (/already belongs to project|thread-in-other-project/iu.test(raw)) {
        return text(t, "detail.threadConflict");
      }
      return raw.slice(0, 200);
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
      // —— B2：协调者区 / thread chip / 展开面板 ——
      // Claude 的左列是"对话"，不是卡片：协调者区不铺边框/底色
      coordinator: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        padding: "0 2px",
        minWidth: 0,
      },
      // Claude 的协调者是"对话"：assistant 是正文（无气泡），user 才是右侧气泡
      coordinatorBubble: {
        alignSelf: "stretch",
        maxWidth: "100%",
        padding: "2px 0",
        background: "transparent",
        color: T.text,
        fontSize: "13.5px",
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        minWidth: 0,
      },
      coordinatorBubbleUser: {
        alignSelf: "flex-end",
        maxWidth: "82%",
        padding: "8px 12px",
        borderRadius: "14px",
        background: T.panel,
        color: T.text,
        fontSize: "13.5px",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        minWidth: 0,
      },
      // 「Today」日期分隔：居中细字 + 两侧 1px 线（Claude 对话流的时间锚点）
      dayDivider: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        margin: "6px 0 2px",
        color: T.faint,
        fontSize: "11.5px",
      },
      // 「✳ Claude is working」状态行
      workingRow: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        color: T.dim,
        fontSize: "12px",
        padding: "4px 2px",
      },
      conclusion: {
        borderLeft: `2px solid ${T.accentText}`,
        paddingLeft: "8px",
        color: T.text,
        fontSize: "12.5px",
        display: "block",
        minWidth: 0,
      },
      refRow: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "2px 4px",
        borderRadius: "6px",
        minWidth: 0,
        cursor: "pointer",
      },
      threadChip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        maxWidth: "220px",
        padding: "2px 8px 2px 6px",
        borderRadius: "999px",
        border: `1px solid ${T.border}`,
        background: "transparent",
        color: T.text,
        fontSize: "11.5px",
        minWidth: 0,
      },
      chipDot: {
        display: "inline-block",
        width: "6px",
        height: "6px",
        borderRadius: "999px",
        flex: "none",
      },
      chipMeta: { color: T.dim, fontVariantNumeric: "tabular-nums", flex: "none" },
      threadDetail: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        marginTop: "6px",
        padding: "8px 10px",
        border: `1px solid ${T.borderSoft}`,
        borderRadius: "10px",
        minWidth: 0,
        // 展开面板必须换到下一行占满整行，否则会被挤成 ~230px 一条
        flexBasis: "100%",
        width: "100%",
      },
      startCard: {
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        padding: "10px 12px",
        borderRadius: "12px",
        border: `1px solid ${T.borderSoft}`,
        background: "transparent",
        minWidth: 0,
      },
      inlineChip: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "1px 8px",
        borderRadius: "6px",
        border: `1px solid ${T.border}`,
        color: T.dim,
        fontSize: "11.5px",
        minWidth: 0,
      },
      taskItem: {
        display: "block",
        color: T.text,
        fontSize: "12px",
        paddingLeft: "2px",
        minWidth: 0,
      },
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
        fontSize: "24px",
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
        minWidth: 0,
        flex: "1 1 90px",
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
        // 窄容器（右栏展开面板 375px）里按钮不许被压成逐字换行
        whiteSpace: "nowrap",
        flexShrink: 0,
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
        whiteSpace: "nowrap",
        flexShrink: 0,
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
        // 小字用 secondary（faint 在浅色下约 3.2:1，达不到可读标准）
        color: T.dim,
        fontSize: "12.5px",
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
        fontSize: "22px",
        fontWeight: 500,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      detailGrid: {
        display: "grid",
        // 视频实测右栏占 28–32%，静态参考 35–65%：取 63:37（右栏 ≈37%，落在两者交集附近）
        gridTemplateColumns: "minmax(0, 63fr) minmax(340px, 37fr)",
        gap: "28px",
        alignItems: "stretch",
      },
      detailGridNarrow: { display: "flex", flexDirection: "column", gap: "24px" },
      mainCol: {
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      },
      // 浅色：面板是"白色圆角卡片 + 阴影"浮在页面上（Claude 浅色帧的结构）
      panelColScroll: {
        maxHeight: "calc(100vh - 170px)",
        overflowY: "auto",
        overscrollBehavior: "contain",
        paddingRight: "6px",
      },
      panelColLight: {
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        // 与深色 panelCol 同一盒模型（此前 padding/border 不同导致切主题整体位移 18px）
        padding: "0 16px 12px",
        borderRadius: "12px",
        border: "1px solid rgba(0,0,0,0.12)",
        // 淡灰卡：页面是白的，纯白卡在白页上分不出层次
        background: "#FAFAFB",
      },
      panelColNarrow: {
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        paddingTop: "16px",
        borderTop: `1px solid ${T.borderSoft}`,
      },
      // 右列：Threads 面板（Claude 结构）——与左列用 1px 分割线隔开，不铺卡片
      panelCol: {
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        // 右栏铺满视口高度（参考图面板是全高，不是一小条）
        minHeight: "calc(100vh - 170px)",
        // 与浅色 panelColLight 完全相同的盒模型：padding 12/16 + 1px 边
        // 顶部不放 padding：overflow 裁剪区包含 padding，滚动内容会从顶部 12px 探出来
        padding: "0 16px 12px",
        borderLeft: `1px solid ${T.borderSoft}`,
        // Claude 深色下页面 #0A0A0A / 面板 #1A1A1A：面板比页面亮一档（层次感）。
        // 之前面板与页面同色（#151516），逐像素比对暴露了这一点。
        // 宿主 token 在深色下给的是 rgba(0.06) 档（≈#202021），比 Claude 的 #1A1A1A 亮；
        // 这里用 0.045 档贴到 #1A1A1A 附近（浅色面板另有白卡样式）。
        background: "rgba(127,127,127,0.045)",
      },
      rail: { minWidth: 0, display: "flex", flexDirection: "column" },
      // 设置抽屉（Claude 的 Project settings 是我们的宿主设置分节；这里是"项目内设置"入口）
      settingsDrawer: {
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "400px",
        maxWidth: "92vw",
        overflowY: "auto",
        padding: "16px 18px 24px",
        background: T.bg,
        borderLeft: `1px solid ${T.border}`,
        boxShadow: T.shadow,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      },
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
      railRow: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, padding: "1px 0" },
      railLabel: { flex: "none", width: "64px", color: T.faint, fontSize: "12px" },
      railValue: {
        flex: "1 1 auto",
        minWidth: 0,
        color: T.text,
        fontSize: "12px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      railToggle: {
        flex: "none",
        width: "14px",
        padding: 0,
        border: "none",
        background: "transparent",
        color: T.dim,
        cursor: "pointer",
        fontSize: "11px",
      },
      railTitleButton: {
        flex: "1 1 auto",
        minWidth: 0,
        padding: 0,
        border: "none",
        background: "transparent",
        color: T.text,
        fontSize: "13px",
        fontWeight: 500,
        textAlign: "left",
        cursor: "pointer",
      },
      headMain: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
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
      // —— B1：Overview 药丸条 / 分组 / 行解剖 / Welcome 头 ——
      badge: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "18px",
        height: "18px",
        padding: "0 5px",
        borderRadius: "999px",
        background: T.accent,
        color: T.accentText,
        fontSize: "11px",
        fontWeight: 600,
        flex: "none",
      },
      archiveBadge: {
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 8px",
        borderRadius: "999px",
        border: `1px solid ${T.borderSoft}`,
        color: T.faint,
        fontSize: "11px",
        flex: "none",
        whiteSpace: "nowrap",
      },
      pillBar: {
        display: "flex",
        alignItems: "center",
        gap: "3px",
        flexWrap: "nowrap",
        flexShrink: 0,
        overflowX: "auto",
        // 去掉横向滚动条占位（否则浅色下常驻 5px 灰条）
        scrollbarWidth: "none",
        padding: "2px 0 6px",
      },
      filterPill: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 9px",
        borderRadius: "999px",
        border: "1px solid transparent",
        background: T.panel,
        color: T.dim,
        fontSize: "12px",
        cursor: "pointer",
        flex: "none",
      },
      pillActive: {
        border: "1px solid transparent",
        background: T.brand,
        color: T.onBrand,
      },
      pillCount: {
        fontVariantNumeric: "tabular-nums",
        fontWeight: 500,
        color: "inherit",
        opacity: 0.72,
      },
      welcome: {
        display: "flex",
        alignItems: "flex-end",
        gap: "12px",
        padding: "4px 2px 14px",
        minWidth: 0,
        flexWrap: "wrap",
        flexShrink: 0,
      },
      welcomeTitle: {
        // Claude 用衬线体做"产品气质"：问候语与大标题
        fontFamily: 'ui-serif, Georgia, "Songti SC", "Noto Serif CJK SC", serif',
        fontSize: "26px",
        fontWeight: 500,
        lineHeight: 1.2,
        letterSpacing: "0.01em",
        minWidth: 0,
      },
      welcomeSub: { color: T.dim, fontSize: "13px", marginTop: "4px", minWidth: 0 },
      spark: { display: "flex", alignItems: "flex-end", gap: "2px", height: "22px", flex: "none" },
      sparkBar: { width: "4px", borderRadius: "2px", background: T.border },
      groupHead: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 10px",
        marginTop: "4px",
        marginBottom: "2px",
        borderRadius: "8px",
        background: T.panel,
        minWidth: 0,
      },
      groupToggle: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        border: "none",
        background: "transparent",
        color: T.text,
        fontSize: "13px",
        fontWeight: 600,
        padding: "2px 4px",
        borderRadius: "6px",
        cursor: "pointer",
        minWidth: 0,
      },
      groupCount: {
        color: T.dim,
        fontSize: "12px",
        fontVariantNumeric: "tabular-nums",
        fontWeight: 400,
      },
      groupBody: { display: "flex", flexDirection: "column", gap: "2px" },
      carousel: {
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        marginLeft: "auto",
        color: T.dim,
        fontSize: "11px",
        flex: "none",
      },
      rowTitle: {
        fontWeight: 500,
        fontSize: "15px",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      rowSub: {
        color: T.dim,
        fontSize: "13.5px",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      rowRight: {
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        flex: "none",
        color: T.faint,
        fontSize: "11px",
        fontVariantNumeric: "tabular-nums",
      },
      stepRing: { flex: "none", display: "inline-block" },
      switchList: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "220px" },
      switchRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 8px",
        borderRadius: "6px",
        border: "none",
        background: "transparent",
        color: T.text,
        fontSize: "13px",
        cursor: "pointer",
        textAlign: "left",
        minWidth: 0,
      },
      emptyCta: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        alignItems: "flex-start",
        padding: "10px 2px",
      },
      composerCardLight: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px 14px",
        borderRadius: "14px",
        border: "1px solid rgba(0,0,0,0.16)",
        background: "#ffffff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        marginTop: "auto",
        zIndex: 3,
      },
      composerCard: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "10px 12px",
        borderRadius: "14px",
        background: T.panel,
        border: `1px solid ${T.border}`,
        // 贴底：左列 flex 撑开 + auto 外边距（minHeight 在列上，不在 grid 上）
        marginTop: "auto",
        zIndex: 3,
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
    /**
     * 当前宿主配色（light/dark）：宿主把"外观"落成 `color-scheme`，读它比 matchMedia 可靠。
     * 每秒轮询一次（设置里切换外观时无需刷新页面）。
     * @returns {"light"|"dark"}
     */
    function useColorScheme() {
      var state = useState("dark");
      var scheme = state[0];
      var setScheme = state[1];
      useEffect(() => {
        var read = () => {
          var value = "";
          try {
            value = getComputedStyle(document.documentElement).colorScheme || "";
          } catch {
            value = "";
          }
          setScheme(value.indexOf("light") >= 0 ? "light" : "dark");
        };
        read();
        var timer = setInterval(read, 1200);
        return () => clearInterval(timer);
      }, [setScheme]);
      return scheme;
    }

    /**
     * 线性 SVG 字形（Claude 的图标语言：1.5px stroke、圆角端点）。
     * 宿主 icon set 覆盖不到的（gear/mic/check/arc/plus）用这里，避免 emoji 混进界面。
     * @param {string} kind @param {number} [size]
     */
    function glyph(kind, size) {
      var px = size || 16;
      var box = {
        width: px,
        height: px,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        style: { flex: "none", display: "block" },
      };
      if (kind === "gear") {
        return h(
          "svg",
          box,
          h("circle", { cx: 12, cy: 12, r: 3.2 }),
          h("path", {
            d: "M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6",
          }),
        );
      }
      if (kind === "mic") {
        return h(
          "svg",
          box,
          h("rect", { x: 9, y: 3, width: 6, height: 10, rx: 3 }),
          h("path", { d: "M5.5 11a6.5 6.5 0 0 0 13 0" }),
          h("path", { d: "M12 17.5V20" }),
        );
      }
      if (kind === "plus") return h("svg", box, h("path", { d: "M12 5v14M5 12h14" }));
      if (kind === "check") return h("svg", box, h("path", { d: "M5 12.5l4.2 4.2L19 7" }));
      if (kind === "arc") {
        return h(
          "svg",
          box,
          h("circle", {
            cx: 12,
            cy: 12,
            r: 7.5,
            strokeDasharray: "34 14",
            transform: "rotate(-90 12 12)",
            opacity: 0.9,
          }),
        );
      }
      if (kind === "pr") {
        return h(
          "svg",
          box,
          h("circle", { cx: 6, cy: 6, r: 2 }),
          h("circle", { cx: 6, cy: 18, r: 2 }),
          h("path", { d: "M6 8v8" }),
          h("path", { d: "M8 6h5.5a4 4 0 0 1 4 4v3" }),
          h("path", { d: "M14.5 12l3 3 3-3" }),
        );
      }
      if (kind === "search") {
        return h(
          "svg",
          box,
          h("circle", { cx: 11, cy: 11, r: 6.5 }),
          h("path", { d: "M16 16l4 4" }),
        );
      }
      if (kind === "bell") {
        return h(
          "svg",
          box,
          h("path", { d: "M6 9a6 6 0 0 1 12 0c0 4 1.6 5.2 2 6H4c.4-.8 2-2 2-6Z" }),
          h("path", { d: "M10 18a2 2 0 0 0 4 0" }),
        );
      }
      return null;
    }

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
     * 行标题清洗：宿主的会话标题可能带 <system-reminder>…</system-reminder> 或其它标签，
     * 直接展示会像"漏数据"。这里剥标签、折叠空白、超长截断（Claude 的行标题都是干净的）。
     * @param {any} value
     * @returns {string}
     */
    function cleanThreadTitle(value) {
      var raw = String(value ?? "");
      raw = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, " ");
      raw = raw.replace(/<[^>\n]{1,80}>/gu, " ");
      raw = raw.replace(/\s+/gu, " ").trim();
      if (raw.length > 90) raw = `${raw.slice(0, 90)}…`;
      return raw;
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

    /** 右栏值行右侧的小按钮：只有动作，没有填充（值行保持只读观感）。 */
    var smallButton = {
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 8px",
      borderRadius: "6px",
      border: `1px solid ${T.border}`,
      background: "transparent",
      color: T.dim,
      fontSize: "12px",
      cursor: "pointer",
      flex: "none",
    };

    /**
     * 右栏一段：标题 + 右侧小动作；窄窗（单列）时默认折叠成「标题 + 一行摘要 + ▸」。
     * 折叠只影响**展示**，不影响任何写路径——展开/收起从不发 RPC。
     * @param {{t: any, id: string, title: string, action?: any, summary?: any, collapsible?: boolean, body: any, attrs?: any}} props
     */
    function RailSection(props) {
      var collapsible = props.collapsible === true;
      var state = useState(!collapsible);
      var open = state[0];
      var setOpen = state[1];
      useEffect(() => {
        setOpen(!collapsible);
      }, [collapsible, setOpen]);
      // 分区过滤：抽屉按 Claude 的 5 分区切换时，只渲染当前分区的 section
      // 分区过滤：只隐藏不卸载——锚点/冒烟/回读仍要在 DOM 里（返回 null 会让 10 条冒烟断言找不到锚点）
      const paneProps = /** @type {any} */ (props);
      const paneHidden = Boolean(
        paneProps.pane && paneProps.activePane && paneProps.pane !== paneProps.activePane,
      );
      return h(
        "section",
        {
          style: paneHidden ? { ...styles.railSection, display: "none" } : styles.railSection,
          ...(props.attrs || {}),
        },
        h(
          "div",
          { style: styles.railHead },
          collapsible
            ? h(
                "button",
                {
                  type: "button",
                  style: styles.railToggle,
                  "data-projects-rail-toggle": props.id,
                  "aria-expanded": open ? "true" : "false",
                  "aria-label": props.title,
                  onClick: () => setOpen(!open),
                },
                open ? "▾" : "▸",
              )
            : null,
          collapsible
            ? h(
                "button",
                {
                  type: "button",
                  style: styles.railTitleButton,
                  "data-projects-rail-title": props.id,
                  onClick: () => setOpen(!open),
                },
                props.title,
              )
            : h("span", { style: styles.railTitle }, props.title),
          props.action || null,
        ),
        open
          ? props.body
          : props.summary
            ? h(
                "div",
                { style: styles.railBody, "data-projects-rail-summary": props.id },
                props.summary,
              )
            : null,
      );
    }

    /**
     * 右栏一行：标签 + 值（单行截断，title 给全文）+ 右侧动作。
     * 值行永远是只读的：编辑入口只在右侧按钮上，点开才出输入控件（右栏不常驻 input）。
     * @param {{label: string, value: any, title?: string, action?: any, attrs?: any}} props
     */
    function RailRow(props) {
      const rowProps = /** @type {any} */ (props);
      const rowHidden = Boolean(
        rowProps.pane && rowProps.activePane && rowProps.pane !== rowProps.activePane,
      );
      return h(
        "div",
        {
          style: rowHidden ? { ...styles.railRow, display: "none" } : styles.railRow,
          ...(props.attrs || {}),
        },
        h("span", { style: styles.railLabel }, props.label),
        h(
          "span",
          {
            style: styles.railValue,
            title: props.title === undefined ? String(props.value ?? "") : props.title,
          },
          props.value,
        ),
        props.action || null,
      );
    }

    /**
     * 右栏值行点「编辑」后打开的小模态（目录 / 仓库授权共用）。
     * @param {{t: any, title: string, open: boolean, onClose: () => void, onSave?: any, saveLabel?: string, saveAttrs?: any, children: any, attrs?: any}} props
     */
    function RailEditor(props) {
      if (!props.open) return null;
      return h(
        "div",
        {
          style: styles.backdrop,
          ...(props.attrs || {}),
          onMouseDown: (/** @type {any} */ event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
          onKeyDownCapture: (/** @type {any} */ event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              props.onClose();
            }
          },
        },
        h(
          "div",
          {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": props.title,
            style: styles.dialog,
          },
          h(
            "div",
            { style: styles.dialogHead },
            h("span", { style: styles.dialogTitle }, props.title),
          ),
          props.children,
          h(
            "div",
            { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
            h(
              "button",
              {
                type: "button",
                style: styles.secondaryButton,
                "data-projects-rail-editor-cancel": "",
                onClick: props.onClose,
              },
              text(props.t, "detail.cancel"),
            ),
            props.onSave
              ? h(
                  "button",
                  {
                    type: "button",
                    style: styles.primaryButton,
                    "data-projects-rail-editor-save": "",
                    ...(props.saveAttrs || {}),
                    onClick: props.onSave,
                  },
                  props.saveLabel || text(props.t, "detail.save"),
                )
              : null,
          ),
        ),
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
    /**
     * 首启引导（F63/U21）：一次性说明「项目现在是一段对话」+ 4 条 bullet。
     * 排在宿主自己的「预览版说明」之后：宿主对话框关掉、面板渲染出来后才可能走到这里；
     * 是否已看过由宿主 storageDomain 的 firstRunDone 决定（跨重启只出现一次）。
     * @param {any} props
     */
    function FirstRunGuide(props) {
      var t = props.t;
      if (props.open !== true) return null;
      var bullets = [
        text(t, "panel.firstRun.bullet1"),
        text(t, "panel.firstRun.bullet2"),
        text(t, "panel.firstRun.bullet3"),
        text(t, "panel.firstRun.bullet4"),
      ];
      return h(
        "div",
        {
          style: styles.backdrop,
          "data-projects-firstrun": "open",
          "data-projects-firstrun-persisted": props.available === true ? "yes" : "no",
        },
        h(
          "div",
          {
            style: { ...styles.dialog, maxWidth: "520px" },
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "projects-firstrun-title",
            "data-projects-firstrun-dialog": "",
          },
          h(
            "div",
            { style: styles.dialogTitle, id: "projects-firstrun-title" },
            text(t, "panel.firstRun.title"),
          ),
          h(
            "div",
            {
              style: { ...styles.meta, whiteSpace: "normal", lineHeight: 1.6, marginBottom: "4px" },
              "data-projects-firstrun-intro": "",
            },
            text(t, "panel.firstRun.intro"),
          ),
          h(
            "ul",
            { style: { margin: 0, paddingLeft: "18px", color: T.dim, lineHeight: 1.7 } },
            bullets.map((line, index) =>
              h(
                "li",
                { key: String(index), "data-projects-firstrun-bullet": String(index + 1) },
                index === 2
                  ? h(
                      "span",
                      {},
                      line,
                      " ",
                      h(
                        "span",
                        {
                          style: { color: T.accentText },
                          "data-projects-firstrun-link": "",
                        },
                        text(t, "panel.firstRun.cloudNote"),
                      ),
                    )
                  : line,
              ),
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
                "data-projects-firstrun-close": "",
                onClick: props.onDone,
              },
              text(t, "panel.firstRun.dismiss"),
            ),
            h(
              "button",
              {
                type: "button",
                style: styles.primaryButton,
                "data-modal-autofocus": "",
                "data-projects-firstrun-cta": "",
                onClick: props.onDone,
              },
              text(t, "panel.firstRun.cta"),
            ),
          ),
        ),
      );
    }

    /** @param {any} props */
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
      // —— F2 Context 多选：目录（≤10）+ 仓库 owner/repo（≤10）——
      var dirs = Array.isArray(form.dirs) ? form.dirs : [];
      var repos = Array.isArray(form.repos) ? form.repos : [];
      var addDir = () => {
        var value = String(form.dirDraft ?? "").trim();
        if (value === "") return;
        if (dirs.includes(value)) {
          patch({ dirDraft: "" });
          return;
        }
        if (dirs.length >= MAX_CONTEXT_DIRS) {
          patch({ error: text(t, "panel.new.contextLimit", { count: MAX_CONTEXT_DIRS }) });
          return;
        }
        patch({ dirs: [...dirs, value], dirDraft: "", error: "" });
      };
      var addRepo = () => {
        var value = String(form.repoDraft ?? "")
          .trim()
          .replace(/^https?:\/\/github\.com\//u, "")
          .replace(/\/+$/u, "");
        if (value === "") return;
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
          patch({ error: text(t, "panel.new.invalidRepo") });
          return;
        }
        if (repos.includes(value)) {
          patch({ repoDraft: "" });
          return;
        }
        if (repos.length >= MAX_CONTEXT_REPOS) {
          patch({ error: text(t, "panel.new.contextLimit", { count: MAX_CONTEXT_REPOS }) });
          return;
        }
        patch({ repos: [...repos, value], repoDraft: "", error: "" });
      };
      var chips = (/** @type {string[]} */ list, /** @type {string} */ kind) =>
        h(
          "div",
          {
            style: { display: "flex", flexWrap: "wrap", gap: "4px", minWidth: 0 },
            "data-projects-new-context-items": kind,
          },
          list.map((item) =>
            h(
              "span",
              {
                key: `${kind}:${item}`,
                style: { ...styles.dirBadge, gap: "4px" },
                "data-projects-new-context-item": `${kind}:${item}`,
              },
              kind === "dir" ? baseName(item) : item,
              h(
                "button",
                {
                  type: "button",
                  style: {
                    border: "none",
                    background: "transparent",
                    color: T.faint,
                    cursor: "pointer",
                    padding: "0 2px",
                    fontSize: "12px",
                  },
                  "aria-label": text(t, "detail.remove"),
                  "data-projects-new-context-remove": `${kind}:${item}`,
                  onClick: () =>
                    patch(
                      kind === "dir"
                        ? { dirs: dirs.filter((/** @type {string} */ dir) => dir !== item) }
                        : { repos: repos.filter((/** @type {string} */ repo) => repo !== item) },
                    ),
                },
                "×",
              ),
            ),
          ),
        );
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
                maxLength: 8000,
                "data-projects-new-goal": "",
                onChange: (/** @type {any} */ event) => patch({ goal: event.target.value }),
              }),
              // F39：≤8,000 与字数提示（对齐 Claude 的 `28 / 8,000`）
              h(
                "span",
                {
                  style: {
                    ...styles.meta,
                    color:
                      String(form.goal ?? "").length > 8000 ? (T.danger ?? T.accentText) : T.faint,
                  },
                  "data-projects-goal-counter": String(String(form.goal ?? "").length),
                },
                text(t, "detail.goalCounter", { count: String(form.goal ?? "").length }),
              ),
            ),
            // —— F2 Context 多选：目录 ≤10（逐个 workspaceRoot）+ 仓库 owner/repo ——
            h(
              "div",
              { style: styles.fieldLabel },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "6px" } },
                h("span", { style: styles.meta }, text(t, "panel.new.contextLabel")),
                h(
                  "span",
                  {
                    style: { ...styles.meta, marginLeft: "auto" },
                    "data-projects-new-context-count": "",
                  },
                  text(t, "panel.new.contextCount", { dirs: dirs.length, repos: repos.length }),
                ),
              ),
              chips(dirs, "dir"),
              h(
                "div",
                { style: { display: "flex", gap: "6px" } },
                h("input", {
                  style: styles.input,
                  value: String(form.dirDraft ?? ""),
                  placeholder: text(t, "panel.new.dirPlaceholder"),
                  "data-projects-new-dir": "",
                  onChange: (/** @type {any} */ event) => patch({ dirDraft: event.target.value }),
                  onKeyDown: (/** @type {any} */ event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addDir();
                    }
                  },
                }),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-new-dir-add": "",
                    onClick: addDir,
                  },
                  text(t, "panel.new.dirAdd"),
                ),
              ),
              chips(repos, "repo"),
              h(
                "div",
                { style: { display: "flex", gap: "6px" } },
                h("input", {
                  style: styles.input,
                  value: String(form.repoDraft ?? ""),
                  placeholder: text(t, "panel.new.repoPlaceholder"),
                  "data-projects-new-repo": "",
                  onChange: (/** @type {any} */ event) => patch({ repoDraft: event.target.value }),
                  onKeyDown: (/** @type {any} */ event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addRepo();
                    }
                  },
                }),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-new-repo-add": "",
                    onClick: addRepo,
                  },
                  text(t, "panel.new.repoAdd"),
                ),
              ),
            ),
            h(
              "label",
              { style: styles.fieldLabel },
              h("span", { style: styles.meta }, text(t, "panel.new.iconLabel")),
              h("input", {
                style: styles.input,
                value: String(form.icon ?? ""),
                placeholder: "🚀",
                maxLength: 8,
                "data-projects-new-icon": "",
                onChange: (/** @type {any} */ event) => patch({ icon: event.target.value }),
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
        // F2 Context 多选：目录（≤10，逐个 workspaceRoot）+ 仓库（owner/repo）+ 图标
        dirs: [],
        dirDraft: "",
        repos: [],
        repoDraft: "",
        icon: "",
        instructions: "",
        busy: false,
        error: "",
      });
      var createForm = createState[0];
      var setCreateForm = createState[1];
      var editState = useState({
        project: null,
        name: "",
        goal: "",
        icon: "",
        busy: false,
        error: "",
      });
      var editForm = editState[0];
      var setEditForm = editState[1];
      var deleteState = useState({ project: null, impact: null, busy: false, error: "" });
      var rowDelete = deleteState[0];
      var setRowDelete = deleteState[1];
      // F63 首启引导：一次性。默认 done=true，避免 RPC 回来之前闪一下引导框。
      // 真正的值来自宿主 storageDomain（projects_ui.firstRunDone，跨重启保留）。
      var firstRunState = useState({
        loaded: false,
        done: true,
        available: false,
        dismissed: false,
      });
      var firstRun = firstRunState[0];
      var setFirstRun = firstRunState[1];

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

      /**
       * 关掉首启引导并落盘 firstRunDone（F63）。
       * storageDomain 不可用时只在本进程内生效——回执里的 available=false 就是"没持久化"的证据。
       */
      var finishFirstRun = useCallback(() => {
        setFirstRun((/** @type {any} */ prev) => ({ ...prev, dismissed: true, done: true }));
        call(api.ctx, "setFirstRunDone", { done: true }).then(
          (/** @type {any} */ readback) => {
            setFirstRun((/** @type {any} */ prev) => ({
              ...prev,
              done: readback?.firstRunDone !== false,
              available: readback?.available === true,
            }));
          },
          () => {
            /* 写失败：本次运行内不再打扰，下次启动会再出现（比假装写成功更诚实） */
          },
        );
      }, [api, setFirstRun]);

      var refresh = useCallback(() => {
        setView((/** @type {any} */ prev) => ({
          loading: true,
          error: prev.error,
          projects: prev.projects,
          describe: prev.describe,
        }));
        return Promise.all([
          call(api.ctx, "listProjects"),
          call(api.ctx, "describe"),
          call(api.ctx, "uiState"),
        ]).then(
          (values) => {
            setView({
              loading: false,
              error: null,
              projects: values[0] || [],
              describe: values[1] || null,
            });
            var ui = values[2];
            if (ui && typeof ui === "object") {
              setFirstRun((/** @type {any} */ prev) => ({
                ...prev,
                loaded: true,
                done: ui.firstRunDone !== false,
                available: ui.available === true,
              }));
            } else {
              setFirstRun((/** @type {any} */ prev) => ({ ...prev, loaded: true }));
            }
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
        var input = {
          goal: String(createForm.goal ?? "").trim(),
          // F2：Context 多选（目录 ≤10 / 仓库 / 图标）一次提交，后端 store 再收敛一遍
          dirs: Array.isArray(createForm.dirs) ? createForm.dirs : [],
          repos: Array.isArray(createForm.repos) ? createForm.repos : [],
          icon: String(createForm.icon ?? "").trim(),
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
              dirs: [],
              dirDraft: "",
              repos: [],
              repoDraft: "",
              icon: "",
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
          // F1：图标也在这里改（短标记，不是图片）
          patch: {
            name,
            goal: String(editForm.goal ?? ""),
            icon: String(editForm.icon ?? ""),
          },
        }).then(
          () => {
            setEditForm({
              project: null,
              name: "",
              goal: "",
              icon: "",
              busy: false,
              error: "",
            });
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
        // F1/F31：等待数来自宿主 pendingInput（权威），未读数来自 pendingInput + 手动标记
        var waiting = Number(project.waiting || 0);
        var working = Number(project.working || 0);
        var unread = Number(project.unread || 0);
        var meta = [
          text(t, "panel.threads", { count: Number(project.threadCount || 0) }),
          waiting > 0 ? text(t, "panel.waiting", { count: waiting }) : "",
          working > 0 && waiting === 0 ? text(t, "panel.working", { count: working }) : "",
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
            // 列表行是主入口：纯键盘用户必须能进详情（审查 P1：以前只有收藏/⋯ 可聚焦）
            role: "button",
            tabIndex: 0,
            "aria-label": project.name,
            onKeyDown: (/** @type {any} */ event) => {
              if (event?.key !== "Enter" && event?.key !== " ") return;
              event.preventDefault();
              setSelectedId(project.id);
            },
            "data-projects-state": project.state,
            "data-row-state": archived ? "archived" : "active",
            "data-projects-row-waiting": String(waiting),
            "data-projects-row-unread-count": String(unread),
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
          // 状态点与详情行同义：等你=强调色（蓝紫）、在跑=暗色；纯视觉，语义由 meta/aria 承担
          waiting > 0 || working > 0
            ? h("span", {
                style: {
                  ...styles.dot,
                  background: waiting > 0 ? T.accentText : T.dim,
                  marginTop: 0,
                },
                "data-projects-row-dot": waiting > 0 ? "waiting" : "working",
                "aria-hidden": "true",
              })
            : null,
          unread > 0
            ? h(
                "span",
                {
                  style: { ...styles.badge, "data-projects-row-unread": project.id },
                  title: text(t, "panel.unread", { count: unread }),
                },
                String(unread),
              )
            : null,
          h(
            "div",
            { style: styles.rowMain },
            h(
              "span",
              { style: styles.name, "data-projects-row-name": project.id },
              project.icon
                ? h(
                    "span",
                    { style: { marginRight: "6px" }, "data-projects-row-icon": project.id },
                    String(project.icon),
                  )
                : null,
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
            archived
              ? h(
                  "span",
                  { style: styles.archiveBadge, "data-projects-row-archived": project.id },
                  project.archivedAt
                    ? text(t, "panel.archivedAt", { date: relativeLabel(t, project.archivedAt) })
                    : text(t, "panel.state.archived"),
                )
              : null,
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
            {
              style: selectedProject ? { ...styles.headRow, display: "none" } : styles.headRow,
              "data-projects-head-row": "",
            },
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
          view.loading && projects.length === 0
            ? h(
                "div",
                { style: { ...styles.meta, padding: "12px 2px" }, "data-projects-loading": "" },
                text(t, "menu.loading"),
              )
            : null,
          view.error
            ? h(
                "div",
                {
                  style: {
                    ...styles.error,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  },
                  "data-projects-error": "",
                },
                h("span", { style: { flex: "1 1 auto" } }, view.error),
                h(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.secondaryButton, fontSize: "11.5px", padding: "1px 8px" },
                    "data-projects-retry": "panel",
                    onClick: () => refresh(),
                  },
                  text(t, "panel.retry"),
                ),
              )
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
          ? h(ProjectDetailSafe, {
              api: api,
              t: t,
              project: selectedProject,
              // F7 项目切换器：详情页标题栏直接换项目，不用先回列表
              projects: projects,
              onSwitchProject: (/** @type {string} */ id) => setSelectedId(id),
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
                  icon: String(target.icon ?? ""),
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
        // F63 首启引导（一次性）：与宿主的「预览版说明」共用同一条用户旅程，排在它之后
        h(FirstRunGuide, {
          t: t,
          open: firstRun.loaded === true && firstRun.done === false && firstRun.dismissed !== true,
          available: firstRun.available === true,
          onDone: finishFirstRun,
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
                h(
                  "label",
                  { style: styles.fieldLabel },
                  h("span", { style: styles.meta }, text(t, "panel.new.iconLabel")),
                  h("input", {
                    style: styles.input,
                    value: String(editForm.icon ?? ""),
                    placeholder: "🚀",
                    maxLength: 8,
                    "data-projects-edit-icon": "",
                    onChange: (/** @type {any} */ event) =>
                      setEditForm((/** @type {any} */ prev) => ({
                        ...prev,
                        icon: event.target.value,
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
    /** B5：字节数的紧凑写法（计量行用；不引入依赖）。 @param {unknown} value */
    function formatBytes(value) {
      var bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }

    /** B5：epoch ms → 相对时间（不依赖宿主的 i18n 格式）。 @param {any} t @param {unknown} value */
    function formatWhen(t, value) {
      // 兼容两种来源：epoch 毫秒（catalog 行）与 ISO 字符串（我们自己记的 `at`）。
      // 只写 Number(value) 会把 ISO 变成 NaN，卡片就显示不出时间（真机踩过）。
      var at = typeof value === "string" ? Date.parse(value) : Number(value);
      if (!Number.isFinite(at) || at <= 0) return "";
      var delta = Date.now() - at;
      if (delta < 60_000) return text(t, "panel.relative.now");
      if (delta < 3_600_000)
        return text(t, "panel.relative.minutes", { count: Math.floor(delta / 60_000) });
      if (delta < 86_400_000)
        return text(t, "panel.relative.hours", { count: Math.floor(delta / 3_600_000) });
      return text(t, "panel.relative.days", { count: Math.floor(delta / 86_400_000) });
    }

    /**
     * B5 · U15：产物缩略卡（标题 + 类型 + 版本 + 时间 + provenance）。
     * Library 列表与线程行内嵌卡共用同一份渲染，避免两处视觉/字段漂移。
     * @param {any} t @param {any} item @param {boolean} available @param {string} keyPrefix
     */
    // ================= M4：产物内容查看器 =================
    /**
     * 极简 Markdown 块解析（与 lib/artifact-render.js 同语义，客户端是 classic script
     * 不能 import，所以这里有一份精简副本；两边都有单测/真机兜着，改动要同步）。
     * @param {string} text
     * @returns {any[]}
     */
    function parseArtifactBlocks(text) {
      var lines = String(text || "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
      var blocks = [];
      /** @type {string[]} */
      var para = [];
      /** @type {any[]} */
      var list = [];
      /** @type {string[]|null} */
      var code = null;
      var flushPara = () => {
        if (para.length) blocks.push({ type: "paragraph", text: para.join(" ") });
        para = [];
      };
      var flushList = () => {
        if (list.length) blocks.push({ type: "list", items: list });
        list = [];
      };
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        const line = raw.trim();
        if (line.indexOf("```") === 0) {
          if (code !== null) {
            blocks.push({ type: "code", text: code.join("\n") });
            code = null;
          } else {
            flushPara();
            flushList();
            code = [];
          }
          continue;
        }
        if (code !== null) {
          code.push(raw);
          continue;
        }
        const h = /^(#{1,6})\s+(.*)/.exec(line);
        if (h) {
          flushPara();
          flushList();
          blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() });
          continue;
        }
        if (
          line.charAt(0) === "|" &&
          i + 1 < lines.length &&
          /^[\s:|-]+$/.test(lines[i + 1].trim()) &&
          lines[i + 1].indexOf("---") >= 0
        ) {
          flushPara();
          flushList();
          const cells = (/** @type {string} */ row) =>
            row
              .trim()
              .replace(/^\\|/, "")
              .replace(/\\|$/u, "")
              .split("|")
              .map((c) => c.trim());
          const header = cells(line);
          const rows = [];
          i += 2;
          while (i < lines.length && lines[i].trim().charAt(0) === "|") {
            rows.push(cells(lines[i]));
            i += 1;
          }
          i -= 1;
          blocks.push({ type: "table", header: header, rows: rows });
          continue;
        }
        const check = /^-\s*\[(x|X| )\]\s*(.*)/.exec(line);
        if (check) {
          flushPara();
          list.push({ text: check[2].trim(), checked: check[1] !== " " });
          continue;
        }
        const bullet = /^-\s+(.*)/.exec(line);
        if (bullet) {
          flushPara();
          list.push({ text: bullet[1].trim(), checked: false });
          continue;
        }
        if (line === "") {
          flushPara();
          flushList();
          continue;
        }
        flushList();
        para.push(line);
      }
      flushPara();
      flushList();
      if (code?.length) blocks.push({ type: "code", text: code.join("\n") });
      return blocks;
    }

    /**
     * 产物内容查看器（弹层）。内容走同源 HTTP 路由 `/artifacts/<id>`（带页面凭据），
     * 不需要新 RPC——所以在旧宿主上也能用。
     * @param {any} props
     */
    function ArtifactViewer(props) {
      var t = props.t;
      var item = props.item || {};
      var st = useState({ loading: true, error: "", blocks: [], text: "" });
      var view = st[0];
      var setView = st[1];
      useEffect(() => {
        var id = String(item.id || "");
        if (id === "") return undefined;
        var alive = true;
        fetch(`/artifacts/${encodeURIComponent(id)}`, { credentials: "same-origin" })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.text();
          })
          .then((text) => {
            if (!alive) return;
            setView({ loading: false, error: "", blocks: parseArtifactBlocks(text), text: text });
          })
          .catch((error) => {
            if (!alive) return;
            setView({
              loading: false,
              error: String(error?.message ? error.message : error),
              blocks: [],
              text: "",
            });
          });
        return () => {
          alive = false;
        };
      }, [item.id]);
      return h(
        "div",
        {
          style: {
            position: "fixed",
            inset: "0",
            zIndex: 40,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          },
          "data-projects-artifact-viewer": String(item.id || ""),
          onClick: (/** @type {any} */ event) => {
            if (event.target === event.currentTarget && typeof props.onClose === "function")
              props.onClose();
          },
        },
        h(
          "div",
          {
            style: {
              width: "min(760px, calc(100vw - 64px))",
              maxHeight: "calc(100vh - 96px)",
              overflow: "auto",
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: "12px",
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 18px 48px rgba(0,0,0,0.35)",
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            h(
              "span",
              { style: { ...styles.name, flex: "1 1 auto", minWidth: 0 } },
              String(item.title || item.id || ""),
            ),
            h(
              "button",
              {
                type: "button",
                style: { ...styles.secondaryButton, padding: "1px 8px", fontSize: "11.5px" },
                "data-projects-artifact-viewer-close": "",
                onClick: () => {
                  if (typeof props.onClose === "function") props.onClose();
                },
              },
              text(t, "artifacts.viewerClose"),
            ),
          ),
          view.loading
            ? h("span", { style: styles.meta }, text(t, "artifacts.viewerLoading"))
            : view.error !== ""
              ? h(
                  "span",
                  { style: styles.error },
                  `${text(t, "artifacts.viewerError")}：${view.error}`,
                )
              : renderArtifactBlocks(view.blocks),
        ),
      );
    }

    /**
     * 把解析后的块渲染成界面：标题 / 段落 / 勾选清单 / 表格 / 代码。
     * @param {any[]} blocks
     */
    function renderArtifactBlocks(blocks) {
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "8px" },
          "data-projects-artifact-body": "",
        },
        (blocks || []).map((block, index) => {
          const key = String(index);
          if (block.type === "heading") {
            const size = block.level <= 1 ? "18px" : block.level === 2 ? "16px" : "14px";
            return h(
              "span",
              { key, style: { fontSize: size, fontWeight: 600, color: T.text } },
              String(block.text || ""),
            );
          }
          if (block.type === "paragraph") {
            return h(
              "span",
              { key, style: { ...styles.meta, lineHeight: "1.6", whiteSpace: "pre-wrap" } },
              String(block.text || ""),
            );
          }
          if (block.type === "list") {
            return h(
              "div",
              { key, style: { display: "flex", flexDirection: "column", gap: "2px" } },
              (block.items || []).map((/** @type {any} */ item, /** @type {number} */ itemIndex) =>
                h(
                  "span",
                  { key: String(itemIndex), style: { ...styles.meta, lineHeight: "1.5" } },
                  `${item.checked ? "✓" : "○"} ${String(item.text || "")}`,
                ),
              ),
            );
          }
          if (block.type === "table") {
            return h(
              "div",
              { key, "data-projects-artifact-table": "", style: { overflowX: "auto" } },
              h(
                "table",
                { style: { borderCollapse: "collapse", fontSize: "12px" } },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    (block.header || []).map(
                      (/** @type {any} */ cell, /** @type {number} */ cellIndex) =>
                        h(
                          "th",
                          {
                            key: String(cellIndex),
                            style: {
                              textAlign: "left",
                              padding: "3px 8px",
                              borderBottom: `1px solid ${T.borderSoft}`,
                              color: T.dim,
                              fontWeight: 600,
                            },
                          },
                          String(cell || ""),
                        ),
                    ),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  (block.rows || []).map((/** @type {any} */ row, /** @type {number} */ rowIndex) =>
                    h(
                      "tr",
                      { key: String(rowIndex) },
                      (row || []).map((/** @type {any} */ cell, /** @type {number} */ cellIndex) =>
                        h(
                          "td",
                          {
                            key: String(cellIndex),
                            style: {
                              padding: "3px 8px",
                              borderBottom: `1px solid ${T.borderSoft}`,
                              color: T.text,
                            },
                          },
                          String(cell || ""),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
          }
          return h(
            "pre",
            {
              key,
              style: {
                ...styles.meta,
                whiteSpace: "pre-wrap",
                fontFamily: "ui-monospace, monospace",
                background: T.bg,
                padding: "6px 8px",
                borderRadius: "6px",
              },
            },
            String(block.text || ""),
          );
        }),
      );
    }

    /**
     * @param {any} t
     * @param {any} item
     * @param {boolean} available
     * @param {string} keyPrefix
     * @param {(item: any) => void} [onOpen]
     */
    function artifactCardFor(t, item, available, keyPrefix, onOpen) {
      var id = String(item?.id ?? "");
      var kind = String(item?.kind ?? "html");
      var known = ["html", "markdown", "json", "csv", "image"];
      var kindLabel = known.indexOf(kind) >= 0 ? text(t, `library.kind.${kind}`) : kind;
      var version = Number(item?.version ?? 1);
      var when = formatWhen(t, item?.updatedAt ?? item?.at);
      var source = item?.source ?? null;
      // 封面：优先用 artifacts 服务给的真实封面地址；旧宿主没透传时按路由约定兜底拼一个
      // （GET /artifacts/<id>/cover.svg，重名/中文 id 都已 URL 编码）。
      var coverUrl = String(item?.coverUrl ?? "");
      if (coverUrl === "" && id !== "") {
        coverUrl = `/artifacts/${encodeURIComponent(id)}/cover.svg`;
      }
      var provenance = source?.sessionId ? String(source.sessionId).slice(0, 8) : "";
      return h(
        "div",
        {
          key: `${keyPrefix}${id}`,
          style: {
            display: "flex",
            gap: "8px",
            alignItems: "flex-start",
            border: `1px solid ${T.borderSoft}`,
            borderRadius: "10px",
            padding: "8px 10px",
            background: T.panel,
            minWidth: 0,
          },
          "data-projects-artifact-card": id,
          "data-projects-artifact-kind": kind,
          "data-projects-artifact-version": String(version),
          "data-projects-artifact-available": available === true ? "true" : "false",
          "data-projects-artifact-time": when || "",
        },
        h(
          "span",
          {
            style: {
              position: "relative",
              width: "38px",
              height: "44px",
              flex: "0 0 38px",
              borderRadius: "6px",
              border: `1px solid ${T.borderSoft}`,
              background: T.card,
              display: "flex",
              flexDirection: "column",
              gap: "3px",
              padding: "7px 6px",
              overflow: "hidden",
            },
            "data-projects-artifact-cover": "",
            title: kindLabel,
          },
          coverUrl !== ""
            ? h("img", {
                src: coverUrl,
                alt: "",
                style: {
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                },
                "data-projects-artifact-cover-img": id,
              })
            : // 没有封面时回退成迷你文档预览（三行灰线）
              h(
                "span",
                {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: "3px",
                    position: "absolute",
                    inset: "7px 6px",
                  },
                },
                h("span", {
                  style: {
                    height: "2px",
                    borderRadius: "1px",
                    background: T.border,
                    width: "100%",
                  },
                }),
                h("span", {
                  style: {
                    height: "2px",
                    borderRadius: "1px",
                    background: T.borderSoft,
                    width: "70%",
                  },
                }),
                h("span", {
                  style: {
                    height: "2px",
                    borderRadius: "1px",
                    background: T.borderSoft,
                    width: "85%",
                  },
                }),
              ),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 } },
          h(
            "span",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                minWidth: 0,
              },
            },
            h(
              "span",
              {
                style: {
                  ...styles.name,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                  flex: "1 1 auto",
                },
                title: String(item?.title || id),
              },
              String(item?.title || id),
            ),
            h(
              "span",
              {
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  color: T.faint,
                  fontSize: "11px",
                  flex: "none",
                },
              },
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.iconButton, padding: "0 2px", color: T.faint },
                  "data-projects-artifact-pin": id,
                  title: text(t, "library.artifactPinHint"),
                  disabled: true,
                },
                uiIcon("pin", "📌", 12),
              ),
              h(
                "span",
                { "data-projects-artifact-menu": id, title: text(t, "library.artifactMenuHint") },
                "⋯",
              ),
            ),
          ),
          h(
            "span",
            { style: { ...styles.meta, fontVariantNumeric: "tabular-nums" } },
            text(t, when === "" ? "library.artifactMetaNoTime" : "library.artifactMeta", {
              kind: kindLabel,
              version: version,
              when: when,
            }),
          ),
          provenance !== "" || source?.toolCallId
            ? h(
                "span",
                { style: { ...styles.meta, color: T.faint } },
                text(t, "library.provenance", {
                  session: provenance || "—",
                  call: source?.toolCallId ? String(source.toolCallId).slice(0, 8) : "—",
                }),
              )
            : null,
          typeof onOpen === "function" && ["markdown", "json", "csv"].indexOf(kind) >= 0
            ? h(
                "button",
                {
                  type: "button",
                  style: {
                    ...styles.secondaryButton,
                    padding: "1px 8px",
                    fontSize: "11px",
                    alignSelf: "flex-start",
                  },
                  "data-projects-artifact-view": id,
                  onClick: (/** @type {any} */ event) => {
                    if (event?.stopPropagation) event.stopPropagation();
                    onOpen(item);
                  },
                },
                text(t, "artifacts.viewerOpen"),
              )
            : null,
        ),
      );
    }

    /**
     * B5 · F33/F34/U15：Library 视图 = 文件面 + 产物面。
     *
     * 视觉对齐 Claude 的 `Artifacts ⌄` 段：小标题 + 计量 + 缩略图列表（标题/类型/版本/时间）。
     * 降级是**明示**的：artifacts 未装或契约不对时写「产物库需要 dsh-artifacts 0.2」，
     * 只列文件面，绝不显示「没有产物」（那是在说谎）。
     * @param {any} props
     */
    function LibraryView(props) {
      const viewerState = useState(null);
      const viewerItem = viewerState[0];
      const setViewerItem = viewerState[1];
      // M4：文件树表格（名称/类型/大小/更新），Claude 的 Library 文件树形态
      const fileTableFor = (/** @type {any} */ dirView) =>
        h(
          "div",
          {
            style: { display: "flex", flexDirection: "column", gap: "1px" },
            "data-projects-library-table": String(dirView.dir),
          },
          h(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) 52px 64px 74px",
                gap: "6px",
                fontSize: "11px",
                color: T.faint,
                padding: "0 2px",
                borderBottom: `1px solid ${T.borderSoft}`,
              },
              "data-projects-library-table-head": "",
            },
            h("span", {}, text(t, "library.colName")),
            h("span", {}, text(t, "library.colType")),
            h("span", { style: { textAlign: "right" } }, text(t, "library.colSize")),
            h("span", { style: { textAlign: "right" } }, text(t, "library.colUpdated")),
          ),
          (Array.isArray(dirView.entries) ? dirView.entries : []).map((/** @type {any} */ entry) =>
            h(
              "div",
              {
                key: String(entry.path),
                style: {
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1fr) 52px 64px 74px",
                  gap: "6px",
                  alignItems: "center",
                  fontSize: "11.5px",
                },
                "data-projects-library-file": String(entry.path),
                "data-projects-library-file-type": String(entry.type || "file"),
                "data-projects-library-file-row": String(entry.path),
              },
              h(
                "span",
                {
                  style: {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "ui-monospace, monospace",
                  },
                  title: String(entry.path),
                },
                `${String(entry.type || "file") === "directory" ? "▸ " : ""}${String(entry.name || entry.path)}`,
              ),
              h("span", { style: { color: T.faint } }, String(entry.type || "file")),
              h(
                "span",
                {
                  style: { textAlign: "right", color: T.faint },
                  "data-projects-library-file-size": String(entry.path),
                },
                Number(entry.size) > 0
                  ? `${Math.max(1, Math.round(Number(entry.size) / 1024))} KB`
                  : "—",
              ),
              h(
                "span",
                {
                  style: { textAlign: "right", color: T.faint },
                  "data-projects-library-file-updated": String(entry.path),
                },
                Number(entry.updatedAt) > 0 ? formatWhen(t, Number(entry.updatedAt)) : "—",
              ),
            ),
          ),
        );

      var api = props.api;
      var t = props.t;
      var project = props.project || {};
      var library = props.library || null;
      var files = library?.files ?? { available: false, reason: "loading", dirs: [] };
      var artifacts = library?.artifacts ?? {
        available: false,
        reason: "loading",
        rows: [],
        stored: [],
        summary: {},
      };
      var stored = Array.isArray(artifacts.stored) ? artifacts.stored : [];
      var rows = Array.isArray(artifacts.rows) ? artifacts.rows : [];
      // 合并：服务在线时以行中的实时数据为准；自存映射补旧产物（同 id 去重）。
      /** @type {Record<string, boolean>} */
      var seen = {};
      /** @type {any[]} */
      var artifactRows = [];
      rows.concat(stored).forEach((/** @type {any} */ item) => {
        var id = String(item?.id ?? "");
        if (id === "" || seen[id]) return;
        seen[id] = true;
        artifactRows.push(item);
      });
      var degraded = artifacts.available !== true;
      var summary = artifacts.summary || {};
      var count = Number(summary.count || artifactRows.length || 0);
      var bytes = Number(summary.bytes || 0);
      var loaded = library !== null && library !== undefined;
      var st = useState({ query: "", busy: false, matches: null, error: "", openNote: "" });
      var view = st[0];
      var setView = st[1];

      var runSearch = () => {
        var query = String(view.query || "").trim();
        if (query === "") {
          setView((/** @type {any} */ prev) => ({ ...prev, matches: null, error: "" }));
          return;
        }
        setView((/** @type {any} */ prev) => ({ ...prev, busy: true, error: "" }));
        call(api.ctx, "searchLibraryFiles", { projectId: project.id, query: query }).then(
          (/** @type {any} */ result) => {
            setView((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              matches: Array.isArray(result?.matches) ? result.matches : [],
              error: result?.available === false ? String(result.reason || "unavailable") : "",
            }));
          },
          (/** @type {any} */ error) => {
            setView((/** @type {any} */ prev) => ({
              ...prev,
              busy: false,
              matches: [],
              error: String(error?.message ?? error).slice(0, 160),
            }));
          },
        );
      };

      /** 右栏服务是否可用（宿主没提供时不渲染成"点了才失败"的按钮）。 */
      var openArtifactPanel = () => {
        // 宿主右栏页签（docs/plugin-conventions §8.5）：拿不到就降级为内联提示，不假装打开了。
        // `sidebarRight` 是晚于插件就绪的服务（官方 ui-reference / artifacts 都写进 inject），
        // 而且**不同版本方法名不同**：openTab(kind, opts) 与 openTabIn(sessionId, kind, opts) 都要试。
        var sidebar =
          api.ctx?.sidebarRight ||
          (typeof api.ctx?.get === "function" ? api.ctx.get("sidebarRight") : undefined);
        var opened = false;
        if (typeof sidebar?.openTab === "function") {
          try {
            sidebar.openTab("artifact", { params: { projectId: project.id } });
            opened = true;
          } catch {
            opened = false;
          }
        }
        var sid = "";
        if (!opened && typeof sidebar?.openTabIn === "function") {
          try {
            sid =
              String(props.threads?.[0]?.sessionId || "") ||
              String(project.coordinatorSessionId || "");
            sidebar.openTabIn(sid, "artifact", { params: { projectId: project.id } });
            opened = true;
          } catch {
            opened = false;
          }
        }
        setView((/** @type {any} */ prev) => ({
          ...prev,
          openNote: opened ? "" : text(t, "library.openPanelUnavailable"),
        }));
        return opened;
      };

      var reasonText = (/** @type {string} */ reason) => {
        if (reason === "no-dir") return text(t, "library.filesNoDir");
        if (reason === "no-session") return text(t, "library.filesNoSession");
        if (reason === "host-unavailable") return text(t, "library.filesHostUnavailable");
        if (reason === "search-failed") return text(t, "library.searchFailed");
        if (reason === "loading") return text(t, "detail.loading");
        return String(reason || "");
      };

      var artifactCard = (/** @type {any} */ item, /** @type {string} */ keyPrefix) =>
        artifactCardFor(t, item, artifacts.available === true, keyPrefix, (target) =>
          setViewerItem(target),
        );

      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "10px" },
          "data-projects-library": "",
          "data-projects-library-loaded": loaded ? "true" : "false",
          "data-projects-library-artifacts-available":
            artifacts.available === true ? "true" : "false",
          "data-projects-library-degraded": degraded
            ? String(artifacts.reason || "unavailable")
            : "false",
        },
        viewerItem
          ? h(ArtifactViewer, {
              t: t,
              item: viewerItem,
              onClose: () => setViewerItem(null),
            })
          : null,
        // —— 标题 + 产物计量 + 打开宿主右栏 ——
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
          h("h3", { style: styles.name }, text(t, "library.title")),
          h(
            "span",
            { style: styles.meta, "data-projects-library-meter": "" },
            text(t, "library.meter", {
              count: count,
              bytes: formatBytes(bytes),
            }),
          ),
          h("span", { style: { flex: "1 1 auto" } }),
          h(
            "button",
            {
              type: "button",
              style: styles.secondaryButton,
              "data-projects-artifact-open": "",
              disabled: degraded,
              title: degraded
                ? text(t, "library.artifactsMissing")
                : text(t, "library.openPanelHint"),
              onClick: openArtifactPanel,
            },
            text(t, "library.openPanel"),
          ),
        ),
        view.openNote
          ? h(
              "div",
              { style: { ...styles.meta, color: T.danger }, "data-projects-library-open-note": "" },
              view.openNote,
            )
          : null,
        // —— 产物面（降级时明示，不显示「没有产物」）——
        degraded
          ? h(
              "div",
              {
                style: {
                  ...styles.meta,
                  border: `1px dashed ${T.border}`,
                  borderRadius: "10px",
                  padding: "8px 10px",
                },
                "data-projects-library-degraded-note": "",
              },
              text(t, "library.artifactsMissing") +
                (artifacts.reason ? `（${String(artifacts.reason)}）` : ""),
            )
          : artifactRows.length === 0
            ? h(
                "div",
                { style: styles.meta, "data-projects-library-artifacts-empty": "" },
                text(t, "library.artifactsEmpty"),
              )
            : h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "6px" },
                  "data-projects-library-artifacts": "",
                },
                h("span", { style: styles.meta }, `${text(t, "library.artifactsTitle")} ⌄`),
                artifactRows.map((item) => artifactCard(item, "lib:")),
              ),
        // —— 文件面：宿主 workspaceFiles（search 只搜文件名，UI 必须写明）——
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
            h("span", { style: styles.name }, text(t, "library.filesTitle")),
            h(
              "span",
              { style: styles.meta, "data-projects-library-file-count": "" },
              text(t, "library.filesCount", { count: Number(files.total || 0) }),
            ),
          ),
          h(
            "span",
            { style: { ...styles.meta, color: T.faint }, "data-projects-library-search-note": "" },
            text(t, "library.searchByNameOnly"),
          ),
          h(
            "div",
            { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
            h("input", {
              type: "text",
              style: { ...styles.input, flex: "1 1 160px" },
              value: view.query,
              placeholder: text(t, "library.searchPlaceholder"),
              "data-projects-library-search": "",
              onChange: (/** @type {any} */ event) => {
                setView((/** @type {any} */ prev) => ({
                  ...prev,
                  query: String(event.target.value || ""),
                }));
              },
              onKeyDown: (/** @type {any} */ event) => {
                if (event.key === "Enter") runSearch();
              },
            }),
            h(
              "button",
              {
                type: "button",
                style: styles.secondaryButton,
                "data-projects-library-search-run": "",
                disabled: view.busy === true,
                onClick: runSearch,
              },
              view.busy ? text(t, "library.searching") : text(t, "library.search"),
            ),
          ),
          view.matches !== null
            ? h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "2px" },
                  "data-projects-library-matches": "",
                },
                view.matches.length === 0
                  ? h("span", { style: styles.meta }, text(t, "library.searchEmpty"))
                  : view.matches.map((/** @type {any} */ match) =>
                      h(
                        "span",
                        {
                          key: String(match.path),
                          style: { ...styles.meta, fontFamily: "ui-monospace, monospace" },
                          "data-projects-library-match": String(match.path),
                        },
                        String(match.path),
                      ),
                    ),
              )
            : null,
          view.error !== "" ? h("span", { style: styles.error }, reasonText(view.error)) : null,
          files.available === false
            ? h(
                "div",
                {
                  style: { ...styles.meta, color: T.faint },
                  "data-projects-library-files-unavailable": String(files.reason || ""),
                },
                reasonText(String(files.reason || "")),
              )
            : h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "6px" },
                  "data-projects-library-files": "",
                },
                (Array.isArray(files.dirs) ? files.dirs : []).map((/** @type {any} */ dirView) =>
                  h(
                    "div",
                    {
                      key: String(dirView.dir),
                      style: { display: "flex", flexDirection: "column", gap: "2px" },
                      "data-projects-library-dir": String(dirView.dir),
                    },
                    h(
                      "span",
                      { style: { ...styles.meta, color: T.faint } },
                      baseName(String(dirView.dir)) +
                        (dirView.truncated === true ? ` · ${text(t, "library.truncated")}` : ""),
                    ),
                    dirView.ok === false
                      ? h("span", { style: styles.error }, reasonText(String(dirView.error || "")))
                      : dirView.entries.length === 0
                        ? h(
                            "span",
                            { style: { ...styles.meta, whiteSpace: "normal", lineHeight: 1.5 } },
                            text(t, "library.filesEmpty"),
                          )
                        : fileTableFor(dirView),
                  ),
                ),
              ),
        ),
      );
    }

    /** @param {any} props */
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
      });
      const data = dataState[0];
      const setData = dataState[1];

      // M4：快捷键（Claude 的 P/R/A/D 思路；这里落到右栏四个视图）。
      // 只在没在输入框里时生效，避免打字被劫持。
      useEffect(() => {
        if (typeof window === "undefined") return undefined;
        const onKeyDown = (/** @type {any} */ event) => {
          if (event?.defaultPrevented || event?.metaKey || event?.ctrlKey || event?.altKey) return;
          const target = event?.target;
          const tag = String(target?.tagName ?? "").toLowerCase();
          if (
            tag === "input" ||
            tag === "textarea" ||
            tag === "select" ||
            target?.isContentEditable
          )
            return;
          const key = String(event?.key ?? "").toLowerCase();
          const next =
            key === "p"
              ? "threads"
              : key === "l"
                ? "library"
                : key === "r"
                  ? "routines"
                  : key === "v"
                    ? "views"
                    : "";
          if (next === "") return;
          setTab(next);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [setTab]);

      const load = useCallback(
        (/** @type {boolean} */ silent) => {
          // 静默刷新：后台轮询不把整页切回「加载中…」，否则行/锚点会周期性消失
          if (silent !== true) {
            setData((/** @type {any} */ prev) => ({ ...prev, loading: true, error: "" }));
          }
          Promise.all([
            call(api.ctx, "progress", { projectId: project.id }),
            call(api.ctx, "getProjectContent", { projectId: project.id }),
            // 审计不再进详情页（§7.3 外迁到设置 Debug），这里不再轮询 listAudit。
            call(api.ctx, "listApprovals", { projectId: project.id }),
            call(api.ctx, "uiState"),
            // B2：协调者区（F9/F11）+ 模型目录（F24）
            call(api.ctx, "coordinatorView", { projectId: project.id }),
            call(api.ctx, "modelCatalog"),
            call(api.ctx, "prPollState"),
            // P0 复审：policy / threadDefaults 的写路径必须能回读——只刷 progress 不够，
            // 父级传进来的 project 是打开详情那一刻的快照，得自己再取一次项目记录。
            call(api.ctx, "getProject", { projectId: project.id }).catch(() => null),
            // B4：右栏「定时任务」段的计数（F36）与提醒待触发数（F30）
            call(api.ctx, "routinesView", { projectId: project.id }).catch(() => null),
            call(api.ctx, "remindersView", { projectId: project.id }).catch(() => null),
            // B5 · F33/F34：Library 视图（文件面 workspaceFiles + 产物面 artifacts / 自存映射）
            call(api.ctx, "libraryView", { projectId: project.id }).catch(() => null),
          ]).then(
            (values) => {
              setData({
                loading: false,
                error: "",
                threads: Array.isArray(values[0]?.rows) ? values[0].rows : [],
                progress: values[0] || null,
                projectState: values[0]?.projectState ?? project.state,
                content: values[1] || null,
                approvals: Array.isArray(values[2]) ? values[2] : [],
                ui: values[3] || null,
                coordinator: values[4] || null,
                models: values[5] || null,
                poll: values[6] || null,
                liveProject: values[7] || null,
                routines: (() => {
                  const view = values[8];
                  if (!view || view.available === false)
                    return { count: 0, summary: "宿主 schedule 不可用" };
                  const count = Array.isArray(view.routines) ? view.routines.length : 0;
                  return {
                    count,
                    summary: count === 0 ? "还没有定时任务" : `${count} 个定时任务`,
                  };
                })(),
                reminders: values[9] || null,
                library: values[10] || null,
              });
              // F25 折叠状态存宿主 storageDomain（跨重启保留）；读不到就当全部展开。
              // 只在首次加载时套用：否则 5s 轮询会用旧值把用户刚点的折叠弹回去。
              if (collapsedInitRef.current !== true) {
                collapsedInitRef.current = true;
                if (values[3] && typeof values[3].collapsedGroups === "object") {
                  setCollapsedGroups({ ...values[3].collapsedGroups });
                }
              }
            },
            (error) => {
              setData({
                loading: false,
                error: String(error?.message ?? error),
                threads: [],
                content: null,
              });
            },
          );
        },
        [api, project.id],
      );
      // Overview 自己会变（线程跑完一轮、宿主 pendingInput 出现）：5s 静默刷新一次。
      // 不切 loading、只更新数据；事件驱动的实时化（去掉轮询）留给 B2 的 replay 修复。
      useEffect(() => {
        const timer = setInterval(() => {
          // 后台标签页不轮询：详情页一轮是 11 个 RPC，藏着页面跑纯浪费
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          load(true);
        }, 5000);
        return () => clearInterval(timer);
      }, [load]);
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
            (/** @type {any} */ result) => {
              // 记录删了，但 worktree/分支还在磁盘：如实提示，别让用户以为已经清干净
              setThreadAction({
                pending: "",
                ok: true,
                message: result?.worktree
                  ? text(t, "detail.threadRemovedWithWorktree", { path: String(result.worktree) })
                  : text(t, "detail.threadRemoved"),
              });
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
      // Claude 只有一个 composer：这里用目标切换统一「协调者 / 新线程」两条发送路
      const composerTargetState = useState("thread");
      const composerTarget = composerTargetState[0];
      const setComposerTarget = composerTargetState[1];
      // 「按规则派活」默认收起：它是补充入口，不该和 composer 抢视觉位置（Claude 只有一个输入框）
      const routeRowState = useState(false);
      const showRouteRow = routeRowState[0];
      const setShowRouteRow = routeRowState[1];
      // 主列顶部的排障信息（PR 轮询/compaction/实时监听）默认收起：
      // 参考图的主列是"对话内容优先"，这些属于诊断，折成一行摘要
      const prBarClosedState = useState("");
      const prBarClosed = prBarClosedState[0];
      const setPrBarClosed = prBarClosedState[1];
      const groupHoverState = useState("");
      const [groupHover, setGroupHover] = groupHoverState;
      const diagnosticsState = useState(false);
      const showDiagnostics = diagnosticsState[0];
      const setShowDiagnostics = diagnosticsState[1];
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
      // 破坏性确认框要默认聚焦主按钮（ADR 0002 / conventions §7.4.2「回车即执行」）。
      // 宿主的 useModalLayer 只服务它自己的 Modal 组件；这里的确认框是面板内联的，得自己聚焦。
      // 主按钮 busy/disabled 时拿不到焦点，回落到第一个可用按钮（即「取消」）。
      const deleteConfirmRef = useRef(null);
      useEffect(() => {
        if (del.confirming !== true) return;
        const host = deleteConfirmRef.current;
        if (!host) return;
        const target =
          host.querySelector("[data-modal-autofocus]") ||
          host.querySelector("button:not([disabled])");
        if (target && typeof target.focus === "function") target.focus();
      }, [del.confirming]);
      // 关闭确认框：状态复位 + 焦点还给触发它的按钮（审查：Esc 之前完全没反应）
      const closeDeleteConfirm = useCallback(() => {
        setDel({ confirming: false, busy: false, impact: null });
        const doc = typeof document === "undefined" ? null : document;
        const target = /** @type {any} */ (
          doc?.querySelector("[data-projects-delete]") ??
            doc?.querySelector("[data-projects-row-menu]")
        );
        if (target && typeof target.focus === "function") target.focus();
      }, [setDel]);
      useEffect(() => {
        if (del.confirming !== true) return undefined;
        const doc = typeof document === "undefined" ? null : document;
        if (!doc) return undefined;
        const onKey = (/** @type {any} */ event) => {
          if (event?.key === "Escape") {
            event.preventDefault();
            closeDeleteConfirm();
          }
        };
        doc.addEventListener("keydown", onKey);
        return () => doc.removeEventListener("keydown", onKey);
      }, [del.confirming, closeDeleteConfirm]);
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
      const dirEditingState = useState(false);
      const dirEditing = dirEditingState[0];
      const setDirEditing = dirEditingState[1];
      // F35 多目录编辑：pending 列表在保存前只改本地；保存时一次性写回（≤10）
      const dirPendingState = useState([]);
      const dirPending = dirPendingState[0];
      const setDirPending = dirPendingState[1];
      const saveDir = useCallback(() => {
        const value = String(dirDraft).trim();
        // 相对路径/空值当场拒绝：以前会被静默存下来，直到建线程时才崩在宿主里，
        // 报错还是"cwd must be an absolute path"，用户根本对不上号（验收时踩到）
        if (value !== "" && !value.startsWith("/")) {
          setDirInfo({ path: value, exists: false, isGit: false, writable: false, invalid: true });
          return;
        }
        // F35：pending 列表 + 本次输入一次写回；去重、上限 10（后端也会拒）
        const next = [...(Array.isArray(dirPending) ? dirPending : [])];
        if (value !== "" && !next.includes(value)) {
          if (next.length >= MAX_CONTEXT_DIRS) {
            setDirInfo({
              path: value,
              exists: false,
              isGit: false,
              writable: false,
              invalid: true,
            });
            if (typeof props.onToast === "function") {
              props.onToast(text(t, "detail.dirLimit", { count: MAX_CONTEXT_DIRS }));
            }
            return;
          }
          next.push(value);
        }
        const primary = next[0] ?? "";
        call(api.ctx, "updateProject", {
          id: project.id,
          patch: { dirs: next },
        })
          .then(() => {
            // 绑完立刻探一次：非 git 目录意味着线程**不会隔离**，必须当场说清（走查发现静默降级）
            if (primary === "") {
              setDirInfo({ path: "", exists: false, isGit: false, writable: false });
              return;
            }
            call(api.ctx, "inspectDir", { options: { path: primary } }).then(
              (/** @type {any} */ info) => setDirInfo({ path: primary, ...info }),
              () => setDirInfo({ path: primary, exists: true, isGit: false, writable: true }),
            );
          })
          .then(() => {
            load();
            // 父级列表缓存着 project.dirs：不刷新，右栏「项目目录」值行会显示旧值
            if (typeof props.onChanged === "function") props.onChanged();
          })
          .catch((/** @type {any} */ error) => {
            setData((/** @type {any} */ prev) => ({
              ...prev,
              error: String(error?.message ?? error),
            }));
          });
      }, [api, dirDraft, dirPending, load, project.id, props, setData, setDirInfo, t]);

      const createThread = useCallback(() => {
        const task = String(draft).trim();
        if (task === "" || busy) return;
        setBusy(true);
        call(api.ctx, "createThread", { projectId: project.id, task }).then(
          (/** @type {any} */ created) => {
            setDraft("");
            setBusy(false);
            load();
            // 线程建了但首条任务没送达：以前完全静默，用户会看到一条永远 idle 的线程
            if (created?.warning) {
              setThreadAction({
                pending: "",
                ok: false,
                message: text(t, "detail.threadPromptFailed", {
                  reason: String(created.warning),
                }),
              });
            }
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

      // —— B2 本地状态：协调者发送 / 线程展开 / steer / 模型 / Create PR ——
      const coordinatorDraftState = useState("");
      const coordinatorDraft = coordinatorDraftState[0];
      const setCoordinatorDraft = coordinatorDraftState[1];
      const coordinatorBusyState = useState(false);
      const coordinatorBusy = coordinatorBusyState[0];
      const setCoordinatorBusy = coordinatorBusyState[1];
      const coordinatorMsgState = useState("");
      const coordinatorMsg = coordinatorMsgState[0];
      const setCoordinatorMsg = coordinatorMsgState[1];
      const expandedState = useState("");
      const expandedThread = expandedState[0];
      // M4：PR 三段式卡的数据源（只读 prOverview；合并/审阅动作需要新 seam）
      const artifactViewerState = useState(/** @type {any} */ (null));
      const artifactViewer = artifactViewerState[0];
      const setArtifactViewer = artifactViewerState[1];
      // 合并 PR 的二次确认（同一时刻只 armed 一条线程）
      const mergeArmState = useState("");
      const mergeArm = mergeArmState[0];
      const setMergeArm = mergeArmState[1];
      const prInfoState = useState(/** @type {any} */ ({}));
      const prInfo = prInfoState[0];
      // PR 概览缓存加 TTL：以前拿到一次就永不刷新，CI/合并状态会一直停在旧值
      const prInfoAtState = useState(/** @type {Record<string, number>} */ ({}));
      const prInfoAt = prInfoAtState[0];
      const setPrInfoAt = prInfoAtState[1];
      const setPrInfo = prInfoState[1];
      // 展开某条线程时拉一次 PR 概览（有 prNumber 才拉；失败不打扰）
      useEffect(() => {
        const sid = String(expandedThread || "");
        const fetchedAt = Number(prInfoAt[sid] ?? 0);
        if (sid === "" || (prInfo[sid] !== undefined && Date.now() - fetchedAt < 30_000)) return;
        const row = (data.progress?.rows ?? []).find(
          (/** @type {any} */ item) => String(item.sessionId) === sid,
        );
        if (!row || Number(row.prNumber) <= 0) return;
        const markFetched = () =>
          setPrInfoAt((/** @type {any} */ prev) => ({ ...prev, [sid]: Date.now() }));
        call(api.ctx, "prOverview", { projectId: project.id, sessionId: sid }).then(
          (/** @type {any} */ result) => {
            setPrInfo((/** @type {any} */ prev) => ({ ...prev, [sid]: result }));
            markFetched();
          },
          () => {
            setPrInfo((/** @type {any} */ prev) => ({ ...prev, [sid]: { ok: false } }));
            markFetched();
          },
        );
      }, [
        api,
        data.progress,
        expandedThread,
        prInfo,
        prInfoAt,
        project.id,
        setPrInfo,
        setPrInfoAt,
      ]);

      const setExpandedThread = expandedState[1];
      const steerDraftState = useState("");
      const steerDraft = steerDraftState[0];
      const setSteerDraft = steerDraftState[1];
      const busyActionState = useState("");
      const busyAction = busyActionState[0];
      const setBusyAction = busyActionState[1];
      const modelPickState = useState({});
      const modelPick = modelPickState[0];
      const setModelPick = modelPickState[1];
      // F24/P1-3：effort 下拉与宿主回读（以前只传 provider/model，effort 从不传）
      const modelEffortPickState = useState({});
      const modelEffortPick = modelEffortPickState[0];
      const setModelEffortPick = modelEffortPickState[1];
      const modelSelectionState = useState({});
      const modelSelection = modelSelectionState[0];
      const setModelSelection = modelSelectionState[1];

      const sendCoordinator = useCallback(() => {
        const value = String(coordinatorDraft).trim();
        if (value === "" || coordinatorBusy) return;
        setCoordinatorBusy(true);
        setCoordinatorMsg("");
        call(api.ctx, "sendToCoordinator", { projectId: project.id, text: value }).then(
          (/** @type {any} */ result) => {
            setCoordinatorBusy(false);
            setCoordinatorDraft("");
            setCoordinatorMsg(
              result?.created === true
                ? text(t, "detail.coordinatorCreated")
                : text(t, "detail.coordinatorMsgSent"),
            );
            load(true);
          },
          (/** @type {any} */ error) => {
            setCoordinatorBusy(false);
            setCoordinatorMsg(String(error?.message ?? error).slice(0, 200));
          },
        );
      }, [api, coordinatorBusy, coordinatorDraft, load, project.id, t]);

      const createCoordinator = useCallback(() => {
        if (coordinatorBusy) return;
        setCoordinatorBusy(true);
        setCoordinatorMsg("");
        call(api.ctx, "ensureCoordinator", { projectId: project.id }).then(
          (/** @type {any} */ result) => {
            setCoordinatorBusy(false);
            setCoordinatorMsg(
              result?.created === true
                ? text(t, "detail.coordinatorCreated")
                : text(t, "detail.coordinatorMsgSent"),
            );
            load(true);
          },
          (/** @type {any} */ error) => {
            setCoordinatorBusy(false);
            setCoordinatorMsg(String(error?.message ?? error).slice(0, 200));
          },
        );
      }, [api, coordinatorBusy, load, project.id, t]);

      const restartCoordinator = useCallback(() => {
        if (coordinatorBusy) return;
        setCoordinatorBusy(true);
        setCoordinatorMsg("");
        call(api.ctx, "restartCoordinator", { projectId: project.id }).then(
          () => {
            setCoordinatorBusy(false);
            setCoordinatorMsg(text(t, "detail.coordinatorRestarted"));
            load(true);
          },
          (/** @type {any} */ error) => {
            setCoordinatorBusy(false);
            setCoordinatorMsg(String(error?.message ?? error).slice(0, 200));
          },
        );
      }, [api, coordinatorBusy, load, project.id, t]);

      const steerThreadNow = useCallback(
        (/** @type {string} */ sessionId) => {
          const value = String(steerDraft).trim();
          if (value === "" || busyAction !== "") return;
          setBusyAction(`steer:${sessionId}`);
          call(api.ctx, "steerThread", { sessionId, text: value }).then(
            (/** @type {any} */ result) => {
              setBusyAction("");
              setSteerDraft("");
              setThreadAction({
                pending: "",
                ok: true,
                message:
                  result?.running === true
                    ? text(t, "detail.steered")
                    : text(t, "detail.steeredQueued"),
              });
              load(true);
            },
            (/** @type {any} */ error) => {
              setBusyAction("");
              setThreadAction({
                pending: "",
                ok: false,
                message: String(error?.message ?? error).slice(0, 200),
              });
            },
          );
        },
        [api, busyAction, load, setThreadAction, steerDraft, t],
      );

      const applyModel = useCallback(
        (
          /** @type {string} */ sessionId,
          /** @type {any} */ option,
          /** @type {string} */ effort,
        ) => {
          if (!option || busyAction !== "") return;
          setBusyAction(`model:${sessionId}`);
          const wantedEffort = String(effort ?? "").trim();
          call(api.ctx, "selectThreadModel", {
            projectId: project.id,
            sessionId,
            input: {
              provider: option.provider,
              model: option.model,
              // 空串 = 继承宿主默认（服务端只在不空时带上该字段）
              reasoningEffort: wantedEffort,
            },
          }).then(
            (/** @type {any} */ result) => {
              setBusyAction("");
              setModelSelection((/** @type {any} */ prev) => ({
                ...prev,
                [sessionId]: result?.selection ?? null,
              }));
              setThreadAction({
                pending: "",
                ok: true,
                message:
                  wantedEffort === ""
                    ? text(t, "detail.modelSaved", { model: String(result?.model ?? "") })
                    : text(t, "detail.modelSavedEffort", {
                        model: String(result?.model ?? ""),
                        effort: String(result?.reasoningEffort ?? wantedEffort),
                      }),
              });
              load(true);
            },
            (/** @type {any} */ error) => {
              setBusyAction("");
              setThreadAction({
                pending: "",
                ok: false,
                message: String(error?.message ?? error).slice(0, 200),
              });
            },
          );
        },
        [api, busyAction, load, project.id, setThreadAction, t],
      );

      const createPrFor = useCallback(
        (/** @type {string} */ sessionId) => {
          if (busyAction !== "") return;
          setBusyAction(`pr:${sessionId}`);
          call(api.ctx, "createPr", { projectId: project.id, sessionId }).then(
            (/** @type {any} */ result) => {
              setBusyAction("");
              const opened = result?.opened === true;
              setThreadAction({
                pending: "",
                ok: opened,
                message: opened
                  ? text(t, "detail.prCreated", { number: Number(result?.prNumber ?? 0) })
                  : text(t, "detail.prFailed", { reason: String(result?.reason ?? "?") }),
              });
              load(true);
            },
            (/** @type {any} */ error) => {
              setBusyAction("");
              setThreadAction({
                pending: "",
                ok: false,
                message: String(error?.message ?? error).slice(0, 200),
              });
            },
          );
        },
        [api, busyAction, load, project.id, setThreadAction, t],
      );

      // F21（B2 复审 P1-2）：auto-fix 的手动触发入口。
      // 以前 `autoFixStep` 只有服务端实现、没有任何调用者，等于死代码；这里把它接到按钮上，
      // 结果（继续修 / 停下 + 原因）回显到行内动作条，审计由服务端写（autofix/round|stopped）。
      const autofixFor = useCallback(
        (/** @type {string} */ sessionId) => {
          if (busyAction !== "") return;
          setBusyAction(`fix:${sessionId}`);
          call(api.ctx, "autoFixStep", {
            projectId: project.id,
            input: { sessionId, log: "", changedFiles: [] },
          }).then(
            (/** @type {any} */ result) => {
              setBusyAction("");
              const continued = result?.continued === true;
              setThreadAction({
                pending: "",
                ok: continued,
                message: continued
                  ? text(t, "detail.autofixStarted", {
                      round: Number(result?.round ?? 0),
                      reason: String(result?.reason ?? "queued"),
                    })
                  : text(t, "detail.autofixStopped", { reason: String(result?.reason ?? "?") }),
              });
              load(true);
            },
            (/** @type {any} */ error) => {
              setBusyAction("");
              setThreadAction({
                pending: "",
                ok: false,
                message: String(error?.message ?? error).slice(0, 200),
              });
            },
          );
        },
        [api, busyAction, load, project.id, setThreadAction, t],
      );

      // F24：把 modelCatalog 摊平成 <option>；结构不认识就返回空（UI 明说"没暴露"）
      const modelOptions = (() => {
        const groups = Array.isArray(data.models?.groups) ? data.models.groups : [];
        /** @type {Array<{ key: string, provider: string, model: string, efforts: string[], label: string }>} */
        const out = [];
        for (const group of groups) {
          const models = Array.isArray(group?.models)
            ? group.models
            : Array.isArray(group?.items)
              ? group.items
              : [];
          for (const model of models) {
            const id =
              typeof model === "string"
                ? model
                : String(model?.id ?? model?.model ?? model?.name ?? "");
            if (id === "") continue;
            const provider = String(group?.provider ?? group?.id ?? group?.name ?? "");
            // F24/P1-3：尽力取 reasoning.efforts（可能是字符串数组，也可能是 {id,label} 数组）
            const reasoning = model && typeof model === "object" ? (model.reasoning ?? {}) : {};
            const rawEfforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
            const efforts = rawEfforts
              .map((/** @type {any} */ item) =>
                typeof item === "string"
                  ? item
                  : String(item?.id ?? item?.value ?? item?.name ?? ""),
              )
              .filter((/** @type {string} */ item) => item !== "");
            out.push({
              key: `${provider}:${id}`,
              provider,
              model: id,
              efforts,
              label: `${String(group?.label ?? group?.name ?? provider)}/${id}`,
            });
          }
        }
        return out;
      })();

      // 3.x：composer 的模型/档位药丸（Claude 的 `Opus 5.5 · Low ▾`）
      const composerModelOpenState = useState(false);
      const composerModelOpen = composerModelOpenState[0];
      const setComposerModelOpen = composerModelOpenState[1];
      const composerPickState = useState(/** @type {any} */ (null));
      // 协调者 composer 的药丸（D3：写 coordinatorDefaults，与线程默认独立）
      // M3：协调者消息折叠（只显示最近 3 条，更早的折起来）
      const coordFoldState = useState(false);
      const coordFoldOpen = coordFoldState[0];
      const setCoordFoldOpen = coordFoldState[1];
      const coordPillOpenState = useState(false);
      const coordPillOpen = coordPillOpenState[0];
      const setCoordPillOpen = coordPillOpenState[1];
      const coordPickState = useState(/** @type {any} */ (null));
      const coordPick = coordPickState[0];
      const setCoordPick = coordPickState[1];
      const coordinatorDefaults = data.progress?.coordinatorDefaults ??
        data.liveProject?.coordinatorDefaults ??
        props.project?.coordinatorDefaults ?? {
          provider: "",
          model: "",
          reasoningEffort: "",
        };
      const coordPillLabel = (() => {
        const model = String(coordinatorDefaults.model ?? "");
        if (model === "") return text(t, "detail.composerModelInherit");
        const provider = String(coordinatorDefaults.provider ?? "");
        const effort = String(coordinatorDefaults.reasoningEffort ?? "");
        const base = provider === "" ? model : `${provider}/${model}`;
        return effort === "" ? base : `${base} · ${effort}`;
      })();
      const coordPicked = coordPick ?? {
        provider: String(coordinatorDefaults.provider ?? ""),
        model: String(coordinatorDefaults.model ?? ""),
        effort: String(coordinatorDefaults.reasoningEffort ?? ""),
      };
      const saveCoordinatorModel = () => {
        call(api.ctx, "setCoordinatorDefaults", {
          projectId: project.id,
          provider: String(coordPicked.provider ?? ""),
          model: String(coordPicked.model ?? ""),
          reasoningEffort: String(coordPicked.effort ?? ""),
        }).then(
          () => {
            setCoordPillOpen(false);
            setCoordPick(null);
            setThreadAction({ pending: "", ok: true, message: "协调者默认已保存" });
            load();
          },
          (/** @type {any} */ error) =>
            setThreadAction({
              pending: "",
              ok: false,
              message: `协调者默认模型保存失败：${String(error?.message ?? error).slice(0, 160)}`,
            }),
        );
      };
      const composerPick = composerPickState[0];
      const setComposerPick = composerPickState[1];
      // 读**回读值**（getProject 的 liveProject），不是父级列表快照——否则保存后药丸不变
      const threadDefaults = data.progress?.threadDefaults ??
        data.liveProject?.threadDefaults ??
        props.project?.threadDefaults ?? {
          provider: "",
          model: "",
          reasoningEffort: "",
        };
      const composerModelLabel = (() => {
        const model = String(threadDefaults.model ?? "");
        const effort = String(threadDefaults.reasoningEffort ?? "");
        if (model === "") return text(t, "detail.composerModelInherit");
        const provider = String(threadDefaults.provider ?? "");
        const base = provider === "" ? model : `${provider}/${model}`;
        return effort === "" ? base : `${base} · ${effort}`;
      })();
      const composerPicked = composerPick ?? {
        model: String(threadDefaults.model ?? ""),
        effort: String(threadDefaults.reasoningEffort ?? ""),
      };
      const composerPickEntry = modelOptions.find(
        (/** @type {any} */ option) => option.key === String(composerPicked.model ?? ""),
      );
      const composerEfforts = Array.isArray(composerPickEntry?.efforts)
        ? composerPickEntry.efforts
        : [];
      const saveComposerModel = () => {
        const key = String(composerPicked.model ?? "");
        const sep = key.indexOf(":");
        const provider = sep >= 0 ? key.slice(0, sep) : "";
        const model = sep >= 0 ? key.slice(sep + 1) : key;
        call(api.ctx, "setThreadDefaults", {
          projectId: project.id,
          provider,
          model,
          reasoningEffort: String(composerPicked.effort ?? ""),
        }).then(
          () => {
            setComposerModelOpen(false);
            setComposerPick(null);
            load();
          },
          (/** @type {any} */ error) =>
            setThreadAction({
              pending: "",
              ok: false,
              message: String(error?.message ?? error).slice(0, 200),
            }),
        );
      };

      // 页签最多 3 个（docs/plugin-conventions.md §7.3）：Library 走右栏入口、审计进设置 Debug，
      // 两者都不再占页签，页签只剩「线程 / 记忆 / Routines」。
      const tabs = [
        {
          id: "threads",
          label: text(t, "detail.tab.threads", {
            count: data.progress?.total ?? data.threads.length,
          }),
        },
        { id: "library", label: text(t, "detail.tab.library") },
        { id: "routines", label: "Routines" },
        { id: "views", label: text(t, "detail.tab.views") },
      ];

      // 右栏 Library 行的一行摘要（文件面 + 产物面；数据没到就说「打开查看」）
      const libraryRailSummary = (() => {
        const library = data.library;
        if (!library) return text(t, "library.railLoading");
        return text(t, "library.railSummary", {
          files: Number(library.files?.total || 0),
          artifacts: Number(library.artifacts?.summary?.count || 0),
        });
      })();
      const budgetText = data.progress?.budget
        ? text(t, "detail.budget", {
            today: data.progress.budget.used?.today ?? 0,
            running: data.progress.budget.used?.running ?? 0,
          })
        : "";
      const projectStateText =
        data.projectState === "archived"
          ? text(t, "detail.projectState.archived")
          : data.projectState === "paused"
            ? text(t, "detail.projectState.paused")
            : text(t, "detail.projectState.active");
      const dirList = Array.isArray(project.dirs) ? project.dirs : [];
      const dirSummary = dirList.length > 0 ? baseName(dirList[0]) : text(t, "detail.none");
      // 值行点「编辑」才出输入控件（右栏不常驻 input）
      // 线程行的「⋯」：回收目录 / 移除追踪 收进来（锚点挂在菜单项上，语义不变）
      const threadMenuState = useState("");
      const threadMenu = threadMenuState[0];
      const setThreadMenu = threadMenuState[1];
      const threadHoverState = useState("");
      const threadHover = threadHoverState[0];
      const setThreadHover = threadHoverState[1];
      const grantsEditingState = useState(false);
      const grantsEditing = grantsEditingState[0];
      const setGrantsEditing = grantsEditingState[1];
      // F29：自动 resolve 的读回值（RPC 回执优先于 props，避免「点了没变」的假开关）
      const autoResolveState = useState(null);
      const autoResolveLocal = autoResolveState[0];
      const setAutoResolveLocal = autoResolveState[1];
      /** 目录编辑：路径非法时**不关窗**（让「必须绝对路径」的说明留在原位） */
      const submitDir = () => {
        const value = String(dirDraft).trim();
        // 非法路径也要交给 saveDir：它只改 dirInfo（当场说明为什么不行），不写盘
        saveDir();
        if (value !== "" && !value.startsWith("/")) return; // 不关窗，让用户改
        setDirEditing(false);
      };

      // —— 详情页新增的本地状态（两列布局 / ⋯ 菜单 / 收藏 / 窄窗）——
      const menuState = useState(false);
      const menuOpen = menuState[0];
      const setMenuOpen = menuState[1];
      const pinState = useState(null);
      const pinnedLocal = pinState[0];
      const setPinnedLocal = pinState[1];
      const gridRef = useRef(null);
      const narrowState = useState(false);
      const colorScheme = useColorScheme();
      const narrow = narrowState[0];
      const setNarrow = narrowState[1];
      const content = data.content || {};
      const counts = data.progress?.counts ?? {};
      const pills = data.progress?.pills ?? counts;
      // —— B1 Overview（F25/F26/F27/F28/F29/F31）：药丸过滤 / 分组折叠 / 组内轮播 / 切换器 ——
      const filterState = useState("");
      const filter = filterState[0];
      const setFilter = filterState[1];
      const collapsedState = useState({});
      const collapsedGroups = collapsedState[0];
      const setCollapsedGroups = collapsedState[1];
      const carouselState = useState({});
      const carousel = carouselState[0];
      const setCarousel = carouselState[1];
      const switcherState = useState(false);
      const switcherOpen = switcherState[0];
      const setSwitcherOpen = switcherState[1];
      const groupMenuState = useState("");
      const groupMenu = groupMenuState[0];
      const setGroupMenu = groupMenuState[1];
      // 设置抽屉：rail 里的 15 段设置不再常驻右栏（Claude 是独立 Project settings），
      // 由面板 header 的 ⚙ 打开；锚点保持原样，冒烟/桌面回归照旧能点。
      // D1：右栏可见性持久化在项目记录里（visibleViews）；override 只做乐观反馈
      // M3：生成态的秒数需要每秒重渲染（只在有 working 行时开定时器）
      const tickState = useState(0);
      // 只用 setter 强制重渲染（tick 值本身不参与计算）
      const setTick = tickState[1];
      const hasWorkingRow = (data.progress?.rows ?? []).some(
        (/** @type {any} */ row) => String(row?.view?.state ?? "") === "working",
      );
      useEffect(() => {
        if (!hasWorkingRow) return undefined;
        const timer = setInterval(() => {
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          setTick((/** @type {number} */ n) => n + 1);
        }, 1000);
        return () => clearInterval(timer);
      }, [hasWorkingRow, setTick]);
      const stepsHoverIdState = useState("");
      const stepsHoverId = stepsHoverIdState[0];
      const setStepsHoverId = stepsHoverIdState[1];
      const visibleOverrideState = useState(/** @type {string[]|null} */ (null));
      const visibleOverride = visibleOverrideState[0];
      const setVisibleOverride = visibleOverrideState[1];
      const storedVisibleViews = Array.isArray(data.progress?.visibleViews)
        ? data.progress.visibleViews
        : Array.isArray(project.visibleViews)
          ? project.visibleViews
          : ["library", "routines"];
      const visibleList = visibleOverride ?? storedVisibleViews;
      /** @type {Record<string, boolean>} */
      const visibleTabs = {
        threads: true,
        library: visibleList.indexOf("library") >= 0,
        routines: visibleList.indexOf("routines") >= 0,
      };
      // 盘上值追上选择后，清掉乐观 override
      useEffect(() => {
        if (visibleOverride === null) return;
        if (storedVisibleViews.join(",") === visibleOverride.join(",")) setVisibleOverride(null);
      }, [storedVisibleViews.join(","), visibleOverride, setVisibleOverride]);
      const toggleVisibleView = (/** @type {string} */ id, /** @type {boolean} */ next) => {
        try {
          document.body.setAttribute("data-projects-toggle-hit", `${id}:${String(next)}`);
        } catch {
          /* ignore */
        }
        const base = visibleList.filter((/** @type {string} */ item) => item !== id);
        const nextList = next ? [...base, id] : base;
        setVisibleOverride(nextList);
        let pending = null;
        try {
          pending = call(api.ctx, "setVisibleViews", {
            projectId: project.id,
            // 标量参数最稳：数组/嵌套对象过网关都可能被收窄
            viewsText: nextList.join(","),
          });
        } catch (error) {
          try {
            document.body.setAttribute(
              "data-projects-view-error",
              `sync: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 240)}`,
            );
          } catch {
            /* ignore */
          }
          return;
        }
        try {
          document.body.setAttribute("data-projects-view-stage", "then-attached");
        } catch {
          /* ignore */
        }
        pending.then(
          (/** @type {any} */ result) => {
            try {
              document.body.setAttribute("data-projects-view-stage", "resolved");
              document.body.setAttribute(
                "data-projects-view-result",
                JSON.stringify(result ?? null).slice(0, 240),
              );
            } catch {
              /* ignore */
            }
            // 不清 override：等 load() 回读到与选择一致的盘上值再清。
            // 旧宿主若忽略 visibleViews，UI 仍按选择隐藏（只是刷新后回默认）。
            load();
          },
          (/** @type {any} */ error) => {
            try {
              document.body.setAttribute("data-projects-view-stage", "rejected");
            } catch {
              /* ignore */
            }
            setVisibleOverride(null);
            // 调试/回归用：把失败原因挂在 DOM 上，别静默吞掉（本轮排查就卡在这）
            try {
              document.body.setAttribute(
                "data-projects-view-error",
                String(error?.message ?? error).slice(0, 300),
              );
            } catch {
              /* ignore */
            }
          },
        );
      };
      const viewNameState = useState("");
      const viewName = viewNameState[0];
      const setViewName = viewNameState[1];
      const panelQueryState = useState("");
      const panelQuery = panelQueryState[0];
      const setPanelQuery = panelQueryState[1];
      const panelPaneState = useState("general");
      const panelPane = panelPaneState[0];
      const setPanelPane = panelPaneState[1];
      const panelSettingsState = useState(false);
      const panelSettingsOpen = panelSettingsState[0];
      const setPanelSettingsOpen = panelSettingsState[1];
      const threadInputRef = useRef(null);
      const collapsedInitRef = useRef(false);
      // F28 `Welcome back, {名}.`：宿主账号没有注入到插件 client（settings.section 之外），
      // 只能走 deepseekAccount/getState 这个 Remote 试读；未登录/未挂载时如实退化成
      // 「Welcome back.」（不拿项目名冒充人名）。
      const userNameState = useState("");
      const userName = userNameState[0];
      const setUserName = userNameState[1];
      useEffect(() => {
        let cancelled = false;
        const rpc = api.ctx?.connection?.rpc;
        if (!rpc || typeof rpc.call !== "function") return undefined;
        Promise.resolve(rpc.call("/api", "deepseekAccount/getState", { args: { _request: {} } }))
          .then((/** @type {any} */ result) => {
            if (cancelled) return;
            const value =
              result && typeof result === "object" && "value" in result ? result.value : result;
            const candidates = [
              value?.profile?.name,
              value?.account?.name,
              value?.details?.name,
              value?.user?.name,
              value?.name,
            ];
            const picked = candidates.find(
              (/** @type {unknown} */ item) => typeof item === "string" && item.trim() !== "",
            );
            if (typeof picked === "string") setUserName(picked.trim().slice(0, 40));
          })
          .catch(() => {
            /* 未登录/服务未挂载：没有名字就不显示名字 */
          });
        return () => {
          cancelled = true;
        };
      }, [api]);

      /** F25：折叠一个分组并落盘（storageDomain；失败只影响"下次还折叠"）。 */
      const setGroupCollapsed = useCallback(
        (/** @type {string} */ groupId, /** @type {boolean} */ collapsed) => {
          setCollapsedGroups((/** @type {any} */ prev) => {
            const next = { ...prev };
            if (collapsed) next[groupId] = true;
            else delete next[groupId];
            return next;
          });
          call(api.ctx, "setGroupCollapsed", { group: groupId, collapsed }).catch(() => {});
        },
        [api, setCollapsedGroups],
      );
      const collapseAllGroups = useCallback(
        (/** @type {boolean} */ collapsed) => {
          /** @type {Record<string, boolean>} */
          const next = {};
          const groups = Array.isArray(data.progress?.groups) ? data.progress.groups : [];
          for (const group of groups) {
            if (collapsed) next[String(group.id)] = true;
            call(api.ctx, "setGroupCollapsed", {
              group: String(group.id),
              collapsed,
            }).catch(() => {});
          }
          setCollapsedGroups(next);
        },
        [api, data.progress, setCollapsedGroups],
      );
      /** 自定义视图：保存的是"当前筛选条件"，不是结果快照。 */
      const views = Array.isArray(data.progress?.views) ? data.progress.views : [];
      /**
       * 视图 RPC 调用：宿主的 `addView` 可能是位置参数（新版）或单对象参数（旧版）。
       * 新版按 `{projectId,name,...}` 传；旧版需要 `{request:{...}}`。网关校验失败时自动重试一次，
       * 这样"装完插件还没重启宿主"的场景也能用（重试只发生在明确的字段不匹配错误上）。
       */
      const callViewRpc = (/** @type {string} */ method, /** @type {any} */ args) => {
        return call(api.ctx, method, args).then(
          (result) => result,
          (error) => {
            const message = String(error?.message ?? error);
            if (!/args fields do not match|unexpected "/u.test(message)) throw error;
            return call(api.ctx, method, { request: args });
          },
        );
      };
      /** 斜杠命令（Claude 的 "Type / for commands"）：选中即跳转，不创建线程。 */
      const slashCommands = [
        {
          key: "memory",
          label: text(t, "detail.slash.memory"),
          run: () => {
            setPanelPane("memory");
            setPanelSettingsOpen(true);
          },
        },
        {
          key: "routines",
          label: text(t, "detail.slash.routines"),
          run: () => setTab("routines"),
        },
        {
          key: "settings",
          label: text(t, "detail.slash.settings"),
          run: () => setPanelSettingsOpen(true),
        },
        {
          key: "clear",
          label: text(t, "detail.slash.clear"),
          run: () => {
            setFilter("");
            setPanelQuery("");
          },
        },
      ];
      const slashQuery = draft.startsWith("/") ? draft.slice(1).trim().toLowerCase() : "";
      const slashOpen = draft.startsWith("/");
      const slashMatches = slashOpen
        ? slashCommands.filter((command) =>
            slashQuery === ""
              ? true
              : command.key.indexOf(slashQuery) >= 0 ||
                command.label.toLowerCase().indexOf(slashQuery) >= 0,
          )
        : [];
      const slashIndexState = useState(0);
      const slashIndex = slashIndexState[0];
      const setSlashIndex = slashIndexState[1];
      const runSlashCommand = (/** @type {any} */ command) => {
        if (!command) return;
        command.run();
        setDraft("");
      };
      const saveView = () => {
        const name = viewName.trim();
        if (name === "") return;
        callViewRpc("addView", {
          projectId: project.id,
          name,
          filter,
          query: panelQuery,
        }).then(
          () => {
            setViewName("");
            load();
          },
          (/** @type {any} */ error) =>
            setThreadAction({
              pending: "",
              ok: false,
              message: text(t, "detail.viewSaveFailed", {
                reason: String(error?.message ?? error),
              }),
            }),
        );
      };
      const deleteView = (/** @type {string} */ viewId) => {
        callViewRpc("deleteView", { projectId: project.id, viewId }).then(
          () => load(),
          (/** @type {any} */ error) =>
            setThreadAction({
              pending: "",
              ok: false,
              message: text(t, "detail.viewSaveFailed", {
                reason: String(error?.message ?? error),
              }),
            }),
        );
      };
      /** F26：药丸点击 = 过滤该状态；再点一次清除。 */
      const toggleFilter = useCallback(
        (/** @type {string} */ state) => {
          setFilter((/** @type {any} */ prev) => (prev === state ? "" : state));
          setCarousel({});
        },
        [setFilter, setCarousel],
      );
      /** F29：手动 resolve / 重开。回执带回读值，面板不自己猜状态。 */
      const resolveRow = useCallback(
        (/** @type {string} */ sessionId, /** @type {boolean} */ resolved) => {
          setThreadMenu("");
          setThreadAction({ pending: sessionId, message: "", ok: null });
          call(api.ctx, "resolveThread", { sessionId, resolved }).then(
            (/** @type {any} */ result) => {
              setThreadAction({
                pending: "",
                ok: true,
                message:
                  result?.readback === "resolved"
                    ? text(t, "detail.resolved")
                    : text(t, "detail.reopened"),
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
      /** F31：手动标记未读/已读（与 pendingInput 的「等你」圆点分开）。 */
      const markUnread = useCallback(
        (/** @type {string} */ sessionId, /** @type {boolean} */ unread) => {
          setThreadMenu("");
          call(api.ctx, "setThreadUnread", { sessionId, unread }).then(
            () => load(),
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
      /** U14：组内前后切换（轮播位置只影响高亮，不过滤数据）。 */
      const moveCarousel = useCallback(
        (
          /** @type {string} */ groupId,
          /** @type {number} */ delta,
          /** @type {number} */ count,
        ) => {
          if (count <= 0) return;
          setCarousel((/** @type {any} */ prev) => ({
            ...prev,
            [groupId]: (((Number(prev[groupId] ?? 0) + delta) % count) + count) % count,
          }));
        },
        [setCarousel],
      );
      /** 时长（U12 右侧元信息）：分钟 / 小时 / 天，没有 createdAt 就不显示。 */
      // Claude 的行尾时长是 small-caps 拉丁形式（now / 5m / 2h / 3d），不用中文长句。
      const durationLabel = useCallback((/** @type {number|null} */ ms) => {
        if (!(Number(ms) > 0)) return "";
        const seconds = Math.round(Number(ms) / 1000);
        if (seconds < 60) return "now";
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours}h`;
        return `${Math.round(hours / 24)}d`;
      }, []);
      const groupLabel = useCallback(
        (/** @type {string} */ id) => {
          const value = t(`detail.group.${id}`);
          return typeof value === "string" && !value.startsWith("detail.") ? value : id;
        },
        [t],
      );
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
          if (width > 0) setNarrow(width < 820);
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

      /**
       * U17 步进环：SVG 环形进度（done/total）。没有 todo 时**不传进来**——行里显示「—」，
       * 不画 0/0 的空环（硬要求：没有数据就说没有）。
       * @param {number} done @param {number} total
       */
      const stepRing = (done, total) => {
        const size = 18;
        const stroke = 2;
        const radius = (size - stroke) / 2;
        const circumference = 2 * Math.PI * radius;
        const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
        return h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: `0 0 ${size} ${size}`,
            style: { display: "block" },
            "data-projects-step-ring": `${done}/${total}`,
            "aria-hidden": "true",
          },
          h("circle", {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: "none",
            stroke: T.border,
            strokeWidth: stroke,
          }),
          h("circle", {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: "none",
            stroke: T.accentText,
            strokeWidth: stroke,
            strokeLinecap: "round",
            strokeDasharray: `${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`,
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
          }),
        );
      };

      /**
       * F27/U12 行解剖：状态点 + 标题 + 副标题（最近 tool/call，没有就留空）+ 右侧元信息
       * （步进 n/m、PR 徽章、通知数、时长）+ 行内菜单（resolve/未读/回收/移除）。
       * 既有锚点（thread-row / -state / -dot / -pill / -stats / -worktree / -menu /
       * -reclaim / -remove）保持不变：冒烟与桌面回归靠它们定位。
       * @param {any} row @param {boolean} focused
       */
      const threadRowView = (row, focused) => {
        const state = String(row.view?.state ?? "idle");
        const stateColor =
          state === "failed"
            ? T.danger
            : state === "working"
              ? T.dim
              : state === "waiting-user"
                ? // 深色下 accentText 近白，和 working 抢色；改用品牌紫
                  colorScheme === "light"
                  ? T.accentText
                  : T.brand
                : state === "resolved"
                  ? T.success
                  : T.faint;
        // 行标题用人话（Claude 是"任务/主题"当标题）：title → 副标题/任务 → 线程短 id；
        // 不再暴露 turn 号与 session id（真机走查里最"脏"的一处）。
        const rawTitle = cleanThreadTitle(row.title);
        const taskHint = cleanThreadTitle(row.subtitle);
        const title =
          rawTitle !== ""
            ? rawTitle
            : taskHint !== ""
              ? taskHint
              : `线程 ${String(row.sessionId)
                  .replace(/^session-/u, "")
                  .slice(0, 6)}`;
        // 副标题统一逻辑：kind 语义 → 旧宿主 fallback → working 的「动词 + 秒数」
        const pickVerb = () => {
          const verbs = text(t, "detail.working.verbs").split("|");
          const began =
            Number(row.view?.firstActivityAt ?? 0) || Number(row.view?.lastActivityAt ?? 0);
          const secs = began > 0 ? Math.max(0, Math.round((Date.now() - began) / 1000)) : null;
          const seed =
            String(row.sessionId ?? "")
              .split("")
              .reduce(
                (/** @type {number} */ sum, /** @type {string} */ ch) => sum + ch.charCodeAt(0),
                0,
              ) % verbs.length;
          const verb = verbs[seed] || verbs[0] || "";
          return secs === null ? verb : `${verb} ${secs}s`;
        };
        const subtitleText = () => {
          const kind = String(row.subtitleKind || "");
          const detail = cleanThreadTitle(row.subtitleDetail || row.subtitle);
          if (kind === "question") {
            return text(t, "detail.rowSub.question", { text: detail.slice(0, 48) });
          }
          if (kind === "action" || state === "working") {
            // M3：工具态优先（Claude 的 `✓✓✓ Using X`）；没有工具名再退回动词+秒数
            const tool = String(row.currentTool || "").trim();
            if (tool !== "") return text(t, "detail.rowSub.using", { tool });
            return detail !== ""
              ? text(t, "detail.rowSub.action", { text: detail.slice(0, 48) })
              : pickVerb();
          }
          if (kind === "failed") return text(t, "detail.rowSub.failed");
          if (kind === "review") return detail !== "" ? detail : text(t, "detail.rowSub.review");
          if (kind === "archived") return text(t, "detail.rowSub.archived");
          if (kind === "result") {
            const summary = String(row.summary || "").trim();
            // 摘要只含真实观测到的量；一条都没有时回退到"已完成"，不写 0 步 / n/a 这种调试串
            return summary !== "" ? summary : text(t, "detail.rowSub.result");
          }
          if (rawTitle === "" && taskHint !== "" && taskHint !== title) return taskHint;
          if (state === "working") return pickVerb();
          return text(t, `detail.state.${state}`);
        };
        const rowSubtitle = subtitleText();
        const steps = row.steps && Number(row.steps.total) > 0 ? row.steps : null;
        // M2.2：行尾 `n/m` 悬停弹层（状态在 ProjectDetail 顶层，threadRowView 只是普通函数）
        const stepHoverOpen = stepsHoverId === String(row.sessionId);
        const tickNow = () => Date.now();
        const duration = durationLabel(row.durationMs);
        const notifications = Array.isArray(row.view?.pendingInput)
          ? row.view.pendingInput.length
          : 0;
        // U18：宿主右键菜单（注册在 `projects.thread` target 族）。服务缺失时返回 false，
        // 右键不拦截，自绘「⋯」菜单仍在。
        /** @param {any} event */
        const openHostThreadMenu = (event) => {
          const menus = api.contextMenus;
          if (!menus || typeof menus.open !== "function") return false;
          try {
            const rect = event?.currentTarget?.getBoundingClientRect?.();
            const point =
              rect && Number(event?.clientX) === 0 && Number(event?.clientY) === 0
                ? { x: rect.left, y: rect.bottom }
                : { x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0 };
            menus.open(
              {
                kind: "projects.thread",
                value: {
                  sessionId: String(row.sessionId),
                  title: title,
                  resolved: state === "resolved",
                },
              },
              point,
            );
            return true;
          } catch (_error) {
            return false;
          }
        };
        return h(
          "div",
          {
            key: row.sessionId,
            style: {
              ...styles.row,
              position: "relative",
              padding: "8px 6px",
              cursor: "pointer",
              alignItems: "flex-start",
              flexWrap: "wrap",
              background: threadHover === row.sessionId ? T.hover : "transparent",
              borderRadius: "8px",
              boxShadow: focused ? `inset 2px 0 0 ${T.accentText}` : "none",
            },
            "data-projects-thread-row": row.sessionId,
            "data-projects-thread-state": state,
            "data-projects-row-artifact-count": String(
              Array.isArray(row.artifacts) ? row.artifacts.length : "none",
            ),
            // F29 回读锚点：resolve 写进去的 resolvedAt 必须能在 UI 上读回来（冒烟比同一份值）
            "data-projects-thread-resolved-at": String(row.resolvedAt ?? ""),
            "data-projects-thread-unread": row.unread === true ? "true" : "false",
            "data-projects-thread-focused": focused ? "true" : "false",
            "data-projects-thread-host-menu": api.contextMenuReady === true ? "yes" : "no",
            // 可访问性：行可聚焦，Enter/Space 展开（行内按钮各自处理，不受影响）
            tabIndex: 0,
            role: "button",
            "aria-expanded": expandedThread === String(row.sessionId) ? "true" : "false",
            "aria-label": `${title} · ${rowSubtitle}`,
            onKeyDown: (/** @type {any} */ event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              if (event.target !== event.currentTarget) return;
              event.preventDefault();
              setExpandedThread(
                expandedThread === String(row.sessionId) ? "" : String(row.sessionId),
              );
            },
            onMouseEnter: () => setThreadHover(String(row.sessionId)),
            onMouseLeave: () => setThreadHover(""),
            onClick: (/** @type {any} */ event) => {
              // 行内按钮/菜单自己处理点击：只把"空白处点击"当作展开/收起
              if (event.target.closest("button, input, textarea, a, select, label")) return;
              setExpandedThread(
                expandedThread === String(row.sessionId) ? "" : String(row.sessionId),
              );
            },
            onContextMenu: (/** @type {any} */ event) => {
              if (openHostThreadMenu(event)) event.preventDefault();
            },
          },
          // 状态点：颜色只表达状态；未读时加一圈光晕（F31）
          h(
            "span",
            {
              style: {
                ...styles.dot,
                marginTop: "5px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background:
                  state === "working" || state === "resolved" ? "transparent" : stateColor,
                boxShadow: row.unread === true ? `0 0 0 3px ${T.accent}` : "none",
                color: state === "resolved" ? T.success : stateColor,
              },
              "data-projects-thread-dot": state,
              "aria-hidden": "true",
            },
            state === "working"
              ? glyph("arc", 12)
              : state === "resolved"
                ? glyph("check", 12)
                : null,
          ),
          h(
            "div",
            {
              style: {
                ...styles.rowMain,
                ...(expandedThread === row.sessionId ? { flex: "1 1 100%" } : {}),
              },
            },
            h(
              "span",
              { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
              h(
                "span",
                {
                  style: styles.rowTitle,
                  title: String(row.sessionId),
                  "data-projects-thread-title": row.sessionId,
                },
                title,
              ),
              h(
                "span",
                { style: { display: "none" }, "data-projects-thread-pill": state },
                text(t, `detail.state.${state}`),
              ),
              row.manualUnread === true
                ? h(
                    "span",
                    {
                      style: { ...styles.badge, minWidth: "14px", height: "14px" },
                      title: text(t, "panel.rowUnread"),
                      "data-projects-thread-unread-badge": row.sessionId,
                    },
                    "•",
                  )
                : null,
            ),
            // 副标题 = 最近一条 tool/call 的可读摘要；没有就留空（不编）
            rowSubtitle !== ""
              ? h(
                  "span",
                  { style: styles.rowSub, "data-projects-thread-subtitle": row.sessionId },
                  rowSubtitle,
                )
              : null,
            // Claude 的嵌套 PR 行：标题下方 `└ #409`（绿色 PR 图标 + 白字，无底无边）
            row.prNumber
              ? h(
                  "span",
                  {
                    style: {
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      color: T.text,
                      fontSize: "12px",
                      paddingLeft: "10px",
                    },
                    "data-panel-thread-pr-line": row.sessionId,
                  },
                  h("span", { style: { color: T.dim } }, "└"),
                  h(
                    "span",
                    { style: { color: T.success, display: "inline-flex" } },
                    glyph("pr", 13),
                  ),
                  h("span", {}, text(t, "detail.prBadge", { number: row.prNumber })),
                  h("span", { style: { color: T.faint } }, text(t, "detail.prOpen")),
                )
              : null,
            // 可观测摘要（规格 §7.7.3）：步骤/工具/diff/tokens，缺失显式 n/a
            row.summary
              ? h(
                  "span",
                  {
                    // 视觉隐藏：Claude 行内不铺 "diff n/a · tokens n/a" 这类实现层信息，
                    // 但冒烟/排障仍要能读文本，所以保留 DOM 只做 sr-only。
                    style: {
                      position: "absolute",
                      width: "1px",
                      height: "1px",
                      overflow: "hidden",
                      clip: "rect(0 0 0 0)",
                      whiteSpace: "nowrap",
                    },
                    "data-projects-thread-stats": "",
                    // P0-3：真实 diff 单独给一个锚点，冒烟不用解析自然语言文案
                    "data-projects-thread-diff": row.diff
                      ? `${row.diff.files}:${row.diff.added}:${row.diff.removed}`
                      : "",
                  },
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
            // M2.3：折叠行露产物（Claude 的行会把线程产物以小缩略卡露出来）
            Array.isArray(row.artifacts) && row.artifacts.length > 0
              ? h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                      marginTop: "2px",
                    },
                    "data-projects-row-artifacts": row.sessionId,
                  },
                  row.artifacts.slice(0, 3).map((/** @type {any} */ item) =>
                    h(
                      "span",
                      {
                        key: String(item?.id ?? ""),
                        style: {
                          ...styles.inlineChip,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          maxWidth: "180px",
                          cursor: "pointer",
                        },
                        "data-projects-row-artifact-chip": String(item?.id ?? ""),
                        title: String(item?.title ?? ""),
                        onClick: () => setExpandedThread(String(row.sessionId)),
                      },
                      h("img", {
                        src:
                          String(item?.coverUrl ?? "") !== ""
                            ? String(item.coverUrl)
                            : `/artifacts/${encodeURIComponent(String(item?.id ?? ""))}/cover.svg`,
                        alt: "",
                        style: {
                          width: "20px",
                          height: "15px",
                          objectFit: "cover",
                          borderRadius: "3px",
                        },
                      }),
                      h(
                        "span",
                        {
                          style: {
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          },
                        },
                        String(item?.title ?? item?.id ?? ""),
                      ),
                    ),
                  ),
                  row.artifacts.length > 3
                    ? h(
                        "span",
                        { style: { ...styles.meta, fontSize: "11px", alignSelf: "center" } },
                        text(t, "detail.rowArtifactsMore", {
                          count: row.artifacts.length - 3,
                        }),
                      )
                    : null,
                )
              : null,
            // —— U5/U6/U7/F17/F19/F24/F12/F20：展开后的线程面板 ——
            expandedThread === row.sessionId
              ? h(
                  "div",
                  { style: styles.threadDetail, "data-projects-thread-detail": row.sessionId },
                  // U5 thread 起始卡（○ + 标题 + 副标题）
                  h(
                    "div",
                    { style: styles.startCard, "data-projects-thread-start-card": row.sessionId },
                    h(
                      "span",
                      {
                        style: {
                          display: "inline-flex",
                          alignItems: "center",
                          marginTop: "3px",
                          color: stateColor,
                        },
                        "data-projects-thread-start-dot": state,
                      },
                      // Claude 的起始卡左侧是空心圆（进行中/已解决用弧与勾区分）
                      state === "working"
                        ? glyph("arc", 13)
                        : state === "resolved"
                          ? glyph("check", 13)
                          : h("span", {
                              style: {
                                width: "9px",
                                height: "9px",
                                borderRadius: "999px",
                                border: `1.5px solid ${stateColor}`,
                              },
                            }),
                    ),
                    h(
                      "div",
                      {
                        style: {
                          minWidth: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: "1px",
                        },
                      },
                      h("span", { style: styles.name }, title),
                      h(
                        "span",
                        { style: styles.meta },
                        (() => {
                          // M2.1：副标题按状态语义渲染（host 未提供 subtitleKind 时退回旧逻辑）
                          const kind = String(row.subtitleKind || "");
                          const detail = cleanThreadTitle(row.subtitleDetail || row.subtitle);
                          if (kind === "question") {
                            return text(t, "detail.rowSub.question", {
                              text: detail.slice(0, 48),
                            });
                          }
                          if (kind === "action") {
                            if (detail !== "") {
                              return text(t, "detail.rowSub.action", { text: detail.slice(0, 48) });
                            }
                            // Claude 的生成态：拟人化动词 + 秒数（Ruminating 4s）
                            const verbs = text(t, "detail.working.verbs").split("|");
                            const last = Number(row.view?.lastActivityAt ?? 0);
                            const began = Number(row.view?.firstActivityAt ?? 0) || last;
                            const elapsedMs = began > 0 ? Math.max(0, tickNow() - began) : NaN;
                            const secs = Number.isFinite(elapsedMs)
                              ? Math.max(0, Math.round(elapsedMs / 1000))
                              : null;
                            const seed =
                              String(row.sessionId ?? "")
                                .split("")
                                .reduce(
                                  (/** @type {number} */ sum, /** @type {string} */ ch) =>
                                    sum + ch.charCodeAt(0),
                                  0,
                                ) % verbs.length;
                            const verb = verbs[seed] || verbs[0] || "";
                            return secs === null ? verb : `${verb} ${secs}s`;
                          }
                          if (kind === "failed") return text(t, "detail.rowSub.failed");
                          if (kind === "review")
                            return detail !== "" ? detail : text(t, "detail.rowSub.review");
                          if (kind === "archived") return text(t, "detail.rowSub.archived");
                          if (kind === "result") {
                            const summary = String(row.summary || "").trim();
                            if (summary !== "") return summary;
                          }
                          const sub = cleanThreadTitle(row.subtitle);
                          if (sub !== "" && sub !== title) return sub;
                          // host 还没给 subtitleKind（旧宿主）时，working 也走「动词 + 秒数」
                          if (state === "working") {
                            const verbs = text(t, "detail.working.verbs").split("|");
                            const began =
                              Number(row.view?.firstActivityAt ?? 0) ||
                              Number(row.view?.lastActivityAt ?? 0);
                            const secs =
                              began > 0
                                ? Math.max(0, Math.round((Date.now() - began) / 1000))
                                : null;
                            const seed =
                              String(row.sessionId ?? "")
                                .split("")
                                .reduce(
                                  (/** @type {number} */ sum, /** @type {string} */ ch) =>
                                    sum + ch.charCodeAt(0),
                                  0,
                                ) % verbs.length;
                            const verb = verbs[seed] || verbs[0] || "";
                            return secs === null ? verb : `${verb} ${secs}s`;
                          }
                          return text(t, `detail.state.${state}`);
                        })(),
                      ),
                    ),
                  ),
                  // 线程的原始任务（行标题/展开面板都要能回看"我当初让它做什么"）
                  row.task
                    ? h(
                        "div",
                        {
                          style: { ...styles.meta, lineHeight: 1.5 },
                          "data-projects-thread-task": row.sessionId,
                        },
                        text(t, "detail.threadTask", { task: String(row.task).slice(0, 160) }),
                      )
                    : null,
                  // U7 行内 chip（分支 / 参数 / 引用）
                  h(
                    "div",
                    {
                      style: { display: "flex", flexWrap: "wrap", gap: "6px" },
                      "data-projects-thread-chips": row.sessionId,
                    },
                    row.branch
                      ? h(
                          "span",
                          {
                            style: styles.inlineChip,
                            "data-projects-thread-branch": row.sessionId,
                          },
                          text(t, "detail.prBranch", { branch: String(row.branch) }),
                        )
                      : null,
                    row.diff && Number(row.diff.files ?? 0) > 0
                      ? h(
                          "span",
                          {
                            style: {
                              ...styles.inlineChip,
                              display: "inline-flex",
                              gap: "4px",
                              fontVariantNumeric: "tabular-nums",
                            },
                            "data-projects-thread-diff-chip": row.sessionId,
                          },
                          h(
                            "span",
                            { style: { color: T.success } },
                            `+${Number(row.diff.added ?? 0)}`,
                          ),
                          h(
                            "span",
                            { style: { color: T.danger } },
                            `−${Number(row.diff.removed ?? 0)}`,
                          ),
                        )
                      : null,
                    h(
                      "span",
                      { style: styles.inlineChip, "data-projects-thread-params": row.sessionId },
                      `${row.isolated === true ? text(t, "detail.paramIsolated") : text(t, "detail.paramShared")} · ${
                        String(row.dir ?? "") !== ""
                          ? String(row.dir).split("/").pop()
                          : text(t, "detail.paramNoDir")
                      }`,
                    ),
                    row.prNumber
                      ? h(
                          "span",
                          {
                            style: styles.inlineChip,
                            "data-projects-thread-pr-chip": row.sessionId,
                          },
                          text(t, "detail.prCi", {
                            state: text(t, `detail.ci.${String(row.ciState ?? "none")}`),
                          }),
                        )
                      : null,
                  ),
                  // M2.3：折叠行里的产物 chips（Claude 的行会把线程产物露出来）
                  Array.isArray(row.artifacts) && row.artifacts.length > 0
                    ? h(
                        "div",
                        {
                          style: { display: "flex", flexWrap: "wrap", gap: "6px" },
                          "data-projects-thread-artifact-chips": row.sessionId,
                        },
                        h(
                          "span",
                          { style: { ...styles.meta, fontSize: "11px", alignSelf: "center" } },
                          text(t, "detail.rowArtifacts"),
                        ),
                        row.artifacts.slice(0, 3).map((/** @type {any} */ item) =>
                          h(
                            "span",
                            {
                              key: String(item?.id ?? ""),
                              style: {
                                ...styles.inlineChip,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                maxWidth: "160px",
                              },
                              "data-projects-thread-artifact-chip": String(item?.id ?? ""),
                              title: String(item?.title ?? ""),
                              onClick: () => {
                                const kind = String(item?.kind ?? "");
                                if (["markdown", "json", "csv"].indexOf(kind) >= 0) {
                                  setArtifactViewer(item);
                                } else {
                                  setExpandedThread(String(row.sessionId));
                                }
                              },
                            },
                            String(item?.id ?? "") !== ""
                              ? h("img", {
                                  // 同 artifactCardFor：宿主没透传 coverUrl 时按路由约定兜底
                                  src:
                                    String(item?.coverUrl ?? "") !== ""
                                      ? String(item.coverUrl)
                                      : `/artifacts/${encodeURIComponent(String(item.id))}/cover.svg`,
                                  alt: "",
                                  style: {
                                    width: "22px",
                                    height: "16px",
                                    objectFit: "cover",
                                    borderRadius: "3px",
                                    display: "block",
                                  },
                                })
                              : null,
                            h(
                              "span",
                              {
                                style: {
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                },
                              },
                              String(item?.title ?? item?.kind ?? ""),
                            ),
                          ),
                        ),
                        row.artifacts.length > 3
                          ? h(
                              "span",
                              { style: { ...styles.meta, fontSize: "11px", alignSelf: "center" } },
                              text(t, "detail.rowArtifactsMore", {
                                count: row.artifacts.length - 3,
                              }),
                            )
                          : null,
                      )
                    : null,
                  // F17 Tasks 清单（✓/◌ + n/m，来自 todo/write）
                  h(
                    "div",
                    {
                      style: { display: "flex", flexDirection: "column", gap: "2px" },
                      "data-projects-thread-tasks": row.sessionId,
                      "data-projects-thread-tasks-source":
                        Array.isArray(row.tasks) && row.tasks.length > 0 ? "todo/write" : "none",
                    },
                    h(
                      "span",
                      { style: styles.meta, "data-projects-thread-tasks-count": row.sessionId },
                      Array.isArray(row.tasks) && row.tasks.length > 0
                        ? `${text(t, "detail.tasks")} · ${text(t, "detail.tasksCount", {
                            done: Number(row.steps?.done ?? 0),
                            total: Number(row.steps?.total ?? 0),
                          })}`
                        : `${text(t, "detail.tasks")} · ${text(t, "detail.stepsNone")}`,
                    ),
                    Array.isArray(row.tasks) && row.tasks.length > 0
                      ? row.tasks.map((/** @type {any} */ task, /** @type {number} */ index) => {
                          const done =
                            task?.done === true || String(task?.status ?? "") === "completed";
                          return h(
                            "span",
                            {
                              key: String(index),
                              style: styles.taskItem,
                              "data-projects-thread-task": row.sessionId,
                              "data-projects-task-status": done ? "done" : "open",
                            },
                            `${done ? "✓" : "◌"} ${String(task?.content ?? "").slice(0, 120)}`,
                          );
                        })
                      : h("span", { style: styles.meta }, text(t, "detail.tasksNone")),
                  ),
                  // F19 steering（`mode:'steer'`）
                  h(
                    "div",
                    { style: { display: "flex", gap: "6px", alignItems: "center" } },
                    h("input", {
                      style: styles.input,
                      value: steerDraft,
                      placeholder: text(t, "detail.steerPlaceholder"),
                      "data-projects-thread-steer-input": row.sessionId,
                      disabled: busyAction !== "",
                      onChange: (/** @type {any} */ event) => setSteerDraft(event.target.value),
                      onKeyDown: (/** @type {any} */ event) => {
                        if (event.key === "Enter") steerThreadNow(String(row.sessionId));
                      },
                    }),
                    h(
                      "button",
                      {
                        type: "button",
                        style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                        "data-projects-thread-steer": row.sessionId,
                        disabled: busyAction !== "" || String(steerDraft).trim() === "",
                        onClick: () => steerThreadNow(String(row.sessionId)),
                      },
                      text(t, "detail.steer"),
                    ),
                  ),
                  // F24 每线程模型（下拉来自 modelCatalog）
                  h(
                    "div",
                    {
                      style: { display: "flex", gap: "6px", alignItems: "center" },
                      "data-projects-thread-model-row": row.sessionId,
                      "data-projects-thread-model-available":
                        modelOptions.length > 0 ? "yes" : "no",
                    },
                    h("span", { style: styles.meta }, text(t, "detail.model")),
                    modelOptions.length > 0
                      ? h(
                          "select",
                          {
                            style: styles.input,
                            "data-projects-thread-model": row.sessionId,
                            value:
                              modelPick[row.sessionId] ??
                              `${modelOptions[0].provider}:${modelOptions[0].model}`,
                            onChange: (/** @type {any} */ event) =>
                              setModelPick((/** @type {any} */ prev) => ({
                                ...prev,
                                [row.sessionId]: event.target.value,
                              })),
                          },
                          modelOptions.map((/** @type {any} */ option) =>
                            h("option", { key: option.key, value: option.key }, option.label),
                          ),
                        )
                      : h(
                          "span",
                          { style: styles.meta, "data-projects-thread-model-none": "" },
                          text(t, "detail.modelNone"),
                        ),
                    // F24/P1-3：effort 下拉**无条件**渲染——模型目录没暴露时也要有明确的
                    // 「继承默认」降级（否则这条能力在无目录部署里既不可用也不可见）。
                    (() => {
                      const pickedKey =
                        modelOptions.length > 0
                          ? (modelPick[row.sessionId] ??
                            `${modelOptions[0].provider}:${modelOptions[0].model}`)
                          : "";
                      const picked = modelOptions.find(
                        (/** @type {any} */ option) => option.key === pickedKey,
                      );
                      const efforts = Array.isArray(picked?.efforts) ? picked.efforts : [];
                      const effortValue = String(modelEffortPick[row.sessionId] ?? "");
                      return h(
                        "select",
                        {
                          style: styles.input,
                          "data-projects-thread-effort": row.sessionId,
                          "data-projects-thread-effort-available":
                            efforts.length > 0 ? "yes" : "no",
                          "aria-label": text(t, "detail.effort"),
                          value: effortValue,
                          onChange: (/** @type {any} */ event) =>
                            setModelEffortPick((/** @type {any} */ prev) => ({
                              ...prev,
                              [row.sessionId]: event.target.value,
                            })),
                        },
                        [
                          h(
                            "option",
                            { key: "inherit", value: "" },
                            text(t, "detail.effortInherit"),
                          ),
                          ...efforts.map((/** @type {string} */ effort) =>
                            h("option", { key: effort, value: effort }, effort),
                          ),
                        ],
                      );
                    })(),
                    modelOptions.length > 0
                      ? (() => {
                          const pickedKey =
                            modelPick[row.sessionId] ??
                            `${modelOptions[0].provider}:${modelOptions[0].model}`;
                          return [
                            h(
                              "button",
                              {
                                key: `save-${row.sessionId}`,
                                type: "button",
                                style: {
                                  ...styles.secondaryButton,
                                  padding: "2px 10px",
                                  fontSize: "12px",
                                },
                                "data-projects-thread-model-save": row.sessionId,
                                disabled: busyAction !== "",
                                onClick: () =>
                                  applyModel(
                                    String(row.sessionId),
                                    modelOptions.find(
                                      (/** @type {any} */ option) => option.key === pickedKey,
                                    ),
                                    String(modelEffortPick[row.sessionId] ?? ""),
                                  ),
                              },
                              text(t, "detail.modelSave"),
                            ),
                            modelSelection[row.sessionId]
                              ? h(
                                  "span",
                                  {
                                    key: `sel-${row.sessionId}`,
                                    style: styles.meta,
                                    "data-projects-thread-model-selection": row.sessionId,
                                  },
                                  text(t, "detail.modelSelection", {
                                    selection: JSON.stringify(modelSelection[row.sessionId]).slice(
                                      0,
                                      120,
                                    ),
                                  }),
                                )
                              : null,
                          ];
                        })()
                      : null,
                  ),
                  // F12/U16：Create PR 条（对齐参考图 13：分支名输入条 + Create PR + ✕）
                  row.prNumber
                    ? null
                    : prBarClosed === String(row.sessionId)
                      ? h(
                          "div",
                          {
                            style: { display: "flex", gap: "6px", alignItems: "center" },
                            "data-projects-branch-bar": row.sessionId,
                          },
                          h(
                            "button",
                            {
                              type: "button",
                              style: {
                                ...styles.secondaryButton,
                                padding: "2px 10px",
                                fontSize: "12px",
                              },
                              "data-projects-create-pr": row.sessionId,
                              disabled: busyAction !== "" || !row.branch,
                              onClick: () => createPrFor(String(row.sessionId)),
                            },
                            text(t, "detail.prCreate"),
                          ),
                        )
                      : h(
                          "div",
                          {
                            style: {
                              display: "flex",
                              gap: "6px",
                              alignItems: "center",
                              border: `1px solid ${T.borderSoft}`,
                              borderRadius: "10px",
                              padding: "3px 6px 3px 10px",
                              background: T.field,
                            },
                            "data-projects-branch-bar": row.sessionId,
                          },
                          h(
                            "span",
                            {
                              style: {
                                ...styles.meta,
                                fontFamily: "ui-monospace, monospace",
                                flex: "1 1 auto",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              },
                              "data-projects-branch-label": row.sessionId,
                            },
                            row.branch ? String(row.branch) : text(t, "detail.noBranch"),
                          ),
                          // F21/P1-2：auto-fix 手动触发入口（只在 CI 失败时可点）
                          h(
                            "button",
                            {
                              type: "button",
                              style: {
                                ...styles.secondaryButton,
                                padding: "2px 8px",
                                fontSize: "11.5px",
                              },
                              "data-projects-thread-autofix": row.sessionId,
                              "data-projects-thread-autofix-state": row.ciState ?? "none",
                              disabled: busyAction !== "" || row.ciState !== "failing",
                              title:
                                row.ciState === "failing"
                                  ? text(t, "detail.autofixHint")
                                  : text(t, "detail.autofixDisabled"),
                              onClick: () => autofixFor(String(row.sessionId)),
                            },
                            busyAction === `fix:${row.sessionId}`
                              ? text(t, "detail.autofixRunning")
                              : text(t, "detail.autofix"),
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              style: {
                                ...styles.primaryButton,
                                padding: "2px 10px",
                                fontSize: "12px",
                              },
                              "data-projects-create-pr": row.sessionId,
                              disabled: busyAction !== "" || !row.branch,
                              onClick: () => createPrFor(String(row.sessionId)),
                            },
                            busyAction === `pr:${row.sessionId}`
                              ? text(t, "detail.prCreating")
                              : text(t, "detail.prCreate"),
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              style: styles.iconButton,
                              "data-projects-pr-bar-dismiss": row.sessionId,
                              "aria-label": text(t, "detail.prBarDismiss"),
                              title: text(t, "detail.prBarDismiss"),
                              onClick: () => setPrBarClosed(String(row.sessionId)),
                            },
                            "✕",
                          ),
                        ),
                  // F18：审批在**线程里**产生；这里的按钮只是把"申请"入口暴露给用户
                  h(
                    "div",
                    { style: { display: "flex", gap: "6px", alignItems: "center" } },
                    h(
                      "span",
                      { style: styles.meta, "data-projects-thread-approval-hint": "" },
                      text(t, "detail.approvalHint"),
                    ),
                  ),
                  // M4：PR 三段式卡（状态 / 标题 / 动作）。Review/Merge 需要宿主 seam，
                  // 现在只给「复制链接」这个真动作，其余如实标注未实现。
                  row.prNumber
                    ? (() => {
                        const info = prInfo[String(row.sessionId)];
                        const pr = info?.ok ? info.pr : null;
                        const stateLabel = text(t, `detail.ci.${String(row.ciState ?? "none")}`);
                        return h(
                          "div",
                          {
                            style: {
                              display: "flex",
                              flexDirection: "column",
                              gap: "4px",
                              border: `1px solid ${T.borderSoft}`,
                              borderRadius: "8px",
                              padding: "8px",
                            },
                            "data-projects-thread-pr-card": row.sessionId,
                            "data-projects-thread-pr-card-ok": info?.ok ? "true" : "false",
                          },
                          h(
                            "div",
                            {
                              style: {
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                minWidth: 0,
                              },
                            },
                            h("span", { style: { color: T.success } }, glyph("pr", 13)),
                            h(
                              "span",
                              {
                                style: {
                                  ...styles.name,
                                  fontSize: "12.5px",
                                  flex: "1 1 auto",
                                  minWidth: 0,
                                },
                              },
                              `#${row.prNumber}`,
                              pr && pr.title !== "" ? ` · ${pr.title}` : "",
                            ),
                            h("span", { style: styles.meta }, stateLabel),
                          ),
                          h(
                            "div",
                            {
                              style: {
                                display: "flex",
                                gap: "6px",
                                alignItems: "center",
                                flexWrap: "wrap",
                              },
                            },
                            pr && pr.url !== ""
                              ? h(
                                  "button",
                                  {
                                    type: "button",
                                    style: {
                                      ...styles.secondaryButton,
                                      padding: "1px 8px",
                                      fontSize: "11.5px",
                                    },
                                    "data-projects-thread-pr-copy": row.sessionId,
                                    onClick: () => {
                                      try {
                                        navigator.clipboard?.writeText?.(String(pr.url));
                                        setThreadAction({
                                          pending: "",
                                          ok: true,
                                          message: text(t, "detail.prCard.copied"),
                                        });
                                      } catch {
                                        /* 剪贴板不可用就什么都不承诺 */
                                      }
                                    },
                                  },
                                  text(t, "detail.prCard.copy"),
                                )
                              : h(
                                  "span",
                                  { style: styles.meta },
                                  info?.ok === false
                                    ? `${text(t, "detail.prCard.unavailable")} · ${String(info?.reason ?? "")}`
                                    : text(t, "detail.prCard.loading"),
                                ),
                            (() => {
                              const dangerOn =
                                (data.liveProject ?? props.project)?.policy?.danger?.autoMerge ===
                                true;
                              const armed = mergeArm === String(row.sessionId);
                              return h(
                                "button",
                                {
                                  type: "button",
                                  style: {
                                    ...styles.secondaryButton,
                                    padding: "1px 8px",
                                    fontSize: "11.5px",
                                    opacity: dangerOn ? 1 : 0.6,
                                  },
                                  "data-projects-thread-pr-merge": row.sessionId,
                                  "data-projects-thread-pr-merge-state": armed
                                    ? "armed"
                                    : dangerOn
                                      ? "ready"
                                      : "off",
                                  disabled: !dangerOn,
                                  title: dangerOn
                                    ? text(t, "detail.prCard.mergeHint")
                                    : text(t, "detail.prCard.mergeOff"),
                                  onClick: () => {
                                    if (!dangerOn) return;
                                    const sid = String(row.sessionId);
                                    if (!armed) {
                                      setMergeArm(sid);
                                      return;
                                    }
                                    setMergeArm("");
                                    call(api.ctx, "mergePr", {
                                      projectId: project.id,
                                      sessionId: sid,
                                      confirm: true,
                                    }).then(
                                      (/** @type {any} */ result) => {
                                        setThreadAction({
                                          pending: "",
                                          ok: result?.ok === true,
                                          message:
                                            result?.ok === true
                                              ? text(t, "detail.prCard.mergeOk", {
                                                  number: Number(row.prNumber),
                                                })
                                              : text(t, "detail.prCard.mergeFail", {
                                                  reason: String(result?.reason ?? "unknown"),
                                                }),
                                        });
                                        load();
                                      },
                                      (/** @type {any} */ error) =>
                                        setThreadAction({
                                          pending: "",
                                          ok: false,
                                          message: String(error?.message ?? error).slice(0, 160),
                                        }),
                                    );
                                  },
                                },
                                armed
                                  ? text(t, "detail.prCard.mergeArmed")
                                  : text(t, "detail.prCard.merge"),
                              );
                            })(),
                            h(
                              "span",
                              { style: { ...styles.meta, color: T.faint } },
                              text(t, "detail.prCard.actionsMissing"),
                            ),
                          ),
                        );
                      })()
                    : null,
                  // B5 · F34：线程内嵌产物缩略卡（标题 + 类型 + 版本 + 时间）
                  // 数据来自 Library 视图：artifacts 行 + 我们自存映射，按 sessionId 命中这条线程。
                  (() => {
                    // 数据优先用 progress 行里带的 `row.artifacts`（服务端按 source.sessionId 归属，
                    // 不需要额外拉 Library 数据）；退化时再看 Library 视图。
                    const rowItems = Array.isArray(row.artifacts) ? row.artifacts : [];
                    const libraryData = data.library;
                    const artifactsData = libraryData ? libraryData.artifacts || {} : {};
                    const available = rowItems.length > 0 || artifactsData.available === true;
                    const rowsList = Array.isArray(artifactsData.rows) ? artifactsData.rows : [];
                    const storedList = Array.isArray(artifactsData.stored)
                      ? artifactsData.stored
                      : [];
                    /** @type {Record<string, boolean>} */
                    const seenIds = {};
                    /** @type {any[]} */
                    const items = [];
                    rowItems.forEach((/** @type {any} */ item) => {
                      const id = String(item?.id ?? "");
                      if (id === "" || seenIds[id]) return;
                      seenIds[id] = true;
                      items.push(item);
                    });
                    rowsList.concat(storedList).forEach((/** @type {any} */ item) => {
                      const id = String(item?.id ?? "");
                      const sid = String(item?.sessionId ?? item?.source?.sessionId ?? "");
                      if (id === "" || seenIds[id] || sid !== String(row.sessionId)) return;
                      seenIds[id] = true;
                      items.push(item);
                    });
                    if (items.length === 0) return null;
                    return h(
                      "div",
                      {
                        style: { display: "flex", flexDirection: "column", gap: "6px" },
                        "data-projects-thread-artifacts": row.sessionId,
                        "data-projects-thread-artifacts-available": available ? "true" : "false",
                        "data-projects-thread-artifacts-count": String(items.length),
                      },
                      h("span", { style: styles.meta }, `${text(t, "library.threadArtifacts")} ⌄`),
                      available
                        ? null
                        : h(
                            "span",
                            { style: { ...styles.meta, color: T.faint } },
                            text(t, "library.threadArtifactsMissing"),
                          ),
                      items
                        .slice(0, 5)
                        .map((item) =>
                          artifactCardFor(
                            t,
                            item,
                            available,
                            `thr:${String(row.sessionId)}:`,
                            (target) => setArtifactViewer(target),
                          ),
                        ),
                    );
                  })(),
                )
              : null,
          ),
          // 右侧元信息（U12）：步进 n/m → PR 徽章 → 通知数 → 时长
          h(
            "div",
            {
              style: {
                ...styles.rowRight,
                alignSelf: "flex-start",
                ...(expandedThread === row.sessionId
                  ? { position: "absolute", top: "6px", right: "4px", maxWidth: "45%" }
                  : {}),
                justifyContent: "flex-end",
                flexWrap: "wrap",
                gap: "8px",
                paddingTop: "2px",
                // 给行尾 ⋯ 留位：右侧元信息不能压在菜单按钮下面
                paddingRight: "26px",
                maxWidth: "45%",
              },
              "data-projects-thread-meta": row.sessionId,
            },
            // U5/U6/U7 展开：起始卡 / 内联 chip / Tasks 清单 / steer / 模型 / Create PR
            h(
              "button",
              {
                type: "button",
                style: {
                  ...styles.secondaryButton,
                  padding: "1px 8px",
                  fontSize: "11px",
                  opacity: threadHover === row.sessionId ? 1 : 0.35,
                  transition: "opacity 120ms ease",
                },
                "data-projects-thread-expand": row.sessionId,
                "data-projects-thread-expanded":
                  expandedThread === row.sessionId ? "true" : "false",
                "aria-expanded": expandedThread === row.sessionId ? "true" : "false",
                onClick: () =>
                  setExpandedThread(expandedThread === row.sessionId ? "" : String(row.sessionId)),
              },
              expandedThread === row.sessionId
                ? text(t, "detail.threadCollapse")
                : text(t, "detail.threadExpand"),
            ),
            h(
              "span",
              {
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  border: `1px solid ${steps === null ? "transparent" : T.borderSoft}`,
                  borderRadius: "999px",
                  padding: steps === null ? "0" : "1px 7px 1px 5px",
                  fontSize: "11.5px",
                  position: "relative",
                },
                "data-projects-thread-steps": row.sessionId,
                "data-projects-thread-steps-state": steps === null ? "none" : "count",
                "data-projects-thread-steps-hover": stepHoverOpen ? "open" : "closed",
                title: steps === null ? text(t, "detail.stepsHint") : undefined,
                onMouseEnter: () => setStepsHoverId(String(row.sessionId)),
                onMouseLeave: () =>
                  setStepsHoverId((/** @type {string} */ prev) =>
                    prev === String(row.sessionId) ? "" : prev,
                  ),
              },
              steps === null ? null : stepRing(steps.done, steps.total),
              h(
                "span",
                {
                  style: {
                    fontVariantNumeric: "tabular-nums",
                    fontSize: "11.5px",
                    color: steps === null ? T.faint : T.dim,
                  },
                },
                // 没有 todo 时 Claude 行尾是空的（不摆 "—" 占位）；锚点仍在，冒烟靠 steps-state 判
                steps === null
                  ? ""
                  : text(t, "detail.steps", { done: steps.done, total: steps.total }),
              ),
              stepHoverOpen && Array.isArray(row.tasks) && row.tasks.length > 0
                ? h(
                    "div",
                    {
                      style: {
                        position: "absolute",
                        right: 0,
                        // 面板是滚动容器：向下弹会被底边裁掉（截图实测只剩一角），改为向上
                        bottom: "calc(100% + 8px)",
                        zIndex: 12,
                        minWidth: "220px",
                        maxWidth: "320px",
                        background: T.card,
                        border: `1px solid ${T.border}`,
                        borderRadius: "8px",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
                        padding: "8px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      },
                      "data-projects-thread-tasks-popover": row.sessionId,
                    },
                    h(
                      "span",
                      { style: { ...styles.meta, fontSize: "11px" } },
                      text(t, "detail.tasksPopover", {
                        done: Number(row.steps?.done ?? 0),
                        total: Number(row.steps?.total ?? 0),
                      }),
                    ),
                    row.tasks
                      .slice(0, 5)
                      .map((/** @type {any} */ task, /** @type {number} */ index) => {
                        const done =
                          task?.done === true || String(task?.status ?? "") === "completed";
                        return h(
                          "span",
                          {
                            key: String(index),
                            style: { ...styles.taskItem, fontSize: "11.5px" },
                          },
                          `${done ? "✓" : "◌"} ${String(task?.content ?? "").slice(0, 60)}`,
                        );
                      }),
                    row.tasks.length > 5
                      ? h(
                          "span",
                          { style: { ...styles.meta, fontSize: "11px" } },
                          text(t, "detail.tasksPopoverMore", { count: row.tasks.length - 5 }),
                        )
                      : null,
                  )
                : null,
            ),
            row.prNumber
              ? h(
                  "span",
                  {
                    // 参考图 22：行内 PR 徽章是「绿色分支符号 + #编号」（不带状态词，状态看颜色点）
                    style: {
                      ...styles.inlineChip,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "3px",
                      color: T.success,
                      fontVariantNumeric: "tabular-nums",
                    },
                    title: text(t, `detail.ci.${String(row.ciState ?? "none")}`),
                    "data-projects-thread-pr": row.sessionId,
                  },
                  "⎇",
                  text(t, "detail.prBadge", { number: row.prNumber }),
                )
              : null,
            // U16：PR 徽章的 CI 状态点（F21 轮询写回；没有就是 "none"，不编颜色）
            row.prNumber
              ? h("span", {
                  style: {
                    ...styles.chipDot,
                    background:
                      String(row.ciState) === "passing"
                        ? T.success
                        : String(row.ciState) === "failing"
                          ? T.danger
                          : String(row.ciState) === "pending"
                            ? T.accentText
                            : T.faint,
                  },
                  title: text(t, `detail.ci.${String(row.ciState ?? "none")}`),
                  "data-projects-thread-pr-ci": row.sessionId,
                  "data-projects-thread-pr-ci-state": String(row.ciState ?? "none"),
                })
              : null,
            notifications > 0
              ? h(
                  "span",
                  {
                    style: styles.badge,
                    title: text(t, "detail.notificationCount", { count: notifications }),
                    "data-projects-thread-notifications": row.sessionId,
                  },
                  String(notifications),
                )
              : null,
            duration !== ""
              ? h(
                  "span",
                  { style: styles.meta, "data-projects-thread-duration": row.sessionId },
                  duration,
                )
              : null,
          ),
          h(
            "span",
            {
              style: {
                position: "absolute",
                top: "4px",
                right: "4px",
                display: "inline-flex",
              },
            },
            h(Popover, {
              open: threadMenu === row.sessionId,
              onClose: () => setThreadMenu(""),
              anchor: h(
                "button",
                {
                  type: "button",
                  style: {
                    ...styles.iconButton,
                    flex: "none",
                    // Claude 的行内操作是 hover 才出现（常驻会显得脏）
                    opacity:
                      threadHover === row.sessionId || threadMenu === row.sessionId ? 1 : 0.35,
                    transition: "opacity 120ms ease",
                  },
                  "data-projects-thread-menu": row.sessionId,
                  "aria-label": text(t, "detail.moreActions"),
                  "aria-haspopup": "menu",
                  "aria-expanded": threadMenu === row.sessionId ? "true" : "false",
                  onClick: () =>
                    setThreadMenu(threadMenu === row.sessionId ? "" : String(row.sessionId)),
                  onKeyDown: (/** @type {any} */ event) => {
                    // U18：Shift+F10 打开宿主菜单（键盘用户与右键等价；宿主菜单自己管焦点）。
                    if (event.key === "F10" && event.shiftKey && openHostThreadMenu(event)) {
                      event.preventDefault();
                    }
                  },
                },
                uiIcon("more", "⋯", 16),
              ),
              menu: h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "2px" },
                  // 菜单键盘导航：↑↓ 在 menuitem 之间移动焦点（Esc 由 Popover 处理）
                  onKeyDown: (/** @type {any} */ event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    const items = [
                      ...event.currentTarget.querySelectorAll('[role="menuitem"]:not([disabled])'),
                    ];
                    if (items.length === 0) return;
                    event.preventDefault();
                    const index = items.indexOf(document.activeElement);
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    const next =
                      index < 0
                        ? delta > 0
                          ? 0
                          : items.length - 1
                        : (index + delta + items.length) % items.length;
                    items[next]?.focus();
                  },
                },
                // F29：手动 resolve / 重开（自动 resolve 是 B6）
                h(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    style: menuItemStyle,
                    "data-projects-thread-resolve": row.sessionId,
                    "data-projects-thread-resolve-target":
                      state === "resolved" ? "reopen" : "resolve",
                    onClick: () => resolveRow(row.sessionId, state !== "resolved"),
                  },
                  state === "resolved" ? text(t, "detail.reopen") : text(t, "detail.resolve"),
                ),
                // Claude ref 31 的「Add a reminder」：给这条线程加一个 30 分钟后的提醒
                h(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    style: menuItemStyle,
                    "data-projects-thread-remind": row.sessionId,
                    onClick: () => {
                      setThreadMenu("");
                      const at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
                      call(api.ctx, "createReminder", {
                        projectId: project.id,
                        input: {
                          at,
                          text: text(t, "detail.threadReminderText", {
                            title: String(title).slice(0, 40),
                          }),
                        },
                      }).then(
                        (/** @type {any} */ result) => {
                          setThreadAction({
                            pending: "",
                            ok: result?.ok !== false,
                            message:
                              result?.ok === false
                                ? text(t, "detail.threadReminderFailed", {
                                    reason: String(result?.reason ?? ""),
                                  })
                                : text(t, "detail.threadReminderAdded"),
                          });
                          load();
                        },
                        (/** @type {any} */ error) =>
                          setThreadAction({
                            pending: "",
                            ok: false,
                            message: text(t, "detail.threadReminderFailed", {
                              reason: String(error?.message ?? error),
                            }),
                          }),
                      );
                    },
                  },
                  text(t, "detail.threadRemind"),
                ),
                // F31：标记未读 / 已读
                h(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    style: menuItemStyle,
                    "data-projects-thread-unread-toggle": row.sessionId,
                    onClick: () => markUnread(row.sessionId, row.manualUnread !== true),
                  },
                  row.manualUnread === true
                    ? text(t, "detail.markRead")
                    : text(t, "detail.markUnread"),
                ),
                // 危险组：回收目录 / 移除追踪（与"正常操作"之间加一条分隔线）
                h("div", {
                  key: `menu-divider`,
                  role: "separator",
                  style: {
                    height: "1px",
                    margin: "4px 2px",
                    background: T.borderSoft,
                    flex: "none",
                  },
                  "data-projects-menu-divider": "",
                }),
                row.worktree
                  ? h(
                      "button",
                      {
                        type: "button",
                        role: "menuitem",
                        style: menuItemStyle,
                        "data-projects-thread-reclaim": row.sessionId,
                        onClick: () => {
                          setThreadMenu("");
                          reclaimDir(row.sessionId);
                        },
                        disabled: threadAction.pending === row.sessionId,
                      },
                      text(t, "detail.threadReclaim"),
                    )
                  : null,
                // F23：重命名（内联输入）+ 复制 ID
                h(ThreadRename, {
                  api: api,
                  t: t,
                  row: row,
                  onChanged: load,
                  onDone: () => setThreadMenu(""),
                }),
                h(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    style: menuItemStyle,
                    "data-projects-thread-copy": row.sessionId,
                    onClick: () => {
                      try {
                        if (
                          navigator.clipboard &&
                          typeof navigator.clipboard.writeText === "function"
                        ) {
                          navigator.clipboard.writeText(String(row.sessionId));
                        }
                      } catch {
                        /* 剪贴板不可用不影响其它动作 */
                      }
                      setThreadMenu("");
                    },
                  },
                  text(t, "b3.actionCopy"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    style: { ...menuItemStyle, color: T.danger },
                    "data-projects-thread-remove": row.sessionId,
                    onClick: () => {
                      // 两段确认：第一次点只把标签换成「确认移除？」，菜单不关，
                      // 否则用户看不到自己点的是哪一步（锚点语义与旧 UI 一致）
                      if (threadAction.pending === row.sessionId) setThreadMenu("");
                      removeThread(row.sessionId);
                    },
                  },
                  threadAction.pending === row.sessionId
                    ? text(t, "detail.threadRemoveConfirm")
                    : text(t, "detail.threadRemove"),
                ),
              ),
            }),
          ),
        );
      };

      // 记忆面板：从页签迁到「项目设置 › 记忆」（Claude 的 Memory 在设置里）
      const memoryPane = (() => {
        const content = data.content || {};
        return h(
          "div",
          { "data-projects-memory": "" },
          // F37：碎片列表 + 索引条目（新增 / 预览 / 逐条忘掉）
          h(MemoryFragments, {
            api: api,
            t: t,
            projectId: project.id,
            content: content,
            onChanged: load,
          }),
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
      })();

      const body = (() => {
        if (data.loading) return h("p", { style: styles.empty }, text(t, "detail.loading"));
        if (data.error !== "")
          return h(
            "div",
            {
              style: { ...styles.error, display: "flex", alignItems: "center", gap: "8px" },
              "data-projects-detail-error": "",
            },
            h("span", { style: { flex: "1 1 auto" } }, data.error),
            h(
              "button",
              {
                type: "button",
                style: { ...styles.secondaryButton, fontSize: "11.5px", padding: "1px 8px" },
                "data-projects-retry": "detail",
                onClick: () => load(),
              },
              text(t, "panel.retry"),
            ),
          );
        if (tab === "library") {
          // Library 不再是页签（§7.3 页签 ≤3）：右栏入口打开后**在主列**渲染，
          // 主列顶部给「返回线程列表」，再点同一 rail 行也能收起。
          return h(
            "div",
            {
              style: { display: "flex", flexDirection: "column", gap: "10px" },
              "data-projects-library-main": "",
            },
            h(
              "div",
              {
                style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
                "data-projects-library-breadcrumb": "",
              },
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                  "data-projects-library-back": "",
                  onClick: () => setTab("threads"),
                },
                `‹ ${text(t, "library.railBack")}`,
              ),
              h(
                "span",
                { style: styles.meta, "data-projects-library-rail-hint": "" },
                text(t, "library.railHint"),
              ),
            ),
            h(LibraryView, {
              api: api,
              t: t,
              project: project,
              library: data.library,
              onChanged: load,
            }),
          );
        }
        // B4 · F36：Routines 视图（六档频率 + Run now + History + 成本提示）+ F30 提醒
        if (tab === "routines") {
          return h(RoutinesView, { api: api, t: t, project: project, onChanged: load });
        }
        if (tab === "views") {
          // Claude 的 Views：控制右栏显示哪些视图 + 管理已保存的筛选视图
          return h(
            "div",
            {
              style: { display: "flex", flexDirection: "column", gap: "12px" },
              "data-projects-views-pane": "",
            },
            h("span", { style: styles.name }, text(t, "views.title")),
            h("span", { style: { ...styles.meta, whiteSpace: "normal" } }, text(t, "views.hint")),
            h(
              "div",
              {
                style: { display: "flex", flexDirection: "column", gap: "4px" },
                "data-projects-view-toggles": "",
              },
              [
                [
                  "threads",
                  text(t, "detail.tab.threads", {
                    count: data.progress?.total ?? data.threads.length,
                  }),
                ],
                ["library", text(t, "detail.tab.library")],
                ["routines", "Routines"],
              ].map(([id, label]) =>
                (() => {
                  const on = visibleTabs[id] !== false;
                  // 用 switch 按钮而不是 checkbox：本轮实测受控 checkbox 的 onChange
                  // 在这套 classic-script 渲染器里收不到（真实点击后 DOM 变了、state 不更新）。
                  return h(
                    "button",
                    {
                      key: id,
                      type: "button",
                      role: "switch",
                      "aria-checked": on ? "true" : "false",
                      "data-projects-view-toggle": id,
                      "data-projects-view-toggle-on": on ? "true" : "false",
                      style: {
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                        border: "none",
                        background: "transparent",
                        padding: "2px 0",
                        cursor: "pointer",
                        fontSize: "12.5px",
                        color: on ? T.text : T.dim,
                        textAlign: "left",
                      },
                      onClick: () => toggleVisibleView(id, !on),
                    },
                    h(
                      "span",
                      {
                        style: {
                          width: "14px",
                          height: "14px",
                          borderRadius: "4px",
                          border: `1px solid ${on ? T.accentText : T.borderSoft}`,
                          background: on ? T.accentText : "transparent",
                          color: on ? T.onPrimary : "transparent",
                          fontSize: "10px",
                          lineHeight: "14px",
                          textAlign: "center",
                          flex: "none",
                        },
                        "aria-hidden": "true",
                      },
                      "✓",
                    ),
                    label,
                  );
                })(),
              ),
            ),
            h("span", { style: styles.name }, text(t, "views.savedTitle")),
            views.length === 0
              ? h(
                  "span",
                  { style: { ...styles.meta, whiteSpace: "normal", lineHeight: 1.5 } },
                  text(t, "views.savedEmpty"),
                )
              : h(
                  "div",
                  {
                    style: { display: "flex", flexDirection: "column", gap: "4px" },
                    "data-projects-saved-views": "",
                  },
                  views.map((/** @type {any} */ view) =>
                    h(
                      "div",
                      {
                        key: view.id,
                        style: {
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          fontSize: "12.5px",
                        },
                        "data-projects-saved-view": view.id,
                      },
                      h("span", { style: { flex: "1 1 auto", minWidth: 0 } }, String(view.name)),
                      h(
                        "button",
                        {
                          type: "button",
                          style: {
                            ...styles.secondaryButton,
                            padding: "1px 8px",
                            fontSize: "11.5px",
                          },
                          "data-projects-saved-view-apply": view.id,
                          onClick: () => {
                            setFilter(String(view.filter ?? ""));
                            setPanelQuery(String(view.query ?? ""));
                            setTab("threads");
                          },
                        },
                        text(t, "views.apply"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          style: {
                            ...styles.secondaryButton,
                            padding: "1px 8px",
                            fontSize: "11.5px",
                          },
                          "data-projects-saved-view-delete": view.id,
                          onClick: () => deleteView(view.id),
                        },
                        text(t, "views.delete"),
                      ),
                    ),
                  ),
                ),
            h(
              "div",
              {
                style: { display: "flex", gap: "6px", alignItems: "center" },
                "data-projects-view-add": "",
              },
              h("input", {
                style: { ...styles.input, fontSize: "12px", padding: "3px 8px" },
                value: viewName,
                placeholder: text(t, "detail.viewNamePlaceholder"),
                "data-projects-view-add-name": "",
                onChange: (/** @type {any} */ event) => setViewName(event.target.value),
              }),
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.primaryButton, padding: "3px 10px", fontSize: "12px" },
                  "data-projects-view-add-save": "",
                  onClick: saveView,
                },
                text(t, "detail.viewSave"),
              ),
            ),
            h(
              "span",
              { style: { ...styles.meta, whiteSpace: "normal" } },
              text(t, "views.addHint"),
            ),
          );
        }
        if (tab === "threads") {
          const rows = data.progress?.rows ?? [];
          const query = panelQuery.trim().toLowerCase();
          const matchesQuery = (/** @type {any} */ row) => {
            if (query === "") return true;
            const haystack = [
              cleanThreadTitle(row.title),
              cleanThreadTitle(row.subtitle),
              String(row.sessionId ?? ""),
            ]
              .join(" ")
              .toLowerCase();
            return haystack.indexOf(query) >= 0;
          };
          const visibleRows = (
            filter === ""
              ? rows
              : rows.filter((/** @type {any} */ row) => row.view.state === filter)
          ).filter(matchesQuery);
          const visibleIds = new Set(
            /** @type {any[]} */ (visibleRows).map((row) => String(row.sessionId)),
          );
          const groups = (Array.isArray(data.progress?.groups) ? data.progress.groups : [])
            .map((/** @type {any} */ group) => ({
              ...group,
              rows: (Array.isArray(group.rows) ? group.rows : []).filter((/** @type {any} */ row) =>
                visibleIds.has(String(row.sessionId)),
              ),
            }))
            .filter((/** @type {any} */ group) => group.rows.length > 0);
          if (rows.length === 0) {
            // U23 空态：一句解释 + 下一步 CTA（不再只有一句话）
            return h(
              "div",
              { "data-projects-threads": "", "data-projects-attention": "0" },
              h(
                "div",
                { style: styles.emptyCta, "data-projects-threads-empty": "" },
                h("span", { style: styles.emptyHint }, text(t, "detail.threadsEmpty")),
              ),
            );
          }
          if (visibleRows.length === 0) {
            // 药丸过滤后为空：仍然给一句 Claude 原文结构的空态 + 清除过滤的出口
            return h(
              "div",
              {
                "data-projects-threads": "",
                "data-projects-attention": String(data.progress?.attention ?? 0),
                "data-projects-filter": filter,
              },
              h(
                "div",
                { style: styles.emptyCta, "data-projects-empty-overview": "" },
                h(
                  "span",
                  { style: styles.name },
                  text(t, query === "" ? "detail.emptyOverview" : "detail.emptySearch"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-empty-overview-clear": "",
                    onClick: () => {
                      setFilter("");
                      setPanelQuery("");
                    },
                  },
                  text(t, "detail.pillClear"),
                ),
              ),
            );
          }
          return h(
            "div",
            {
              "data-projects-threads": "",
              "data-projects-attention": String(data.progress?.attention ?? 0),
              "data-projects-filter": filter,
            },
            groups.map((/** @type {any} */ group) => {
              const collapsed = collapsedGroups[group.id] === true;
              const position = Math.min(
                Number(carousel[group.id] ?? 0),
                Math.max(0, group.rows.length - 1),
              );
              const focusedId = group.rows[position]?.sessionId;
              return h(
                "div",
                { key: `group:${group.id}`, "data-projects-group-section": group.id },
                // U11 分组头：▾ + 名称 + 计数 + 菜单；U14 轮播在右侧
                h(
                  "div",
                  {
                    style:
                      colorScheme === "light"
                        ? {
                            ...styles.groupHead,
                            background:
                              groupHover === group.id ? "rgba(0,0,0,0.07)" : "rgba(0,0,0,0.045)",
                            padding: "3px 8px",
                          }
                        : {
                            ...styles.groupHead,
                            background:
                              groupHover === group.id ? "rgba(127,127,127,0.09)" : T.panel,
                            padding: "3px 8px",
                          },
                    onMouseEnter: () => setGroupHover(group.id),
                    onMouseLeave: () => setGroupHover(""),
                    "data-projects-group": group.id,
                    "data-projects-group-hover": groupHover === group.id ? "true" : "false",
                    "data-projects-group-count": String(group.rows.length),
                    "data-projects-group-collapsed": collapsed ? "true" : "false",
                  },
                  h(
                    "button",
                    {
                      type: "button",
                      style: styles.groupToggle,
                      "data-projects-group-toggle": group.id,
                      "aria-expanded": collapsed ? "false" : "true",
                      "aria-label": text(
                        t,
                        collapsed ? "detail.groupExpand" : "detail.groupCollapse",
                      ),
                      onClick: () => setGroupCollapsed(group.id, !collapsed),
                    },
                    h(
                      "span",
                      {
                        style: {
                          color: T.dim,
                          width: "12px",
                          display: "inline-block",
                          fontSize: "12px",
                          lineHeight: 1,
                        },
                      },
                      collapsed ? "›" : "⌄",
                    ),
                    h("span", { style: { fontSize: "12px", color: T.dim } }, groupLabel(group.id)),
                    h(
                      "span",
                      { style: styles.groupCount, "data-projects-group-badge": group.id },
                      ` · ${String(group.rows.length)}`,
                    ),
                  ),
                  h("span", { style: { flex: "1 1 auto" } }),
                  // 拖拽柄（Claude 的分组头右端有 ⠿；排序本身留待后续，这里只给视觉锚点）
                  h(
                    "span",
                    {
                      style: {
                        color: T.faint,
                        fontSize: "11px",
                        cursor: "default",
                        paddingTop: "2px",
                        opacity: groupHover === group.id || groupMenu === group.id ? 1 : 0,
                        transition: "opacity 120ms",
                      },
                      "data-panel-group-handle": group.id,
                      title: text(t, "detail.groupReorderHint"),
                    },
                    "⠿",
                  ),
                  // 轮播只在组内条目多的时候才出现：2 条时「1–2 of 2 预览 ⋯」
                  // 只是噪音（真机截图里整行控件都比线程内容显眼）
                  group.rows.length > 3
                    ? h(
                        "span",
                        {
                          style: {
                            ...styles.carousel,
                            opacity: groupHover === group.id || groupMenu === group.id ? 1 : 0,
                            transition: "opacity 120ms",
                          },
                          "data-projects-carousel": group.id,
                        },
                        h(
                          "button",
                          {
                            type: "button",
                            style: styles.iconButton,
                            "data-projects-carousel-prev": group.id,
                            "aria-label": text(t, "detail.carouselPrev"),
                            onClick: () => moveCarousel(group.id, -1, group.rows.length),
                          },
                          "‹",
                        ),
                        h(
                          "span",
                          { "data-projects-carousel-position": group.id },
                          `${position + 1}/${group.rows.length}`,
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            style: styles.iconButton,
                            "data-projects-carousel-next": group.id,
                            "aria-label": text(t, "detail.carouselNext"),
                            onClick: () => moveCarousel(group.id, 1, group.rows.length),
                          },
                          "›",
                        ),
                        // 不渲染「预览」文字按钮：407px 宽下会把分组头挤爆；点行本身即可展开
                      )
                    : null,
                  h(Popover, {
                    open: groupMenu === group.id,
                    onClose: () => setGroupMenu(""),
                    anchor: h(
                      "button",
                      {
                        type: "button",
                        style: styles.iconButton,
                        "data-projects-group-menu": group.id,
                        "aria-label": text(t, "detail.groupMenu"),
                        "aria-haspopup": "menu",
                        "aria-expanded": groupMenu === group.id ? "true" : "false",
                        onClick: () => setGroupMenu(groupMenu === group.id ? "" : group.id),
                      },
                      uiIcon("more", "⋯", 14),
                    ),
                    menu: h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: "2px" } },
                      h(
                        "button",
                        {
                          type: "button",
                          role: "menuitem",
                          style: menuItemStyle,
                          "data-projects-group-collapse-all": "",
                          onClick: () => {
                            setGroupMenu("");
                            collapseAllGroups(true);
                          },
                        },
                        text(t, "detail.groupCollapseAll"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          role: "menuitem",
                          style: menuItemStyle,
                          "data-projects-group-expand-all": "",
                          onClick: () => {
                            setGroupMenu("");
                            collapseAllGroups(false);
                          },
                        },
                        text(t, "detail.groupExpandAll"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          role: "menuitem",
                          style: menuItemStyle,
                          "data-projects-group-only": group.id,
                          onClick: () => {
                            setGroupMenu("");
                            setFilter(filter === group.id ? "" : group.id);
                          },
                        },
                        text(t, "detail.groupOnly"),
                      ),
                    ),
                  }),
                ),
                collapsed
                  ? null
                  : h(
                      "div",
                      { style: styles.groupBody, "data-projects-group-body": group.id },
                      group.rows.map((/** @type {any} */ row) =>
                        threadRowView(row, group.rows.length > 3 && row.sessionId === focusedId),
                      ),
                    ),
              );
            }),
          );
        }
        // 审计已外迁到设置分节 Debug 区（§7.3：审计/诊断这类进设置页），详情页不再有审计视图。
        return null;
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
        artifactViewer
          ? h(ArtifactViewer, {
              t: t,
              item: artifactViewer,
              onClose: () => setArtifactViewer(null),
            })
          : null,
        // —— 头部：返回 / 标题 / 收藏 / ⋯ ——
        // 头部与内容用同一套栅格：pin 与 ⋯ 贴**主列右缘**（1440 宽下不再跑到页面最右）。
        h(
          "div",
          {
            style: narrow ? styles.detailGridNarrow : styles.detailGrid,
            "data-projects-detail-head": "",
            "data-projects-state-actions": "",
          },
          h(
            "div",
            { style: styles.headMain, "data-projects-detail-head-main": "" },
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
            // F7/U2：标题即项目切换器（下拉换项目，不用先回列表）
            h(Popover, {
              open: switcherOpen,
              onClose: () => setSwitcherOpen(false),
              anchor: h(
                "button",
                {
                  type: "button",
                  style: {
                    ...styles.detailTitle,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    border: "none",
                    background: "transparent",
                    color: T.text,
                    cursor: "pointer",
                    padding: 0,
                    minWidth: 0,
                  },
                  "data-projects-switcher": "",
                  "data-projects-detail-title": "",
                  "aria-haspopup": "menu",
                  "aria-expanded": switcherOpen ? "true" : "false",
                  "aria-label": text(t, "detail.switch"),
                  title: text(t, "detail.switch"),
                  onClick: () => setSwitcherOpen(!switcherOpen),
                },
                project.icon
                  ? h("span", { "data-projects-detail-icon": "" }, String(project.icon))
                  : null,
                h(
                  "span",
                  {
                    style: {
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  project.name,
                ),
                h("span", { style: { color: T.dim, fontSize: "12px" } }, "▾"),
              ),
              menu: h(
                "div",
                { style: styles.switchList, "data-projects-switcher-menu": "" },
                (Array.isArray(props.projects) ? props.projects : []).map(
                  (/** @type {any} */ candidate) =>
                    h(
                      "button",
                      {
                        type: "button",
                        key: candidate.id,
                        role: "menuitem",
                        style: {
                          ...styles.switchRow,
                          background: candidate.id === project.id ? T.hover : "transparent",
                        },
                        "data-projects-switcher-option": candidate.id,
                        onClick: () => {
                          setSwitcherOpen(false);
                          if (
                            candidate.id !== project.id &&
                            typeof props.onSwitchProject === "function"
                          ) {
                            props.onSwitchProject(candidate.id);
                          }
                        },
                      },
                      candidate.icon ? h("span", {}, String(candidate.icon)) : null,
                      h(
                        "span",
                        {
                          style: {
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          },
                        },
                        String(candidate.name),
                      ),
                      candidate.id === project.id
                        ? h("span", { style: { marginLeft: "auto", color: T.accentText } }, "✓")
                        : null,
                    ),
                ),
                (Array.isArray(props.projects) ? props.projects : []).length === 0
                  ? h("span", { style: styles.meta }, text(t, "detail.switchEmpty"))
                  : null,
              ),
            }),
            // U2：Overview（清过滤/展开分组，回到总览）
            h(
              "button",
              {
                type: "button",
                style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                "data-projects-overview": "",
                onClick: () => {
                  setFilter("");
                  setCarousel({});
                  collapseAllGroups(false);
                  if (
                    threadInputRef.current &&
                    typeof threadInputRef.current.scrollIntoView === "function"
                  ) {
                    threadInputRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
                  }
                },
              },
              text(t, "detail.overview"),
            ),
            // 通知铃铛：数量 = 需要你处理（等你 + 失败）。点一下直接筛到「等你」。
            h(
              "button",
              {
                type: "button",
                style: { ...styles.iconButton, position: "relative" },
                "data-projects-bell": String(Number(data.progress?.attention ?? 0) || 0),
                "aria-label": text(t, "detail.bellTitle", {
                  count: Number(data.progress?.attention ?? 0) || 0,
                }),
                title: text(t, "detail.bellTitle", {
                  count: Number(data.progress?.attention ?? 0) || 0,
                }),
                onClick: () => {
                  const attention = Number(data.progress?.attention ?? 0) || 0;
                  setFilter(attention > 0 && filter !== "waiting-user" ? "waiting-user" : "");
                },
              },
              h(
                "span",
                {
                  style: {
                    display: "inline-flex",
                    color: Number(data.progress?.attention ?? 0) > 0 ? T.text : T.faint,
                  },
                },
                glyph("bell", 15),
              ),
              Number(data.progress?.attention ?? 0) > 0
                ? h(
                    "span",
                    {
                      style: {
                        position: "absolute",
                        top: "0px",
                        right: "0px",
                        minWidth: "13px",
                        height: "13px",
                        borderRadius: "999px",
                        background: T.brand,
                        color: T.onBrand,
                        fontSize: "9.5px",
                        lineHeight: "13px",
                        textAlign: "center",
                        padding: "0 3px",
                      },
                      "data-projects-bell-count": "",
                    },
                    String(Number(data.progress?.attention ?? 0)),
                  )
                : null,
            ),
            // U2：⚙。宿主没有暴露"打开插件设置"的 client API（未验证），拿不到就明说去哪里找。
            h(
              "button",
              {
                type: "button",
                style: styles.iconButton,
                // 与设置面板根 `data-projects-settings` 区分开：否则"设置是否打开"会误判（桌面回归踩过）
                "data-projects-header-settings": "",
                "aria-label": text(t, "detail.settings"),
                title: text(t, "detail.settings"),
                onClick: () => {
                  const opened =
                    typeof api.openSettings === "function" ? api.openSettings() : false;
                  if (opened !== true && typeof props.onToast === "function") {
                    props.onToast(text(t, "detail.settingsHint"));
                  }
                },
              },
              "⚙",
            ),
            h("span", { style: { flex: "1 1 auto" } }),
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
          narrow
            ? null
            : h("span", { style: { minWidth: 0 }, "data-projects-detail-head-rail": "" }),
        ),
        project.goal
          ? h(
              "span",
              { style: { ...styles.meta, display: "block" }, "data-projects-detail-goal": "" },
              project.goal,
            )
          : null,
        h(
          "div",
          {
            ref: gridRef,
            style: narrow ? styles.detailGridNarrow : styles.detailGrid,
            "data-projects-detail-grid": "",
          },
          // —— 左列：项目对话（thread 操作条 / 协调者 / composer / 按规则派活 / 审批）——
          h(
            "div",
            {
              // 宽窗让 composer 贴左列底部（Claude 形状）；窄窗单列时不撑高，避免中间一大段空白
              style: narrow
                ? styles.mainCol
                : {
                    ...styles.mainCol,
                    minHeight: "calc(100vh - 160px)",
                    display: "flex",
                    flexDirection: "column",
                  },
              "data-projects-detail-main": "",
            },
            // 诊断摘要：一行说清"工作区/协调者/轮询"三件事，点「详情」才展开原始行
            h(
              "div",
              {
                style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
                "data-projects-diagnostics": "",
              },
              h(
                "span",
                { style: { ...styles.meta, fontSize: "12px" } },
                [
                  hasDir
                    ? text(t, "detail.diag.workspaceBound")
                    : text(t, "detail.diag.workspaceUnbound"),
                  data.coordinator?.available === true
                    ? text(t, "detail.diag.coordinatorReady")
                    : text(t, "detail.diag.coordinatorEmpty"),
                  data.poll?.running === true
                    ? text(t, "detail.diag.pollRunning")
                    : text(t, "detail.diag.pollStopped"),
                ].join(" · "),
              ),
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.secondaryButton, fontSize: "11px", padding: "0 8px" },
                  "data-projects-diagnostics-toggle": showDiagnostics ? "open" : "closed",
                  onClick: () => setShowDiagnostics(!showDiagnostics),
                },
                text(t, "detail.diag.details"),
              ),
            ),
            // 主列空态：Claude 的项目主页有一段"欢迎 + 怎么用"的文字，不是纯空白
            Number(data.progress?.total ?? 0) === 0 &&
              !(Array.isArray(data.coordinator?.messages) && data.coordinator.messages.length > 0)
              ? h(
                  "div",
                  { style: { padding: "10px 2px 0" }, "data-projects-main-welcome": "" },
                  h(
                    "div",
                    { style: { ...styles.welcomeTitle, fontSize: "21px" } },
                    text(t, "detail.mainWelcomeTitle"),
                  ),
                  h(
                    "div",
                    { style: { ...styles.welcomeSub, maxWidth: "620px", lineHeight: 1.5 } },
                    text(t, "detail.mainWelcomeBody"),
                  ),
                )
              : null,
            threadAction.message !== ""
              ? h(
                  "div",
                  {
                    style: {
                      ...styles.meta,
                      color: threadAction.ok === false ? T.danger : T.text,
                    },
                    "data-projects-thread-action-result": "",
                    // F20/P1-4：冒烟要点按钮验结果态，ok 也要能读（成功条/失败条）
                    "data-projects-thread-action-ok": String(threadAction.ok),
                  },
                  threadAction.message,
                )
              : null,
            !hasDir && (Array.isArray(data.threads) ? data.threads.length : 0) === 0
              ? h(
                  "div",
                  {
                    // 默认也收进「详情」里：主列顶部只留一行摘要（参考图顶部没有排障段落）
                    style: showDiagnostics
                      ? { ...styles.meta, whiteSpace: "nowrap" }
                      : { ...styles.meta, whiteSpace: "nowrap", display: "none" },
                    title: text(t, "detail.noDirHint"),
                    "data-projects-no-dir-hint": "",
                  },
                  text(t, "detail.noDirHint"),
                )
              : null,
            // —— U4/F9/F10/F11/F13：协调者区（**不是**宿主 composer）——
            // 一个长期会话：你只跟它说话；它在线程跑完后汇报（结论上浮 + thread chip）。
            // 没有会话时显示"建协调者"；compaction 缺失时如实说明（F10 的判空兜底）。
            (() => {
              const coordinator = data.coordinator || null;
              const available = coordinator?.available === true;
              const messages = Array.isArray(coordinator?.messages)
                ? coordinator.messages.slice(-4)
                : [];
              const chips = (Array.isArray(coordinator?.threads) ? coordinator.threads : []).slice(
                0,
                6,
              );
              const compaction = coordinator?.compaction || null;
              return h(
                "div",
                {
                  style: styles.coordinator,
                  "data-projects-coordinator": available ? "ready" : "empty",
                  "data-projects-coordinator-available": available ? "yes" : "no",
                  "data-projects-coordinator-session": String(coordinator?.sessionId ?? ""),
                },
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
                  h(
                    "span",
                    { style: styles.name, "data-projects-coordinator-title": "" },
                    text(t, "detail.coordinator"),
                  ),
                  available
                    ? h(
                        "span",
                        {
                          style:
                            colorScheme === "light"
                              ? { ...styles.pill, background: "rgba(0,0,0,0.045)" }
                              : styles.pill,
                          "data-projects-coordinator-state": "ready",
                        },
                        String(coordinator.sessionId).slice(0, 10),
                      )
                    : null,
                  h("span", { style: { flex: "1 1 auto" } }),
                  available
                    ? h(
                        "button",
                        {
                          type: "button",
                          style: {
                            ...styles.secondaryButton,
                            padding: "2px 10px",
                            fontSize: "12px",
                          },
                          "data-projects-coordinator-restart": "",
                          disabled: coordinatorBusy,
                          onClick: restartCoordinator,
                        },
                        text(t, "detail.coordinatorRestart"),
                      )
                    : h(
                        "button",
                        {
                          type: "button",
                          style: {
                            ...styles.secondaryButton,
                            padding: "2px 10px",
                            fontSize: "12px",
                          },
                          "data-projects-coordinator-create": "",
                          disabled: coordinatorBusy,
                          onClick: createCoordinator,
                        },
                        text(t, "detail.coordinatorCreate"),
                      ),
                ),
                compaction
                  ? h(
                      "div",
                      {
                        // 窄窗隐藏：这是部署能力说明（无 compaction），不属于对话内容
                        style:
                          narrow || !showDiagnostics
                            ? { ...styles.meta, display: "none" }
                            : styles.meta,
                        "data-projects-coordinator-compaction": compaction.available ? "yes" : "no",
                        title: String(compaction.note || compaction.mode || ""),
                      },
                      compaction.available
                        ? text(t, "detail.coordinatorCompactionYes", {
                            mode: String(compaction.mode ?? ""),
                          })
                        : text(t, "detail.coordinatorCompactionNo"),
                    )
                  : null,
                messages.length > 0
                  ? h(
                      "div",
                      { style: styles.dayDivider, "data-projects-day-divider": "" },
                      h("span", {
                        style: { flex: "1 1 auto", height: "1px", background: T.borderSoft },
                      }),
                      text(t, "detail.today"),
                      h("span", {
                        style: { flex: "1 1 auto", height: "1px", background: T.borderSoft },
                      }),
                    )
                  : null,
                messages.length === 0
                  ? h(
                      "div",
                      { style: styles.meta, "data-projects-coordinator-empty": "" },
                      text(t, "detail.coordinatorEmpty"),
                    )
                  : h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                      messages.length > 3
                        ? h(
                            "button",
                            {
                              type: "button",
                              style: {
                                ...styles.meta,
                                textAlign: "left",
                                background: "transparent",
                                border: "none",
                                padding: "0 0 2px",
                                cursor: "pointer",
                                color: T.dim,
                              },
                              "data-projects-coordinator-folded": "",
                              "data-projects-coordinator-folded-open": coordFoldOpen
                                ? "true"
                                : "false",
                              onClick: () => setCoordFoldOpen(!coordFoldOpen),
                            },
                            coordFoldOpen
                              ? text(t, "detail.coordinatorFoldHide")
                              : text(t, "detail.coordinatorFold", {
                                  count: messages.length - 3,
                                }),
                          )
                        : null,
                      messages.length > 3 && coordFoldOpen
                        ? messages
                            .slice(0, messages.length - 3)
                            .map((/** @type {any} */ item, /** @type {number} */ index) =>
                              h(
                                "div",
                                {
                                  key: `fold-${String(index)}`,
                                  style:
                                    item.role === "assistant"
                                      ? styles.coordinatorBubble
                                      : colorScheme === "light"
                                        ? {
                                            ...styles.coordinatorBubbleUser,
                                            background: "rgba(0,0,0,0.045)",
                                          }
                                        : styles.coordinatorBubbleUser,
                                  "data-projects-coordinator-message": String(item.role),
                                  "data-projects-coordinator-message-folded": "",
                                },
                                String(item.text ?? "").slice(0, 400),
                              ),
                            )
                        : null,
                      messages
                        .slice(Math.max(0, messages.length - 3))
                        // 结论已在上面单独成块：列表里剔除同一条，避免同一句话出现两次
                        .filter(
                          (/** @type {any} */ item) =>
                            !(
                              item.role === "assistant" &&
                              String(item.text ?? "").trim() ===
                                String(coordinator?.conclusion ?? "").trim() &&
                              String(coordinator?.conclusion ?? "").trim() !== ""
                            ),
                        )
                        .map((/** @type {any} */ item, /** @type {number} */ index) =>
                          h(
                            "div",
                            {
                              key: String(index),
                              style:
                                item.role === "assistant"
                                  ? styles.coordinatorBubble
                                  : styles.coordinatorBubbleUser,
                              "data-projects-coordinator-message": String(item.role),
                            },
                            String(item.text ?? "").slice(0, 400),
                          ),
                        ),
                    ),
                String(coordinator?.conclusion ?? "") !== ""
                  ? h(
                      "div",
                      { style: styles.conclusion, "data-projects-coordinator-report": "" },
                      `${text(t, "detail.coordinatorConclusion")}：${String(
                        coordinator.conclusion,
                      ).slice(0, 400)}`,
                    )
                  : null,
                // M6：结论旁的产物 chip（Claude 的「结论 + 产物」）
                Array.isArray(coordinator?.artifacts) && coordinator.artifacts.length > 0
                  ? h(
                      "div",
                      {
                        style: { display: "flex", flexWrap: "wrap", gap: "6px" },
                        "data-projects-coordinator-artifacts": "",
                      },
                      coordinator.artifacts.map((/** @type {any} */ item) =>
                        h(
                          "span",
                          {
                            key: String(item.id),
                            style: {
                              ...styles.inlineChip,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              maxWidth: "200px",
                              cursor: "pointer",
                            },
                            "data-projects-coordinator-artifact": String(item.id),
                            title: String(item.title || item.id),
                            onClick: () => setArtifactViewer(item),
                          },
                          String(item.kind ?? "") === "markdown" ||
                            String(item.kind ?? "") === "json" ||
                            String(item.kind ?? "") === "csv"
                            ? h("img", {
                                src:
                                  String(item.coverUrl ?? "") !== ""
                                    ? String(item.coverUrl)
                                    : `/artifacts/${encodeURIComponent(String(item.id))}/cover.svg`,
                                alt: "",
                                style: {
                                  width: "20px",
                                  height: "15px",
                                  objectFit: "cover",
                                  borderRadius: "3px",
                                },
                              })
                            : null,
                          h(
                            "span",
                            {
                              style: {
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              },
                            },
                            String(item.title || item.id),
                          ),
                        ),
                      ),
                    )
                  : null,
                chips.length > 0
                  ? h(
                      "div",
                      {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          gap: "1px",
                          marginTop: "2px",
                          "data-projects-coordinator-refs": "",
                        },
                      },
                      chips.map((/** @type {any} */ chip) => {
                        var chipState = String(chip.state ?? "idle");
                        return h(
                          "div",
                          {
                            key: String(chip.sessionId),
                            style: styles.refRow,
                            title: String(chip.title || chip.sessionId),
                            "data-projects-coordinator-ref": String(chip.sessionId),
                            "data-projects-coordinator-chip": String(chip.sessionId),
                            "data-projects-chip-branch": String(chip.branch ?? ""),
                            "data-projects-chip-pr":
                              Number(chip.prNumber) > 0 ? String(Number(chip.prNumber)) : "",
                            onClick: () => setExpandedThread(String(chip.sessionId)),
                          },
                          h("span", { style: { color: T.dim, fontSize: "12px" } }, "└"),
                          h(
                            "span",
                            {
                              style: {
                                display: "inline-flex",
                                color:
                                  chipState === "resolved"
                                    ? T.success
                                    : chipState === "working"
                                      ? T.accentText
                                      : chipState === "failed"
                                        ? T.danger
                                        : T.dim,
                              },
                              "data-projects-chip-dot": chipState,
                            },
                            chipState === "working"
                              ? glyph("arc", 12)
                              : chipState === "resolved"
                                ? glyph("check", 12)
                                : h("span", { style: styles.chipDot, background: T.faint }),
                          ),
                          h(
                            "span",
                            {
                              style: {
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontSize: "12.5px",
                              },
                            },
                            String(chip.title || chip.sessionId).slice(0, 48),
                          ),
                          Number(chip.prNumber) > 0
                            ? h(
                                "span",
                                {
                                  style: {
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "3px",
                                    color: T.success,
                                    fontSize: "11.5px",
                                  },
                                },
                                glyph("pr", 12),
                                `#${Number(chip.prNumber)}`,
                              )
                            : null,
                          h("span", { style: { flex: "1 1 auto" } }),
                          h(
                            "span",
                            {
                              style: { color: T.dim, fontSize: "12px", paddingLeft: "4px" },
                              "data-projects-coordinator-ref-menu": String(chip.sessionId),
                            },
                            "⋯",
                          ),
                        );
                      }),
                    )
                  : null,
                // F21：轮询状态 + 实验性实时监听开关（**默认关**，说明会建临时 webhook）
                h(
                  "div",
                  {
                    // 窄窗隐藏：这一行是排障信息（"PR 轮询·上次·间隔"），Claude 的窄屏不摆它
                    style: {
                      display: narrow || !showDiagnostics ? "none" : "flex",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    },
                    "data-projects-detail-poll-row": "",
                  },
                  h(
                    "span",
                    {
                      style: styles.meta,
                      "data-projects-poll-state":
                        data.poll?.running === true ? "running" : "stopped",
                    },
                    text(t, "settings.pollState", {
                      state:
                        data.poll?.running === true
                          ? text(t, "settings.pollRunning")
                          : text(t, "settings.pollStopped"),
                      at: data.poll?.lastAt
                        ? new Date(Number(data.poll.lastAt)).toLocaleTimeString()
                        : "—",
                      delay: String(Math.round(Number(data.poll?.nextDelayMs ?? 30000) / 1000)),
                    }),
                  ),
                  h(
                    "label",
                    {
                      style: {
                        display: "flex",
                        gap: "6px",
                        alignItems: "center",
                        fontSize: "11.5px",
                        color: T.dim,
                        marginLeft: "auto",
                      },
                      title: text(t, "settings.realtimeCiHint"),
                      "data-projects-detail-realtime-ci-row": "",
                    },
                    h("input", {
                      type: "checkbox",
                      // B2 复审 P1-2：实时监听**未实现**（要 gh webhook forward + 管理员 + 验签），
                      // 以前开关能点能存却什么也不启动，属于假承诺；现在 disabled 并写明原因。
                      checked: false,
                      disabled: true,
                      "data-projects-detail-realtime-ci": "",
                      "data-projects-detail-realtime-ci-implemented": "no",
                    }),
                    text(t, "settings.realtimeCi"),
                  ),
                ),
                Number(pills.working ?? 0) > 0
                  ? h(
                      "div",
                      { style: styles.workingRow, "data-projects-working-row": "" },
                      h("span", { style: { color: "#c2703e", fontSize: "13px" } }, "✳"),
                      h(
                        "span",
                        {},
                        text(t, "detail.workingLine", { count: Number(pills.working ?? 0) }),
                      ),
                    )
                  : null,
                // 协调者输入已并入底部 composer（目标切换）；这里只留模型药丸，且只在有会话时显示
                h(
                  "div",
                  {
                    style: {
                      display: coordinator?.available === true ? "flex" : "none",
                      gap: "6px",
                      alignItems: "center",
                    },
                  },
                  h(
                    "div",
                    { style: { position: "relative", flex: "none" } },
                    h(
                      "button",
                      {
                        type: "button",
                        style: {
                          ...styles.secondaryButton,
                          padding: "1px 8px",
                          fontSize: "11.5px",
                          whiteSpace: "nowrap",
                        },
                        "data-projects-coordinator-model-pill": "",
                        "data-projects-coordinator-model-pill-label": coordPillLabel,
                        "data-projects-coordinator-model-open": coordPillOpen ? "true" : "false",
                        title: text(t, "detail.coordinatorModelHint"),
                        onClick: () => setCoordPillOpen(!coordPillOpen),
                      },
                      `${coordPillLabel} ▾`,
                    ),
                    coordPillOpen
                      ? h(
                          "div",
                          {
                            style: {
                              position: "absolute",
                              right: 0,
                              top: "calc(100% + 8px)",
                              zIndex: 14,
                              minWidth: "250px",
                              background: T.card,
                              border: `1px solid ${T.border}`,
                              borderRadius: "8px",
                              boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                              padding: "8px",
                              display: "flex",
                              flexDirection: "column",
                              gap: "6px",
                              color: T.text,
                            },
                            "data-projects-coordinator-model-menu": "",
                          },
                          h(
                            "span",
                            { style: { ...styles.meta, fontSize: "11px" } },
                            text(t, "detail.coordinatorModelMenuTitle"),
                          ),
                          modelOptions.length > 0
                            ? h(
                                "select",
                                {
                                  style: styles.input,
                                  value: `${String(coordPicked.provider ?? "")}:${String(coordPicked.model ?? "")}`,
                                  "data-projects-coordinator-model-select": "",
                                  onChange: (/** @type {any} */ event) => {
                                    const key = String(event.target.value || "");
                                    const sep = key.indexOf(":");
                                    setCoordPick({
                                      provider: sep >= 0 ? key.slice(0, sep) : "",
                                      model: sep >= 0 ? key.slice(sep + 1) : key,
                                      effort: "",
                                    });
                                  },
                                },
                                [""].map((/** @type {string} */ value) =>
                                  h(
                                    "option",
                                    { key: "inherit", value: value },
                                    text(t, "detail.composerModelInherit"),
                                  ),
                                ),
                                modelOptions.map((/** @type {any} */ option) =>
                                  h(
                                    "option",
                                    { key: option.key, value: option.key },
                                    String(option.label),
                                  ),
                                ),
                              )
                            : h(
                                "div",
                                {
                                  style: { display: "flex", flexDirection: "column", gap: "4px" },
                                  "data-projects-coordinator-model-manual-menu": "",
                                },
                                h("input", {
                                  style: styles.input,
                                  value: `${String(coordPicked.provider ?? "")}|${String(coordPicked.model ?? "")}`,
                                  placeholder: "provider|model",
                                  "data-projects-coordinator-model-manual": "",
                                  onChange: (/** @type {any} */ event) =>
                                    setCoordPick((/** @type {any} */ prev) => {
                                      const text = String(event.target.value || "");
                                      const sep = text.indexOf("|");
                                      return {
                                        ...(prev ?? {}),
                                        provider: sep >= 0 ? text.slice(0, sep) : "",
                                        model: sep >= 0 ? text.slice(sep + 1) : text,
                                      };
                                    }),
                                }),
                              ),
                          h("input", {
                            style: styles.input,
                            value: String(coordPicked.effort ?? ""),
                            placeholder: text(t, "detail.effortPlaceholder"),
                            "data-projects-coordinator-model-effort": "",
                            onChange: (/** @type {any} */ event) =>
                              setCoordPick((/** @type {any} */ prev) => ({
                                ...(prev ?? {}),
                                effort: String(event.target.value || ""),
                              })),
                          }),
                          h(
                            "div",
                            { style: { display: "flex", gap: "6px" } },
                            h(
                              "button",
                              {
                                type: "button",
                                style: {
                                  ...styles.primaryButton,
                                  padding: "2px 10px",
                                  fontSize: "12px",
                                },
                                "data-projects-coordinator-model-save": "",
                                onClick: saveCoordinatorModel,
                              },
                              text(t, "detail.composerModelSave"),
                            ),
                          ),
                        )
                      : null,
                  ),
                ),
                coordinatorMsg !== ""
                  ? h(
                      "div",
                      { style: styles.meta, "data-projects-coordinator-result": "" },
                      coordinatorMsg,
                    )
                  : null,
              );
            })(),
            // 按规则派活：保留既有语义（一句话决定怎么做），锚点与旧 UI 一致；
            // 窄窗隐藏（三行输入框堆叠太吵），入口仍在「项目设置 → 通用」的指令里
            h(
              "div",
              {
                style: {
                  display: narrow || !showRouteRow ? "none" : "flex",
                  gap: "8px",
                  alignItems: "center",
                },
                "data-projects-route-row": "",
              },
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
            // 把对话内容留在上方，composer 贴左列底部（Claude 形状）
            h("div", {
              style: { flex: "1 1 auto", minHeight: "12px" },
              "data-projects-composer-spacer": "",
            }),
            h(
              "div",
              {
                style: colorScheme === "light" ? styles.composerCardLight : styles.composerCard,
                "data-projects-composer": "",
              },
              slashOpen && slashMatches.length > 0
                ? h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        gap: "1px",
                        marginBottom: "4px",
                        border: `1px solid ${T.borderSoft}`,
                        borderRadius: "10px",
                        padding: "4px",
                        background: T.panel,
                      },
                      "data-panel-slash-menu": "",
                    },
                    slashMatches.map((command) =>
                      h(
                        "button",
                        {
                          type: "button",
                          key: command.key,
                          "data-panel-slash": command.key,
                          "data-panel-slash-active":
                            slashMatches[slashIndex]?.key === command.key ? "true" : "false",
                          style: {
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            border: "none",
                            background:
                              slashMatches[slashIndex]?.key === command.key
                                ? T.hover
                                : "transparent",
                            color: T.text,
                            fontSize: "12.5px",
                            textAlign: "left",
                            padding: "4px 6px",
                            borderRadius: "6px",
                            cursor: "pointer",
                          },
                          onClick: () => runSlashCommand(command),
                        },
                        h("span", { style: { color: T.faint, width: "44px" } }, `/${command.key}`),
                        h("span", {}, command.label),
                      ),
                    ),
                  )
                : null,
              // 目标切换：协调者 / 新线程（同一个输入框，Claude 只有一个 composer）
              h("input", {
                ref: threadInputRef,
                style: {
                  ...styles.input,
                  border: "none",
                  background: "transparent",
                  padding: "2px 0",
                  fontSize: "14px",
                },
                value: composerTarget === "coordinator" ? coordinatorDraft : draft,
                placeholder: text(
                  t,
                  composerTarget === "coordinator"
                    ? "detail.coordinatorPlaceholder"
                    : "detail.threadPlaceholder",
                ),
                "data-projects-thread-input": "",
                "data-projects-coordinator-input": "",
                "data-projects-composer-target-value": composerTarget,
                onChange: (/** @type {any} */ event) => {
                  if (composerTarget === "coordinator") setCoordinatorDraft(event.target.value);
                  else setDraft(event.target.value);
                },
                onKeyDown: (/** @type {any} */ event) => {
                  if (slashOpen) {
                    if (event.key === "Escape") {
                      setDraft("");
                      return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const total = slashMatches.length;
                      if (total > 0) {
                        const delta = event.key === "ArrowDown" ? 1 : -1;
                        setSlashIndex(
                          (/** @type {number} */ prev) => (prev + delta + total) % total,
                        );
                      }
                      return;
                    }
                    if (event.key === "Enter") {
                      runSlashCommand(slashMatches[slashIndex] ?? slashMatches[0]);
                      return;
                    }
                  }
                  if (event.key === "Enter") {
                    if (composerTarget === "coordinator") sendCoordinator();
                    else createThread();
                  }
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
                    style: { ...styles.secondaryButton, fontSize: "11.5px", padding: "1px 8px" },
                    "data-projects-route-toggle": showRouteRow ? "open" : "closed",
                    onClick: () => setShowRouteRow(!showRouteRow),
                  },
                  text(t, "detail.routeToggle"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: {
                      width: "26px",
                      height: "26px",
                      borderRadius: "999px",
                      border: "none",
                      background: busy || coordinatorBusy ? T.hover : T.brand,
                      // 配对前景 token：写死白字在浅色主题下会和白底糊在一起（check 也会警告）
                      color: T.onPrimary,
                      fontSize: "13px",
                      lineHeight: 1,
                      cursor: busy || coordinatorBusy ? "default" : "pointer",
                      flex: "none",
                    },
                    title:
                      composerTarget === "coordinator"
                        ? text(t, "detail.coordinatorSend")
                        : text(t, "detail.threadCreate"),
                    "aria-label":
                      composerTarget === "coordinator"
                        ? text(t, "detail.coordinatorSend")
                        : text(t, "detail.threadCreate"),
                    // 双锚点：旧冒烟/桌面回归按这两个名字找入口；行为按当前目标分流
                    "data-projects-thread-create": "",
                    "data-projects-coordinator-send": "",
                    "data-projects-composer-send": composerTarget,
                    onClick: () => {
                      if (composerTarget === "coordinator") sendCoordinator();
                      else createThread();
                    },
                    disabled: busy || coordinatorBusy,
                  },
                  busy || coordinatorBusy ? "…" : "↵",
                ),
              ),
            ),
            // composer 控件行（Claude 输入框下方那一行）：+ / 🎤 / 模型 / effort。
            // 现阶段是**读回显 + 占位**：模型与 effort 真源在「项目设置」，这里只显示继承值。
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  paddingTop: "2px",
                  color: T.faint,
                  fontSize: "12px",
                },
                "data-composer-controls": "",
              },
              // 目标切换（Claude 只有一个 composer）：新线程 / 协调者
              ...[
                { id: "thread", label: text(t, "detail.composer.targetThread") },
                { id: "coordinator", label: text(t, "detail.composer.targetCoordinator") },
              ].map((item) =>
                h(
                  "button",
                  {
                    key: item.id,
                    type: "button",
                    "data-projects-composer-target": item.id,
                    "aria-selected": composerTarget === item.id ? "true" : "false",
                    style: {
                      border: "none",
                      background: composerTarget === item.id ? T.hover : "transparent",
                      color: composerTarget === item.id ? T.text : T.dim,
                      fontSize: "11.5px",
                      padding: "1px 7px",
                      borderRadius: "999px",
                      cursor: "pointer",
                    },
                    onClick: () => setComposerTarget(item.id),
                  },
                  item.label,
                ),
              ),
              h(
                "span",
                {
                  style: { ...styles.meta, paddingLeft: "2px" },
                  "data-projects-composer-hint": "",
                },
                text(
                  t,
                  composerTarget === "coordinator"
                    ? "detail.composerHintCoordinator"
                    : "detail.composerHint",
                ),
              ),
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "button",
                {
                  type: "button",
                  style: {
                    width: "22px",
                    height: "22px",
                    borderRadius: "999px",
                    border: `1px solid ${T.borderSoft}`,
                    background: "transparent",
                    color: T.dim,
                    cursor: "default",
                    lineHeight: 1,
                  },
                  "data-composer-attach": "",
                  title: text(t, "detail.composerAttach"),
                  disabled: true,
                },
                "+",
              ),
              h(
                "span",
                {
                  "data-composer-mic": "",
                  title: text(t, "detail.composerMic"),
                  style: { display: "inline-flex", color: T.faint },
                },
                glyph("mic", 14),
              ),
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "div",
                { style: { position: "relative" } },
                h(
                  "button",
                  {
                    type: "button",
                    style: {
                      ...styles.secondaryButton,
                      padding: "1px 8px",
                      fontSize: "11.5px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    },
                    "data-composer-model": "",
                    "data-composer-model-label": composerModelLabel,
                    "data-composer-model-open": composerModelOpen ? "true" : "false",
                    title: text(t, "detail.composerModelHint"),
                    onClick: () => setComposerModelOpen(!composerModelOpen),
                  },
                  composerModelLabel,
                  h("span", { style: { color: T.dim } }, "▾"),
                ),
                composerModelOpen
                  ? h(
                      "div",
                      {
                        style: {
                          position: "absolute",
                          right: 0,
                          bottom: "calc(100% + 8px)",
                          zIndex: 14,
                          minWidth: "240px",
                          background: T.card,
                          border: `1px solid ${T.border}`,
                          borderRadius: "8px",
                          boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                          padding: "8px",
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                          color: T.text,
                        },
                        "data-composer-model-menu": "",
                      },
                      h(
                        "span",
                        { style: { ...styles.meta, fontSize: "11px" } },
                        text(t, "detail.composerModelMenuTitle"),
                      ),
                      h(
                        "select",
                        {
                          style: styles.input,
                          value: composerPicked.model,
                          "data-composer-model-select": "",
                          onChange: (/** @type {any} */ event) =>
                            setComposerPick({
                              model: String(event.target.value || ""),
                              effort: "",
                            }),
                        },
                        [""]
                          .concat(modelOptions.map((/** @type {any} */ option) => option.key))
                          .map((/** @type {string} */ value, /** @type {number} */ index) => {
                            const option = modelOptions[index - 1];
                            return h(
                              "option",
                              { key: value || "inherit", value: value },
                              value === ""
                                ? text(t, "detail.composerModelInherit")
                                : String(option?.label ?? value),
                            );
                          }),
                      ),
                      composerEfforts.length > 0
                        ? h(
                            "select",
                            {
                              style: styles.input,
                              value: composerPicked.effort,
                              "data-composer-effort-select": "",
                              onChange: (/** @type {any} */ event) =>
                                setComposerPick((/** @type {any} */ prev) => ({
                                  model: String((prev ?? composerPicked).model ?? ""),
                                  effort: String(event.target.value || ""),
                                })),
                            },
                            [""]
                              .concat(composerEfforts)
                              .map((/** @type {string} */ value) =>
                                h(
                                  "option",
                                  { key: value || "inherit", value: value },
                                  value === "" ? text(t, "detail.composerModelInherit") : value,
                                ),
                              ),
                          )
                        : null,
                      h(
                        "div",
                        { style: { display: "flex", gap: "6px" } },
                        h(
                          "button",
                          {
                            type: "button",
                            style: {
                              ...styles.primaryButton,
                              padding: "2px 10px",
                              fontSize: "12px",
                            },
                            "data-composer-model-save": "",
                            onClick: saveComposerModel,
                          },
                          text(t, "detail.composerModelSave"),
                        ),
                      ),
                    )
                  : null,
              ),
            ),
          ),
          // —— 右列：Threads 面板（页签 + Welcome + 药丸条 + 列表/记忆/Routines）——
          h(
            "div",
            {
              style: {
                ...(narrow
                  ? styles.panelColNarrow
                  : colorScheme === "light"
                    ? styles.panelColLight
                    : styles.panelCol),
                // 宽窗：面板自己滚动，头部（页签+搜索）粘住
                ...(narrow ? {} : styles.panelColScroll),
              },
              "data-panel-column": "",
              "data-panel-scheme": colorScheme,
            },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  gap: "4px",
                  alignItems: "center",
                  flexWrap: "nowrap",
                  overflow: "hidden",
                  flexShrink: 0,
                  marginTop: "12px",
                  borderBottom:
                    colorScheme === "light"
                      ? "1px solid rgba(0,0,0,0.12)"
                      : `1px solid ${T.borderSoft}`,
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  // 与面板底色一致：透明时 sticky 滚动内容会从页签后面透出来（叠字）
                  background: colorScheme === "light" ? "#FAFAFB" : T.panel,
                  paddingTop: "2px",
                },
                role: "tablist",
              },
              tabs
                .filter(
                  (/** @type {any} */ item) =>
                    item.id === "threads" || item.id === "views" || visibleTabs[item.id] !== false,
                )
                .map((/** @type {any} */ item) =>
                  h(
                    "button",
                    {
                      type: "button",
                      key: item.id,
                      role: "tab",
                      "aria-selected": tab === item.id ? "true" : "false",
                      "data-projects-tab": item.id,
                      style: {
                        background: tab === item.id ? T.hover : "transparent",
                        border: "none",
                        borderRadius: "6px",
                        padding: "5px 7px",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                        color: tab === item.id ? T.text : T.dim,
                        fontWeight: tab === item.id ? 600 : 400,
                        cursor: "pointer",
                      },
                      onClick: () => setTab(item.id),
                    },
                    item.label,
                  ),
                ),
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "label",
                {
                  style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    border:
                      colorScheme === "light"
                        ? "1px solid rgba(0,0,0,0.12)"
                        : `1px solid ${T.borderSoft}`,
                    borderRadius: "999px",
                    padding: "1px 8px",
                    color: T.faint,
                    flex: "1 1 70px",
                    minWidth: 0,
                    maxWidth: "160px",
                  },
                  "data-panel-search-box": "",
                },
                glyph("search", 12),
                h("input", {
                  style: {
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    color: T.text,
                    fontSize: "12px",
                    width: "100%",
                    minWidth: 0,
                    padding: "2px 0",
                  },
                  value: panelQuery,
                  placeholder: text(t, "detail.panelSearch"),
                  "data-panel-search": "",
                  onChange: (/** @type {any} */ event) => setPanelQuery(event.target.value),
                  onKeyDown: (/** @type {any} */ event) => {
                    if (event.key === "Escape") setPanelQuery("");
                  },
                }),
              ),
              h(
                "button",
                {
                  type: "button",
                  style: {
                    background: "transparent",
                    border: "none",
                    color: T.dim,
                    fontSize: "14px",
                    padding: "2px 6px",
                    cursor: "pointer",
                  },
                  "data-panel-settings-open": "",
                  "aria-label": text(t, "detail.settingsOpen"),
                  title: text(t, "detail.settingsOpen"),
                  onClick: () => setPanelSettingsOpen(true),
                },
                glyph("gear", 14),
              ),
              // Claude 的面板 header 右侧有「+ Add view」；这里先做占位（禁用 + 说明）
              h(
                "button",
                {
                  type: "button",
                  style: {
                    background: "transparent",
                    border: "none",
                    color: T.faint,
                    fontSize: "12px",
                    padding: "4px 6px",
                    cursor: "default",
                  },
                  "data-panel-add-view": "",
                  title: text(t, "detail.addViewHint"),
                  onClick: () => setTab("views"),
                },
                "+",
              ),
            ),
            // —— F28/U10：Welcome 头（大字 + 状态句 + 7 日 token 迷你图）——
            (() => {
              const waiting = Number(pills["waiting-user"] ?? 0);
              const working = Number(pills.working ?? 0);
              const statusSentence =
                waiting > 0
                  ? text(t, "detail.welcomeWaiting", { count: waiting })
                  : working > 0
                    ? text(t, "detail.welcomeWorking", { count: working })
                    : Number(data.progress?.total ?? 0) === 0
                      ? text(t, "detail.welcomeEmpty")
                      : text(t, "detail.welcomeIdle");
              const usageDays = Array.isArray(data.progress?.usageDays)
                ? data.progress.usageDays
                : [];
              const peak = usageDays.reduce(
                (/** @type {number} */ max, /** @type {any} */ item) =>
                  Math.max(max, Number(item?.tokens) || 0),
                0,
              );
              return h(
                "div",
                {
                  style:
                    tab === "threads" ? styles.welcome : { ...styles.welcome, display: "none" },
                  "data-projects-welcome": "",
                },
                h(
                  "div",
                  { style: { minWidth: 0, flex: "1 1 auto" } },
                  h(
                    "div",
                    { style: styles.welcomeTitle, "data-projects-welcome-title": "" },
                    userName !== ""
                      ? text(t, "detail.welcome", { name: userName })
                      : text(t, "detail.welcomeAnon"),
                  ),
                  h(
                    "div",
                    { style: styles.welcomeSub, "data-projects-welcome-status": "" },
                    statusSentence,
                  ),
                ),
                usageDays.length > 0
                  ? h(
                      "div",
                      {
                        style: { display: "flex", flexDirection: "column", gap: "2px" },
                        "data-projects-spark": "",
                        title: text(t, "detail.sparkHint"),
                      },
                      h(
                        "span",
                        {
                          style: { ...styles.meta, fontSize: "10.5px" },
                          "data-projects-spark-caption": "",
                        },
                        text(t, "detail.sparkCaption"),
                      ),
                      h(
                        "div",
                        { style: styles.spark },
                        usageDays.map((/** @type {any} */ item) =>
                          h("span", {
                            key: String(item.date),
                            "data-projects-spark-bar": String(item.date),
                            style: {
                              ...styles.sparkBar,
                              height:
                                peak > 0
                                  ? `${Math.max(3, Math.round(((Number(item.tokens) || 0) / peak) * 22))}px`
                                  : "3px",
                              background: Number(item.tokens) > 0 ? T.accentText : T.border,
                            },
                          }),
                        ),
                      ),
                    )
                  : null,
              );
            })(),
            // —— F26/U13 药丸条：5 类计数 + 在跑的时间估计；点击 = 过滤该状态 ——
            h(
              "div",
              {
                style:
                  tab !== "threads" || Number(data.progress?.total ?? 0) === 0
                    ? { ...styles.pillBar, display: "none" }
                    : styles.pillBar,
                "data-projects-pills": "",
                "data-projects-counts": "",
              },
              h(
                "button",
                {
                  type: "button",
                  style: {
                    ...styles.filterPill,
                    ...(filter === ""
                      ? styles.pillActive
                      : colorScheme === "light"
                        ? { background: "rgba(0,0,0,0.045)" }
                        : {}),
                  },
                  "data-projects-pill": "all",
                  "data-projects-pill-active": filter === "" ? "true" : "false",
                  "aria-pressed": filter === "" ? "true" : "false",
                  onClick: () => {
                    setFilter("");
                    setCarousel({});
                  },
                },
                text(t, "detail.pillAll"),
              ),
              (() => {
                const estimates = (Array.isArray(data.threads) ? data.threads : [])
                  .filter(
                    (/** @type {any} */ row) =>
                      row.view?.state === "working" && Number(row.estimateMs) > 0,
                  )
                  .map((/** @type {any} */ row) => Number(row.estimateMs));
                const eta = estimates.length > 0 ? Math.min(...estimates) : 0;
                return ["waiting-user", "failed", "working", "resolved", "idle"].map((state) => {
                  const count = Number(pills[state] ?? 0);
                  const active = filter === state;
                  return h(
                    "button",
                    {
                      type: "button",
                      key: state,
                      style: {
                        ...styles.filterPill,
                        ...(active
                          ? styles.pillActive
                          : colorScheme === "light"
                            ? { background: "rgba(0,0,0,0.045)" }
                            : {}),
                      },
                      "data-projects-pill": state,
                      "data-projects-pill-count": String(count),
                      "data-projects-pill-active": active ? "true" : "false",
                      "aria-pressed": active ? "true" : "false",
                      onClick: () => toggleFilter(state),
                    },
                    text(t, `detail.pill.${state}`),
                    h("span", { style: styles.pillCount }, String(count)),
                    state === "working" && eta > 0
                      ? h(
                          "span",
                          { style: { color: T.dim }, "data-projects-pill-eta": "" },
                          text(t, "detail.pillWorkingEta", {
                            minutes: Math.max(1, Math.round(eta / 60_000)),
                          }),
                        )
                      : null,
                  );
                });
              })(),
            ),
            body,
          ),
          // —— 右栏：指令 / 记忆 / 上下文 ——
          // 一律「值行 + 右侧小动作」：右栏不常驻 input，点动作才开编辑（Batch C）；
          // 窄窗（单列）时每段默认折叠成「标题 + 一行摘要 + ▸」，点开才展开。
          h(
            "aside",
            {
              // 关着时仍挂载（锚点/冒烟照旧），但不可见；打开时是 fixed 抽屉
              style: panelSettingsOpen
                ? styles.settingsDrawer
                : { ...styles.rail, display: "none" },
              "data-panel-settings-drawer": panelSettingsOpen ? "open" : "closed",
              "data-projects-config": "",
              "data-projects-rail": "",
            },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  paddingBottom: "8px",
                },
              },
              h(
                "span",
                { style: { ...styles.name, fontSize: "14px", fontWeight: 600, flex: "1 1 auto" } },
                text(t, "detail.settingsTitle"),
              ),
              h(
                "button",
                {
                  type: "button",
                  style: { ...styles.iconButton, flex: "none" },
                  "data-panel-settings-close": "",
                  "aria-label": text(t, "detail.settingsClose"),
                  onClick: () => setPanelSettingsOpen(false),
                },
                "✕",
              ),
            ),
            // Claude 的 Project settings 有 5 个分区；这里先做骨架导航
            h(
              "div",
              {
                style: {
                  display: "flex",
                  gap: "4px",
                  flexWrap: "wrap",
                  paddingBottom: "10px",
                  borderBottom: `1px solid ${T.borderSoft}`,
                  marginBottom: "4px",
                },
                role: "tablist",
                "data-panel-settings-nav": "",
              },
              ...["general", "memory", "environment", "usage", "debug"].map((id) =>
                h(
                  "button",
                  {
                    type: "button",
                    key: id,
                    role: "tab",
                    "aria-selected": panelPane === id ? "true" : "false",
                    "data-panel-settings-pane": id,
                    style: {
                      background: "transparent",
                      border: "none",
                      borderBottom: `2px solid ${panelPane === id ? T.accentText : "transparent"}`,
                      borderRadius: "6px 6px 0 0",
                      padding: "5px 8px",
                      fontSize: "12px",
                      color: panelPane === id ? T.text : T.dim,
                      fontWeight: panelPane === id ? 600 : 400,
                      cursor: "pointer",
                    },
                    onClick: () => setPanelPane(id),
                  },
                  text(t, `detail.settingsPane.${id}`),
                ),
              ),
            ),
            // 记忆面板（从页签迁入）：只在「记忆」分区显示
            h(
              "div",
              {
                style: {
                  display: panelPane === "memory" ? "block" : "none",
                  paddingTop: "6px",
                },
                "data-projects-memory-pane": "",
              },
              memoryPane,
            ),
            // 环境/调试的分区内容还在宿主设置里（后续批次搬进来）
            panelPane === "debug"
              ? h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      padding: "10px 2px",
                      color: T.dim,
                      fontSize: "12.5px",
                    },
                    "data-panel-settings-host-hint": panelPane,
                  },
                  text(
                    t,
                    panelPane === "environment"
                      ? "detail.settingsEnvHint"
                      : "detail.settingsDebugHint",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: { ...styles.secondaryButton, alignSelf: "flex-start" },
                      "data-panel-settings-host-link": "",
                      onClick: () => {
                        if (typeof api.openSettings === "function") api.openSettings();
                      },
                    },
                    text(t, "detail.settingsOpenFull"),
                  ),
                )
              : null,
            h(RailSection, {
              t: t,
              id: "instructions",
              pane: "general",
              activePane: panelPane,
              title: text(t, "detail.section.instructions"),
              collapsible: narrow,
              summary: String(content.instructions ?? "") || text(t, "detail.instructionsEmpty"),
              attrs: { "data-projects-rail-instructions": "" },
              action: h(
                "button",
                {
                  type: "button",
                  style: styles.iconButton,
                  "data-projects-instructions-edit": "",
                  "aria-label": text(t, "detail.instructionsEdit"),
                  onClick: () => {
                    setPanelPane("memory");
                    setPanelSettingsOpen(true);
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
              body: h(
                "div",
                {
                  style: styles.railBody,
                  "data-projects-instructions": "",
                  title: String(content.instructions ?? ""),
                },
                content.instructions || text(t, "detail.instructionsEmpty"),
              ),
            }),
            h(RailSection, {
              t: t,
              id: "memory",
              pane: "memory",
              activePane: panelPane,
              title: text(t, "detail.section.memory"),
              collapsible: narrow,
              summary: text(t, "detail.memoryCount", { count: memoryEntries }),
              attrs: { "data-projects-rail-memory": "" },
              action: h(
                "button",
                {
                  type: "button",
                  style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                  "data-projects-memory-open": "",
                  onClick: () => {
                    setPanelPane("memory");
                    setPanelSettingsOpen(true);
                  },
                },
                `${text(t, "detail.section.open")} ›`,
              ),
              body: h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "2px" } },
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
            }),
            h(RailSection, {
              t: t,
              id: "library",
              pane: "usage",
              activePane: panelPane,
              title: text(t, "library.title"),
              collapsible: narrow,
              summary: libraryRailSummary,
              attrs: { "data-projects-rail-library": "" },
              // Library 从页签外迁成右栏一行入口（§7.3 页签 ≤3）：点开在主列渲染，
              // 再点一次同一行收起回线程列表。
              action: h(
                "button",
                {
                  type: "button",
                  style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                  "data-projects-library-open": "",
                  "aria-pressed": tab === "library" ? "true" : "false",
                  onClick: () => setTab(tab === "library" ? "threads" : "library"),
                },
                tab === "library"
                  ? `‹ ${text(t, "library.railBack")}`
                  : `${text(t, "library.railOpen")} ›`,
              ),
              body: h(
                "div",
                { style: styles.railBodyFull, "data-projects-library-rail-summary": "" },
                libraryRailSummary,
              ),
            }),
            h(RailSection, {
              t: t,
              id: "routines",
              pane: "usage",
              activePane: panelPane,
              title: "定时任务",
              collapsible: narrow,
              summary: data.routines?.summary || "打开查看",
              attrs: { "data-projects-rail-routines": "" },
              action: h(
                "button",
                {
                  type: "button",
                  style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
                  "data-projects-rail-routines-open": "",
                  onClick: () => setTab("routines"),
                },
                "＋",
              ),
              body: h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "2px" } },
                h(
                  "div",
                  { style: styles.railBodyFull, "data-projects-rail-routines-count": "" },
                  String(data.routines?.count ?? 0) +
                    " 个定时任务 · " +
                    String(data.reminders?.pendingCount ?? 0) +
                    " 条提醒待触发",
                ),
                h(
                  "div",
                  { style: styles.railBodyFull },
                  "每次到点投递都会跑一次模型（会花 token）；手动档不自动跑。",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: smallButton,
                    "data-projects-rail-reminder-open": "",
                    onClick: () => setTab("routines"),
                  },
                  "打开 Routines / 提醒",
                ),
              ),
            }),
            h(RailSection, {
              t: t,
              id: "context",
              // 该段内混装 general/environment/debug 三组行，父段常驻、由内层行按 pane 过滤
              pane: "",
              activePane: panelPane,
              title: text(t, "detail.section.context"),
              collapsible: narrow,
              summary: dirSummary,
              attrs: { "data-projects-rail-context": "" },
              action: h("span", { style: styles.meta, "data-projects-budget": "" }, budgetText),
              body: h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "8px" } },
                // B3：授权卡 / 线程默认模型 / 从会话开线程 / @ 源状态（设置页禁用时仍可达）
                h(B3ContextCard, {
                  api: api,
                  t: t,
                  activePane: panelPane,
                  onAddDir: () => setDirEditing(true),
                  project: data.liveProject || project,
                  fragments: data.content?.fragments || [],
                  entries: data.content?.entries || [],
                  onChanged: load,
                }),
                // 项目状态：值 + 暂停/恢复
                h(RailRow, {
                  pane: "general",
                  activePane: panelPane,
                  label: text(t, "detail.projectState"),
                  value: projectStateText,
                  attrs: { "data-projects-rail-state": "" },
                  action: h(
                    "button",
                    {
                      type: "button",
                      style: smallButton,
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
                }),
                // F29：自动 resolve（N 天无活动）。设置页可能被宿主禁用，
                // 所以同时在这里给一个真能写的入口（同一个 RPC，写审计 + 回读）。
                (() => {
                  const days = autoResolveLocal ?? project.autoResolveDays ?? null;
                  const options = [
                    ["", text(t, "detail.autoResolveOff")],
                    ["3", text(t, "detail.autoResolveDays", { days: 3 })],
                    ["7", text(t, "detail.autoResolveDays", { days: 7 })],
                    ["14", text(t, "detail.autoResolveDays", { days: 14 })],
                    ["30", text(t, "detail.autoResolveDays", { days: 30 })],
                  ];
                  return h(RailRow, {
                    pane: "general",
                    activePane: panelPane,
                    label: text(t, "detail.autoResolve"),
                    value:
                      days === null
                        ? text(t, "detail.autoResolveOff")
                        : text(t, "detail.autoResolveDays", { days }),
                    attrs: {
                      "data-projects-auto-resolve": days === null ? "off" : String(days),
                    },
                    action: h(
                      "select",
                      {
                        style: {
                          ...styles.input,
                          flex: "0 0 auto",
                          width: "auto",
                          padding: "2px 6px",
                          fontSize: "12px",
                        },
                        value: days === null ? "" : String(days),
                        "data-projects-auto-resolve-select": "",
                        onChange: (/** @type {any} */ event) => {
                          const next = String(event.target.value);
                          call(api.ctx, "setAutoResolveDays", {
                            projectId: project.id,
                            days: next === "" ? null : Number(next),
                          }).then(
                            (/** @type {any} */ result) => {
                              setAutoResolveLocal(result?.autoResolveDays ?? null);
                              load(true);
                            },
                            (/** @type {any} */ error) => {
                              setData((/** @type {any} */ prev) => ({
                                ...prev,
                                error: String(error?.message ?? error),
                              }));
                            },
                          );
                        },
                      },
                      options.map(([value, label]) => h("option", { key: value, value }, label)),
                    ),
                  });
                })(),
                // F1：归档时间只对归档项目显示（不伪造未归档的时间）
                data.projectState === "archived"
                  ? h(RailRow, {
                      pane: "general",
                      activePane: panelPane,
                      label: text(t, "detail.archivedLabel"),
                      value: project.archivedAt
                        ? relativeLabel(t, project.archivedAt)
                        : text(t, "detail.none"),
                      attrs: { "data-projects-archived-at": "" },
                    })
                  : null,
                // F2：关联仓库（owner/repo）；没有就不显示这一行
                Array.isArray(project.repos) && project.repos.length > 0
                  ? h(RailRow, {
                      pane: "environment",
                      activePane: panelPane,
                      label: text(t, "detail.reposLabel"),
                      value: project.repos.join(" · "),
                      title: project.repos.join(" · "),
                      attrs: { "data-projects-repos": "" },
                    })
                  : null,
                // 项目目录：值行（单行截断）+ 编辑按钮 → 模态里出输入框
                h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "2px" } },
                  h(RailRow, {
                    pane: "environment",
                    activePane: panelPane,
                    label: text(t, "detail.dirLabel"),
                    value: dirList.length > 0 ? dirList.join(" · ") : text(t, "detail.none"),
                    title: dirList.join(" · "),
                    attrs: { "data-projects-rail-dir": "" },
                    action: h(
                      "button",
                      {
                        type: "button",
                        style: smallButton,
                        "data-projects-dir-edit": "",
                        onClick: () => {
                          // 打开时把现有目录装进 pending：删除/新增都在这一次保存里生效
                          setDirPending([...dirList]);
                          setDirDraft("");
                          setDirEditing(true);
                        },
                      },
                      text(t, "detail.edit"),
                    ),
                  }),
                  dirInfo.path !== ""
                    ? h(
                        "div",
                        {
                          style: {
                            ...styles.meta,
                            color: dirInfo.invalid
                              ? T.danger
                              : dirInfo.isGit
                                ? T.text
                                : T.accentText,
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
                ),
                // 仓库授权：值行 + ＋（点开才出输入与删除）
                h(RailRow, {
                  pane: "environment",
                  activePane: panelPane,
                  label: text(t, "detail.grantsLabel"),
                  value: grants.length > 0 ? grants.join(" · ") : text(t, "detail.none"),
                  title: grants.join(" · "),
                  attrs: { "data-projects-grants": "" },
                  action: h(
                    "button",
                    {
                      type: "button",
                      style: smallButton,
                      "data-projects-grant-edit": "",
                      onClick: () => setGrantsEditing(true),
                    },
                    "＋",
                  ),
                }),
                // 回收站清理：值行 + 预览/确认（两个都是动作，不是输入）
                h(RailRow, {
                  pane: "environment",
                  activePane: panelPane,
                  label: text(t, "detail.purgeLabel"),
                  value: purge.message !== "" ? purge.message : text(t, "detail.purgeNothing"),
                  attrs: { "data-projects-purge": "" },
                  action: h(
                    "span",
                    { style: { display: "inline-flex", gap: "4px", flex: "none" } },
                    h(
                      "button",
                      {
                        type: "button",
                        style: smallButton,
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
                            style: { ...smallButton, color: T.danger, borderColor: T.danger },
                            "data-projects-purge-confirm": "",
                            onClick: runPurge,
                          },
                          text(t, "detail.purgeConfirm", { count: purge.eligible }),
                        )
                      : null,
                  ),
                }),
                purge.message !== ""
                  ? h(
                      "div",
                      { style: styles.meta, "data-projects-purge-result": "" },
                      purge.message,
                    )
                  : null,
                // 回收站（可恢复）：值行 + 条目列表（列表本来就是行）
                h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                  h(RailRow, {
                    label: text(t, "detail.trashLabel"),
                    value:
                      trash.entries.length > 0
                        ? text(t, "detail.trashCount", { count: trash.entries.length })
                        : text(t, "detail.trashNone"),
                    attrs: { "data-projects-trash-count": "" },
                  }),
                  h(
                    "div",
                    {
                      "data-projects-trash": "",
                      style: { display: "flex", flexDirection: "column", gap: "4px" },
                    },
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
                                    whiteSpace: "nowrap",
                                  },
                                  title: `${entry.name} · ${entry.threadCount} 个线程 · ${formatBytes(entry.sizeBytes)}`,
                                },
                                `${entry.name} · ${entry.threadCount} 个线程 · ${formatBytes(entry.sizeBytes)}`,
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  style: { ...smallButton, fontSize: "11px" },
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
                                    ...smallButton,
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
                          trash.entries.length > 0
                            ? h(
                                "div",
                                { style: { display: "flex", justifyContent: "flex-end" } },
                                h(
                                  "button",
                                  {
                                    type: "button",
                                    style: {
                                      ...smallButton,
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
                        ),
                  ),
                  trash.message !== ""
                    ? h(
                        "div",
                        { style: styles.meta, "data-projects-trash-result": "" },
                        trash.message,
                      )
                    : null,
                ),
                // 危险动作开关：本来就是「一行 + 展开」，保留 details 语义
                h(DangerSwitches, {
                  pane: "debug",
                  activePane: panelPane,
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
            }),
          ),
        ),
        // 右栏值行的编辑入口：点「编辑 / ＋」才出输入（右栏本身不常驻 input）
        h(RailEditor, {
          t: t,
          title: text(t, "detail.dirLabel"),
          open: dirEditing,
          attrs: { "data-projects-dir-editor": "" },
          onClose: () => setDirEditing(false),
          saveLabel: text(t, "detail.dirSave"),
          saveAttrs: { "data-projects-dir-save": "" },
          onSave: submitDir,
          children: h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            (Array.isArray(dirPending) ? dirPending : []).length > 0
              ? h(
                  "div",
                  {
                    style: { display: "flex", flexDirection: "column", gap: "2px" },
                    "data-projects-dir-list": "",
                  },
                  dirPending.map((/** @type {any} */ item) =>
                    h(
                      "span",
                      {
                        key: String(item),
                        style: {
                          ...styles.dirBadge,
                          maxWidth: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        },
                        "data-projects-dir-item": String(item),
                      },
                      h(
                        "span",
                        { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } },
                        String(item),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          style: {
                            border: "none",
                            background: "transparent",
                            color: T.faint,
                            cursor: "pointer",
                            padding: "0 2px",
                          },
                          "aria-label": text(t, "detail.dirRemove"),
                          "data-projects-dir-remove": String(item),
                          onClick: () =>
                            setDirPending(
                              (Array.isArray(dirPending) ? dirPending : []).filter(
                                (candidate) => candidate !== item,
                              ),
                            ),
                        },
                        "×",
                      ),
                    ),
                  ),
                )
              : null,
            h("input", {
              style: styles.input,
              value: dirDraft,
              placeholder: text(t, "detail.dirPlaceholder"),
              "data-projects-dir-input": "",
              onChange: (/** @type {any} */ event) => setDirDraft(event.target.value),
              onKeyDown: (/** @type {any} */ event) => {
                if (event.key === "Enter") submitDir();
              },
            }),
            h(
              "span",
              { style: styles.meta, "data-projects-dir-limit": "" },
              text(t, "detail.dirLimit", {
                count: MAX_CONTEXT_DIRS,
                used: Array.isArray(dirPending) ? dirPending.length : 0,
              }),
            ),
          ),
        }),
        h(RailEditor, {
          t: t,
          title: text(t, "detail.grantsLabel"),
          open: grantsEditing,
          attrs: { "data-projects-grants-editor": "" },
          onClose: () => setGrantsEditing(false),
          saveLabel: text(t, "detail.grantAdd"),
          onSave: () => setGrantsEditing(false),
          children: h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "8px" } },
            h(
              "div",
              { style: styles.meta },
              grants.length > 0 ? grants.join(" · ") : text(t, "detail.grantsEmpty"),
            ),
            h(
              "div",
              { style: { display: "flex", gap: "6px", alignItems: "center" } },
              h("input", {
                style: styles.input,
                value: grantsDraft,
                placeholder: "owner/repo",
                "data-projects-grant-input": "",
                onInput: (/** @type {any} */ event) => setGrantsDraft(event.target.value),
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.secondaryButton,
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
        }),
        del.confirming
          ? h(
              // 破坏性确认要挡住整页：内联渲染会把详情顶出视口（审查实测标题 y=-48），
              // 而且背景仍可点。改成 fixed 覆盖层 + aria-modal；Esc/点遮罩 = 取消。
              "div",
              {
                style: {
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0, 0, 0, 0.38)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "20px",
                  zIndex: 80,
                },
                "data-projects-delete-confirm-backdrop": "",
                onClick: (/** @type {any} */ event) => {
                  if (event?.target === event?.currentTarget) closeDeleteConfirm();
                },
                onKeyDown: (/** @type {any} */ event) => {
                  if (event?.key === "Escape") {
                    event.preventDefault();
                    closeDeleteConfirm();
                  }
                },
              },
              h(
                "div",
                {
                  role: "alertdialog",
                  "aria-modal": "true",
                  "aria-label": text(t, "detail.delete"),
                  ref: deleteConfirmRef,
                  style: {
                    border: `1px solid ${T.danger}`,
                    borderRadius: "12px",
                    padding: "16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    background: T.panel,
                    width: "100%",
                    maxWidth: "420px",
                    boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)",
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
                      onClick: () => closeDeleteConfirm(),
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
              ),
            )
          : null,
      );
    }

    /**
     * 详情页渲染护栏：详情里抛错时只毁详情，不毁整个面板（列表/回收站入口还得在）。
     * 与 ProjectsPanelSafe 同款：以函数调用让 hooks 归属本组件、异常可被 try/catch 捕获。
     * @param {any} props
     */
    function ProjectDetailSafe(props) {
      try {
        return ProjectDetail(props);
      } catch (error) {
        return h(
          "pre",
          {
            "data-projects-crash": "",
            "data-projects-detail-crash": "",
            style: { color: T.danger, whiteSpace: "pre-wrap", fontSize: "12px" },
          },
          String(/** @type {any} */ (error)?.stack || error),
        );
      }
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
                error: threadErrorText(t, error),
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

    // —— B4 · F36 Routines（六档频率 + Run now + History + 成本提示）——
    // 数据全部来自 host `routinesView`（宿主 schedule 的状态 + 本地记录），
    // 面板不自己算 cron、也不自己记「上次跑没跑」。
    /** @param {any} props */
    function RoutinesView(props) {
      const api = props.api;
      const t = props.t;
      const project = props.project;
      const [view, setView] = useState(null);
      const [draft, setDraft] = useState({
        name: "",
        instructions: "",
        frequency: "daily",
        time: "09:00",
        weekday: 1,
        dayOfMonth: 1,
      });
      const [busy, setBusy] = useState("");
      const [message, setMessage] = useState({ text: "", ok: null });
      const [history, setHistory] = useState({ routineId: "", rows: [], retention: null });
      // M4：Routines 详情三段（Trigger / Instructions / Runs in），一次只开一个
      const [detailId, setDetailId] = useState("");
      // 编辑一条 routine（指令/频率/时间）：只支持已有 routine，不新增
      const [editId, setEditId] = useState("");
      const [editDraft, setEditDraft] = useState({
        instructions: "",
        frequency: "daily",
        time: "09:00",
      });
      const load = useCallback(() => {
        call(api.ctx, "routinesView", { projectId: project.id }).then(
          (/** @type {any} */ result) => setView(result),
          (/** @type {any} */ error) =>
            setView({ available: false, reason: String(error?.message ?? error), routines: [] }),
        );
      }, [api, project.id]);
      useEffect(() => {
        load();
        const timer = setInterval(() => {
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          load();
        }, 5000);
        return () => clearInterval(timer);
      }, [load]);
      const report = (/** @type {any} */ textValue, /** @type {any} */ ok) =>
        setMessage({ text: textValue, ok });
      const runAction = (/** @type {any} */ label, /** @type {any} */ promise) => {
        setBusy(label);
        report("", null);
        promise.then(
          (/** @type {any} */ result) => {
            setBusy("");
            if (result && result.ok === false)
              report(String(result.reason || `${label}失败`), false);
            else report(`${String(label)}完成`, true);
            load();
          },
          (/** @type {any} */ error) => {
            setBusy("");
            report(String(error?.message ?? error).slice(0, 200), false);
          },
        );
      };
      /** @type {any[]} */
      const routines = Array.isArray(view?.routines) ? view.routines : [];
      const frequencyOptions = [
        ["manual", text(t, "routines.freq.manual")],
        ["hourly", text(t, "routines.freq.hourly")],
        ["daily", text(t, "routines.freq.daily")],
        ["weekdays", text(t, "routines.freq.weekdays")],
        ["weekly", text(t, "routines.freq.weekly")],
        ["monthly", text(t, "routines.freq.monthly")],
      ];
      const weekdayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((id) =>
        text(t, `routines.weekday.${id}`),
      );
      const automatic = draft.frequency !== "manual";
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
          "data-projects-routines": "",
          "data-projects-routines-available": view ? (view.available ? "yes" : "no") : "loading",
        },
        h(
          "div",
          { style: styles.railBodyFull, "data-projects-routines-cost": "" },
          view?.costHint || text(t, "routines.costHint"),
        ),
        view && view.available === false
          ? h(
              "div",
              {
                style: { ...styles.meta, color: T.danger },
                "data-projects-routines-unavailable": "",
              },
              text(t, "routines.scheduleUnavailablePrefix") +
                String(view.reason || "unknown") +
                text(t, "routines.scheduleUnavailableSuffix"),
            )
          : null,
        // —— 新建表单 ——
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              border: `1px solid ${T.borderSoft}`,
              borderRadius: "10px",
              padding: "8px 10px",
            },
          },
          h("span", { style: styles.name }, text(t, "routines.formTitle")),
          h(
            "label",
            { style: styles.fieldLabel },
            h("span", { style: styles.meta }, text(t, "routines.name")),
            h("input", {
              style: styles.input,
              value: draft.name,
              placeholder: text(t, "routines.namePlaceholder"),
              "data-projects-routine-name": "",
              onChange: (/** @type {any} */ event) =>
                setDraft((/** @type {any} */ prev) => ({ ...prev, name: event.target.value })),
            }),
          ),
          h(
            "label",
            { style: styles.fieldLabel },
            h("span", { style: styles.meta }, text(t, "routines.instructionsLabel")),
            h("textarea", {
              style: { ...styles.input, minHeight: "54px", resize: "vertical" },
              value: draft.instructions,
              placeholder: text(t, "routines.instructionsPlaceholder"),
              "data-projects-routine-instructions": "",
              onChange: (/** @type {any} */ event) =>
                setDraft((/** @type {any} */ prev) => ({
                  ...prev,
                  instructions: event.target.value,
                })),
            }),
          ),
          h(
            "div",
            { style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "flex-end" } },
            h(
              "label",
              { style: { ...styles.fieldLabel, flex: "1 1 150px" } },
              h("span", { style: styles.meta }, text(t, "routines.frequency")),
              h(
                "select",
                {
                  style: styles.input,
                  value: draft.frequency,
                  "data-projects-routine-frequency": "",
                  onChange: (/** @type {any} */ event) =>
                    setDraft((/** @type {any} */ prev) => ({
                      ...prev,
                      frequency: event.target.value,
                    })),
                },
                frequencyOptions.map((/** @type {any} */ option) =>
                  h("option", { key: option[0], value: option[0] }, option[1]),
                ),
              ),
            ),
            h(
              "label",
              { style: { ...styles.fieldLabel, flex: "0 1 110px" } },
              h("span", { style: styles.meta }, text(t, "routines.time")),
              h("input", {
                style: styles.input,
                value: draft.time,
                "data-projects-routine-time": "",
                onChange: (/** @type {any} */ event) =>
                  setDraft((/** @type {any} */ prev) => ({ ...prev, time: event.target.value })),
              }),
            ),
            draft.frequency === "weekly"
              ? h(
                  "label",
                  { style: { ...styles.fieldLabel, flex: "0 1 110px" } },
                  h("span", { style: styles.meta }, text(t, "routines.weekday")),
                  h(
                    "select",
                    {
                      style: styles.input,
                      value: String(draft.weekday),
                      "data-projects-routine-weekday": "",
                      onChange: (/** @type {any} */ event) =>
                        setDraft((/** @type {any} */ prev) => ({
                          ...prev,
                          weekday: Number(event.target.value),
                        })),
                    },
                    weekdayNames.map((/** @type {any} */ label, /** @type {any} */ index) =>
                      h("option", { key: label, value: String(index) }, label),
                    ),
                  ),
                )
              : null,
            draft.frequency === "monthly"
              ? h(
                  "label",
                  { style: { ...styles.fieldLabel, flex: "0 1 110px" } },
                  h("span", { style: styles.meta }, text(t, "routines.dayOfMonth")),
                  h("input", {
                    style: styles.input,
                    value: String(draft.dayOfMonth),
                    "data-projects-routine-day": "",
                    onChange: (/** @type {any} */ event) =>
                      setDraft((/** @type {any} */ prev) => ({
                        ...prev,
                        dayOfMonth: Number(event.target.value),
                      })),
                  }),
                )
              : null,
          ),
          h(
            "div",
            { style: { display: "flex", gap: "6px", alignItems: "center" } },
            h(
              "button",
              {
                type: "button",
                style: styles.primaryButton,
                disabled: busy !== "",
                "data-projects-routine-create": "",
                onClick: () =>
                  runAction(
                    "create",
                    call(api.ctx, "createRoutine", {
                      projectId: project.id,
                      // 宿主网关按**参数名**包：方法与 `(projectId, input)` 对应，
                      // 所以表单字段要落在 input 里（扁平传会被 gateway 判成 unexpected）。
                      input: {
                        name: draft.name,
                        instructions: draft.instructions,
                        frequency: draft.frequency,
                        time: draft.time,
                        weekday: draft.weekday,
                        dayOfMonth: draft.dayOfMonth,
                      },
                    }),
                  ),
              },
              busy === "create" ? text(t, "routines.creating") : text(t, "routines.create"),
            ),
            h(
              "span",
              { style: styles.meta },
              automatic ? text(t, "routines.autoHint") : text(t, "routines.manualHint"),
            ),
          ),
          message.text !== ""
            ? h(
                "span",
                {
                  style: { ...styles.meta, color: message.ok === false ? T.danger : T.text },
                  "data-projects-routine-message": "",
                },
                message.text,
              )
            : null,
        ),
        // —— 列表 ——
        routines.length === 0
          ? h(
              "div",
              {
                style: { ...styles.meta, whiteSpace: "normal", lineHeight: 1.5 },
                "data-projects-routines-empty": "",
              },
              text(t, "routines.empty"),
            )
          : h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              routines.map((/** @type {any} */ routine) =>
                h(
                  "div",
                  {
                    key: routine.id,
                    style: {
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                      border: `1px solid ${T.borderSoft}`,
                      borderRadius: "10px",
                      padding: "8px 10px",
                      minWidth: 0,
                    },
                    "data-projects-routine": routine.id,
                    "data-projects-routine-id": routine.id,
                  },
                  h(
                    "div",
                    { style: { display: "flex", gap: "6px", alignItems: "center", minWidth: 0 } },
                    h(
                      "span",
                      {
                        style: {
                          ...styles.name,
                          flex: "1 1 auto",
                          minWidth: 0,
                          overflow: "hidden",
                        },
                        title: routine.name,
                      },
                      String(routine.name || routine.id),
                    ),
                    h(
                      "span",
                      {
                        style: styles.meta,
                        "data-projects-routine-status":
                          routine.hostStatus || routine.status?.status || "",
                      },
                      routine.enabled === false
                        ? text(t, "routines.disabled")
                        : String(routine.status?.label || ""),
                    ),
                  ),
                  h("span", { style: styles.meta }, String(routine.description || "")),
                  // M4：详情三段（Claude 的 Routines 详情 = Trigger / Instructions / Runs in）
                  h(
                    "button",
                    {
                      type: "button",
                      style: {
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        padding: "0",
                        cursor: "pointer",
                        fontSize: "11.5px",
                        color: T.dim,
                      },
                      "data-projects-routine-detail-toggle": routine.id,
                      "data-projects-routine-detail-open":
                        detailId === routine.id ? "true" : "false",
                      onClick: () => setDetailId(detailId === routine.id ? "" : routine.id),
                    },
                    detailId === routine.id
                      ? `▾ ${text(t, "routines.detail")}`
                      : `▸ ${text(t, "routines.detail")}`,
                  ),
                  detailId === routine.id
                    ? h(
                        "div",
                        {
                          style: { display: "flex", flexDirection: "column", gap: "4px" },
                          "data-projects-routine-detail": routine.id,
                        },
                        h(
                          "span",
                          { style: { ...styles.meta, color: T.text, fontWeight: 600 } },
                          text(t, "routines.trigger"),
                        ),
                        h("span", { style: styles.meta }, String(routine.description || "")),
                        h(
                          "span",
                          { style: styles.meta },
                          `宿主状态：${String(routine.hostStatus || routine.status?.status || "unknown")}`,
                        ),
                        h(
                          "span",
                          { style: { ...styles.meta, color: T.text, fontWeight: 600 } },
                          text(t, "routines.instructions"),
                        ),
                        h(
                          "span",
                          { style: { ...styles.meta, whiteSpace: "pre-wrap" } },
                          String(routine.instructions || "").slice(0, 400),
                        ),
                        h(
                          "span",
                          { style: { ...styles.meta, color: T.text, fontWeight: 600 } },
                          text(t, "routines.runsOn"),
                        ),
                        h(
                          "span",
                          { style: styles.meta, "data-projects-routine-detail-runs": routine.id },
                          `${String(view?.timeZone || "")} · ${String(view?.projectDir || "")}`,
                        ),
                        h(
                          "div",
                          { style: { display: "flex", gap: "6px", marginTop: "2px" } },
                          h(
                            "button",
                            {
                              type: "button",
                              style: smallButton,
                              "data-projects-routine-edit": routine.id,
                              onClick: () => {
                                setEditId(routine.id);
                                setEditDraft({
                                  instructions: String(routine.instructions || ""),
                                  frequency: String(routine.frequency || "daily"),
                                  time: String(routine.time || "09:00").slice(0, 5),
                                });
                              },
                            },
                            text(t, "routines.edit"),
                          ),
                        ),
                        editId === routine.id
                          ? h(
                              "div",
                              {
                                style: { display: "flex", flexDirection: "column", gap: "4px" },
                                "data-projects-routine-edit-form": routine.id,
                              },
                              h("textarea", {
                                style: {
                                  ...styles.input,
                                  minHeight: "64px",
                                  fontFamily: "inherit",
                                },
                                value: editDraft.instructions,
                                "data-projects-routine-edit-instructions": "",
                                onChange: (/** @type {any} */ event) =>
                                  setEditDraft((/** @type {any} */ prev) => ({
                                    ...prev,
                                    instructions: event.target.value,
                                  })),
                              }),
                              h(
                                "div",
                                { style: { display: "flex", gap: "6px" } },
                                h(
                                  "select",
                                  {
                                    style: styles.input,
                                    value: editDraft.frequency,
                                    "data-projects-routine-edit-frequency": "",
                                    onChange: (/** @type {any} */ event) =>
                                      setEditDraft((/** @type {any} */ prev) => ({
                                        ...prev,
                                        frequency: event.target.value,
                                      })),
                                  },
                                  [
                                    "manual",
                                    "hourly",
                                    "daily",
                                    "weekdays",
                                    "weekly",
                                    "monthly",
                                  ].map((/** @type {string} */ value) =>
                                    h("option", { key: value, value }, value),
                                  ),
                                ),
                                h("input", {
                                  style: { ...styles.input, width: "90px" },
                                  value: editDraft.time,
                                  placeholder: "HH:mm",
                                  "data-projects-routine-edit-time": "",
                                  onChange: (/** @type {any} */ event) =>
                                    setEditDraft((/** @type {any} */ prev) => ({
                                      ...prev,
                                      time: event.target.value,
                                    })),
                                }),
                              ),
                              h(
                                "button",
                                {
                                  type: "button",
                                  style: smallButton,
                                  "data-projects-routine-edit-save": routine.id,
                                  onClick: () =>
                                    runAction(
                                      text(t, "routines.update"),
                                      call(api.ctx, "updateRoutine", {
                                        projectId: project.id,
                                        routineId: routine.id,
                                        input: {
                                          name: String(routine.name || routine.id),
                                          instructions: editDraft.instructions,
                                          frequency: editDraft.frequency,
                                          time: editDraft.time,
                                        },
                                      }).then((/** @type {any} */ result) => {
                                        if (result?.ok === true) setEditId("");
                                        return result;
                                      }),
                                    ),
                                },
                                text(t, "routines.save"),
                              ),
                            )
                          : null,
                      )
                    : null,
                  h(
                    "span",
                    { style: styles.meta, "data-projects-routine-lastdelivery": "" },
                    routine.lastDelivery?.deliveredAt
                      ? `最近投递：${String(routine.lastDelivery.deliveredAt)}`
                      : routine.lastRunAt
                        ? `最近 Run now：${String(routine.lastRunAt)}`
                        : text(t, "routines.historyEmpty"),
                  ),
                  h(
                    "div",
                    { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                    h(
                      "button",
                      {
                        type: "button",
                        style: smallButton,
                        disabled: busy !== "",
                        "data-projects-routine-toggle": routine.id,
                        onClick: () =>
                          runAction(
                            text(t, "routines.switch"),
                            call(api.ctx, "setRoutineEnabled", {
                              projectId: project.id,
                              routineId: routine.id,
                              enabled: routine.enabled === false,
                            }),
                          ),
                      },
                      routine.enabled === false
                        ? text(t, "routines.enable")
                        : text(t, "routines.disable"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: smallButton,
                        disabled: busy !== "",
                        title: text(t, "routines.deliveryNote"),
                        "data-projects-routine-run": routine.id,
                        onClick: () =>
                          runAction(
                            "Run now",
                            call(api.ctx, "runRoutineNow", {
                              projectId: project.id,
                              routineId: routine.id,
                            }),
                          ),
                      },
                      "Run now",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: smallButton,
                        "data-projects-routine-history": routine.id,
                        onClick: () => {
                          call(api.ctx, "routineHistory", {
                            projectId: project.id,
                            routineId: routine.id,
                          }).then(
                            (/** @type {any} */ result) =>
                              setHistory({
                                routineId: routine.id,
                                rows: Array.isArray(result?.rows) ? result.rows : [],
                                retention: result?.retention ?? null,
                                hostAvailable: result?.hostAvailable === true,
                              }),
                            (/** @type {any} */ error) =>
                              setHistory({
                                routineId: routine.id,
                                rows: [],
                                retention: null,
                                error: String(error?.message ?? error),
                              }),
                          );
                        },
                      },
                      "History",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: { ...smallButton, color: T.danger },
                        disabled: busy !== "",
                        "data-projects-routine-delete": routine.id,
                        onClick: () =>
                          runAction(
                            "delete",
                            call(api.ctx, "deleteRoutine", {
                              projectId: project.id,
                              routineId: routine.id,
                            }),
                          ),
                      },
                      text(t, "routines.delete"),
                    ),
                  ),
                  history.routineId === routine.id
                    ? h(
                        "div",
                        {
                          style: { display: "flex", flexDirection: "column", gap: "2px" },
                          "data-projects-routine-history-panel": routine.id,
                          "data-projects-routine-history-count": String(history.rows.length),
                        },
                        history.rows.length === 0
                          ? h("span", { style: styles.meta }, text(t, "routines.historyNone"))
                          : history.rows.map((/** @type {any} */ row, /** @type {any} */ index) =>
                              h(
                                "span",
                                { key: index, style: styles.meta },
                                [
                                  String(row.at || ""),
                                  String(row.status || ""),
                                  String(row.message || ""),
                                ]
                                  .filter((part) => part !== "")
                                  .join(" · "),
                              ),
                            ),
                        history.retention
                          ? h(
                              "span",
                              { style: styles.meta },
                              text(t, "routines.retention", {
                                days:
                                  String(history.retention.days ?? "?") +
                                  text(t, "routines.retentionDays"),
                                records:
                                  String(history.retention.records ?? "?") +
                                  text(t, "routines.retentionRecords"),
                              }),
                            )
                          : null,
                      )
                    : null,
                ),
              ),
            ),
        h(RemindersPanel, { api: api, t: props.t, project: project }),
      );
    }

    // —— B4 · F30 提醒（双模式：timer 免费 / schedule 计费）——
    /** @param {any} props */
    function RemindersPanel(props) {
      const api = props.api;
      const project = props.project;
      const [view, setView] = useState(null);
      const [form, setForm] = useState({
        open: false,
        mode: "",
        text: "",
        minutes: "5",
        message: "",
        ok: null,
        busy: false,
      });
      const load = useCallback(() => {
        call(api.ctx, "remindersView", { projectId: project.id }).then(
          (/** @type {any} */ result) => setView(result),
          (/** @type {any} */ error) =>
            setView({ list: [], defaultMode: "timer", reason: String(error?.message ?? error) }),
        );
      }, [api, project.id]);
      useEffect(() => {
        load();
        const timer = setInterval(() => {
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          load();
        }, 5000);
        return () => clearInterval(timer);
      }, [load]);
      const defaultMode = String(view?.defaultMode || "timer");
      const openForm = () =>
        setForm((/** @type {any} */ prev) => ({
          ...prev,
          open: true,
          mode: defaultMode,
          message: "",
          ok: null,
        }));
      const patch = (/** @type {any} */ next) =>
        setForm((/** @type {any} */ prev) => ({ ...prev, ...next }));
      const submit = () => {
        const minutes = Number(String(form.minutes).trim());
        const dueAt = new Date(Date.now() + (Number.isFinite(minutes) ? minutes : 0) * 60_000);
        patch({ busy: true, message: "", ok: null });
        call(api.ctx, "createReminder", {
          projectId: project.id,
          input: {
            at: dueAt.toISOString(),
            text: form.text,
            mode: form.mode || defaultMode,
          },
        }).then(
          (/** @type {any} */ result) => {
            if (result && result.ok === false) {
              patch({ busy: false, ok: false, message: String(result.reason || "创建失败") });
              return;
            }
            patch({
              busy: false,
              ok: true,
              message: `已创建（${String(result?.mode || "")}）`,
            });
            load();
          },
          (/** @type {any} */ error) =>
            patch({
              busy: false,
              ok: false,
              message: String(error?.message ?? error).slice(0, 200),
            }),
        );
      };
      /** @type {any[]} */
      const list = Array.isArray(view?.list) ? view.list : [];
      /** @type {any[]} */
      const active = list.filter((/** @type {any} */ item) => item.state === "pending");
      /** @type {any[]} */
      const fired = list.filter((/** @type {any} */ item) => item.state === "fired");
      const modeNote =
        (form.mode || defaultMode) === "schedule"
          ? "计费：到点会跑一次模型（= 一次模型调用）；DSH 关着也会跑。"
          : "免费：本机计时，不花模型调用；DSH 关着的时候不会响（重新打开后补一次）。";
      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            border: `1px solid ${T.borderSoft}`,
            borderRadius: "10px",
            padding: "8px 10px",
            marginTop: "6px",
          },
          "data-projects-reminders": "",
          "data-projects-reminder-default": defaultMode,
          "data-projects-reminder-pending": String(view?.pendingCount ?? active.length),
          "data-projects-reminder-unread": String(view?.unreadCount ?? 0),
          "data-projects-reminder-armed": String(view?.armed?.armed ?? 0),
        },
        h(
          "div",
          { style: { display: "flex", gap: "6px", alignItems: "center", minWidth: 0 } },
          h(
            "span",
            { style: { ...styles.name, flex: "1 1 auto" } },
            "提醒（" +
              String(active.length) +
              " 条待触发" +
              (fired.length > 0 ? ` · ${String(fired.length)} 条已响` : "") +
              "）",
          ),
          h(
            "button",
            {
              type: "button",
              style: { ...styles.secondaryButton, padding: "2px 10px", fontSize: "12px" },
              "data-projects-reminder-open": "",
              onClick: openForm,
            },
            "＋ 新建提醒",
          ),
        ),
        h(
          "div",
          { style: styles.railBodyFull },
          "默认模式：" +
            (defaultMode === "schedule" ? "定时任务（计费）" : "本机计时（免费）") +
            " · 每条可以另选。本机计时由 DSH 进程负责，重启后按盘上到期时间自动恢复。",
        ),
        h(
          "div",
          { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: styles.meta }, "项目默认："),
          [
            ["timer", "本机计时（免费）"],
            ["schedule", "定时任务（计费）"],
          ].map((/** @type {any} */ option) =>
            h(
              "button",
              {
                key: option[0],
                type: "button",
                "data-projects-reminder-default-option": option[0],
                "aria-selected": defaultMode === option[0] ? "true" : "false",
                style: {
                  ...smallButton,
                  ...(defaultMode === option[0]
                    ? { borderColor: T.accentText, color: T.accentText }
                    : {}),
                },
                onClick: () =>
                  call(api.ctx, "setReminderDefault", {
                    projectId: project.id,
                    mode: option[0],
                  }).then(() => load()),
              },
              option[1],
            ),
          ),
        ),
        form.open
          ? h(
              "div",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  border: `1px solid ${T.border}`,
                  borderRadius: "10px",
                  padding: "8px 10px",
                },
                role: "dialog",
                "aria-modal": "true",
                "data-projects-reminder-dialog": "open",
              },
              h(
                "div",
                { style: { display: "flex", gap: "6px", alignItems: "center" } },
                h("span", { style: styles.name }, "新建提醒"),
                h("span", { style: { flex: "1 1 auto" } }),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.iconButton,
                    "data-projects-reminder-close": "",
                    "aria-label": "关闭",
                    onClick: () => patch({ open: false }),
                  },
                  "✕",
                ),
              ),
              h(
                "div",
                { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                [
                  ["timer", "免费（本机计时）"],
                  ["schedule", "定时任务（到点跑模型）"],
                ].map((/** @type {any} */ option) =>
                  h(
                    "button",
                    {
                      key: option[0],
                      type: "button",
                      "data-projects-reminder-mode": option[0],
                      "aria-selected": (form.mode || defaultMode) === option[0] ? "true" : "false",
                      style: {
                        ...styles.button,
                        borderColor:
                          (form.mode || defaultMode) === option[0] ? T.accentText : T.border,
                        color: (form.mode || defaultMode) === option[0] ? T.accentText : T.text,
                      },
                      onClick: () => patch({ mode: option[0] }),
                    },
                    option[1],
                  ),
                ),
              ),
              h("span", { style: styles.meta, "data-projects-reminder-note": "" }, modeNote),
              h(
                "label",
                { style: styles.fieldLabel },
                h("span", { style: styles.meta }, "提醒内容"),
                h("input", {
                  style: styles.input,
                  value: form.text,
                  placeholder: "例如：看一下构建结果",
                  "data-projects-reminder-text": "",
                  "data-modal-autofocus": "",
                  onChange: (/** @type {any} */ event) => patch({ text: event.target.value }),
                }),
              ),
              h(
                "label",
                { style: styles.fieldLabel },
                h("span", { style: styles.meta }, "多少分钟后（0 = 立即）"),
                h("input", {
                  style: styles.input,
                  value: form.minutes,
                  inputMode: "decimal",
                  "data-projects-reminder-minutes": "",
                  onChange: (/** @type {any} */ event) => patch({ minutes: event.target.value }),
                }),
              ),
              h(
                "div",
                { style: { display: "flex", gap: "6px", alignItems: "center" } },
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.primaryButton,
                    disabled: form.busy === true,
                    "data-projects-reminder-submit": "",
                    onClick: submit,
                  },
                  form.busy === true ? "正在创建…" : "创建",
                ),
                form.message !== ""
                  ? h(
                      "span",
                      {
                        style: { ...styles.meta, color: form.ok === false ? T.danger : T.text },
                        "data-projects-reminder-message": "",
                      },
                      String(form.message),
                    )
                  : null,
              ),
            )
          : null,
        list.length > 0
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "2px" } },
              list.map((reminder) =>
                h(
                  "div",
                  {
                    key: reminder.id,
                    style: { display: "flex", gap: "6px", alignItems: "center", minWidth: 0 },
                    "data-projects-reminder-row": reminder.id,
                    "data-projects-reminder-state": String(reminder.state || ""),
                  },
                  h(
                    "span",
                    {
                      style: { ...styles.meta, flex: "1 1 auto", minWidth: 0, overflow: "hidden" },
                      title: String(reminder.text || ""),
                    },
                    String(reminder.text || "") +
                      " · " +
                      (reminder.mode === "schedule" ? "定时任务（计费）" : "本机计时（免费）") +
                      " · " +
                      String(reminder.remaining?.text || "") +
                      (reminder.state === "fired" ? " · 已响" : ""),
                  ),
                  reminder.state === "pending"
                    ? h(
                        "button",
                        {
                          type: "button",
                          style: smallButton,
                          "data-projects-reminder-complete": reminder.id,
                          onClick: () =>
                            call(api.ctx, "completeReminder", {
                              projectId: project.id,
                              reminderId: reminder.id,
                            }).then(() => load()),
                        },
                        "提前完成",
                      )
                    : null,
                  reminder.state === "pending"
                    ? h(
                        "button",
                        {
                          type: "button",
                          style: smallButton,
                          "data-projects-reminder-cancel": reminder.id,
                          onClick: () =>
                            call(api.ctx, "cancelReminder", {
                              projectId: project.id,
                              reminderId: reminder.id,
                            }).then(() => load()),
                        },
                        "取消",
                      )
                    : null,
                ),
              ),
            )
          : null,
      );
    }

    // —— B4 · F52 权限收窄（默认「继承宿主」，只会收窄，不会放宽）——
    /** @param {any} props */
    function PermissionNarrowCard(props) {
      const api = props.api;
      const project = props.project;
      const [view, setView] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState({ text: "", ok: null });
      const load = useCallback(() => {
        call(api.ctx, "permissionState", { projectId: project.id }).then(
          (/** @type {any} */ result) => setView(result),
          (/** @type {any} */ error) =>
            setView({
              catalog: { available: false, options: [], notes: [] },
              sessions: [],
              reason: String(error?.message ?? error),
            }),
        );
      }, [api, project.id]);
      useEffect(() => {
        load();
      }, [load]);
      const catalog = view?.catalog ?? { available: false, options: [], notes: [] };
      const current = view ? String(view.preset ?? "") : "";
      const choose = (/** @type {any} */ next) => {
        setBusy(true);
        setMessage({ text: "", ok: null });
        call(api.ctx, "setProjectPreset", { projectId: project.id, preset: next }).then(
          (/** @type {any} */ result) => {
            setBusy(false);
            if (result && result.ok === false) {
              setMessage({ text: String(result.reason || "设置失败"), ok: false });
              return;
            }
            const applied = Array.isArray(result?.applied?.applied) ? result.applied.applied : [];
            const okCount = applied.filter((/** @type {any} */ item) => item.ok === true).length;
            const pending = applied.length - okCount;
            setMessage({
              text:
                "已保存" +
                (applied.length === 0
                  ? "（新会话生效）"
                  : "；回读成功 " +
                    okCount +
                    "/" +
                    applied.length +
                    (pending > 0 ? `（${pending} 条待应用）` : "")),
              ok: pending === 0,
            });
            load();
          },
          (/** @type {any} */ error) => {
            setBusy(false);
            setMessage({ text: String(error?.message ?? error).slice(0, 200), ok: false });
          },
        );
      };
      /** @type {any[]} */
      const sessions = Array.isArray(view?.sessions) ? view.sessions : [];
      const lastApplied = sessions.find((/** @type {any} */ item) => item?.at) ?? null;
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "6px" },
          "data-projects-preset": "",
          "data-projects-preset-available": catalog.available ? "yes" : "no",
          "data-projects-preset-current": current,
          // 回读证据：每个会话的 {sessionId, kind, targetPreset, currentPreset, ok, mode}（原样给冒烟/排查用）
          "data-projects-preset-readback": JSON.stringify(sessions),
        },
        h(
          "div",
          { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: styles.meta }, "线程权限（只会收窄）"),
          h(
            "select",
            {
              style: { ...styles.input, flex: "1 1 200px" },
              value: current,
              disabled: busy || catalog.available !== true,
              "data-projects-preset-select": "",
              onChange: (/** @type {any} */ event) => {
                const next = String(event.target.value);
                if (next === current) return;
                choose(next);
              },
            },
            catalog.available
              ? [catalog.inherit, ...(catalog.options ?? [])].map((/** @type {any} */ option) =>
                  h(
                    "option",
                    {
                      key: option.name,
                      value: option.name,
                      "data-projects-preset-option": option.name,
                    },
                    String(option.label) +
                      (option.relation === "narrower" ? "（比宿主默认更窄）" : "") +
                      (option.isDefault ? "（宿主默认）" : ""),
                  ),
                )
              : h("option", { value: "" }, "宿主没有 permissionPresets，无法收窄"),
          ),
          h(
            "button",
            {
              type: "button",
              style: smallButton,
              disabled: busy || catalog.available !== true,
              "data-projects-preset-apply": "",
              onClick: () => {
                setBusy(true);
                call(api.ctx, "applyProjectPreset", { projectId: project.id }).then(
                  (/** @type {any} */ result) => {
                    setBusy(false);
                    const applied = Array.isArray(result?.applied) ? result.applied : [];
                    setMessage({
                      text:
                        "已应用到 " +
                        String(
                          applied.filter((/** @type {any} */ item) => item.ok === true).length,
                        ) +
                        "/" +
                        String(applied.length) +
                        " 个现有会话",
                      ok: applied.every((/** @type {any} */ item) => item.ok === true),
                    });
                    load();
                  },
                  (/** @type {any} */ error) => {
                    setBusy(false);
                    setMessage({ text: String(error?.message ?? error).slice(0, 200), ok: false });
                  },
                );
              },
            },
            "应用到现有会话",
          ),
        ),
        h(
          "div",
          { style: styles.meta, "data-projects-preset-note": "" },
          "推 / 合并 / 删除永远需要你在面板里批准（插件执行器）；本开关只影响工具调用是否逐次询问，以及命令能否写到项目目录之外，不绕过任何一道闸门。",
        ),
        sessions.length > 0
          ? h(
              "div",
              { style: styles.meta, "data-projects-preset-sessions": String(sessions.length) },
              "现有会话回读：" +
                String(sessions.filter((/** @type {any} */ item) => item.ok === true).length) +
                "/" +
                String(sessions.length) +
                " 已生效" +
                (lastApplied?.currentPreset
                  ? `（current(session)=${String(lastApplied.currentPreset)}）`
                  : "（句柄未就绪的会标「待应用」）"),
            )
          : null,
        message.text !== ""
          ? h(
              "span",
              {
                style: { ...styles.meta, color: message.ok === false ? T.danger : T.text },
                "data-projects-preset-message": "",
              },
              String(message.text),
            )
          : null,
        (catalog.notes ?? []).length > 0
          ? h(
              "details",
              { style: styles.meta },
              h("summary", { style: { cursor: "pointer" } }, "边界说明"),
              (catalog.notes ?? []).map((/** @type {any} */ note, /** @type {any} */ index) =>
                h("div", { key: index, style: styles.meta }, `· ${String(note)}`),
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
      // B4/F30：提醒到点后由宿主标记 fired+unread，这里轮询出来弹 toast（弹过就 ack）。
      const reminderState = useState(null);
      const reminderNotice = reminderState[0];
      const setReminderNotice = reminderState[1];
      const previous = React.useRef({ threads: {}, projects: [] });

      useEffect(() => {
        let cancelled = false;
        const tick = () => {
          // 页面在后台时不轮询：每 5s 一次 listProjects + 每项目 progress，
          // 在用户没看的时候纯属浪费（而且没人能看见 toast）。
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          // 轻量 RPC：只回线程六态 + 项目通知开关；不再每 5s 对每个项目跑 progress()。
          // 以前 progress() 会为每条 isolated 线程 spawn 一次 git，多项目时是进程风暴。
          call(api.ctx, "threadStates").then(
            (projects) => {
              if (cancelled || !Array.isArray(projects)) return;
              /** @type {Record<string, {state: string, projectId?: string}>} */
              const threads = {};
              /** @type {Record<string, any>} */
              const prefsByProject = {};
              for (const project of projects) {
                const projectId = String(project?.projectId ?? "");
                if (projectId === "") continue;
                prefsByProject[projectId] = project.notifyPrefs || {};
                for (const row of project.rows ?? []) {
                  threads[String(row.sessionId)] = {
                    state: String(row.state ?? "idle"),
                    projectId,
                  };
                }
              }
              const active = projects.map((/** @type {any} */ project) => project.projectId);
              const next = {
                threads,
                projects: active,
              };
              const items = diffAttention(previous.current, next);
              previous.current = next;
              // F58：按项目的通知开关过滤（项目没配置就用默认值：失败/等你开、完成关）
              const defaults = { failed: true, "waiting-user": true, completed: false };
              const filtered = items.filter((/** @type {any} */ item) => {
                const override = prefsByProject[item.projectId] || {};
                const prefs = { ...defaults, ...override };
                return prefs[item.kind] !== false;
              });
              const counts = summarize(filtered);
              const parts = [];
              if (counts.failed > 0) parts.push(text(t, "notify.failed", { count: counts.failed }));
              if (counts.waiting > 0)
                parts.push(text(t, "notify.waiting", { count: counts.waiting }));
              if (counts.completed > 0)
                parts.push(text(t, "notify.completed", { count: counts.completed }));
              const line = parts.join(" · ");
              if (line !== "") setNotice({ text: line, at: Date.now() });
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
        let cancelled = false;
        const tick = () => {
          const doc = typeof document === "undefined" ? null : document;
          if (doc?.hidden === true) return;
          call(api.ctx, "allDueReminders").then(
            (result) => {
              if (cancelled) return;
              const todo = Array.isArray(result?.todo) ? result.todo : [];
              if (todo.length === 0) return;
              setReminderNotice({
                ids: todo.map((/** @type {any} */ item) => ({
                  projectId: item.projectId,
                  id: item.id,
                })),
                text: todo
                  .map((/** @type {any} */ item) => String(item.text || ""))
                  .filter((/** @type {string} */ line) => line !== "")
                  .join(" · "),
                at: Date.now(),
              });
              // 弹过就标 notified：关掉再开不重复弹（unread 标记仍在提醒列表里）
              for (const item of todo) {
                void call(api.ctx, "ackReminder", {
                  projectId: item.projectId,
                  reminderId: item.id,
                }).catch(() => {});
              }
            },
            () => {},
          );
        };
        tick();
        const timer = setInterval(tick, 3000);
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

      useEffect(() => {
        if (!reminderNotice) return undefined;
        const timer = setTimeout(() => setReminderNotice(null), 12000);
        return () => clearTimeout(timer);
      }, [reminderNotice]);

      return h(
        "div",
        { "data-projects-notifier": "", style: { display: "contents" } },
        reminderNotice
          ? h(
              "div",
              {
                role: "status",
                "data-projects-reminder-toast": String((reminderNotice.ids ?? []).length),
                onClick: () => props.onOpen?.(),
                style: {
                  position: "fixed",
                  right: "16px",
                  bottom: notice ? "92px" : "16px",
                  zIndex: 61,
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
              },
              h("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "提醒"),
              h("div", { style: { color: T.dim } }, String(reminderNotice.text || "到点了")),
            )
          : null,
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
        } else if (
          was === "working" &&
          (entry.state === "idle" || entry.state === "resolved") &&
          before[sessionId]?.projectId === entry.projectId
        ) {
          out.push({ kind: "completed", projectId: String(entry.projectId || ""), sessionId });
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
        completed: list.filter((item) => item.kind === "completed").length,
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
      const dangerPanes = /** @type {any} */ (props);
      const dangerHidden = Boolean(
        dangerPanes.pane && dangerPanes.activePane && dangerPanes.pane !== dangerPanes.activePane,
      );
      return h(
        "details",
        {
          "data-projects-policy-danger": "",
          style: dangerHidden ? { display: "none" } : undefined,
        },
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

      // B2：重启协调器（F45）+ 实验性实时监听（F21）+ 轮询状态回读
      var ciView = useState({ ui: null, poll: null, spec: null, busy: "", message: "" });
      var ci = ciView[0];
      var setCi = ciView[1];

      var reload = useCallback(() => {
        Promise.all([
          call(api.ctx, "describe"),
          call(api.ctx, "listProjects"),
          call(api.ctx, "uiState"),
          call(api.ctx, "prPollState"),
          call(api.ctx, "realtimeCiSpec"),
        ]).then(
          (values) => {
            var projects = Array.isArray(values[1]) ? values[1] : [];
            setView((/** @type {any} */ prev) => ({
              loading: false,
              describe: values[0] || null,
              error: null,
              projects: projects,
              selectedId: prev.selectedId || (projects[0] ? projects[0].id : ""),
            }));
            setCi((/** @type {any} */ prev) => ({
              ...prev,
              ui: values[2] || null,
              poll: values[3] || null,
              spec: values[4] || prev.spec,
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
      // —— B3：设置四分区（F41/U19）+ 预算（F22）+ Usage（F49）+ Debug access（F50）+ 通知（F58）——
      var sectionState = useState("general");
      var section = sectionState[0];
      var setSection = sectionState[1];
      var b3State = useState({
        usage: null,
        content: null,
        gh: null,
        // 审计从项目页签外迁到这里（§7.3：审计/诊断进设置页）
        audit: [],
        message: "",
        busy: "",
        draft: null,
      });
      var b3 = /** @type {any} */ (b3State[0]);
      var setB3 = /** @type {any} */ (b3State[1]);
      var selectedForB3 =
        view.projects.find((/** @type {any} */ project) => project.id === view.selectedId) ||
        view.projects[0] ||
        null;
      var selectedForB3Id = selectedForB3 ? String(selectedForB3.id) : "";
      var loadB3 = useCallback(() => {
        if (selectedForB3Id === "") return;
        Promise.all([
          call(api.ctx, "usageView", { projectId: selectedForB3Id }).catch(() => null),
          call(api.ctx, "getProjectContent", { projectId: selectedForB3Id }).catch(() => null),
          call(api.ctx, "listAudit", { projectId: selectedForB3Id }).catch(() => null),
        ]).then((/** @type {any} */ values) => {
          setB3((/** @type {any} */ prev) => ({
            ...prev,
            usage: values[0],
            content: values[1],
            audit: Array.isArray(values[2]) ? values[2] : [],
          }));
        });
      }, [api, selectedForB3Id]);
      useEffect(() => {
        loadB3();
      }, [loadB3]);
      var budgetKeys = ["maxThreadsPerDay", "maxConcurrent", "maxStepsPerThread", "dailyTokens"];
      var budgetValues = /** @type {Record<string, any>} */ ({});
      budgetKeys.forEach((/** @type {any} */ key) => {
        var stored = selectedForB3?.budget ? selectedForB3.budget[key] : null;
        budgetValues[key] = Object.hasOwn(b3.draft || {}, key)
          ? b3.draft[key]
          : stored === null || stored === undefined
            ? ""
            : String(stored);
      });
      var setDraft = (/** @type {any} */ key, /** @type {any} */ value) => {
        setB3((/** @type {any} */ prev) => ({
          ...prev,
          draft: { ...(prev.draft || {}), [key]: value },
        }));
      };
      var saveBudget = () => {
        if (!selectedForB3) return;
        var patch = /** @type {Record<string, any>} */ ({});
        budgetKeys.forEach((/** @type {any} */ key) => {
          var raw = String(budgetValues[key] === "" ? "" : budgetValues[key]).trim();
          patch[key] = raw === "" ? null : Number(raw);
        });
        setB3((/** @type {any} */ prev) => ({ ...prev, busy: "budget", message: "" }));
        call(api.ctx, "setBudget", { projectId: selectedForB3.id, budget: patch }).then(
          (/** @type {any} */ result) => {
            setB3((/** @type {any} */ prev) => ({
              ...prev,
              busy: "",
              draft: null,
              message: text(t, "settings.budgetSaved", {
                budget: JSON.stringify(result?.budget || patch),
              }),
            }));
            reload();
          },
          (/** @type {any} */ error) => {
            setB3((/** @type {any} */ prev) => ({
              ...prev,
              busy: "",
              message: String(error?.message ? error.message : error).slice(0, 160),
            }));
          },
        );
      };
      var b3Message =
        b3.message === ""
          ? null
          : h(
              "div",
              { style: { color: T.dim, marginTop: "6px" }, "data-projects-settings-b3-result": "" },
              b3.message,
            );
      var budgetPanel = h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "6px" },
          "data-projects-settings-budget": "",
        },
        h("div", { style: { color: T.dim, fontSize: "12px" } }, text(t, "settings.budget")),
        h(
          "div",
          { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" } },
          budgetKeys.map((/** @type {any} */ key) =>
            h(
              "label",
              {
                key: key,
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  fontSize: "11.5px",
                  color: T.faint,
                },
              },
              h("span", null, key),
              h("input", {
                type: "text",
                inputMode: "numeric",
                value: budgetValues[key],
                placeholder: text(t, "settings.budgetUnlimited"),
                "data-projects-budget-input": key,
                style: { ...styles.input, width: "84px" },
                onChange: (/** @type {any} */ event) => {
                  setDraft(key, event.target.value);
                },
              }),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-budget-save": "",
              onClick: saveBudget,
            },
            text(t, "settings.budgetSave"),
          ),
        ),
        // M6：失败自动重试（诚实语义：失败结束后自动再发「继续」，最多 2 次）
        h(
          "label",
          {
            style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" },
            "data-projects-auto-retry-row": "",
          },
          h("input", {
            type: "checkbox",
            checked: selectedForB3?.policy?.autoRetry === true,
            "data-projects-auto-retry": "",
            onChange: (/** @type {any} */ event) =>
              applyPolicy({ autoRetry: event.target.checked === true }),
          }),
          text(t, "settings.autoRetry"),
        ),
        h(
          "span",
          { style: { color: T.faint, fontSize: "11.5px" } },
          text(t, "settings.autoRetryHint"),
        ),
        b3Message,
      );
      var memoryPanel = h(
        "div",
        {
          "data-projects-settings-memory": "",
          style: { display: "flex", flexDirection: "column", gap: "6px" },
        },
        h("div", { style: { color: T.dim, fontSize: "12px" } }, text(t, "settings.memoryTitle")),
        h(
          "div",
          { style: { color: T.dim, fontSize: "12px" }, "data-projects-settings-memory-counts": "" },
          text(t, "settings.memoryCounts", {
            instructions: b3.content ? b3.content.instructionsChars : 0,
            memory: b3.content ? b3.content.memoryChars : 0,
            fragments:
              b3.content && Array.isArray(b3.content.fragments) ? b3.content.fragments.length : 0,
          }),
        ),
        // M5：Memory 两层呈现（Claude 的 instructions 计数 + MEMORY.md 更新于 + Memory files）
        h(
          "div",
          {
            style: { display: "flex", flexDirection: "column", gap: "3px" },
            "data-projects-memory-layers": "",
          },
          h(
            "span",
            { style: { color: T.dim, fontSize: "12px" }, "data-projects-memory-instructions": "" },
            text(t, "settings.memoryInstructions", {
              used: Number(b3.content?.instructionsChars ?? 0),
              limit: Number(b3.content?.instructionsLimit ?? 16_000),
              updated: b3.content?.instructionsUpdatedAt
                ? formatWhen(t, b3.content.instructionsUpdatedAt)
                : text(t, "settings.memoryNever"),
            }),
          ),
          h(
            "span",
            { style: { color: T.dim, fontSize: "12px" }, "data-projects-memory-index-updated": "" },
            text(t, "settings.memoryIndexUpdated", {
              updated: b3.content?.memoryUpdatedAt
                ? formatWhen(t, b3.content.memoryUpdatedAt)
                : text(t, "settings.memoryNever"),
            }),
          ),
          Array.isArray(b3.content?.memoryFiles) && b3.content.memoryFiles.length > 0
            ? h(
                "div",
                {
                  style: { display: "flex", flexDirection: "column", gap: "1px" },
                  "data-projects-memory-files": "",
                },
                b3.content.memoryFiles.slice(0, 8).map((/** @type {any} */ file) =>
                  h(
                    "span",
                    {
                      key: String(file.name),
                      style: {
                        display: "flex",
                        gap: "8px",
                        fontSize: "11.5px",
                        color: T.faint,
                      },
                      "data-projects-memory-file": String(file.name),
                    },
                    h(
                      "span",
                      {
                        style: {
                          fontFamily: "ui-monospace, monospace",
                          minWidth: 0,
                          flex: "1 1 auto",
                        },
                      },
                      String(file.name),
                    ),
                    h("span", {}, formatWhen(t, file.updatedAt)),
                  ),
                ),
              )
            : h(
                "span",
                {
                  style: { color: T.faint, fontSize: "11.5px" },
                  "data-projects-memory-files-empty": "",
                },
                text(t, "settings.memoryFilesEmpty"),
              ),
        ),
        h(
          "button",
          {
            type: "button",
            style: styles.button,
            "data-projects-template-apply": "",
            onClick: () => {
              if (!selectedForB3) return;
              call(api.ctx, "applyProjectTemplate", { projectId: selectedForB3.id }).then(
                (/** @type {any} */ result) => {
                  setB3((/** @type {any} */ prev) => ({
                    ...prev,
                    message: text(t, "settings.memoryTemplateDone", {
                      path: String(result?.agentsPath || ""),
                    }),
                  }));
                  loadB3();
                },
                (/** @type {any} */ error) => {
                  setB3((/** @type {any} */ prev) => ({
                    ...prev,
                    message: String(error?.message ? error.message : error).slice(0, 160),
                  }));
                },
              );
            },
          },
          text(t, "settings.memoryTemplate"),
        ),
        b3Message,
      );
      var usage = b3.usage;
      var usagePanel = h(
        "div",
        {
          "data-projects-settings-usage": "",
          style: { display: "flex", flexDirection: "column", gap: "4px" },
        },
        h("div", { style: { color: T.dim, fontSize: "12px" } }, text(t, "settings.usageTitle")),
        usage
          ? h(
              "div",
              { style: { color: T.text, fontSize: "12px" } },
              h(
                "div",
                { "data-projects-usage-tokens": "" },
                text(t, "settings.usageTokens", {
                  today: usage.todayTokens,
                  total: usage.totalTokens,
                }),
              ),
              h(
                "div",
                { "data-projects-usage-context": "" },
                text(t, "settings.usageContext", {
                  instructions: usage.context ? usage.context.instructionsChars : 0,
                  memory: usage.context ? usage.context.memoryChars : 0,
                  fragments: usage.context ? usage.context.fragments : 0,
                }),
              ),
              h(
                "div",
                { "data-projects-usage-threads": "" },
                text(t, "settings.usageThreads", {
                  total: usage.threads ? usage.threads.total : 0,
                  today: usage.threads ? usage.threads.today : 0,
                  working: usage.threads ? usage.threads.working : 0,
                  waiting: usage.threads ? usage.threads.waiting : 0,
                }),
              ),
            )
          : h(
              "div",
              { style: { color: T.faint, fontSize: "12px" }, "data-projects-usage-empty": "" },
              text(t, "settings.usageEmpty"),
            ),
        h(
          "div",
          { style: { color: T.faint, fontSize: "11.5px" }, "data-projects-usage-money": "none" },
          text(t, "settings.usageNote"),
        ),
      );
      var notifyPrefs = selectedForB3?.notifyPrefs || {
        failed: true,
        "waiting-user": true,
        completed: false,
      };
      // Claude 的通知是「四档」；我们底层是三个布尔，这里用**档位预设**表达真实行为
      var notifyTier = (() => {
        var failed = notifyPrefs.failed === true;
        var waiting = notifyPrefs["waiting-user"] === true;
        var completed = notifyPrefs.completed === true;
        if (failed && waiting && completed) return "all";
        if (failed && waiting) return "coordinator";
        if (!failed && waiting) return "waiting";
        if (!failed && !waiting && !completed) return "none";
        return "custom";
      })();
      var setNotifyTier = (/** @type {any} */ tier) => {
        if (!selectedForB3) return;
        var prefs =
          tier === "all"
            ? { failed: true, "waiting-user": true, completed: true }
            : tier === "coordinator"
              ? { failed: true, "waiting-user": true, completed: false }
              : tier === "waiting"
                ? { failed: false, "waiting-user": true, completed: false }
                : { failed: false, "waiting-user": false, completed: false };
        call(api.ctx, "setNotifyPrefs", { projectId: selectedForB3.id, prefs: prefs }).then(
          () => {
            setB3((/** @type {any} */ prev) => ({
              ...prev,
              message: text(t, "settings.notifySaved"),
            }));
            reload();
          },
          (/** @type {any} */ error) =>
            setB3((/** @type {any} */ prev) => ({
              ...prev,
              message: String(error?.message ? error.message : error).slice(0, 160),
            })),
        );
      };
      var setNotifyPref = (/** @type {any} */ key, /** @type {any} */ value) => {
        if (!selectedForB3) return;
        var patch = /** @type {Record<string, any>} */ ({});
        patch[key] = value;
        call(api.ctx, "setNotifyPrefs", { projectId: selectedForB3.id, prefs: patch }).then(
          () => {
            setB3((/** @type {any} */ prev) => ({
              ...prev,
              message: text(t, "settings.notifySaved"),
            }));
            reload();
          },
          (/** @type {any} */ error) => {
            setB3((/** @type {any} */ prev) => ({
              ...prev,
              message: String(error?.message ? error.message : error).slice(0, 160),
            }));
          },
        );
      };
      var notifyRow = h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "4px" },
          "data-projects-notify-prefs": "",
        },
        h("span", { style: { color: T.dim, fontSize: "12px" } }, text(t, "settings.notifyTitle")),
        h(
          "select",
          {
            style: styles.input,
            value: notifyTier === "custom" ? "custom" : notifyTier,
            "data-projects-notify-tier": notifyTier,
            onChange: (/** @type {any} */ event) => setNotifyTier(String(event.target.value || "")),
          },
          ["all", "coordinator", "waiting", "none"]
            .concat(notifyTier === "custom" ? ["custom"] : [])
            .map((/** @type {string} */ tier) =>
              h("option", { key: tier, value: tier }, text(t, `settings.notifyTier.${tier}`)),
            ),
        ),
        h(
          "span",
          { style: { ...styles.meta, fontSize: "11px" } },
          text(t, "settings.notifyTierHint"),
        ),
        h(
          "div",
          { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" } },
          ["failed", "waiting-user", "completed"].map((/** @type {any} */ key) => {
            var labelKey =
              key === "failed"
                ? "settings.notifyFailed"
                : key === "waiting-user"
                  ? "settings.notifyWaiting"
                  : "settings.notifyCompleted";
            return h(
              "label",
              {
                key: key,
                style: {
                  display: "flex",
                  gap: "4px",
                  alignItems: "center",
                  fontSize: "12px",
                  color: T.dim,
                },
              },
              h("input", {
                type: "checkbox",
                checked: notifyPrefs[key] === true,
                "data-projects-notify-pref": key,
                onChange: (/** @type {any} */ event) => {
                  setNotifyPref(key, event.target.checked);
                },
              }),
              text(t, labelKey),
            );
          }),
        ),
      );
      var debugPanel = h(
        "div",
        {
          "data-projects-settings-debug": "",
          style: { display: "flex", flexDirection: "column", gap: "6px" },
        },
        h(
          "div",
          { style: { color: T.dim, fontSize: "12px" }, "data-projects-debug-access": "" },
          text(t, "settings.debugTitle"),
        ),
        describe
          ? h(
              "div",
              { style: { color: T.dim, fontSize: "12px" }, "data-projects-debug-rows": "" },
              text(t, "settings.debugRows", {
                projects: describe.projectCount,
                active: describe.activeCount,
                attached: describe.attachedSessions,
              }),
            )
          : null,
        notifyRow,
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              "data-projects-gh-check": "",
              disabled: b3.busy === "gh",
              onClick: () => {
                setB3((/** @type {any} */ prev) => ({ ...prev, busy: "gh", message: "" }));
                call(api.ctx, "githubCheck").then(
                  (/** @type {any} */ result) => {
                    setB3((/** @type {any} */ prev) => ({
                      ...prev,
                      busy: "",
                      gh: result,
                      message: text(
                        t,
                        result && result.level === "ok" ? "settings.ghOk" : "settings.ghFail",
                        {
                          message: String(result?.message || ""),
                          hint: String(result?.hint || ""),
                        },
                      ),
                    }));
                  },
                  (/** @type {any} */ error) => {
                    setB3((/** @type {any} */ prev) => ({
                      ...prev,
                      busy: "",
                      message: String(error?.message ? error.message : error).slice(0, 160),
                    }));
                  },
                );
              },
            },
            text(t, b3.busy === "gh" ? "settings.ghChecking" : "settings.ghCheck"),
          ),
          h(
            "span",
            {
              style: { color: T.faint, fontSize: "11.5px" },
              "data-projects-gh-result": b3.gh ? String(b3.gh.level || "") : "",
            },
            b3.gh ? String(b3.gh.message || "") : "",
          ),
        ),
        b3Message,
        // 审计（原项目详情「审计」页签）：审计/诊断属于设置页，不再占项目页签（§7.3）。
        // 最多列最近 100 条（与 listAudit 的截断一致，新的在前）：设置页不是审计浏览器，
        // 全量留给 listAudit 的调用方（工具/脚本）。
        h(
          "div",
          {
            style: {
              marginTop: "4px",
              paddingTop: "6px",
              borderTop: `1px solid ${T.borderSoft}`,
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            },
            "data-projects-settings-audit": "",
          },
          h(
            "div",
            { style: { color: T.dim, fontSize: "12px" }, "data-projects-audit-title": "" },
            text(t, "settings.auditTitle", {
              count: Array.isArray(b3.audit) ? b3.audit.length : 0,
            }),
          ),
          Array.isArray(b3.audit) && b3.audit.length > 0
            ? h(
                "div",
                { "data-projects-audit": "" },
                b3.audit
                  .slice(-100)
                  .reverse()
                  .map((/** @type {any} */ entry, /** @type {any} */ index) =>
                    h(
                      "div",
                      {
                        key: String(index),
                        style: { display: "flex", gap: "8px", alignItems: "baseline" },
                        "data-projects-audit-row": String(entry.action || entry.kind || "?"),
                      },
                      h(
                        "span",
                        { style: { ...styles.name, minWidth: 0 } },
                        String(entry.action || entry.kind || "?"),
                      ),
                      h("span", { style: styles.meta }, String(entry.at || "")),
                    ),
                  ),
              )
            : h(
                "p",
                { style: styles.empty, "data-projects-audit-empty": "" },
                text(t, "detail.auditEmpty"),
              ),
        ),
      );
      var sectionPanel = h(
        "div",
        {
          style: { marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" },
          "data-projects-settings-panel": section,
        },
        section === "general"
          ? budgetPanel
          : section === "memory"
            ? memoryPanel
            : section === "usage"
              ? usagePanel
              : debugPanel,
      );
      var sectionNav = h(
        "div",
        {
          style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" },
          "data-projects-settings-nav": "",
        },
        ["general", "memory", "usage", "debug"].map((id) =>
          h(
            "button",
            {
              key: id,
              type: "button",
              "data-projects-settings-nav-item": id,
              "aria-selected": section === id ? "true" : "false",
              style: {
                ...styles.button,
                ...(section === id ? { borderColor: T.accentText, color: T.accentText } : {}),
              },
              onClick: () => {
                setSection(id);
              },
            },
            text(t, `settings.nav.${id}`),
          ),
        ),
      );
      return h(
        "div",
        {
          style: { color: T.text, fontSize: "13px" },
          "data-projects-settings": "",
          "data-projects-settings-section": section,
        },
        sectionNav,
        sectionPanel,
        h(
          "div",
          {
            style: section === "general" ? { display: "contents" } : { display: "none" },
            "data-projects-settings-general": "",
          },
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

          // —— B4/F52：线程权限收窄（默认「继承宿主」；写→回读在卡片里显示）——
          (() => {
            var selectedForPreset = view.projects.find(
              (/** @type {any} */ item) => item.id === view.selectedId,
            );
            if (!selectedForPreset) return null;
            return h(
              "div",
              { style: { marginTop: "8px" } },
              h(PermissionNarrowCard, {
                api: api,
                t: t,
                project: selectedForPreset,
              }),
            );
          })(),

          // —— B2/F45：Restart 行（丢掉当前协调器会话，重开一个）——
          (() => {
            var selectedForRestart = view.projects.find(
              (/** @type {any} */ project) => project.id === view.selectedId,
            );
            var projectId = selectedForRestart ? selectedForRestart.id : "";
            var coordinatorId = String(selectedForRestart?.coordinatorSessionId ?? "");
            return h(
              "div",
              {
                style: {
                  marginTop: "8px",
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  flexWrap: "wrap",
                },
                "data-projects-settings-restart-row": projectId,
                "data-projects-settings-coordinator": coordinatorId,
              },
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-settings-restart": projectId,
                  disabled: projectId === "" || ci.busy !== "",
                  onClick: () => {
                    if (projectId === "") return;
                    setCi((/** @type {any} */ prev) => ({ ...prev, busy: "restart", message: "" }));
                    call(api.ctx, "restartCoordinator", { projectId: projectId }).then(
                      (/** @type {any} */ result) => {
                        setCi((/** @type {any} */ prev) => ({
                          ...prev,
                          busy: "",
                          message: text(t, "settings.restartDone", {
                            previous: String(result?.previousSessionId ?? "").slice(0, 10),
                          }),
                        }));
                        reload();
                      },
                      (/** @type {any} */ error) =>
                        setCi((/** @type {any} */ prev) => ({
                          ...prev,
                          busy: "",
                          message: String(error?.message ?? error).slice(0, 160),
                        })),
                    );
                  },
                },
                text(t, "settings.restartRow"),
              ),
              h(
                "span",
                { style: { color: T.dim, fontSize: "12px", minWidth: 0, flex: "1 1 220px" } },
                text(t, "settings.restartHint"),
              ),
            );
          })(),
          // —— B2/F21：实验性实时监听开关（默认关）+ 轮询状态回读 ——
          (() => {
            var enabled = ci.ui?.realtimeCi === true;
            var poll = ci.poll || null;
            return h(
              "div",
              {
                style: { marginTop: "8px", display: "flex", flexDirection: "column", gap: "2px" },
                "data-projects-realtime-ci-row": "",
                "data-projects-realtime-ci-state": enabled ? "on" : "off",
                "data-projects-realtime-ci-persisted": ci.ui?.available === true ? "yes" : "no",
              },
              h(
                "label",
                { style: { display: "flex", gap: "6px", alignItems: "center" } },
                h("input", {
                  type: "checkbox",
                  // 未实现：见详情页同一处注释（gh webhook 扩展 + 仓库管理员 + 验签，本轮不做）
                  checked: false,
                  disabled: true,
                  "data-projects-realtime-ci": "",
                  "data-projects-realtime-ci-implemented": "no",
                }),
                text(t, "settings.realtimeCi"),
              ),
              h(
                "span",
                { style: { color: T.faint, fontSize: "11.5px", marginLeft: "20px" } },
                ci.spec?.warning ? String(ci.spec.warning) : text(t, "settings.realtimeCiHint"),
              ),
              poll
                ? h(
                    "span",
                    {
                      style: { color: T.dim, fontSize: "11.5px", marginLeft: "20px" },
                      "data-projects-poll-state": poll.running ? "running" : "stopped",
                    },
                    text(t, "settings.pollState", {
                      state: poll.running
                        ? text(t, "settings.pollRunning")
                        : text(t, "settings.pollStopped"),
                      at: poll.lastAt ? new Date(poll.lastAt).toLocaleTimeString() : "—",
                      delay: String(Math.round(Number(poll.nextDelayMs ?? 30000) / 1000)),
                    }),
                  )
                : null,
            );
          })(),
          ci.message !== ""
            ? h(
                "div",
                {
                  style: { marginTop: "6px", color: T.dim },
                  "data-projects-settings-b2-result": "",
                },
                ci.message,
              )
            : null,
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
                    style: {
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                      marginTop: "6px",
                    },
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
                          style: {
                            display: "flex",
                            gap: "6px",
                            alignItems: "center",
                            color: T.dim,
                          },
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
        ),
      );
    }

    // ================= B3 第二批 UI：本地优势 / 设置入口 / 记忆碎片 / 线程动作 =================

    /**
     * F55/U20 授权卡 + F42 线程默认模型 + F3 从会话开线程 + F62 @ 源状态。
     * 放在右栏「上下文」段里：设置页在本机 profile 可能被禁用，这里保证功能可达、可测。
     * @param {any} props
     */
    function B3ContextCard(props) {
      var api = props.api;
      // 这张卡混装三种分区内容（通用/记忆/环境），按当前分区隐藏而不是卸载
      var b3Pane = String(props.activePane || "");
      var paneStyle = (/** @type {string} */ pane, /** @type {any} */ base) => {
        if (b3Pane === "" || pane === b3Pane) return base;
        return { ...(base || {}), display: "none" };
      };
      var t = props.t;
      var project = props.project || {};
      var dirs = Array.isArray(project.dirs) ? project.dirs : [];
      var folderAuth = project.policy?.folderAuth || {};
      var defaults = project.threadDefaults || { provider: "", model: "", reasoningEffort: "" };
      var coordinatorDefaults = project.coordinatorDefaults || {
        provider: "",
        model: "",
        reasoningEffort: "",
      };
      var st = useState({
        message: "",
        busy: "",
        catalog: null,
        sessions: null,
        rename: "",
        manualOpen: false,
        /** F55：授权 RPC 回执里的 mode（宿主回读值），父级刷新前先用它渲染。 */
        folderModes: {},
        /** F42：setThreadDefaults 回执里的 defaults（宿主回读值），同样先于父级刷新。 */
        savedDefaults: null,
        /** D3：setCoordinatorDefaults 回执里的 defaults。 */
        savedCoordinatorDefaults: null,
        /** D3：目录为空时的手填兜底（与线程默认一致） */
        coordinatorManualOpen: false,
      });
      var view = st[0];
      var setView = st[1];
      var reload = props.onChanged;
      // F42：下拉是**可写**的，选中值必须有自己的 state（不能回写 props 旧值——那是假保存）。
      var pickedState = useState({
        model: defaults.provider && defaults.model ? `${defaults.provider}|${defaults.model}` : "",
        effort: defaults.reasoningEffort || "",
      });
      var picked = pickedState[0];
      var setPicked = pickedState[1];
      // 协调者默认模型是**独立**的下拉（视频里 Coordination 与 Thread 两个旋钮）。
      var coordinatorPickedState = useState({
        model:
          coordinatorDefaults.provider && coordinatorDefaults.model
            ? `${coordinatorDefaults.provider}|${coordinatorDefaults.model}`
            : "",
        effort: coordinatorDefaults.reasoningEffort || "",
      });
      var coordinatorPicked = coordinatorPickedState[0];
      var setCoordinatorPicked = coordinatorPickedState[1];
      // F62：`@` 源是晚于插件就绪的服务，注册状态变化要能让这张卡重渲染（否则永远停在初始值）。
      var mentionTick = useState(0);
      var forceMention = mentionTick[1];
      useEffect(() => {
        if (typeof api.subscribeMentionSource !== "function") return undefined;
        return api.subscribeMentionSource(() => {
          forceMention((/** @type {number} */ n) => n + 1);
        });
      }, [api, forceMention]);
      // 项目切换 / 宿主回读变化时，把下拉重置为盘上值。
      useEffect(() => {
        setPicked({
          model:
            defaults.provider && defaults.model ? `${defaults.provider}|${defaults.model}` : "",
          effort: defaults.reasoningEffort || "",
        });
      }, [project.id, defaults.provider, defaults.model, defaults.reasoningEffort, setPicked]);
      useEffect(() => {
        setCoordinatorPicked({
          model:
            coordinatorDefaults.provider && coordinatorDefaults.model
              ? `${coordinatorDefaults.provider}|${coordinatorDefaults.model}`
              : "",
          effort: coordinatorDefaults.reasoningEffort || "",
        });
      }, [
        project.id,
        coordinatorDefaults.provider,
        coordinatorDefaults.model,
        coordinatorDefaults.reasoningEffort,
        setCoordinatorPicked,
      ]);

      useEffect(() => {
        call(api.ctx, "modelCatalog").then(
          (/** @type {any} */ catalog) => {
            setView((/** @type {any} */ prev) => ({ ...prev, catalog: catalog || null }));
          },
          () => {
            setView((/** @type {any} */ prev) => ({ ...prev, catalog: null }));
          },
        );
      }, [api, project.id]);
      var note = (/** @type {string} */ message) => {
        setView((/** @type {any} */ prev) => ({ ...prev, message: message }));
      };
      var fail = (/** @type {any} */ error) => {
        note(String(error?.message ? error.message : error).slice(0, 160));
      };
      var decide = (/** @type {string} */ path, /** @type {string} */ decision) => {
        call(api.ctx, "authorizeFolder", {
          projectId: project.id,
          path: path,
          decision: decision,
        }).then((/** @type {any} */ result) => {
          var label =
            decision === "default"
              ? text(t, "b3.folderDefault")
              : decision === "deny"
                ? text(t, "b3.folderDeny")
                : text(t, "b3.folderOnce");
          // 服务端回执带 summary.mode（它自己从 store 回读）——先落到本地再等父级刷新。
          var mode = String(result?.summary?.mode || result?.decision || decision);
          setView((/** @type {any} */ prev) => ({
            ...prev,
            folderModes: { ...prev.folderModes, [path]: mode },
          }));
          note(text(t, "b3.folderSaved", { decision: label }));
          if (typeof reload === "function") reload();
        }, fail);
      };
      var saveCoordinatorDefaults = () => {
        var parts = String(coordinatorPicked.model || "").split("|");
        var provider = parts.length > 1 ? parts[0] : "";
        var modelId = parts.length > 1 ? parts.slice(1).join("|") : "";
        call(api.ctx, "setCoordinatorDefaults", {
          projectId: project.id,
          provider: provider,
          model: modelId,
          reasoningEffort: String(coordinatorPicked.effort || ""),
        }).then((/** @type {any} */ result) => {
          var readback = result?.defaults || {};
          setView((/** @type {any} */ prev) => ({
            ...prev,
            savedCoordinatorDefaults: {
              provider: String(readback.provider ?? ""),
              model: String(readback.model ?? ""),
              reasoningEffort: String(readback.reasoningEffort ?? ""),
            },
          }));
          setCoordinatorPicked({
            model:
              readback.provider && readback.model
                ? `${readback.provider}|${readback.model}`
                : String(coordinatorPicked.model || ""),
            effort: String(readback.reasoningEffort ?? coordinatorPicked.effort ?? ""),
          });
          note(text(t, "b3.coordinatorSaved"));
          if (typeof reload === "function") reload();
        }, fail);
      };
      var saveDefaults = () => {
        var parts = String(picked.model || "").split("|");
        var provider = parts.length > 1 ? parts[0] : "";
        var modelId = parts.length > 1 ? parts.slice(1).join("|") : "";
        call(api.ctx, "setThreadDefaults", {
          projectId: project.id,
          provider: provider,
          model: modelId,
          reasoningEffort: String(picked.effort || ""),
        }).then((/** @type {any} */ result) => {
          // 回读盘上的值（不是把刚选的值再写一遍）：服务端返回 readback defaults。
          var readback = result?.defaults || {};
          setView((/** @type {any} */ prev) => ({
            ...prev,
            savedDefaults: {
              provider: String(readback.provider ?? ""),
              model: String(readback.model ?? ""),
              reasoningEffort: String(readback.reasoningEffort ?? ""),
            },
          }));
          setPicked({
            model:
              readback.provider && readback.model
                ? `${readback.provider}|${readback.model}`
                : String(picked.model || ""),
            effort: String(readback.reasoningEffort ?? picked.effort ?? ""),
          });
          note(text(t, "b3.modelSaved"));
          if (typeof reload === "function") reload();
        }, fail);
      };
      var loadSessions = () => {
        call(api.ctx, "recentSessions", { projectId: project.id }).then(
          (/** @type {any} */ result) => {
            setView((/** @type {any} */ prev) => ({
              ...prev,
              sessions: Array.isArray(result?.sessions) ? result.sessions : [],
            }));
          },
          () => {
            setView((/** @type {any} */ prev) => ({ ...prev, sessions: [] }));
          },
        );
      };
      var attach = (/** @type {string} */ sessionId) => {
        call(api.ctx, "attachThread", { sessionId: sessionId, projectId: project.id }).then(() => {
          note(text(t, "b3.sessionsAttached", { id: String(sessionId).slice(0, 10) }));
          if (typeof reload === "function") reload();
        }, fail);
      };
      // F42：modelCatalog → 可写的模型/effort 下拉。结构不认识就只留「继承宿主默认」。
      /** @type {{ value: string, label: string }[]} */
      var options = [{ value: "", label: text(t, "b3.modelInherit") }];
      /** @type {Record<string, string[]>} */
      var effortByModel = {};
      var appendCatalogOptions = (/** @type {any} */ catalog) => {
        if (!catalog || typeof catalog !== "object") return;
        const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
        for (const group of groups) {
          const models = Array.isArray(group?.models) ? group.models : [];
          const provider = String(group?.id || group?.provider || "");
          for (const model of models) {
            const id = String(model?.id || model?.model || "");
            if (id === "") continue;
            const value = provider === "" ? id : `${provider}|${id}`;
            const rawEfforts =
              model?.reasoning && Array.isArray(model.reasoning.efforts)
                ? model.reasoning.efforts
                : [];
            const efforts = [];
            for (const item of rawEfforts) {
              const effortId =
                typeof item === "string"
                  ? item
                  : String((item && (item.id || item.value || item.name)) || "");
              if (effortId !== "") efforts.push(effortId);
            }
            options.push({
              value: value,
              label: (group.name ? `${String(group.name)}/` : provider ? `${provider}/` : "") + id,
            });
            effortByModel[value] = efforts;
          }
        }
      };
      appendCatalogOptions(view.catalog);
      var effortChoices = (effortByModel[picked.model] || []).slice();
      // 当前值不在目录里（部署换了 / 目录没暴露）也要留在选项里，不能把盘上的值吞掉。
      if (picked.effort !== "" && effortChoices.indexOf(picked.effort) < 0) {
        effortChoices.push(picked.effort);
      }
      // 目录统计（测试与 UI 共用）：下拉选项必须等于目录里的模型数 + 1（继承），
      // 硬编码任何一条都会在这条等式上露馅。
      var catalogStats = JSON.stringify({
        groups: view.catalog && Array.isArray(view.catalog.groups) ? view.catalog.groups.length : 0,
        models: options.length - 1,
        failures:
          view.catalog && Array.isArray(view.catalog.failures) ? view.catalog.failures.length : 0,
        selectedEfforts: (effortByModel[picked.model] || []).length,
      });
      // 协调者默认的回读锚点（宿主回读值，不是本地选择）
      var coordinatorDefaultsReadback = JSON.stringify(
        view.savedCoordinatorDefaults || {
          provider: String(coordinatorDefaults.provider || ""),
          model: String(coordinatorDefaults.model || ""),
          reasoningEffort: String(coordinatorDefaults.reasoningEffort || ""),
        },
      );
      var coordinatorEffortChoices = (effortByModel[coordinatorPicked.model] || []).slice();
      if (
        coordinatorPicked.effort !== "" &&
        coordinatorEffortChoices.indexOf(coordinatorPicked.effort) < 0
      ) {
        coordinatorEffortChoices.push(coordinatorPicked.effort);
      }
      // 回读锚点：值来自宿主回读（props.project.threadDefaults），不是本地选择。
      var defaultsReadback = JSON.stringify(
        view.savedDefaults || {
          provider: String(defaults.provider || ""),
          model: String(defaults.model || ""),
          reasoningEffort: String(defaults.reasoningEffort || ""),
        },
      );
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "8px" },
          "data-projects-b3-card": "",
          "data-projects-mention-source-state": String(api.mentionSource || "unavailable"),
        },
        // F62：@ 源注册状态（注册失败也要诚实显示）
        h(
          "div",
          {
            style: paneStyle("general", styles.meta),
            "data-projects-mention-source": String(api.mentionSource || "unavailable"),
          },
          text(
            t,
            api.mentionSource === "registered" ? "b3.mentionRegistered" : "b3.mentionUnavailable",
          ),
        ),
        // F62：候选预览（不依赖 inputTriggers 是否可用，直接读 host RPC）
        h(
          "div",
          {
            style: paneStyle("memory", { display: "flex", flexWrap: "wrap", gap: "6px" }),
            "data-projects-mention-candidates": "",
          },
          (view.mentions || []).map((/** @type {any} */ item) =>
            h(
              "span",
              {
                key: `${String(item.kind)}:${String(item.id)}`,
                style: styles.inlineChip,
                "data-projects-mention-candidate": `${String(item.kind)}:${String(item.id)}`,
              },
              String(item.label || ""),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.secondaryButton,
              "data-projects-mention-load": "",
              onClick: () => {
                call(api.ctx, "mentionItems", { query: "" }).then((/** @type {any} */ items) => {
                  setView((/** @type {any} */ prev) => ({
                    ...prev,
                    mentions: Array.isArray(items) ? items.slice(0, 6) : [],
                  }));
                }, fail);
              },
            },
            text(t, "b3.mentionTitle"),
          ),
        ),
        // F37：碎片计数（写入口在记忆页签；右栏保持只读观感）
        h(
          "span",
          { style: paneStyle("memory", styles.meta), "data-projects-frag-count": "" },
          text(t, "b3.fragLimit", {
            count: Array.isArray(props.fragments) ? props.fragments.length : 0,
            limit: 100,
          }),
        ),
        // M5：Environment 摘要（Claude 的「Your computer / Repositories / Folders without asking」）
        h(
          "div",
          {
            style: paneStyle("environment", {
              display: "flex",
              flexDirection: "column",
              gap: "3px",
            }),
            "data-projects-env-summary": "",
          },
          h(
            "span",
            { style: { ...styles.meta, color: T.dim }, "data-projects-env-machine": "" },
            text(t, "b3.envMachine", {
              value:
                dirs.length > 0 ? text(t, "b3.envMachineLocal") : text(t, "b3.envMachineNoDir"),
            }),
          ),
          h(
            "span",
            { style: { ...styles.meta, color: T.dim }, "data-projects-env-repos": "" },
            text(t, "b3.envRepos", { count: dirs.length }),
          ),
          h(
            "span",
            { style: { ...styles.meta, color: T.dim }, "data-projects-env-allowed": "" },
            (() => {
              const allowed = Array.isArray(dirs)
                ? dirs.filter((/** @type {string} */ dir) => {
                    const record = folderAuth[dir] || null;
                    const mode = String(view.folderModes[dir] || record?.mode || "");
                    return mode === "default";
                  })
                : [];
              return allowed.length === 0
                ? text(t, "b3.envAllowedEmpty")
                : text(t, "b3.envAllowed", {
                    count: allowed.length,
                    names: allowed.map((/** @type {string} */ dir) => baseName(dir)).join("、"),
                  });
            })(),
          ),
        ),
        // F55/U20：本地文件夹授权卡
        h(
          "div",
          {
            style: paneStyle("environment", {
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }),
            "data-projects-folder-auth": "",
          },
          h(
            "span",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                justifyContent: "space-between",
              },
            },
            h("span", { style: styles.name }, text(t, "b3.folderTitle")),
            h(
              "button",
              {
                type: "button",
                style: { ...styles.secondaryButton, padding: "1px 8px", fontSize: "11.5px" },
                "data-projects-folder-add": "",
                title: text(t, "b3.folderAddHint"),
                onClick: () => {
                  if (typeof props.onAddDir === "function") props.onAddDir();
                },
              },
              `+ ${text(t, "b3.folderAdd")}`,
            ),
          ),
          dirs.length === 0
            ? h("span", { style: styles.meta }, text(t, "b3.folderNoDir"))
            : dirs.map((/** @type {string} */ dir) => {
                var record = folderAuth[dir] || null;
                var mode = String(view.folderModes[dir] || record?.mode || "");
                var stateLabel =
                  mode === "default"
                    ? text(t, "b3.folderDefaultTag")
                    : mode === "deny"
                      ? text(t, "b3.folderDeniedTag")
                      : mode === "once"
                        ? record && record.used === true
                          ? text(t, "b3.folderOnceUsed")
                          : text(t, "b3.folderOnce")
                        : text(t, "b3.folderUnset");
                return h(
                  "div",
                  {
                    key: dir,
                    style: {
                      border: `1px solid ${T.borderSoft}`,
                      borderRadius: "10px",
                      padding: "8px 10px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                    },
                    "data-projects-folder-card": dir,
                    "data-projects-folder-mode": mode || "unset",
                  },
                  h(
                    "span",
                    {
                      style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
                    },
                    h("span", { style: styles.name }, baseName(dir)),
                    Array.isArray(project.repos) && project.repos.length > 0
                      ? h(
                          "span",
                          {
                            style: {
                              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                              fontSize: "11px",
                              color: T.dim,
                              border: `1px solid ${T.borderSoft}`,
                              borderRadius: "6px",
                              padding: "0 5px",
                              flex: "none",
                            },
                            "data-projects-folder-repo": dir,
                          },
                          String(project.repos[0]),
                        )
                      : null,
                  ),
                  h(
                    "span",
                    {
                      style: {
                        ...styles.meta,
                        color: T.faint,
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: "11px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                      title: dir,
                      "data-projects-folder-path": dir,
                    },
                    dir,
                  ),
                  h(
                    "span",
                    { style: { ...styles.meta, whiteSpace: "normal" } },
                    text(t, "b3.folderCopy"),
                  ),
                  h(
                    "span",
                    {
                      style: { ...styles.meta, color: T.faint, whiteSpace: "normal" },
                      "data-projects-folder-cwd-hint": dir,
                    },
                    text(t, "b3.folderWorktreeHint"),
                  ),
                  h(
                    "span",
                    {
                      style: { ...styles.meta, color: T.faint },
                      "data-projects-folder-state": dir,
                    },
                    stateLabel,
                  ),
                  h(
                    "div",
                    { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                    h(
                      "button",
                      {
                        type: "button",
                        style: styles.secondaryButton,
                        "data-projects-folder-decision": "deny",
                        "data-projects-folder-path": dir,
                        onClick: () => {
                          decide(dir, "deny");
                        },
                      },
                      text(t, "b3.folderDeny"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: styles.secondaryButton,
                        "data-projects-folder-decision": "default",
                        "data-projects-folder-path": dir,
                        onClick: () => {
                          decide(dir, "default");
                        },
                      },
                      text(t, "b3.folderDefault"),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        style: styles.secondaryButton,
                        "data-projects-folder-decision": "once",
                        "data-projects-folder-path": dir,
                        onClick: () => {
                          decide(dir, "once");
                        },
                      },
                      text(t, "b3.folderOnce"),
                    ),
                  ),
                );
              }),
        ),
        // D3：协调者默认模型 / effort（与线程默认分开；视频里 Coordination 与 Thread 是两个旋钮）
        h(
          "div",
          {
            style: paneStyle("general", { display: "flex", flexDirection: "column", gap: "4px" }),
            "data-projects-coordinator-defaults": "",
            "data-projects-coordinator-defaults-value": coordinatorDefaultsReadback,
          },
          h("span", { style: styles.name }, text(t, "b3.coordinatorTitle")),
          h(
            "label",
            {
              style: {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                fontSize: "12px",
                color: T.dim,
              },
            },
            h("span", null, text(t, "b3.coordinatorModel")),
            h(
              "select",
              {
                style: styles.input,
                value: coordinatorPicked.model,
                "data-projects-coordinator-model": "",
                onChange: (/** @type {any} */ event) => {
                  var next = String(event.target.value || "");
                  setCoordinatorPicked((/** @type {any} */ prev) => {
                    var allowed = effortByModel[next] || [];
                    var effort =
                      prev.effort === "" || allowed.indexOf(prev.effort) >= 0 ? prev.effort : "";
                    return { model: next, effort: effort };
                  });
                },
              },
              options.map((/** @type {any} */ option) =>
                h("option", { key: option.value || "inherit", value: option.value }, option.label),
              ),
            ),
          ),
          h(
            "label",
            {
              style: {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                fontSize: "12px",
                color: T.dim,
              },
            },
            h("span", null, text(t, "b3.coordinatorEffort")),
            h(
              "select",
              {
                style: styles.input,
                value: coordinatorPicked.effort,
                "data-projects-coordinator-effort": "",
                onChange: (/** @type {any} */ event) => {
                  var next = String(event.target.value || "");
                  setCoordinatorPicked((/** @type {any} */ prev) => ({ ...prev, effort: next }));
                },
              },
              [""]
                .concat(coordinatorEffortChoices)
                .map((/** @type {string} */ value) =>
                  h(
                    "option",
                    { key: value || "inherit", value: value },
                    value || text(t, "b3.modelInherit"),
                  ),
                ),
            ),
          ),
          h(
            "div",
            { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
            h(
              "button",
              {
                type: "button",
                style: styles.secondaryButton,
                "data-projects-coordinator-defaults-save": "",
                onClick: saveCoordinatorDefaults,
              },
              text(t, "b3.modelSave"),
            ),
            h(
              "button",
              {
                type: "button",
                style: styles.secondaryButton,
                "data-projects-coordinator-manual-toggle": "",
                onClick: () =>
                  setView((/** @type {any} */ prev) => ({
                    ...prev,
                    coordinatorManualOpen: !prev.coordinatorManualOpen,
                  })),
              },
              text(t, "b3.modelManual"),
            ),
          ),
          view.coordinatorManualOpen
            ? h(
                "div",
                {
                  style: { display: "flex", gap: "6px", flexWrap: "wrap" },
                  "data-projects-coordinator-manual": "",
                },
                h("input", {
                  style: { ...styles.input, fontSize: "12px", padding: "3px 8px" },
                  value: coordinatorPicked.model,
                  placeholder: "provider|model",
                  "data-projects-coordinator-model-manual": "",
                  onChange: (/** @type {any} */ event) =>
                    setCoordinatorPicked((/** @type {any} */ prev) => ({
                      ...prev,
                      model: String(event.target.value || ""),
                    })),
                }),
                h("input", {
                  style: { ...styles.input, fontSize: "12px", padding: "3px 8px" },
                  value: coordinatorPicked.effort,
                  placeholder: "effort",
                  "data-projects-coordinator-effort-manual": "",
                  onChange: (/** @type {any} */ event) =>
                    setCoordinatorPicked((/** @type {any} */ prev) => ({
                      ...prev,
                      effort: String(event.target.value || ""),
                    })),
                }),
              )
            : null,
        ),
        // F42：线程默认模型 / effort
        h(
          "div",
          {
            style: paneStyle("general", { display: "flex", flexDirection: "column", gap: "4px" }),
            "data-projects-thread-defaults": "",
            "data-projects-thread-defaults-value": defaultsReadback,
            "data-projects-model-catalog": catalogStats,
          },
          h("span", { style: styles.name }, text(t, "b3.modelTitle")),
          h(
            "label",
            {
              style: {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                fontSize: "12px",
                color: T.dim,
              },
            },
            h("span", null, text(t, "b3.model")),
            h(
              "select",
              {
                style: styles.input,
                value: picked.model,
                "data-projects-thread-model": "",
                "data-projects-thread-model-count": String(options.length - 1),
                onChange: (/** @type {any} */ event) => {
                  var next = String(event.target.value || "");
                  setPicked((/** @type {any} */ prev) => {
                    var allowed = effortByModel[next] || [];
                    var effort =
                      prev.effort === "" || allowed.indexOf(prev.effort) >= 0 ? prev.effort : "";
                    return { model: next, effort: effort };
                  });
                },
              },
              options.map((/** @type {any} */ option) =>
                h("option", { key: option.value || "inherit", value: option.value }, option.label),
              ),
            ),
          ),
          h(
            "label",
            {
              style: {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                fontSize: "12px",
                color: T.dim,
              },
            },
            h("span", null, text(t, "b3.effort")),
            h(
              "select",
              {
                style: styles.input,
                value: picked.effort,
                "data-projects-thread-effort": "",
                "data-projects-thread-effort-count": String(effortChoices.length),
                onChange: (/** @type {any} */ event) => {
                  var next = String(event.target.value || "");
                  setPicked((/** @type {any} */ prev) => ({ ...prev, effort: next }));
                },
              },
              [""]
                .concat(effortChoices)
                .map((/** @type {string} */ value) =>
                  h(
                    "option",
                    { key: value || "inherit", value: value },
                    value || text(t, "b3.modelInherit"),
                  ),
                ),
            ),
          ),
          // 下拉自身就是可写路径；按钮把当前选择写给宿主，并回读宿主值（不是回写旧 props）。
          h(
            "div",
            { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
            h(
              "button",
              {
                type: "button",
                style: styles.secondaryButton,
                "data-projects-thread-defaults-save": "",
                onClick: saveDefaults,
              },
              text(t, "b3.modelSave"),
            ),
            h(
              "button",
              {
                type: "button",
                style: styles.secondaryButton,
                "data-projects-recent-sessions": "",
                onClick: loadSessions,
              },
              text(t, "b3.sessionsLoad"),
            ),
          ),
          // 模型目录不可用（无凭据部署）时的**可写兜底**：手填 provider|model / effort。
          // 默认收起（右栏值行应保持只读观感）；点「手填」才展开，保存写的就是这里看到的值。
          h(
            "button",
            {
              type: "button",
              style: { ...styles.secondaryButton, alignSelf: "flex-start" },
              "data-projects-thread-manual-toggle": "",
              "aria-expanded": view.manualOpen ? "true" : "false",
              onClick: () =>
                setView((/** @type {any} */ prev) => ({ ...prev, manualOpen: !prev.manualOpen })),
            },
            text(t, "b3.modelManualToggle"),
          ),
          view.manualOpen
            ? h(
                "div",
                { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                h("input", {
                  type: "text",
                  style: { ...styles.input, width: "170px" },
                  value: picked.model,
                  placeholder: text(t, "b3.modelManual"),
                  "data-projects-thread-model-manual": "",
                  onChange: (/** @type {any} */ event) =>
                    setPicked((/** @type {any} */ prev) => ({
                      ...prev,
                      model: String(event.target.value || ""),
                    })),
                }),
                h("input", {
                  type: "text",
                  style: { ...styles.input, width: "120px" },
                  value: picked.effort,
                  placeholder: text(t, "b3.effortManual"),
                  "data-projects-thread-effort-manual": "",
                  onChange: (/** @type {any} */ event) =>
                    setPicked((/** @type {any} */ prev) => ({
                      ...prev,
                      effort: String(event.target.value || ""),
                    })),
                }),
                h("span", { style: styles.meta }, text(t, "b3.modelManualHint")),
              )
            : null,
        ),
        // F3：从会话开线程
        view.sessions
          ? h(
              "div",
              {
                style: paneStyle("general", {
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }),
                "data-projects-recent-list": "",
              },
              view.sessions.length === 0
                ? h("span", { style: styles.meta }, text(t, "b3.sessionsEmpty"))
                : view.sessions.slice(0, 5).map((/** @type {any} */ session) => {
                    var attached = session.attached === true;
                    return h(
                      "div",
                      {
                        key: session.sessionId,
                        style: { display: "flex", gap: "6px", alignItems: "center", minWidth: 0 },
                        "data-projects-recent-session": session.sessionId,
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
                        String(session.title || session.sessionId).slice(0, 60),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          style: styles.secondaryButton,
                          disabled: attached,
                          "data-projects-attach-session": session.sessionId,
                          onClick: () => {
                            attach(String(session.sessionId));
                          },
                        },
                        text(t, "b3.sessionsAttach"),
                      ),
                    );
                  }),
            )
          : null,
        view.message !== ""
          ? h(
              "div",
              { style: { color: T.dim, fontSize: "11.5px" }, "data-projects-b3-message": "" },
              view.message,
            )
          : null,
      );
    }

    /**
     * F37：记忆页签里的碎片列表 + 索引条目（新增 / 预览 / 逐条忘掉）。
     * @param {any} props
     */
    function MemoryFragments(props) {
      var api = props.api;
      var t = props.t;
      var projectId = props.projectId;
      var content = props.content || {};
      var fragments = Array.isArray(content.fragments) ? content.fragments : [];
      var entries = Array.isArray(content.entries) ? content.entries : [];
      var st = useState({ title: "", text: "", message: "", preview: "", busy: "" });
      var view = st[0];
      var setView = st[1];
      var reload = props.onChanged;
      var patch = (/** @type {any} */ next) => {
        setView((/** @type {any} */ prev) => ({ ...prev, ...next }));
      };
      var fail = (/** @type {any} */ error) => {
        patch({ message: String(error?.message ? error.message : error).slice(0, 160) });
      };
      var add = () => {
        call(api.ctx, "addMemoryFragment", {
          projectId: projectId,
          title: view.title,
          text: view.text,
        }).then((/** @type {any} */ result) => {
          patch({
            title: "",
            text: "",
            message: text(t, "b3.fragAdded", { slug: String(result?.slug || "") }),
          });
          if (typeof reload === "function") reload();
        }, fail);
      };
      var forget = (/** @type {string} */ kind, /** @type {string} */ id) => {
        call(api.ctx, "forgetMemory", { projectId: projectId, kind: kind, id: id }).then(() => {
          patch({ message: text(t, "b3.actionDone"), preview: "" });
          if (typeof reload === "function") reload();
        }, fail);
      };
      var preview = (/** @type {string} */ slug) => {
        call(api.ctx, "readMemoryFragment", { projectId: projectId, slug: slug }).then(
          (/** @type {any} */ result) => {
            patch({ preview: String(result?.text || "") });
          },
          fail,
        );
      };
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "6px", margin: "10px 0 14px" },
          "data-projects-fragments": "",
        },
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h("h3", { style: styles.name }, text(t, "detail.fragmentsTitle")),
          h(
            "span",
            { style: { ...styles.meta, color: T.faint }, "data-projects-frag-count": "" },
            text(t, "b3.fragLimit", { count: fragments.length, limit: 100 }),
          ),
        ),
        h("input", {
          style: styles.input,
          value: view.title,
          placeholder: text(t, "b3.fragTitlePh"),
          "data-projects-frag-title": "",
          onChange: (/** @type {any} */ event) => {
            patch({ title: event.target.value });
          },
        }),
        h("textarea", {
          style: { ...styles.input, minHeight: "64px", fontFamily: "inherit" },
          value: view.text,
          placeholder: text(t, "b3.fragTextPh"),
          "data-projects-frag-text": "",
          onChange: (/** @type {any} */ event) => {
            patch({ text: event.target.value });
          },
        }),
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          h(
            "button",
            { type: "button", style: styles.button, "data-projects-frag-add": "", onClick: add },
            text(t, "b3.fragAdd"),
          ),
          view.message !== ""
            ? h("span", { style: styles.meta, "data-projects-frag-message": "" }, view.message)
            : null,
        ),
        fragments.length === 0
          ? h(
              "span",
              { style: styles.meta, "data-projects-frag-empty": "" },
              text(t, "b3.fragEmpty"),
            )
          : fragments.map((/** @type {any} */ fragment) =>
              h(
                "div",
                {
                  key: fragment.slug,
                  style: {
                    display: "flex",
                    gap: "6px",
                    alignItems: "center",
                    minWidth: 0,
                    flexWrap: "wrap",
                  },
                  "data-projects-frag": fragment.slug,
                },
                h(
                  "span",
                  { style: { ...styles.meta, minWidth: 0 }, title: fragment.slug },
                  fragment.title || fragment.slug,
                ),
                h(
                  "span",
                  { style: { ...styles.meta, color: T.faint } },
                  `${String(fragment.chars)} 字符`,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-frag-preview": fragment.slug,
                    onClick: () => {
                      preview(String(fragment.slug));
                    },
                  },
                  text(t, "b3.fragPreview"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-frag-forget": fragment.slug,
                    onClick: () => {
                      forget("fragment", String(fragment.slug));
                    },
                  },
                  text(t, "b3.fragForget"),
                ),
              ),
            ),
        view.preview !== ""
          ? h(
              "pre",
              {
                style: {
                  ...styles.meta,
                  whiteSpace: "pre-wrap",
                  maxHeight: "180px",
                  overflow: "auto",
                },
                "data-projects-frag-preview-text": "",
              },
              view.preview,
            )
          : null,
        h("h4", { style: { ...styles.name, margin: "6px 0 0" } }, text(t, "b3.entriesTitle")),
        entries.length === 0
          ? h(
              "span",
              { style: styles.meta, "data-projects-entry-empty": "" },
              text(t, "b3.entriesEmpty"),
            )
          : entries.map((/** @type {any} */ entry) =>
              h(
                "div",
                {
                  key: entry.id,
                  style: { display: "flex", gap: "6px", alignItems: "center", minWidth: 0 },
                  "data-projects-entry": entry.id,
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
                  String(entry.text || "").slice(0, 90),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    style: styles.secondaryButton,
                    "data-projects-entry-forget": entry.id,
                    onClick: () => {
                      forget("entry", String(entry.id));
                    },
                  },
                  text(t, "b3.entryForget"),
                ),
              ),
            ),
      );
    }

    /**
     * F23：线程重命名（内联在既有 ⋯ 菜单里：输入 + 保存，走 renameThread RPC）。
     * @param {any} props
     */
    function ThreadRename(props) {
      var api = props.api;
      var t = props.t;
      var row = props.row || {};
      var sessionId = String(row.sessionId || "");
      var st = useState({ renaming: false, title: String(row.title || ""), message: "" });
      var view = st[0];
      var setView = st[1];
      /** @param {any} next */
      var patch = (next) => {
        setView((/** @type {any} */ prev) => ({ ...prev, ...next }));
      };
      var rename = () => {
        call(api.ctx, "renameThread", { sessionId: sessionId, title: view.title }).then(
          () => {
            patch({ renaming: false, message: t("b3.renamed") });
            if (typeof props.onChanged === "function") props.onChanged();
            if (typeof props.onDone === "function") props.onDone();
          },
          (/** @type {any} */ error) => {
            patch({ message: String(error?.message ?? error).slice(0, 120) });
          },
        );
      };
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "4px" },
          "data-projects-thread-rename-row": sessionId,
        },
        view.renaming
          ? h(
              "div",
              { style: { display: "flex", gap: "6px", alignItems: "center" } },
              h("input", {
                style: styles.input,
                value: view.title,
                placeholder: t("b3.renamePlaceholder"),
                "data-projects-thread-rename-input": "",
                onChange: (/** @type {any} */ event) => patch({ title: event.target.value }),
              }),
              h(
                "button",
                {
                  type: "button",
                  style: styles.button,
                  "data-projects-thread-rename-save": "",
                  onClick: rename,
                },
                t("b3.renameSave"),
              ),
            )
          : h(
              "button",
              {
                type: "button",
                role: "menuitem",
                style: menuItemStyle,
                "data-projects-thread-rename": sessionId,
                onClick: () => patch({ renaming: true }),
              },
              t("b3.actionRename"),
            ),
        view.message !== ""
          ? h(
              "span",
              { style: styles.meta, "data-projects-thread-rename-message": "" },
              view.message,
            )
          : null,
      );
    }

    exports.inject = ["slots", "locale", "connection", "sidebarRight"];
    /** @param {any} ctx */
    exports.apply = function apply(ctx) {
      var c = /** @type {any} */ (ctx);
      c.effect(() => c.locale.register(NS, { zh: ZH, en: EN }), "projects: dictionaries");
      var t = c.locale.bind(NS);
      /** 给组件用的句柄：组件里拿不到 ctx，统一从这里取。 */
      var api = {
        ctx: c,
        t: t,
        mentionSource: "unavailable",
        /** F62：注册状态变化的订阅者（ctx.inject 晚到，卡片要能重渲染）。
         * @type {((status: string) => void)[]} */
        mentionListeners: [],
        /**
         * F62：只有在 `registerSource()` **成功返回**之后才置 `registered`；
         * 失败/服务缺失一律 `unavailable`（面板上照实显示，不假装注册过）。
         * @param {"registered"|"unavailable"} status
         */
        setMentionSource: (status) => {
          var next = String(status || "unavailable");
          if (api.mentionSource === next) return;
          api.mentionSource = next;
          const listeners = api.mentionListeners.slice();
          for (const listener of listeners) {
            try {
              listener(next);
            } catch (_error) {
              /* 订阅者异常不应影响注册本身 */
            }
          }
        },
        /** @param {(status: string) => void} listener */
        subscribeMentionSource: (listener) => {
          if (typeof listener !== "function") return () => {};
          api.mentionListeners.push(listener);
          return () => {
            var at = api.mentionListeners.indexOf(listener);
            if (at >= 0) api.mentionListeners.splice(at, 1);
          };
        },
        /** U18：宿主 contextMenus 服务（晚到；缺失时自绘菜单照常可用）。 */
        contextMenus: null,
        contextMenuReady: false,
        /** U2 ⚙：宿主没有已验证的「打开插件设置」client API；有就调，没有返回 false 交给 UI 说明。 */
        openSettings: () => {
          try {
            if (typeof c.selectSettings === "function") {
              c.selectSettings();
              return true;
            }
            if (typeof c.openSettings === "function") {
              c.openSettings();
              return true;
            }
          } catch (_error) {
            /* 未验证的 API：失败就当没有 */
          }
          return false;
        },
      };

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

      // F62：`@` 提及 provider（client 半唯一 seam：ctx.inputTriggers.registerSource）。
      // 候选来自 host RPC `mentionItems`（本项目的线程 + 项目名），插入形如 `@thread:<sessionId>`。
      //
      // `inputTriggers` 是**晚于插件就绪**的服务：用 `ctx.inject` 等它，不要写进 `exports.inject`
      // ——后者缺服务会让整个插件不激活（docs/runtime/0.2.2-rc.2.md「晚于插件就绪的服务」）。
      var mentionSpec = {
        trigger: "@",
        name: "projects",
        order: 40,
        showGroupTitle: false,
        candidates: async (/** @type {any} */ _session, /** @type {any} */ request) => {
          var items = await call(c, "mentionItems", {
            query: String(request?.query || ""),
          });
          return (Array.isArray(items) ? items : []).map((/** @type {any} */ item) => {
            var token = (item.kind === "thread" ? "thread:" : "project:") + String(item.id);
            return {
              name: token,
              label: String(item.label || token),
              description: String(item.detail || ""),
              icon: item.kind === "thread" ? "session" : "folder",
              value: token,
            };
          });
        },
        onPick: (/** @type {any} */ pick) => {
          var token = String(pick?.candidate?.value || "");
          var label = String(pick?.candidate?.label || token);
          return {
            insert: {
              source: "projects",
              ref: `@${token}`,
              label: label,
              appearance: "session",
              clipboardText: `@${token}`,
            },
          };
        },
        codec: {
          clipboardText: (/** @type {string} */ ref) => ref,
          serialize: (/** @type {string} */ ref) =>
            Promise.resolve(`<project-ref>${ref}</project-ref>`),
        },
      };
      /** 注册一次 `@` 源；只有 registerSource 成功返回函数才算 registered。 */
      var installMentionSource = (/** @type {any} */ svc) => {
        if (!svc || typeof svc.registerSource !== "function") {
          api.setMentionSource("unavailable");
          return () => {};
        }
        /** @type {null | (() => void)} */
        var dispose = null;
        try {
          dispose = svc.registerSource(mentionSpec);
        } catch (error) {
          c.logger?.warn?.(`projects: @ source registration failed: ${String(error)}`);
          api.setMentionSource("unavailable");
          return () => {};
        }
        if (typeof dispose !== "function") {
          api.setMentionSource("unavailable");
          return () => {};
        }
        const disposeMention = dispose;
        api.setMentionSource("registered");
        return () => {
          try {
            disposeMention();
          } catch (_error) {
            /* 卸载失败不影响插件其余部分 */
          }
          if (api.mentionSource === "registered") api.setMentionSource("unavailable");
        };
      };
      if (typeof c.inject === "function") {
        try {
          c.inject(["inputTriggers"], (/** @type {any} */ scope) => {
            var svc =
              scope?.inputTriggers ??
              (typeof scope?.get === "function" ? scope.get("inputTriggers") : null);
            c.effect(() => installMentionSource(svc), "projects: @ mention source");
          });
        } catch (_error) {
          api.setMentionSource("unavailable");
        }
      } else {
        // 老宿主没有 ctx.inject：走同步取服务，拿不到就如实 unavailable。
        c.effect(
          () =>
            installMentionSource(
              (() => {
                try {
                  return typeof c.get === "function" ? c.get("inputTriggers") : c.inputTriggers;
                } catch (_error) {
                  return null;
                }
              })(),
            ),
          "projects: @ mention source",
        );
      }

      // F23/U18：线程右键菜单。**真正接进宿主 `contextMenus`**（右键线程行 / ⋯ 上 Shift+F10）：
      // 宿主菜单自带键盘导航、视口定位与键位提示；服务缺失时保留自绘「⋯」菜单，不丢入口。
      // 与 `@` 源同理用 `ctx.inject` 等晚到的服务。
      var installThreadMenus = (/** @type {any} */ menus) => {
        if (!menus || typeof menus.register !== "function") {
          api.contextMenuReady = false;
          return () => {};
        }
        var rpc = (/** @type {string} */ method, /** @type {any} */ args) => call(c, method, args);
        var notify = (/** @type {string} */ message) => {
          try {
            menus.notify(message, true);
          } catch (_error) {
            /* 未验证的 API：提示失败不影响动作本身 */
          }
        };
        /** @type {null | (() => void)} */
        var dispose = /** @type {any} */ (
          menus.register({
            id: "projects.thread",
            target: "projects.thread",
            order: 200,
            resolve: (/** @type {any} */ target) => {
              // 宿主把 `{kind, value}` 的 value 传进来（registry.resolve 的约定）。
              var value = target && typeof target === "object" ? target : {};
              var sessionId = String(value.sessionId || "");
              if (sessionId === "") return [];
              return [
                {
                  id: "rename",
                  label: text(t, "b3.actionRename"),
                  run: () => {
                    var title = typeof value.title === "string" ? value.title : "";
                    return rpc("renameThread", { sessionId: sessionId, title: title }).then(() => {
                      notify(text(t, "b3.renamed"));
                    });
                  },
                },
                {
                  id: "unread",
                  label: text(t, "b3.actionUnread"),
                  run: () =>
                    rpc("setThreadUnread", { sessionId: sessionId, unread: true }).then(() => {
                      notify(text(t, "b3.actionDone"));
                    }),
                },
                {
                  id: "resolve",
                  label: value.resolved ? text(t, "b3.actionReopen") : text(t, "b3.actionResolve"),
                  run: () =>
                    rpc("resolveThread", { sessionId: sessionId, resolved: !value.resolved }).then(
                      () => {
                        notify(text(t, "b3.actionDone"));
                      },
                    ),
                },
                {
                  id: "copy",
                  label: text(t, "b3.actionCopy"),
                  run: () => {
                    try {
                      if (
                        navigator.clipboard &&
                        typeof navigator.clipboard.writeText === "function"
                      ) {
                        navigator.clipboard.writeText(sessionId);
                      }
                    } catch (_error) {
                      /* 剪贴板不可用 */
                    }
                    notify(text(t, "b3.copied"));
                  },
                },
                {
                  id: "reclaim",
                  label: text(t, "b3.actionReclaim"),
                  separatorBefore: true,
                  run: () =>
                    rpc("reclaimThread", { sessionId: sessionId }).then(() => {
                      notify(text(t, "b3.actionDone"));
                    }),
                },
                {
                  id: "detach",
                  label: text(t, "b3.actionDetach"),
                  run: () =>
                    rpc("detachThread", { sessionId: sessionId }).then(() => {
                      notify(text(t, "b3.actionDone"));
                    }),
                },
              ];
            },
          })
        );
        if (typeof dispose !== "function") {
          api.contextMenuReady = false;
          return () => {};
        }
        const disposeMenus = dispose;
        api.contextMenus = menus;
        api.contextMenuReady = true;
        return () => {
          try {
            disposeMenus();
          } catch (_error) {
            /* 卸载失败不影响插件其余部分 */
          }
          if (api.contextMenus === menus) {
            api.contextMenus = null;
            api.contextMenuReady = false;
          }
        };
      };
      if (typeof c.inject === "function") {
        try {
          c.inject(["contextMenus"], (/** @type {any} */ scope) => {
            var menus =
              scope?.contextMenus ??
              (typeof scope?.get === "function" ? scope.get("contextMenus") : null);
            c.effect(() => installThreadMenus(menus), "projects: thread context menu");
          });
        } catch (_error) {
          api.contextMenuReady = false;
        }
      } else {
        c.effect(
          () =>
            installThreadMenus(
              (() => {
                try {
                  return typeof c.get === "function" ? c.get("contextMenus") : c.contextMenus;
                } catch (_error) {
                  return null;
                }
              })(),
            ),
          "projects: thread context menu",
        );
      }

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
