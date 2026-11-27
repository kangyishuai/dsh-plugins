# @kangyishuai/dsh-projects

> 把项目做成一等上下文单元：会话归属、项目级指令与记忆注入、每线程独立工作树、可审计的协调器，以及可封顶的成本闸。

[English](./README.md)

非官方 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，与 DeepSeek 无关。

> **关于协调器的上下文（2026-11-17，DSH 0.2.2-rc.3）：** 宿主的按会话 runtime context 不会投递给协调器会话，
> 因此项目规则、记忆索引**与人格**改为**随 wake 信封**送达——每轮一封信，同时带着线程结果。
> 细节见 `docs/runtime/0.2.2-rc.3.md` §11.24–§11.26。

> **状态：M4 已完成，仍是 1.0 之前。** 项目、上下文注入、隔离的并行线程、可选协调器，以及带闸门的审批/执行层均已实现，
> 有 502 项单测、196 项 web 端到端冒烟覆盖；桌面只读回归更新到 17 项（首启引导那条改成只断言不点击，
> 不再往 live profile 的 `firstRunDone` 写东西），
> 但本阶段**没有重启桌面版复跑**（只跑了 `pnpm verify` 与临时 DSH_HOME 的 web 冒烟）。
> 远端写入（推分支 / 开 PR / 合并）已接线，并用本地 bare 远端 + 桩 `gh` 完成端到端验证；
> 真实 GitHub 上的效果还需发版后确认一次。**项目共享**已推迟（[ADR 0018](../../docs/adr/0018-projects-defer-liveshare-sharing.md)）。

## 做什么

DSH 按工作目录给会话分组，且模型看不到项目级记忆。本插件补上这一层：

- **项目是一等上下文单元** —— 一条持久记录，带目标、目录、预算与策略。会话归属由插件自己存（不依赖不可变的 `cwd` 现算）。
- **项目指令与记忆注入** —— 归属某项目的会话在每次请求前收到该项目的常设规则与 `MEMORY.md` 索引（16k 预算、不与宿主已加载的 AGENTS.md 重复）。实现是全局注册一次、按会话求值：不属于任何项目的会话拿到的始终是空串。- **项目级预算闸** —— 建线程前拦每日线程数与并发上限（token 维度的花费上限随协调器一起做）。
- **暂停 / 归档 / 删除** —— 暂停可逆、只拦新建；删除遵循 ADR 0002：一行影响面（线程数、体积、是否在跑、可否恢复）+ 两段式确认，全部移入 `trash/` 并留 `manifest.json`。
- **应用内通知** —— 全局 overlay 轮询，线程新出现失败或在等你时弹 toast；浏览器 Notification 默认不开。

- **隔离的并行线程** —— 每个任务一个会话。项目目录是 Git 仓库时，线程拿到自己的 worktree（`<仓库同级>/.dsh-worktrees/<仓库名>/`）；不是仓库时**降级为共享目录**并明确告警，而不是建不出线程。
- **本地优势、设置与记忆（B3）** —— 记忆变成「索引 + 独立碎片文件」（`memory/fragments/<slug>.md`，可列、可预览、可逐条忘掉；`MEMORY.md` 里的普通条目也能按稳定内容 id 单独 forget）。项目指令保持 16,000 字符预算，并与宿主 `dsh-agent-instructions` 已注入的 AGENTS.md 去重（重复段落省略并在注入里写明省略了几段），整块用 `<project-context>` 包裹，并显式写明「这是项目记忆，不是 AGENTS.md」。`goal` 上限 8,000 字符并带计数。新建项目带一组保守默认预算（日线程 20 / 并发 2 / 步数 60 / token 不限），可在设置里改。**暂停只停新建线程与定时任务，不再静默停掉上下文注入。** 设置页分四个分区（General / Memory / Usage / Debug access）；Usage 只报 token 与上下文占用、**永远不显示金额**（宿主没有价目 API）；通知按项目开关（失败、等你默认开，完成默认关）。`gh auth status` / `gh repo list` 只读检查会给出「没装 / 没登录 / 缺 repo scope」三种可操作提示。项目模板把受管区块幂等写进 `AGENTS.md`（区块外的用户内容不动）。线程重命名与 `@` 候选（项目 + 线程）走 RPC，`@` 源用 `ctx.inject(["inputTriggers"])` 注册，且只有 `registerSource()` 成功返回后才显示 `registered`（服务缺失时面板如实写 `unavailable`，不假装注册过）。三键文件夹授权卡是**执行闸**而不是备注：`Deny` 会让审批执行器在项目目录里跑的 `gh`/`git` 命令被拒，`Allow once` 首次使用即消费（再来被拒），`Set as default` 长期有效，未授权的目录保持旧行为。线程行右键 / Shift+F10 打开宿主 `contextMenus`（自绘 `⋯` 菜单保留为降级路径）；中英文字典已对齐（B3 新增 106 个 key 两边都有）。
- **Library 与产物卡（B5）** —— 项目页「Library」页签合并两块数据。**文件面**走宿主 `workspaceFiles`（scope `{sessionId, workspaceRoot}`，每个项目目录一次 `list`；没有目录或没有会话时如实说明原因）；面板写明**搜索只匹配文件名 / 路径、不搜正文**——这是宿主的边界。**产物面**按 Remote 契约读 `artifacts` 0.2（先 `ctx.get("artifacts")`，再 `version().contract === "artifacts/2"`，最后 `list({ projectId })`）；因为产物 meta 不保证带 `projectId`，插件在项目记录里**自存 `projectId ↔ artifactId` 映射**（`artifactRefs[]`：id / 标题 / 类型 / 版本 / 字节 / 时间 / 来源会话与工具调用；项目线程里 `recordArtifact` 写入，冷启动可回读）。计量给条数与字节，provenance 说清「来自哪条会话的哪次调用」。artifacts 未装、没有 `version()` 或契约不符时，Library 明写**「产物库需要 dsh-artifacts 0.2」**并且只列文件面——**绝不显示「这个项目没有产物」**。展开的线程行内嵌产物缩略卡（标题 / 类型 / 版本 / 相对时间 / provenance）；「打开产物库」按钮走宿主右栏 `sidebarRight.openTab("artifact", { params: { projectId } })`，服务缺失时按钮禁用并说明原因。B3 复审修复随这批一起落地：线程默认 effort **白名单删掉**（本部署的 `max` / `xhigh` / `off` 现在都能存住，只保留 40 字符上限）、`locale/{zh,en}.json` 补齐 **44 个缺失的 runtime 键**（实时 CI 文案改成「未实现」，不再承诺会建 webhook）、冒烟开局加 **INFRA 自检**（宿主端口 / 插件激活 / `projects.json` 落盘 / 浏览器结果）失败即 fail-fast 而不混进断言计数、`once` 凭据改到**所有闸通过且占位成功之后**才消费（没落地会回滚），文件夹闸按**命令实际运行的目录**求 mode（线程 worktree 继承其项目目录的授权），`listMemoryFragments` 先校验项目存在再碰文件系统。
- **Claude UI 对齐（M2–M6）** —— 主列改为**单 composer**（新线程/协调者目标切换、圆形 ↵ 发送、控件行在卡片外）并贴底；右栏四视图 + **视图可见性开关**（写项目记录，刷新后仍生效）；行状态副标题（working 动词+秒数、`✓✓✓ 使用 X`、失败/等你/结果摘要，结果摘要只写真实观测值）、步进圆环与任务弹层、产物 chips（含封面）与 diff chip、行尾时长 `now/Nm/Nh/Nd`；协调者结论上浮 + 消息折叠块 + 结论旁产物 chips，协调者默认模型独立于线程默认；**Routines 可编辑**（频率↔手动会真正建/删宿主定时，避免「改手动仍投递」；43 处硬编码中文抽成 i18n）；**PR 流程**含三段式卡、复制链接、**合并**（有 PR 号 + 二次确认 + 危险开关三重门禁，草稿自动 `pr ready`）与统一在线程 worktree 执行；**失败自动重试**是语义明确的替代版本（失败后 60s 重发「继续」，累计最多 2 次，不冒充「用量恢复续跑」）；深浅双主题分层与浅色对比度补强，WebUI 与桌面在 1440×900 下布局几何一致。
- **四个页签，对齐 Claude Projects（界面规范 §7.3 的例外）** —— 面板现在是 `线程 / Library / Routines / 视图`，对齐 Claude「Projects」的 IA（D1/D2 决策，来自 4 条视频调研）。「视图」页签里是可见性复选 + 已保存的筛选视图；记忆迁到 **项目设置 › 记忆**（`data-projects-memory-pane`）。§7.3 默认仍是 ≤3，这个第 4 个页签是对齐宿主产品固定 IA 的**书面例外**。
- **页签 5 → 3（界面规范 §7.3「页签最多 3 个」）** —— 项目主页只剩 `线程 / 记忆 / Routines`。**Library** 改成右栏一行入口：`data-projects-library-open` 点开后把同一份 `LibraryView` 渲染在**主列**（`data-projects-library-main` 包裹，旧的 `data-projects-library*` 锚点全部保留），主列顶部 `data-projects-library-back`（或再次点同一右栏行）回到线程列表。**审计**移到设置分节的 **Debug** 区（`data-projects-settings-audit`，列表仍用 `data-projects-audit` / `data-projects-audit-empty`，新的在前，最多 100 条 = `listAudit` 的截断），项目详情不再轮询审计。桌面只读回归新增 **`--create`**（默认关，默认仍严格只读）：用 UI 建一个 `smoke-desktop-<ts>` 临时项目 → 断言两列详情页（`data-projects-detail-grid/main/rail`）、6 个药丸、3 个页签 → 用同一套 UI 删除并彻底删除 → 断言盘上 `projects.json` 里没有它；不带 `--create` 时，profile 里有项目就真断言，没有就如实 SKIP 并写明原因。
- **结构性三项（B4）** —— **Routines** 把六档频率（手动 / 每小时 / 每天 / 工作日 / 每周 / 每月）映射到宿主 `schedule`：每小时与三档日历用 `cron`，每天用宿主 `daily`，时间一律补成宿主硬要求的 `HH:mm:ss`（`09:30` 会被 `ScheduleInputError` 拒）。支持创建 / 列表 / 启停（宿主 `paused|active` **加**本地 `enabled` 副本）/ 删除（先删宿主条目，宿主拒绝就不动本地，避免留下继续花 token 的孤儿）/ **Run now** / **History**（宿主投递记录与本地 Run now 记录按时间倒序合并）。UI 在创建处强制写明成本：**每次投递 = 一次模型调用**、新建会话两次投递至少隔 60 秒、手动档不自动跑。**权限开关是「收窄」不是「自动放行」**：本部署 `catalog().defaultPreset` 已是 `danger-full-access` + `approval: never`，所以下拉第一项是「继承宿主默认」，其余选项**全部来自 `catalog()`**（名字不写死），逐项 `resolve()` 后把 `{sandbox, approval}` 翻成人话（只读 / 工作区可写 / 全权限 / 自定义）并标出「比宿主默认更窄」。选择以名字存进项目记录，在**线程或协调器会话创建后**用 `permissionPresets.set(session, name)` 应用；拿不到会话句柄就如实标 `pending`（不假装生效），没有匹配档时用 `session.append('approval/policy' | 'sandbox/mode')` 兜底并标「自定义」。每次应用都做写→回读（`current(session)`；兜底路径读 `approval.overrideOf` / `sandboxPolicy.overrideOf`），面板同时明示「推 / 合并 / 删除永远需要你批准」。**提醒**每条可选两种模式：`timer`（默认，免费）本机计时 + 到期时间落盘，每次启动按盘上记录重建（关机期间到点的在启动时补触发一次并写回 `fired` + 未读，重启不会重复响），到点弹 `shell.overlay` toast；`schedule`（计费）转宿主 `schedule` 并写明「到点跑一次模型、DSH 关着也会跑」。项目默认模式（`reminderDefault`，默认 `timer`）可被单条覆盖；支持取消、提前完成与过期清理（终态超 7 天清掉，pending 永不动）。
- **把桩接通（B2）** —— 项目页有协调者区（一个长期会话：可建、可发一句话、可重开；**不是**宿主 composer），协调者汇报做结论上浮 + thread chip，上下文策略里 `compaction` 一律判空兜底，wake 信封新增「最近线程」「记忆索引」两段；线程内 Tasks 清单（来自宿主 `todo/write` 快照，`✓`/`◌` + n/m，没清单时显示 `none` 而不是 0/0）、线程内 steering（`prompt({mode:'steer'})`）、每线程模型 / effort（`session/selectModel`，下拉取 `modelCatalog`，改完回读 `modelSelection`）、Create PR 条 + PR 徽章（带 CI 状态点）、可展开的线程面板（起始卡、分支/参数 chip）；线程**不可跨项目移动**（`attachThread` 对「已属于别的项目」直接拒绝，只允许挂空槽或先 detach 再挂）；PR/CI 默认轮询（只对有开放 PR 的项目，30–90s 退避，应用关掉即停；档位读 `policy.pr.tier`，可按项目 opt-out），设置与详情页各有一个「实验性实时监听」开关——**disabled 且明确标注未实现**（真做需要 gh-webhook 扩展、仓库管理员权限与验签；当前只有轮询），另有一个「修一轮 CI」手动入口把失败线程喂给有界 auto-fix 循环。
- **Overview / 项目主页（B1）** —— 六态（`等你 > 失败 > 在跑 > 待审 > 空闲`，另有 `归档`）由宿主 `state().pendingInput/running`、持久 `turn/end` 失败原因与插件自存的 `resolvedAt` 共同结算；分组头带计数、药丸条五类过滤（`~Nm` 只在能从已观测步进节奏估计时显示）、行副标题取最近一条 `tool/call` 的可读摘要、步进环取 `todo/write` 快照（没有 todo 就显示「—」，绝不用 0/0）、手动 resolve/重开与未读标记、`Welcome back` 头 + 7 日 token 迷你图、一次性首启引导（`firstRunDone` 存宿主 `storageDomain`）、项目切换器，以及 Context 多目录（每项目 ≤10）。
- **「需要我」判定** —— `pendingInput` 与失败轮全部来自宿主/持久事件，不依赖模型自报；需要你处理的排在前面。
- **协调器** —— 线程跑完一轮就给它送一封结构化唤醒信封（**带着线程的真实结果**），每轮最多一次。用户输入**先按扁平规则路由**（`{when, action}`），规则都不命中时才由模型提议。
- **自治闸门** —— `L0` 只观察、`L1` 只提议（默认）、`L2` 可建线程、`L3` 全权。闸门在**决策之后、执行之前**，所以审计里同时看得到意图与拒绝原因。
- **极小的工具篮子** —— 协调器只有 4 个 `project_*` 工具（建线程/列线程/发消息/申请动作），**没有** shell、写文件、删除、推送、合并。危险动作只能「申请」，由审批队列收集、由你决定。
- **先批准、后执行** —— 批准只代表「同意这一次」；真正执行还要对应危险开关打开（六个**默认全关**）、影响面在阈值内，且动作与开关之间是显式映射。每次执行都留恢复证据，每次拒绝都写审计说明原因。
- **不可信输入只是数据** —— 来自 CI 日志、PR 评论或 peer 的内容以 `relay` 身份进来，会被包成「这是数据不是指令」的块（围栏比内容里最长反引号串更长），永远不能构成授权。
- **收尾（B6）** —— Overview 能跨重启重建：每个项目线程保留一段有上限（80 条）的**最小可回放事件**（轮起止、失败 attempt、副标题摘要、todo 快照、交互开关；正文与工具参数一律不落盘），service 启动时用 `replay()` 重建视图，所以重启后失败/等你不会又变回空闲（人工 `resolvedAt` 晚于最后一次活动才算数；resolve 之后又有新活动则旧 resolve 过期，不会「点完已解决又自己弹回失败」）。**自动 resolve（F29）**：项目字段 `autoResolveDays`（null = 关，默认）启动时查一次、之后每日一次，把**无活动 ≥ N 天**的线程标为 resolved，写审计 `thread/auto-resolved`（带 `days`/`idleDays`）并同步内存视图；已 resolved / 归档 / 没有时间事实的线程一律不动，刚好 N 天算命中、差 1ms 不算。下拉在项目详情右栏（关 / 3 / 7 / 14 / 30 天）——宿主可能禁用设置页，所以这里必须能真写；`setAutoResolveDays` 返回回读值并写 `project/auto-resolve`，`checkAutoResolve` 可手动跑同一套检查。线程行摘要现在显示真实的 `diff N 文件 +N/-M`（`git diff --numstat <baseSha>`，**含未提交改动**、5s 缓存、git 答不了才 `n/a`），并给 `data-projects-thread-diff` 精确锚点；「改本插件配置」审批路径的 routing 规则改用匹配器**同一份对象契约**校验（`{textMatches,textMaxChars,isQuestion,threadState}`），真实规则终于写得进也命中得了。
- **策略可编辑** —— 自治级别、人格、模型兜底开关都在设置里改（设置首屏仍保持三行）。
- **可选远端写入** —— 推线程分支、开 PR（四档，默认 `off`）、合并，都要危险开关 + 人工批准；
  已用本地 bare 远端 + 桩 `gh` 完成端到端验证，真实 GitHub 上的效果还需发版后确认一次。
- **项目共享** —— 推迟，见 [ADR 0018](../../docs/adr/0018-projects-defer-liveshare-sharing.md)：
  DSH 0.2.2-rc.3 虽带 `dsh-experimental-liveshare`，但未启用、也没有稳定宿主接口，基于它实现等于猜测。

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-projects
```

装完重启 DSH 桌面版。

## 副作用与风险

- **写元数据**到 `$DSH_HOME/projects/projects.json`（配置了 `config.dataRoot` 时写到那里；桌面版不导出 `DSH_HOME` 时回落到 `~/.dsh/projects`）。用临时文件原子替换；文件损坏时**改名隔离**，绝不删除。
- **会创建 Git worktree**（在仓库同级、绝不进仓库或 `.git/` 内）。归档线程时**只有**同时满足"干净、无未推送提交、不是当前会话目录"才会删除它，否则保留并报告。
- **会调用 `git`**（`node:child_process`）做 worktree 创建/删除与干净度检查。不走网络、不读凭据。
- **不碰会话日志。** 解绑或归档项目不会改动任何 `session.v*.jsonl.zstd`。
- 启动时对账：记录里有、磁盘上没有的 worktree 会从记录里清掉；磁盘上有、记录里没有的目录**保留**，只报告。
- **Routines 与 schedule 模式的提醒会花 token。** 每次投递都是一次模型调用；你没在界面里保存就不会建（每个创建按钮旁都写了成本）。`timer` 模式不调模型，但只在 DSH 开着时响（关机期间到点的会在下次启动补一次）。
- **远端写入是 opt-in 且默认关。** `git push`、`gh pr create`、`gh pr merge` 都已实现，但每个动作都要求**危险开关打开 + 人工批准**；不会自动推送或合并。
- **设计上不把凭据读进模型上下文。**
- 元数据读不出来（权限、版本更新）时，插件保持静默并记一条警告，不会让宿主启动失败。

## 远程访问

一切都跑在承载 DSH 的那台机器上。想从另一台设备连过来，见
[docs/deployment/projects-l1-remote.md](../../docs/deployment/projects-l1-remote.md)：
里面写了安全暴露 Web UI 的几种做法（回环 + 隧道、HTTPS、反向代理），以及 `projects` 在远程连接下的能力边界。

### 「多目录 Context」这一项的口径（F35）

本批**只做多目录**：每项目 ≤10 个 root，**全部生效**；每条线程记录自己跑在哪个 root（`thread.dir`，行内显示）。

Claude 的项目体量限制——**1000 文件 / 单项目 2 GB / 单文件 480 MB**——属于它的**上传能力**。DSH 目前没有上传通道，
这些数字随上传能力一起**后置**，本插件**不做也不宣称**；目录 root 是就地引用，不往 profile 里拷贝任何文件。

## 兼容性

表中 `0.10.x`–`0.14.x` 是**为即将到来的 Changesets 发布预写的说明**：数字在对应提交上为真，但版本尚未发布；
真正发版发生在本分支合并之后（Changesets 会改版本号并写 `CHANGELOG.md`）。


| 插件版本         | 已验证的 DSH 版本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未发布（本分支） | 0.2.2-rc.5：`pnpm verify` **686** 单测；`pnpm gate:projects` 全绿——runtime probe **72/72**、web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**、桌面只读回归 **20 PASS / 0 SKIP**。本分支落下 Claude Projects UI 对齐（M2–M6：右栏四视图 + 可见开关、贴底单 composer、状态副标题、协调者结论+产物、Routines 可编辑、Library 文件树+产物查看器、PR 卡与合并门禁、双主题打磨）与两轮独立 subagent 审查修复：**P0** UI 合并曾绕过自己承诺的 CI/批准数/改动量门禁（现由 `assessMergePr` 统一）、项目生命周期不再删在跑线程 worktree、回收站保留期清理真正能命中、`getProject` 回读生效；另有性能项（紧凑写盘 + 250ms 合并、`libraryView` 调用预算、按会话缓存 `state()`、后台标签页不轮询）。详见 `.changeset/projects-claude-ui-alignment.md`。                                           |
| 0.14.x           | 0.2.2-rc.5：`pnpm verify` EXIT=0（projects 单测 **595**，+23）；web 冒烟 **248 PASS / 0 SKIP / 0 FAIL**（238 → 248，连跑两次一致）。B6 收尾：**自动 resolve**（`autoResolveDays`，默认关；无活动 ≥ N 天的线程在启动时与每日一次被标为 resolved，写审计 `thread/auto-resolved`；配置下拉在项目详情右栏——宿主可能禁用设置页，另有 `checkAutoResolve` 可手动跑）、**启动 `replay()`**（每线程一段有上限的最小归约事实 journal，重启后重建 Overview 而不是从空闲开始）、**行摘要真实 diff**（`git diff --numstat` 对 worktree base，含未提交改动，git 答不了才 `n/a`）、**routing 单一契约**（审批写路径改校验匹配器同一份对象 `when`）。桌面只读回归本轮未复跑（本阶段不重启桌面版）。                                                                                         |
| 0.13.x           | 0.2.2-rc.5：`pnpm verify` EXIT=0（projects 单测 **572**，+17）；web 冒烟 **238 PASS / 0 SKIP / 0 FAIL**（220 → 238，连跑两次一致），截图仅本地留存（不入库）。B5 落地 **Library**（宿主 `workspaceFiles` 文件面 + `artifacts/2` 产物面 + 自存 `projectId ↔ artifactId` 映射 + 条数/字节计量 + provenance + 只搜文件名）、展开线程行内的**产物卡**（点开走宿主右栏 `artifact` 页签），以及**如实的降级**（「需要 dsh-artifacts 0.2」且只列文件面，绝不显示「没有产物」）。B3 复审修复同行：删 effort 白名单（`max`/`xhigh`/`off` 能存住）、补 44 个 locale 键并改真实时 CI 文案、冒烟加 INFRA 自检、once 凭据改到闸门之后消费并在拒绝时回滚、文件夹闸按实际 cwd 求 mode（worktree 继承项目目录授权）、记忆碎片列表先校验项目。桌面只读回归本轮未复跑（本阶段不重启桌面版）。 |
| 0.12.x           | 0.2.2-rc.5：`pnpm verify` 绿（projects **555** 条单测，+53）；web 冒烟 **220 PASS / 0 SKIP / 0 FAIL**（196 → 220，+24；连跑两次一致），截图已归档。B4 落结构性三项：**Routines**（六档频率映射宿主 `schedule`、Run now、History、创建处写成本提示）、**权限收窄**开关（选项来自 `catalog()`、默认「继承宿主」、逐会话 `current(session)` 回读、无匹配档时用 `approval/policy`+`sandbox/mode` 兜底）、**双模式提醒**（免费本机计时：落盘 + 开机重排、到点写回 `fired/firedAt` 并弹 `shell.overlay` toast；或计费的宿主 `schedule`）。桌面只读回归本阶段未复跑（不重启桌面版）。                                                                                                                                                                                              |
| 0.10.x           | 0.2.2-rc.5：`pnpm verify` 绿（projects **502** 条单测）；web 冒烟 **196 PASS / 0 SKIP / 0 FAIL**。桌面只读回归更新到 **17** 条以匹配新锚点，但本阶段**没有重启桌面版复跑**。B1–B3 一起进这一版：六态事件回写 + 药丸过滤 + 分组行 + 项目切换器（每项目 ≤10 目录、`~Nm`）、B2 把桩接通（协调者区与汇报、Tasks 清单、steering、每线程模型**与 effort**、Create PR 条 + CI 点徽章、可展开面板、禁止跨项目移动、PR/CI 轮询读 `policy.pr.tier`、实时监听改为 **disabled/未实现**、手动「修一轮 CI」入口）、B3 本地优势 UI（文件夹授权卡、记忆碎片、`@` 源、从会话开线程）。                                                                                                                                                                                                       |
| 0.9.x            | 0.2.2-rc.5：跑满 `pnpm gate:all`（web 冒烟 **78**/0/0、桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**，124s）。本阶段补完走查遗留、线程级操作与危险开关的 UI 可达性，并用**真实私有仓库 + 真实 Actions CI**验证了开 PR / CI 判定 / 真合并 / 人工批准门槛与 L2 路由（现场见 docs/testing/projects.md §17）。逐版本改动见 CHANGELOG。                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 0.4.2            | 0.2.2-rc.5：装进 live profile 并**重启桌面版后实测**——桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**、web 冒烟 **54**/0/0、`pnpm gate:all` 全绿（64s）。本版修「空项目无法建线程」，已用真实界面截图确认                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.3.0            | 0.2.2-rc.5：装进 live profile 并**重启桌面版后实测**——桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**、web 冒烟 **52**/0/0、`pnpm gate:all` 全绿（64s）。本次改动了 client 半（详情页新增执行按钮/仓库授权/回收站清理），已在真实界面确认面板渲染                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 0.2.1            | 0.2.2-rc.5：装进 live profile 并**重启桌面版后实测**——桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**、web 冒烟 50/0/0、`pnpm gate:all` 全绿。本版只含 README 兼容表更新                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 0.2.0            | 0.2.2-rc.5：新增三项危险动作。309 项单测 + `pnpm verify` + web 冒烟 50/0/0；三项动作在临时宿主上真机验证（本地 bare 远端 + 桩 `gh`，见 docs/testing/projects.md §10）。桌面回归由 0.2.1 复跑确认（client 半两版一致）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 0.1.1            | 0.2.2-rc.5：这一版不需要改代码。276 项单测 + `pnpm probe:runtime` 72/72 + web 冒烟 50/0/0 + 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0.1.x            | 0.2.2-rc.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

本插件依赖的私有 seam（`dsh-session`、`dsh-workspace`、`dsh-api-gateway`、`dsh-typert-protocol`、`dsh-agent` 等）在 rc.3 与 rc.5 之间**逐字节相同**（43 包逐包 diff 未发现变化，[runtime rc.5 §1.1](../../docs/runtime/0.2.2-rc.5.md)）。

## License

MIT
