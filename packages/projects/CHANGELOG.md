# @kangyishuai/dsh-projects

## 0.10.10

### Patch Changes

- [#348](https://github.com/kangyishuai/dsh-plugins/pull/348) [`efccaca`](https://github.com/kangyishuai/dsh-plugins/commit/efccaca07913e9942be88cf19ad215c6ed7b54e6) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个真机复验发现的 UX bug：在项目列表点行尾 `⋯ → 删除…` 时，点击会冒泡到整行，
  **删除确认框弹出的同时把项目详情页也打开了**（确认框挂在详情页之上，关闭后落在 BODY/详情页）。
  
  - 项目行 `onClick` 现在忽略来自行内 button/menu/menuitem/input 等控件的点击（与详情页线程行的守卫同口径）
  - 重新验证：打开行删除确认后仍在列表页；取消/Esc 关闭后焦点归还「更多操作」按钮
  - 附带把这条写进源码守卫，防止回归

## 0.10.9

### Patch Changes

- [#346](https://github.com/kangyishuai/dsh-plugins/pull/346) [`3d31c6c`](https://github.com/kangyishuai/dsh-plugins/commit/3d31c6c9f813465852c9cf93a7250eb6d283ebda) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 第 3 轮独立复审修复（功能/安全 P0 + UI P1）：
  
  - **P0 回收/归档 worktree 不再无视 ignored 文件**：`reclaimThreadWorktree` 改用 `status --porcelain --ignored`，`.env`/模型缓存存在即保留（`dirty`）。
  - **P0 回收站恢复不再丢 workspace**：删除时的 manifest 记录 `workspaceDir`，`restoreTrash` 把 `workspace/` 搬回 `dataRoot/workspaces/<id>`。
  - **P1 删除回滚不丢已搬内容**：`moveInto` 失败先把已移动目录搬回原位，再清回收站（不再整目录 `rmSync`）。
  - **P1 归档钩子的 busy 保护真正生效**：`threadBusy(thread, states, sessionId)` 显式接收 id（store 原始记录没有 `sessionId`）；且 busy 判定移到 `setThreadState(archived)` 之前。
  - **P1 `cleanupBranches` 的 worktree 删除要求 `confirm`**：未确认时返回 `confirm-required`、不动磁盘；真删写 `worktree/removed` 审计。
  - **P1 合并/推仓库解析补 `thread.dir`**：worktree 被回收后不再回落 `dirs[0]`（多目录项目不会合错仓库）；merge 的文件夹授权闸也按线程 worktree/dir 判（`deny` 不再被绕过）。
  - **P2 显示与 busy 口径统一**：宿主明确 `running=false` 且无 turn 事实时，记录里的 `working` 不再永久显示「在跑」。
  - **UI（同步修复）**：新建项目/编辑详情两个模态补**焦点陷阱 + 全局 Esc + 初始聚焦**；详情页头部 ⚙ 改为真正打开项目设置抽屉；tablist 补 `aria-label`；列表删除弹窗关闭后焦点归还行菜单；设置抽屉/删除确认的 a11y 断言随冒烟覆盖。
  
  验证：`pnpm verify` **719** 单测；web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**。

## 0.10.8

### Patch Changes

- [#341](https://github.com/kangyishuai/dsh-plugins/pull/341) [`94327d2`](https://github.com/kangyishuai/dsh-plugins/commit/94327d2b6f70cef5d021a6438468ea4715d9e1a7) Thanks [@kangyishuai](https://github.com/kangyishuai)! - UI 复审剩余小项：
  
  - 自动解决（N 天无活动）下拉补 `aria-label`（此前只有视觉标签）
  - 文案：`协调者未建`→`未创建协调者`、`盘上到期时间`→`已保存的到期时间`、视图空态说明改为「保存『筛选条件 + 名称』即可创建一个」
  
  验证：verify 710、web 冒烟 270 PASS/0/0。

## 0.10.7

### Patch Changes

- [#338](https://github.com/kangyishuai/dsh-plugins/pull/338) [`b9579fa`](https://github.com/kangyishuai/dsh-plugins/commit/b9579fa940852cd4d3f786be73ddda5f2559a0db) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 删除确认框默认焦点真正生效（0.10.6 只改了 `data-modal-autofocus` 属性，列表弹窗没有 focus 逻辑）：
  
  - 列表行 `⋯ → 删除` 弹窗打开后自动聚焦「确认删除」（真机实测 `activeElement` 从 BODY → 确认删除按钮）
  - 同一弹窗补 Esc 关闭（此前只有详情页弹窗支持）
  - 验证：verify 710、web 冒烟 270 PASS/0/0

## 0.10.6

### Patch Changes

- [#336](https://github.com/kangyishuai/dsh-plugins/pull/336) [`68ebbe7`](https://github.com/kangyishuai/dsh-plugins/commit/68ebbe731eaaf3c81954a987f28b9a666e8f5716) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 删除确认框默认焦点统一（按定案 A，遵守 `docs/plugin-conventions.md` §7.4.2）：
  
  - 列表行 `⋯ → 删除` 弹窗此前默认聚焦「取消」，与详情页删除弹窗（聚焦「确认删除」）不一致；
    现在两处都聚焦「确认删除」，打开后回车即执行，取消需 Tab/点击。
  - 补源码守卫测试，防止两处再次分叉。

## 0.10.5

### Patch Changes

- [#333](https://github.com/kangyishuai/dsh-plugins/pull/333) [`51898fc`](https://github.com/kangyishuai/dsh-plugins/commit/51898fc634f8b971e7a26c7de8b187f8d58f2c22) Thanks [@kangyishuai](https://github.com/kangyishuai)! - - 窄窗/单列（<940 面板宽）时主列也撑到视口高，composer 不再悬在页面中部（真机 1100 视口实测 composer 从 y≈360 落到 y≈689–768，贴底可见）
  - 页签文案本地化：zh 下 `Library`→`库`、`Routines`→`定时任务`（en 不变），消除中英混排

## 0.10.4

### Patch Changes

- [#331](https://github.com/kangyishuai/dsh-plugins/pull/331) [`6031d9a`](https://github.com/kangyishuai/dsh-plugins/commit/6031d9a645b1dee05208aa6c61bee276dc834683) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 设置与线程行的 P2 收尾：
  
  - 项目设置抽屉页签 **5 → 3**（通用 / 记忆 / 环境），用量与调试并入「环境」分区（plugin-conventions §7 页签 ≤3）
  - 线程行「展开」改成图标（`⌄`/`⌃`，aria-label 保留「展开/收起」）并提到 0.6 不透明度，400px 右栏不再挤成两行
  - 行尾 meta `flex: 0 0 auto`，不再被挤到第三行
  - 触达尺寸：设置图标 26×26、麦克风 24×24 盒子、composer 模型药丸 min-height 24
  
  验证：`pnpm verify` 706、web 冒烟 270 PASS/0/0、`pnpm gate projects` EXIT=0。

## 0.10.3

### Patch Changes

- [#329](https://github.com/kangyishuai/dsh-plugins/pull/329) [`de7719e`](https://github.com/kangyishuai/dsh-plugins/commit/de7719ee8045fa36aa21380c5ec4c06d8d0ebace) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 第二轮复审的 P2/UI 收尾（无行为破坏）：
  
  - 设置抽屉：`role=dialog` + `aria-modal`、Esc 关闭、关闭后焦点归还触发按钮；字段标签 `white-space: nowrap`（400px 下不再两行）
  - 回收站只在「通用」分区出现（以前详情页 Context 段在通用/环境/调试三处各渲染一份）
  - 项目行不再显示 `#id` 噪声，完整 id 挪到 `title`（重名仍可区分）
  - 空态删除重复的同名「新建项目」CTA（头部保留一个）
  - 迷你图：零值柱改用 accent 色 + 透明度（原 border 在深色下 ~1.5:1）、容器 `role=img` + 汇总 `aria-label`、空态不再重复 caption
  - 删除确认框：`aria-labelledby`/`aria-describedby` 指向标题与影响面；影响面 summary 过滤空段落（修 `· ·`）
  - 文案统一：状态词「进行中」→「在跑」、`自动 resolve`→`自动解决`、手填提示去掉英文 `effort`
  
  验证：`pnpm verify` **706**；web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**；`pnpm gate projects` EXIT=0（桌面 17 PASS）。

## 0.10.2

### Patch Changes

- [#327](https://github.com/kangyishuai/dsh-plugins/pull/327) [`b4d6e18`](https://github.com/kangyishuai/dsh-plugins/commit/b4d6e18f0af1a09ccf086e475d5d399bd16e4dcc) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 第二轮独立复审（功能/性能/安全 + UI/UX）修复：
  
  - **P0 归档不再删 worktree**：`archiveProject` 只做元数据操作；`cleanupBranches` 先判「已合并 + 无未推送」再谈 worktree，默认只报告不删（显式 `removeWorktrees` 且无任何含 ignored 文件才删）。归档钩子（`session-archived`）补 `threadBusy`，在跑会话不回收 cwd。
  - **P0 审批合并与 UI 同一仓库解析**：按线程 `worktree` 找仓库（多目录项目不再把 repoB 的 PR 合到 repoA 同号 PR）；审批路径改用 `assessMergePr`（CI/批准数/draft/改动量同一套判据），删掉不存在的 `policy.danger.merge` 读法；`delete-project` 审批补 `await`（失败不再报 executed）。
  - **P1 直推保护分支 refname 校验**：拒绝 `--force` / `src:dst` refspec / `..` / 非 heads ref；强推前置检查用实际 worktree 仓库。
  - **P1 `waiting-user` 不再粘住**：记录里的 `waiting-user` 只在「没有任何 turn 事实」时兜底；`isThreadBusy` 对无 turn 事实且宿主 `running=false` 的 `working` 记录不再判忙。
  - **P2**：`rollupState` 的 PENDING/EXPECTED 归 pending；已合并 PR 不再轮询；`threadStates` 与 `buildThreadRow` 同口径；回收站条目拒绝 `.`；`isSafeRecordKey` 拒绝 `.`/`..`；无目录项目模板不再写进程 CWD；`workspaces/<id>` 随删项目进回收站；`mergePr` 先判完门禁再 `pr ready`；`deleteTrashEntry`/`threadStates` 等小修。
  - **UI**：新项目对话框聚焦第一步 + Tab 环 clamp（Esc 可关闭）；补 `detail.groupCollapse/Expand` 两个 locale；危险文字用 `light-dark()` 成对颜色（浅 #b3261e / 深 #ff8c8c，两主题 ≥4.5:1）；`not-a-git-repository` 降级改中性提示并自动消失；「打开产物库」成功也给反馈（跨视图可见性说明）；空输入时发送按钮禁用；行尾时长与项目列表统一相对文案。
  
  验证：`pnpm verify` **706** 单测；web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**；`pnpm gate projects` EXIT=0（probe 72/72、桌面 17 PASS）。

## 0.10.1

### Patch Changes

- [#323](https://github.com/kangyishuai/dsh-plugins/pull/323) [`1dc25c1`](https://github.com/kangyishuai/dsh-plugins/commit/1dc25c12383719bcdf299dba327d7a314970c4e2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - `coordinator/defaults` 审计带 `source`（设置卡 / composer 药丸），并修正两处冒烟适配。
  
  - RPC `setCoordinatorDefaults` 增加可选第 5 参数 `source`，写进审计；两个 UI 写入口分别传
    `"settings"` / `"composer"`。旧调用不传仍工作（source 为空串）。
  - 冒烟 F42：模型目录里第一个模型可能没有 `reasoning.efforts`（本机 local provider），
    现在遍历选项优先选带 effort 的模型、把最终选择按回 DOM，并按 `source` 定位设置卡那次保存；
    UI 未实际选中 effort 时不再硬断言落盘值（`effortChecked` 写进断言 detail）。
    web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**。

## 0.10.0

### Minor Changes

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - feat(projects): B4 结构性三项 —— Routines / 权限**收窄**开关 / 双模式提醒
  
  - **F36 Routines（定时任务）**：六档频率（手动 / 每小时 / 每天 / 工作日 / 每周 / 每月）映射成宿主 `schedule` 的 timing —— 每小时与三档 cron 用 `cron`，每天用宿主 `daily`，时间统一补成宿主硬要求的 `HH:mm:ss`（`09:30` 会被 `ScheduleInputError` 拒，已按实测口径写死在校验里）。能力包含创建、列表、启停（宿主 `paused/active` + 本地 `enabled` 双写）、删除（先删宿主条目再删本地，宿主删失败就不动本地，避免留下会继续花钱的孤儿）、**Run now**（走 `schedule.run`；手动档则投递到协调器会话）与 **History**（宿主 `history()` 的投递记录 + 本地 Run now 记录按时间倒序合并）。数据落项目 store 的 `routines[]`（`id/name/instructions/frequency/cron/enabled/spaceId/scheduleId/lastRunAt/history`）。UI 在详情页新增「Routines」视图与右栏「定时任务」段，并强制写明成本：**每次投递 = 一次模型调用**、新建会话两次投递至少间隔 60 秒、手动档不自动跑。
  - **F52 权限收窄开关**：方向按实测反转——本部署 `catalog().defaultPreset` 已是 `danger-full-access` + `approval: never`，所以项目开关是**收窄**而不是「打开自动」。下拉选项**全部来自 `catalog()`**（不写死 preset 名），逐项 `resolve()` 后把 `{sandbox, approval}` 翻译成人话（只读 / 工作区可写 / 全权限 / 自定义）并标出「比宿主默认更窄」。默认档是「继承宿主」（空串 = 不干预）。保存到项目 store 的 `preset`（存名字不存 spec），在**新建线程 / 协调器会话创建后**用 `permissionPresets.set(session, name)` 应用；拿不到会话句柄时如实标 `pending`（不假装生效），没有匹配档时用 `session.append('approval/policy'|'sandbox/mode')` 兜底并在 UI 标「自定义」。每次应用都做**写→回读**（`current(session)`，兜底路径读 `approval/sandbox` 的 `overrideOf`），回读结果进审计与 `data-projects-preset-readback`。UI 明示「推 / 合并 / 删除永远需要你批准（插件执行器），本开关只影响工具调用是否逐次询问、命令能否写到项目目录之外」。
  - **F30 双模式提醒**：`timer`（默认，免费）用本机计时器 + 持久化到期时间，**重启后由 `armReminders()` 按盘上记录重建**，关机期间到点的在启动时补触发（写回 `state=fired/firedAt/unread`，重启后不会重复响）；到点走 `shell.overlay` toast（宿主没有 unread 原语，未读由插件自存）。`schedule`（计费）转宿主 `schedule`，UI 明示「到点会跑一次模型、DSH 关着也会跑」。项目设置 `reminderDefault` 决定默认模式（默认 `timer`），**每条提醒可选择另一种并记住本次选择**。支持取消（schedule 模式同时删宿主条目）、提前完成、过期清理（终态超 7 天清掉，pending 永不动）。
  - **验证**：`pnpm verify` EXIT=0（projects 单测 **555**）；`pnpm smoke:projects` **220 PASS / 0 SKIP / 0 FAIL**（新增 24 条，含 routines 落盘回读、`current(session)` 回读、timer 真到点 + toast + fired 落盘、取消落盘、预设落盘）。宿主限制如实写进 README/UI：`schedule` 每次投递都花 token、timer 模式 DSH 不开不响、`approval` 没有「记住这次授权」。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - feat(projects): B5 · Library / Artifacts（F33 / F34 / U15）+ B3 复审修复
  
  - **F33 Library 视图**：项目页「Library」页签合并两块数据。**文件面**走宿主 `workspaceFiles`（scope `{sessionId, workspaceRoot}`，多目录逐个 list；明写「搜索只匹配文件名/路径，不搜正文」——这是宿主的边界）；**产物面**走 `artifacts` 0.2 契约（`ctx.get("artifacts")` + `version().contract === "artifacts/2"` 再 `list({projectId})`），并**自存 `projectId↔artifactId` 映射**（项目记录里的 `artifactRefs[]`：id/标题/类型/版本/字节/时间/来源；发布时在项目线程里 `recordArtifact` 落盘，冷启动可回读）。计量给 count/bytes，provenance 给「来自会话哪次工具调用」。
  - **降级是明示的**：artifacts 未安装、`version()` 不可用或契约不是 `artifacts/2` 时，Library 写「产物库需要 dsh-artifacts 0.2」并只列文件面；**不会**显示「这个项目没有产物」。
  - **F34 产物卡 / U15 视觉**：线程展开面板内嵌产物缩略卡（标题 + 类型 + 版本 + 时间 + provenance），Library 列表同样是「小标题 + 计量 + 缩略卡」的 Claude `Artifacts ⌄` 形态；「打开产物库」按钮走宿主右栏 `sidebarRight.openTab("artifact", { params: { projectId } })`，服务缺失时按钮禁用并说明原因。
  - **B3 复审 P0（`store.js` effort 白名单）**：`THREAD_EFFORTS = ["","low","medium","high"]` 会把本部署的 `max` / `xhigh` / `off` 静默清空、UI 还提示「已保存」。删掉白名单改为**非空即收**（只做 40 字符上限），`setThreadDefaults` 写→冷启动回读单测覆盖三档；冒烟用手填路径逐档写入并断言回读与审计。
  - **B3 复审 P1（locale 落后 44 键）**：`locale/{zh,en}.json` 补齐 runtime 字典缺失的 44 个键，`settings.realtimeCiHint/On/Off` 改成与 B2 一致的「未实现、不会建 webhook」；新增 `test/locale-parity.test.js` 锁 runtime↔locale 的键集与文案值，冒烟再验一次线上口径。
  - **B3 复审 P1（冒烟 flake）**：开局加**基础设施自检**——宿主端口不可连、插件未激活、`projects.json` 未落盘、浏览器脚本没有返回结果，一律打印 `INFRA` 并 fail-fast，不再把环境问题混进断言计数；把最有劣化风险的几处固定 `waitForTimeout`（toast 自动消失、会话行、归属菜单、详情打开、折叠状态回读）改成轮询等待。
  - **B3 复审 P2**：`once` 凭据改为**所有闸通过且占位成功之后**才消费，执行没落地时由 `settle` 回滚（`folder/once-rolled-back` 审计），动作被拒不再烧掉授权；文件夹闸按**实际 cwd 所属目录**求 mode（`push-branch` 的 worktree 继承其项目目录授权，反查不到才退回 `dirs[0]` 并标 `inherited:false`），授权卡补 cwd 语义说明；`listMemoryFragments` 先校验项目存在再拼路径（`../` 不能再枚举 dataRoot 外目录名）。
  - **验证**：`pnpm verify` EXIT=0（projects 单测 **572**，新增 17 条：locale parity 5 / Library 6 / once+cwd 4 / effort 1 / memory guard 1）；`pnpm smoke:projects` **238 PASS / 0 SKIP / 0 FAIL**（新增 ≥10 条断言，含 A 段每条修复与 B 段文件面/产物面写→回读、降级）。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Claude Projects 复刻对齐（M2–M6）+ 三轮质量审查后的修复：布局、状态呈现、协作流程与性能。
  
  - **布局与视觉（对齐 Claude 项目主页）**：右栏四视图（线程 / Library / Routines / 视图），
    Views 改为**可见性开关**（写 `visibleViews` + 审计，刷新后保持）；主列单 composer
    （新线程 / 协调者目标切换、圆形 ↵ 发送、控件行移出卡片）、composer 贴底；详情页去掉页面级
    双标题；Welcome/药丸计数只在线程页签；分组头去噪（拖拽把手/轮播 hover 才出现）；
    行内 PR 徽章改为绿色 `⎇ #N`；展开面板占满整行、右侧元信息悬浮右上角。
    深浅双主题分层（浅色右栏变淡灰卡）、浅色对比度补强（除禁用「+」外均 ≥4.5:1）。
  - **状态呈现**：行副标题按状态派生（working 动词+秒数、`✓✓✓ 使用 X`、失败/等你/结果摘要），
    idle 结果摘要只写真实观测值（不再出现 `0 步 · diff n/a` 调试串）；步进圆环/任务弹层/
    时长（now/Nm/Nh/Nd）/产物 chips（含封面）与 diff chip。
  - **协调者**：结论上浮 + 消息折叠块 + 结论旁产物 chips；协调者默认模型独立于线程默认
    （设置页写→回读）；主列顶部排障信息折成一行摘要（详情可展开）。
  - **Routines**：详情三段（触发/指令/运行于）+ **可编辑**（频率↔手动会真正建/删宿主定时，
    不再漂移）；整页 43 处硬编码中文抽成 i18n。
  - **Library / 产物**：文件树表格（名称/类型/大小/更新时间）+ 交互式产物查看器
    （markdown 标题/列表/表格/勾选清单，HTML 不渲染）。
  - **PR 流程**：三段式卡（状态 · 标题 · CI）、复制链接、**合并**（三重门禁：有 PR 号、
    二次确认、危险开关；草稿自动 `pr ready`）；PR 命令统一在线程 worktree 里执行
    （多目录项目不再查/合并错仓库）；分支名带项目短 id 避免撞远端；客户端 PR 概览 30s TTL。
  - **设置**：通知四档（真实映射三布尔）、Memory 两层（指令计数/索引更新于/文件列表）、
    Environment 三段摘要、失败自动重试（**诚实语义**：失败后 60s 重发「继续」，累计最多 2 次，
    不冒充"用量恢复续跑"）、短路键 P/L/R/V。
  - **可访问性与健壮性**：线程行 `tabindex/role/aria-expanded` + Enter/Space 展开；行内菜单
    分隔线 + ↑↓ 导航；错误条可重试；面板/详情加载态；行内操作常显（0.35）而非 hover-only。
  - **性能**：写盘改紧凑 JSON（体积 −30%）+ 250ms 合并写；`liveSessionFacts` 只问本项目线程并
    按会话缓存；后台标签页不轮询（详情页一轮 11 RPC）；diff 目标限 24 条 + 并发 4；缓存有界。
  - **验证**：`pnpm gate:projects` 全绿 —— `pnpm verify` EXIT=0（projects 单测 **688**）、
    runtime probe **72/72**、web 端到端冒烟 **270 PASS / 0 SKIP**、桌面只读回归 **20 PASS**（空 profile 17）；
    WebUI 与桌面在 1440×900 下布局几何一致（≤1px）。两轮独立 subagent 审查（功能/性能/安全 + UI/UX）
    的发现已修：UI 合并补回 CI/批准数/改动量门禁、项目生命周期不再误伤在跑线程、回收站保留期清理真的能清、
    `getProject` 回读、Library 调用预算、写盘失败可见等。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 项目面板界面改版（对齐 Claude Projects 本地 space 的布局）：列表页加搜索/排序/收藏，新建项目改为「从零开始 / 使用已有文件夹」两入口模态 + toast；详情页改为「主列 + 右栏」项目主页布局（右栏为只读值行 + 编辑动作，窄窗口折叠为摘要行），配置块不再压在线程列表之前；破坏性确认框默认聚焦主按钮。web 端到端冒烟 78 → 102 条。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 本地优势 + 设置 + 记忆（B3）。数据面：记忆碎片（`MEMORY.md` 索引 + 独立 `.md`，可预览、可逐条 forget）、instructions 16k 预算与宿主 `dsh-agent-instructions` 去重、`<project-context>` 包裹 + 「这是项目记忆，不是 AGENTS.md」、goal ≤8,000 + 计数、预算默认值（日线程 20 / 并发 2 / 步数 60 / token 不限）、**暂停语义修正**（暂停不再中断上下文注入）、设置四分区（General/Memory/Usage/Debug access，Usage 只报 token 不报金额）、按项目通知开关、`gh` 只读连接检查、模板受管 AGENTS.md 区块、线程重命名、`@` 候选与 `setThreadDefaults` RPC。
  
  UI 面：详情右栏「上下文」新增本地优势卡（@ 候选预览、碎片计数）（**本地文件夹授权卡三键 Deny / Set as default folder / Allow once（一次性凭据用掉即失效）**、线程默认模型 / effort 下拉（`modelCatalog`，默认值落项目 store 并在建线程时套用）、从会话开线程（`recentSessions` + 挂为线程）、`@` 源状态）；记忆页签新增碎片列表（新增 / 预览 / 逐条忘掉）与 `MEMORY.md` 索引条目逐条忘掉；既有线程 ⋯ 菜单补上「重命名」（内联输入，写 `renameThread`）与「复制 ID」，并注册 `contextMenus` 自定义 target 族 `projects.thread`；`@` 源通过 client `inputTriggers.registerSource` 注册（插入 `@thread:<id>` / `@project:<id>`）；客户端的完成通知（`completed`）接到 `shell.overlay` toast 并按项目开关过滤。验证：projects 单测 472（新增断言并入既有用例），web 冒烟 172 → 180。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 项目主页对齐 Claude Projects 的 Overview（B1）：六态状态机（等你 / 失败 / 在跑 / 待审 / 空闲 / 归档，事件回写持久 `state`）、分组折叠 + 五类药丸条过滤（`~Nm` 只在能从已观测步进节奏估计时显示）、行解剖（副标题取最近 `tool/call` 的可读摘要，步进环取 `todo/write` 快照，没有 todo 显示「—」而不是 0/0）、`Welcome back` 头 + 7 日 token 迷你图、手动 resolve/重开与未读标记、项目切换器、一次性首启引导（`firstRunDone` 存宿主 `storageDomain`）、Context 多选（目录 ≤10 + 仓库 owner/repo）与多目录线程。web 端到端冒烟 102 → 133 条；桌面只读回归随新锚点更新（本阶段未重启桌面版复跑）。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - feat(projects): 页签收敛到 3 个（Library 走右栏入口、审计进设置 Debug），桌面回归可用 `--create` 覆盖详情页
  
  - **页签 5 → 3（`docs/plugin-conventions.md` §7.3「页签最多 3 个」）**：项目主页只剩 `线程 / 记忆 / Routines`。
    `data-projects-tab` 的取值集合同步收缩为 `threads|memory|routines`；`audit`、`library` 不再是页签。
  - **Library 外迁为右栏一行入口**：右侧栏「记忆」下方新增 `data-projects-rail-library` 段，动作按钮
    `data-projects-library-open`（`aria-pressed` 跟随状态）点开后**在主列**渲染现有的 `LibraryView`
    （`data-projects-library-main` 包裹，原有 `data-projects-library*` 锚点全部保留），主列顶部
    `data-projects-library-back`（‹ 返回线程列表）或再次点同一右栏行动作都能收起；右栏段给一行摘要
    `data-projects-library-rail-summary`（文件数 · 产物数）。数据面没有变化：仍然是宿主 `workspaceFiles`
    文件面 + `artifacts/2` 产物面 + 自存的 `projectId ↔ artifactId` 映射。
  - **审计外迁到设置分节 Debug 区**：项目详情不再请求/渲染审计（少一轮 5s 轮询），设置
    Debug 分区新增 `data-projects-settings-audit`（标题 `data-projects-audit-title`，列表保留
    `data-projects-audit` / 空态 `data-projects-audit-empty` 锚点，新的在前，最多 100 条 = `listAudit` 的截断）。
  - **桌面只读回归新增 `--create`（默认关，默认仍严格只读）**：开启时用 UI 从零建一个
    `smoke-desktop-<ts>` 临时项目 → 断言详情页两列（`data-projects-detail-grid/main/rail`）、6 个药丸、
    3 个页签、Library 右栏入口、审计不在详情页 → 再用同一套 UI「详情 ⋯ → 删除 → 确认 → 回收站 → 彻底删除」，
    最后断言盘上 `projects.json` 里没有它。默认模式（不带 `--create`）在有项目的 profile 上真断言详情页，
    没有项目时如实 SKIP 并写明原因（不再只能吃「live profile 没有项目」这条跳过）。
  - 设置分节那条从「渲染了就算 PASS」改成真断言：四个分区（general/memory/usage/debug）+ Debug 面板 +
    审计锚点；设置页打不开仍如实 SKIP 并进计数行。
  - **中英 runtime 字典 + `locale/{zh,en}.json` 三处同步**（新增 `library.railOpen/railBack/railHint/
    railSummary/railLoading`、`settings.auditTitle`；删掉不再使用的 `detail.tab.audit`），
    `test/locale-parity.test.js` 保持绿（键集与文案值逐条相等）。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把桩接通（B2）：协调者区（项目页里一个长期会话，可建会话 / 发一句话 / 重开会话，**不是**宿主 composer）、协调者汇报渲染（结论上浮 + thread chip）、上下文策略（`compaction` 一律 `ctx.get()` 判空兜底 + wake 信封新增「最近线程」「记忆索引」两段）、线程 Tasks 清单（`todo/write` 整表快照 → ✓/◌ + n/m）、线程内 steering（`prompt({mode:'steer'})`）、每线程模型 / effort（`session/selectModel`，下拉取 `modelCatalog`，改后读 `modelSelection`）、Create PR 条与分支条、PR 徽章 + CI 状态点、展开面板里的 thread 起始卡与行内 chip、禁止跨项目移动（`store.attachThread` 对「已在 A 项目」的会话直接拒绝，只允许 attach 空槽 / 先 detach，含单测）、PR/CI 默认轮询（只对有开放 PR 的项目，30–90s 退避，应用关闭即停）与设置里的「实验性实时监听」开关（**disabled 且标注未实现**：真做需要 gh-webhook 扩展、仓库管理员权限与验签），以及设置页的 Restart 行。web 端到端冒烟 133 → 157 条；单测 428 → 453 条。另修 B1 审查的 3 个 P0 / 5 个 P1：宿主侧持久化断言改成具体值（不再有恒真式）、六态词表两端统一（`waiting-user` 不再被丢弃、冷启动 `failed`/`working` 读得回来）、`dirs` 在 load 时不再静默截断（超限只由写入口拒绝）、`~Nm` 的 `firstActivityAt` 用最早时间（估得出非 null）、桌面回归首启步骤改只读、`thread.dir` 在行内显示短名；F35 口径写明「本批只做多目录」。
  
  F35 口径：本批**只做多目录**（每项目 ≤10 个 root，全部生效；每条线程记录自己跑在哪个 root，行内显示 `thread.dir` 短名）。Claude 的 1000 文件 / 单项目 2 GB / 单文件 480 MB 属于它的上传能力，DSH 没有上传通道，随上传能力一起**后置**，本批不做也不宣称。

### Patch Changes

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - B2 复审修复：把「批准 / 派活」的入口真正接上，并清掉三处不可证伪的宣称。
  
  - **P0 协调器工具从未注册**：`attachCoordinatorTools` 全仓零调用者，`project_thread_start` / `project_request_action` / `project_memory_*` 运行时不存在（F18「审批产生入口」与 F9「它派活」都是死代码）。现在注册逻辑抽到 `coordinator-tools.js`，在 `onAgentCreated` 与 `warmUpCoordinator` 两条路径幂等挂载，`agent/disposed` 时摘掉；单测断言 6 个工具注册 + 失败写审计不抛，冒烟断言审计里有 `coordinator/tools` 且 `count=6`。
  - **F21 口径**：`autoFixStep` 补上手动入口「修一轮 CI」（只在 CI 失败时可点，结果回显，服务端写审计）；实验性实时监听开关改为 **disabled + 明确「未实现」**（需要 gh-webhook 扩展与仓库管理员），README / changeset 里「会建临时 webhook」的宣称删掉。
  - **F24 effort**：模型下拉旁新增 effort 下拉（数据来自 `modelCatalog().groups[].models[].reasoning.efforts`），`selectThreadModel` 传 `reasoningEffort` 并回读 `modelSelection`（以前只传 provider/model）。
  - **F20 断言可证伪**：冒烟真的点 Create PR，断言行内动作条出现且原因是决策层真实原因（`no-commits` 等）；删掉 `openPr` 调用只会得到 `unknown`，这条会红。
  - **F17 订阅单测**：`todo/write` → `reduce` 后 `todoItems` 非空（行 `tasks` 的来源），并用源码守卫钉住 `session/event` 订阅与事件回写。
  - **写路径单测**：`sendToCoordinator` / `steerThread` / `selectThreadModel` / `createPr` 抽到 `write-paths.js`，用假 `sessionController` 断言 `mode:'queue'|'steer'`、`content:[{type:'text'}]`、`reasoningEffort`、signal 必传与错误信封。
  - **P2**：删掉零调用者的 `threadTasks` RPC；跨项目移动冲突错误本地化；协调者 user 气泡按「同角色同文本 + 5s 窗口」去重；`defaultPolicy`/`normalizePolicy` 补 `pr.tier`（按项目 opt-out）；`setThreadState('resolved')` 维护 `resolvedAt`；`mergeRecord` 映射 `waiting-user`（盘上读回不再变 idle）；`createProject` 超限目录改为显式拒绝（不再静默截断）；`runCommand` 加 30s 超时（gh 卡住不再把轮询 inFlight 永久占住）；README 两条矛盾的 0.10.x 行合并。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - B3 独立审查修复（5 P0 / 10 P1）：`@` 源改用 `ctx.inject(["inputTriggers"])` 真正注册（`registered` 只在 `registerSource()` 成功后置位），冒烟断言该状态；临时 profile 里打开 `ui-settings`（只改临时 home 的 `cordis.patch.yml`），设置页 14 条断言从「跳过计 PASS」变成真跑，跑不了时如实 SKIP；线程默认模型的模型/effort 下拉从 `modelCatalog` 动态生成并可写，保存后按具体值回读；`threadDefaults` 冒烟断言改为逐字段比对 `projects.json`；删除 F3 恒真测试、`recentUi` 兜底改为「候选行数 > 0 且 attach 的 sessionId 落进 threads」；注入时真实读取宿主会加载的 `AGENTS.md`/`CLAUDE.md` 并去重（可注入读取器，测试用临时目录）；文件夹授权三键接进审批执行闸（deny 拒绝、once 消费、default 长期、unset 保持旧行为）；`applyProjectTemplate` 改传 `{ projectId }` 并补 AGENTS.md 可回读/幂等断言；线程行右键/Shift+F10 走宿主 `contextMenus`（保留自绘 ⋯ 菜单作降级）；`forgetMemory` 加路径守卫并抽到可注入根目录的 `memory-store.js`（`../`、`..%2F`、绝对路径、未知 kind 全部拒绝）；补齐 106 个 B3 EN 文案（runtime 字典 + `locale/en.json`）；冒烟把记忆/归档/删除/搜索四处固定等待改成轮询，桌面回归不再把「设置页没开」计 PASS。

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - B6 收尾：F29 自动 resolve + 三个「接线断了」的 P0（replay / threadStats / routing 契约）。
  
  - **F29 自动 resolve（`autoResolveDays`）**：项目字段不再只是占位。启动时与之后每 24 小时各检查一次：项目里**无活动 ≥ N 天**的线程自动标记 resolved（`resolvedAt` 落盘），写审计 `thread/auto-resolved`（带 `days` / `idleDays`），并同步内存视图（不会下一次轮询又弹回失败）。`null` = 关闭（默认），非法值一律当关闭；刚好 N 天即算命中，差 1ms 不算；已 resolved / 归档 / 没有时间事实的线程一律不动。新增 RPC `setAutoResolveDays`（写→回读 + 审计 `project/auto-resolve`）与 `checkAutoResolve`（手动跑一趟，返回 `checked` / `resolved`）。UI 在项目详情右栏「上下文」段给出下拉（关 / 3 / 7 / 14 / 30 天）——宿主可能禁用设置页，所以这里必须能真写。
  - **P0-2 启动 `replay()`**：以前 `overview.replay()` 全仓零调用者，重启后 Overview 视图归零。现在 `session/event` 把 `reduce()` 认的最小事实（轮起止、错误 attempt、副标题摘要、todo 快照、交互开关；正文/参数不进盘）追加到线程记录的 `events`（每线程上限 80 条），service 构造时 `hydrateViews()` 用 `hydrateThreadView()` 重建视图；人工 resolve 的时间戳晚于最后一次活动才生效（之后又有新活动则旧 resolve 过期，不会「点完已解决又自己弹回失败」）。旧数据没有 `events` 字段仍可读。
  - **P0-3 `threadStats` 接进行摘要**：`progress()` 现在为每个有 worktree 的线程算真实 `git diff --numstat <baseSha>`（**故意不带 `..HEAD`**，未提交改动也算；5s 缓存，失败如实 `null`），`buildThreadRow` 把它传给 `summarizeForRow`，行摘要显示 `diff N 文件 +N/-M` 而不是恒 `diff n/a`；行上另有 `data-projects-thread-diff="files:added:removed"` 精确锚点。`threadStats` 与 `progress` 共用同一路径，详情页和行摘要不会给出两个口径。
  - **P0-4 routing 契约统一**：`settings.js` 曾要求规则的 `when` 是**字符串**，而 `routing.js` 的匹配器只认**对象**（`{textMatches,textMaxChars,isQuestion,threadState}`）——真实规则（含内置 `defaultRules()`）永远进不了「改配置」审批写路径。现在 `sanitizeSettingsPatch` 用同一份白名单校验并收敛 `when`（未知键/类型错误给出可读 reason，字符串形态明确拒绝），`titleTemplate` 也会保留；单测断言写入后能被 `matchRules()` / `decideRoute()` 真命中，内置默认规则也满足自己这份契约。
  - **验证**：`pnpm verify` EXIT=0（projects 单测 **595**，+23）；`pnpm smoke:projects` **248 PASS / 0 SKIP / 0 FAIL**（238 → 248，连跑两次一致；新增 10 条：自动 resolve 的右栏配置回读 / 落盘 / 审计 / 不误伤 + `checkAutoResolve` RPC、事件 journal 与启动 replay 重建、行摘要真实 diff 的 `n/a → +N/-M`）。单测新覆盖 `test/autoresolve.test.js`（边界：刚好 N 天 / 差 1ms / 超过 / 关闭 / 已 resolved / 无时间事实 / 真实 store 冷启动 + 幂等）与 `test/replay.test.js`（压缩只留最小事实、新 store → replay 非 idle、resolve 覆盖与过期、journal 上限、旧数据兼容、service 接线源码守卫）。

## 0.9.1

### Patch Changes

- [#314](https://github.com/kangyishuai/dsh-plugins/pull/314) [`d839b2b`](https://github.com/kangyishuai/dsh-plugins/commit/d839b2bb4b367e314700ae5dd98716f3a0038895) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 真实 GitHub 仓库端到端验证（含真 CI、真 PR、真合并）抓到并修掉两个只有真机才暴露的缺陷。
  
  - **`gh` 调用没有工作目录** → **自动开 PR 在真实仓库上从来没成功过**。
    `gh pr create` / `gh pr merge` 会在 cwd 里解析 git 上下文，而从宿主进程 cwd（不是仓库）调用会直接报
    `fatal: not a git repository`。桩 gh 不关心 cwd，所以单测与 web 冒烟一直是绿的。
    现在 `runGh(args, cwd)` 支持 cwd，`openPr` 用 worktree（没有则项目目录）、合并链路用项目目录。
  - **合并方式字段读错**：REST `GET /repos/{owner}/{repo}` 返回 `allow_squash_merge` 等三个布尔，
    **没有** `allowed_merge_methods`。代码一直读后者 → 永远得到空数组 → 真实仓库上合并永远被拒
    （`merge/method-unknown`）。新增纯函数 `allowedMergeMethodsFromRepo`（两种形态都认）并加 4 项单测。
  
  **真机验证结果**（私有测试仓库 + 真实 Actions CI）：
  
  | 场景 | 结果 |
  | --- | --- |
  | 开 PR（真 GitHub） | `opened:true`，PR [#3](https://github.com/kangyishuai/dsh-plugins/issues/3) 创建成功 |
  | CI 绿检测 | `statusCheckRollup` 读到 `SUCCESS` |
  | `minApprovals=0` + CI 绿 | `executed:true`（真合并发生在真实仓库上） |
  | `minApprovals=1`（无人 review） | `merge/not-approved`（真人批准门槛生效） |
  | L2 自治 + 规则命中 `new-thread` | `executed:true`，真的新建了线程 |
  
  单测 392 → **397**。

## 0.9.0

### Minor Changes

- [#310](https://github.com/kangyishuai/dsh-plugins/pull/310) [`7cd748e`](https://github.com/kangyishuai/dsh-plugins/commit/7cd748e7c6a8241b5db4142d049da62339c8d21e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 线程行终于有操作入口了（第二轮走查记录的最后一条缺口）。
  
  之前：线程只是一个只读的行——看不到 worktree 在哪，也不能单独清理；开发者想收拾一个线程，
  只能把整个项目删掉。
  
  现在每个线程行带：
  - **目录路径**（超长省略号，hover 看全路径）
  - **回收目录** → `reclaimThread`：按三重判据回收 worktree（干净、无未推送、非当前会话），
    分支保留；被拒时把原因显示出来（如"未回收：unpushed-commits"）
  - **移除** → `detachThread`：两步确认，移除追踪关系；同时写审计 `thread/detached`
  
  `detachThread` 之前不写审计，这次补上——移除追踪也是可审计的变更。
  
  冒烟 76 → **78** 项（线程行入口、移除两步确认）。

## 0.8.2

### Patch Changes

- [#308](https://github.com/kangyishuai/dsh-plugins/pull/308) [`6fc07b5`](https://github.com/kangyishuai/dsh-plugins/commit/6fc07b5e8ac25e873a2470e1d0555e38a825bced) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 第二轮三用户走查（v0.8.1 实测）发现并修掉的四处：
  
  - **危险开关勾选后界面弹回**：复选框状态来自父级项目列表数据，勾选后只 `load()` 了详情、
    没刷新父级，于是界面显示"没勾上"（服务端其实已保存）——用户会以为没生效而反复点。
    现在写完策略同时刷新父级列表。
  - **危险开关变更不写审计**：产品主张"可审计"，但这几个开关是最关键的控制点，之前改了不留痕。
    `updateProject` 现在对比前后策略，变更时写 `project/policy-changed`（哪些开关切成什么、自治等级、路由）。
  - **文案里还有 Markdown 星号**：`回收站清理` 的中英文文案各留了一处 `**…**`，界面不渲染 Markdown，
    用户看到字面星号。已清掉，并把 `**` 加进冒烟的黑名单。
  - **未绑目录时没说清线程跑在哪**：线程实际跑在插件数据目录（不隔离），界面只写"共享目录（未隔离）"。
    现在详情页明确提示"还没有绑定项目目录：线程会跑在插件的数据目录里…"；线程行标记改为中性的"未隔离"。
  
  冒烟 73 → **76** 项：开关即时反映、开关写审计、未绑目录提示（另把 `**` 并入黑名单断言）。

## 0.8.1

### Patch Changes

- [#306](https://github.com/kangyishuai/dsh-plugins/pull/306) [`351a608`](https://github.com/kangyishuai/dsh-plugins/commit/351a6083b8020534096a1c612b8ae34ddac81e5d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把六个危险开关的说明改成人话。
  
  原来的文案内容准确但**偏工程向**——`--force-with-lease`、`SHA`、`per-repo`、`protection/rulesets`、
  `manifest`、`dry-run`、`diff 阈值` 这些词会直接把普通用户挡住。走查逐条确认后重写：
  
  | 开关 | 现在的一句话 |
  | --- | --- |
  | 覆盖插件自己创建的远端分支 | 只覆盖插件自己建的分支；覆盖前核对远端版本，被别人改过就停下并记下旧版本号，方便恢复 |
  | 直接推送主干或受保护分支 | 只对你在「仓库授权」里显式加过的仓库生效；要求走 PR 的仓库直接拒绝；每次记录，多人协作会额外提醒 |
  | 自动合并 PR | 合并之后只能用 revert 回退；仍要求改动量在阈值内、CI 通过、人工批准达标 |
  | 自动归档或删除到回收站 | 内容先移进回收站，之后还能恢复，但要花点时间找回 |
  | 清理过期的回收站条目 | 只清理已进回收站且超过保留期的条目；先列清单，默认只看不删，真删再确认一次 |
  | 修改项目策略本身 | 协调器可能借此放宽对自己的限制——风险最高，建议保持关闭 |
  
  冒烟 72 → **73** 项：新增「危险开关文案不含工程术语」——直接断言文案里不出现
  `--force-with-lease` / `SHA` / `per-repo` / `rulesets` / `manifest` / `dry-run`，防止以后再写回术语。

## 0.8.0

### Minor Changes

- [#304](https://github.com/kangyishuai/dsh-plugins/pull/304) [`f3f3c86`](https://github.com/kangyishuai/dsh-plugins/commit/f3f3c86f1329bfeec32766ad5872a7792a3b1499) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 六个危险开关现在**在项目详情里就能看到**，不再只依赖宿主设置页。
  
  **为什么**：验收时把 profile 的 `ui-settings` 打开后，插件设置分节在未登录 profile 里并没有出现——
  「插件」页只列出「已安装插件 → @kangyishuai/dsh-projects → 开始使用」。也就是说：
  **如果设置分节没渲染，六个开关（以及人格/路由/预算）在界面上完全不可达，只能手改 JSON。**
  而这些本来就是 per-project 策略，放进项目自己的「高级设置」更合理。
  
  - 项目详情 → 高级设置 → 「危险动作开关（默认全关）」，六个复选框各带风险说明
  - 仍是默认全关；勾选即时写入项目策略（与设置页同一套 i18n 文案）
  
  冒烟 71 → **72** 项（新增：项目详情可见六个危险开关）。

## 0.7.3

### Patch Changes

- [#302](https://github.com/kangyishuai/dsh-plugins/pull/302) [`f6623c5`](https://github.com/kangyishuai/dsh-plugins/commit/f6623c565d5aa170b8fffe769206408ef913e597) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 `reclaimThread` 对**已合并线程**的保守判据：squash 合并 + 删分支之后，worktree 会一直回收不掉。
  
  **根因**：回收要确认"提交都推上去了"。但 squash 合并会生成一个新的提交，原分支的提交
  **不再是主干的祖先**，而分支一旦被删（B5 的常规操作），这些提交也不在任何 remote ref 上——
  两个判据同时失效，于是永远拒绝。
  
  **修法**：让"已合并"成为一个可记录的事实，而不是靠 git 事后推断。
  - 线程记录新增 `prNumber` / `mergedAt`：`openPr` 成功时记下 PR 号
  - 合并审批执行成功时，把对应 PR 的线程标记 `mergedAt`
  - 回收判据：`mergedAt` 存在即放行（内容已在主干）；否则维持原判据（未合并且有未推送就拒绝）
  
  新增 1 项真实 git 集成测试：squash 合并 + 删远端分支后，**未标记时拒绝、标记后允许回收**；
  另加 4 项 `shouldReclaim` 单测（merged 放行、未合并拒绝、当前会话/脏工作区仍拒绝）。

## 0.7.2

### Patch Changes

- [#300](https://github.com/kangyishuai/dsh-plugins/pull/300) [`d0df734`](https://github.com/kangyishuai/dsh-plugins/commit/d0df734207819eae8fe2045bc37b9cc6259e6c5f) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 多项目并行与审批队列走查后修的三处。
  
  - **返回列表不刷新**：在详情页建了线程、改了目录，返回面板看到的还是旧的「未设置线程数」——
    面板没有轮询，`onBack` 也不刷新。现在返回即刷新。
  - **头部统计看不出线程数**：`N 个项目 · N 个活跃 · 0 个会话已接入` 里的"已接入"其实是
    「已挂载项目上下文的会话数」，建了线程也不会变，用户看到"0"会以为没生效。
    现在改成 `N 个项目 · N 个活跃 · N 个线程 · N 个会话带上下文`，线程总数一眼可见。
  - **审批执行成功没有反馈**：执行完审批列表清空，提示也跟着消失（提示原本渲染在列表内部）。
    现在提示放在列表外，执行后显示「已执行（结果见审计）」。
  
  审批链路本身（待批准 → 批准 → 执行 → 审计三行）在临时宿主端到端验证通过。
  冒烟 70 → **71** 项（新增：返回后列表线程数已刷新、头部给出线程数）。

## 0.7.1

### Patch Changes

- [#298](https://github.com/kangyishuai/dsh-plugins/pull/298) [`90d2397`](https://github.com/kangyishuai/dsh-plugins/commit/90d2397dd72b97f76dcf101ff144cf38271be8ef) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 0.7.0 验收时踩到的两个问题。
  
  - **相对路径被静默接受**：项目目录填 `relative/plain` 也能"保存成功"，直到建线程时才在宿主里崩，
    报错是 `session header cwd must be an absolute path, got "undefined/plain"`——用户完全对不上号。
    现在绑定前当场校验：不是绝对路径直接拒绝，并提示「需要绝对路径（以 / 开头）；相对路径无法作为会话目录」。
  - **文案里的 Markdown 泄漏**：非 git 目录提示写成 `**共享这个目录**`，界面不渲染 Markdown，
    用户看到的是字面星号。已去掉。
  
  冒烟 69 → **70** 项（新增：相对路径当场拒绝并说明原因）。

## 0.7.0

### Minor Changes

- [#296](https://github.com/kangyishuai/dsh-plugins/pull/296) [`6a519e9`](https://github.com/kangyishuai/dsh-plugins/commit/6a519e9c02a2a11c7a45f9869a6688196a7584f9) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 边界/空态走查后修的三处（走查报告见私有 notes）。
  
  - **非 git 目录静默降级**：绑一个普通目录后，线程其实是**共享目录**（没有 worktree 隔离），
    但界面什么都不说，用户会以为有隔离。现在绑定后当场探测并明确提示：
    「不是 git 仓库：线程会共享这个目录（没有 worktree 隔离，别让两个线程同时改同一批文件）」；
    线程行也标「共享目录（未隔离）」。新增 RPC `inspectDir({ path })`（exists / isGit / writable）。
  - **超长项目名撑爆行高**：120 字符的项目名会把列表行拉得很高。现在名字单行省略号截断。
  - **绑定目录无任何反馈**：成功失败都静默。现在绑定后显示目录状态（git / 非 git）。
  
  冒烟 67 → **69** 项（新增：非 git 目录如实说明、超长名字截断）。

## 0.6.1

### Patch Changes

- [#294](https://github.com/kangyishuai/dsh-plugins/pull/294) [`2421abd`](https://github.com/kangyishuai/dsh-plugins/commit/2421abd95925ae994cbed09cb4e07ed016006dbc) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 0.6.0 验收时发现的**自锁死路**：回收站只挂在项目详情页里，所以**删掉最后一个项目后就再也进不去回收站**——
  恢复入口自己把门锁上了（回收站里明明有项目可恢复，但界面上没有任何入口）。
  
  - 面板新增面板级回收站（`PanelTrash`）：**项目列表为空时**仍能查看、恢复、彻底删除（含两步确认）
  - 顺带修：`restoreProject` 恢复时**保留原状态**——之前一律写成 `active`，
    把用户显式设过的 paused/archived 状态抹掉了（冒烟里归档/暂停两条断言因此红过）
  
  冒烟 62 → **67** 项，新增「项目清零后面板仍能进入回收站（防自锁）」——
  这条是**真的删掉所有项目**再断言，不是跳过。

## 0.6.0

### Minor Changes

- [#292](https://github.com/kangyishuai/dsh-plugins/pull/292) [`5d319ba`](https://github.com/kangyishuai/dsh-plugins/commit/5d319ba18af09296959a323e563f6a3c75aab6aa) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 「记忆」页签从只读变成可写。
  
  走查发现：用户能看到「常设规则（instructions.md）」和「记忆索引（MEMORY.md）」，却没有任何编辑入口——
  规则只能靠协调器工具写，人想加一句"这个仓库测试用 pnpm test"都无处下手。
  
  - RPC `setProjectInstructions({ projectId, text })`：写 `instructions.md`（0o600）；
    空文本视为清空（删文件，而不是留个空文件让人分不清有没有规则）；上限 20k 字符（每次请求都会注入，太长持续吃上下文）
  - 界面：「编辑常设规则」→ 文本域 →「保存规则」；另有「追加一条记忆」输入框（回车即追加，重复条目会如实提示"已经记过了"）
  - 两个动作都写审计（`project/instructions-saved` / `project/instructions-cleared` / `memory/appended`）
  
  **踩坑记录**：给 `appendMemory` 加行内类型注释会让 SRC 网关拒绝注册该方法，
  表现为运行时 `typert gateway: ...`。`pnpm check` 里的 SRC 守卫当场拦住了——改用上方 JSDoc `@param`。
  
  冒烟 62 → **61**（本分支基于 main，新增 2 条记忆编辑断言）。

- [#291](https://github.com/kangyishuai/dsh-plugins/pull/291) [`59df29a`](https://github.com/kangyishuai/dsh-plugins/commit/59df29ae3b3e649a4e54846b6e72fb55750bcae8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 回收站补「彻底删除 / 清空回收站」。
  
  走查发现：`purgeTrash` 只清**超过保留期（默认 30 天）**的条目，所以删错的项目即使恢复回来又删掉，
  也会在回收站里躺满 30 天——用户没有任何"现在就清掉"的手段。
  
  - RPC `deleteTrashEntry({ entryId, confirm })`：彻底删一个条目；不带 `confirm` 时只回报影响面（字节数），不动手
  - RPC `emptyTrash({ confirm })`：清空回收站，同样先回报条目数与总量
  - 界面：每行「彻底删除」（**两步确认**，第二次的按钮上直接写「确认彻底删除（1.6 KB，不可恢复）」），
    底部「清空回收站」（同样两步确认并写明条目数与总量）
  - 两个动作都写审计（`trash/entry-deleted` / `trash/emptied`），符合 ADR 0002
  
  冒烟 59 → **61** 项（新增：二次确认文案含"不可恢复"、确认后条目从回收站消失）。

### Patch Changes

- [#290](https://github.com/kangyishuai/dsh-plugins/pull/290) [`bd9aa97`](https://github.com/kangyishuai/dsh-plugins/commit/bd9aa979638430795bbeabc36ae6727e707b9433) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 走查 P2 的三处纯体验修补。
  
  - **空态指引过时**：原本只说"在会话行的「…」菜单里归属"，但现在面板本身就能建线程。
    改成「在上面输入一个任务就能新建线程；也可以回到会话行，用「…」菜单把已有会话归属到本项目」。
  - **页签被记忆**：上次停在「审计」，再进详情还停在「审计」，容易误判"这个项目没有线程"。
    现在换项目/重进详情一律回到「线程」。
  - **头部术语**：`N 个会话已挂上下文` → `N 个会话已接入`。
  
  冒烟 59 → **62** 项（新增：默认页签、空态指引、头部术语三条断言）。

## 0.5.0

### Minor Changes

- [#287](https://github.com/kangyishuai/dsh-plugins/pull/287) [`685dab8`](https://github.com/kangyishuai/dsh-plugins/commit/685dab8b80e374b5993fc0b72be5e2698a70c21b) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 真实用户走查后发现并修复的两处缺陷 + 一处补齐（走查报告见私有 notes）。
  
  **修：回收站预览直接报网关错**
  `purgeTrash(options)` 只有一个参数 `options`，客户端把 `dryRun`/`projectId` 平铺在最外层，
  网关按参数名校验拒绝，用户看到的是 `typert gateway: ... unexpected "dryRun", "projectId"`。
  改成 `{ options: {...} }`。已核对全仓 16 个客户端调用，仅此一处写错。
  
  **补：删除承诺"可恢复"，现在真的能恢复**
  - 新增 RPC `listTrash()`：列出回收站条目（名称 / 线程数 / 删除时间 / 体积）
  - 新增 RPC `restoreTrash(entryId)`：把项目与线程放回仓储、内容目录搬回、清掉回收站条目
  - 详情页新增「回收站（可恢复）」区块，每行一个「恢复」按钮；恢复后自动刷新项目列表
  
  **修：冒烟断言把报错当成通过**
  原断言只校验"有文字且不含 FAIL"，于是上面的网关错误一路绿灯发版。现在必须校验成功语义，
  并新增「回收站列表」与「删除→恢复往返」两条断言（web 冒烟 57 项）。
  
  新增 3 项 store 单测（恢复项目、同 id 拒绝、线程归属保持）。

- [#289](https://github.com/kangyishuai/dsh-plugins/pull/289) [`e1315bc`](https://github.com/kangyishuai/dsh-plugins/commit/e1315bca89ae3c45b03dfe65f62afc25c1cf2949) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 真实用户走查的 P1 四项（走查报告见私有 notes）。
  
  - **建线程写审计**：从面板「新建线程」成功后不再无声无息，现在写 `thread/created`
    （含 sessionId、是否隔离、任务摘要），「审计」页签能看到。之前只有被拒绝才留痕，
    与"可审计"的主张自相矛盾。
  - **路由结果说人话**：`按 blocked → new-thread · #long-task · 被拦: autonomy/L1` 这种内部码
    换成「规则「long-task」建议「新建线程」，但当前自治等级（L1）不允许自动执行，已拦下（可在设置里提高自治等级，或手动执行）」；
    原始码移到 `title` 属性，需要的人 hover 才看。
  - **高级设置默认折叠**：仓库授权 / 回收站清理 / 回收站（可恢复）三块收进一个
    「高级设置」折叠区，首屏留给线程——走查里这三块把主内容压到了折叠线以下。
  - **重名项目可区分**：项目行在名字后显示 `#<id 后缀>`，两条同名项目不再一模一样。
  
  冒烟从 57 增至 **59** 项（新增折叠态、项目行短 id 两条断言）。

## 0.4.3

### Patch Changes

- [#285](https://github.com/kangyishuai/dsh-plugins/pull/285) [`8fb2ffd`](https://github.com/kangyishuai/dsh-plugins/commit/8fb2ffdc0cc74a3d0c3f46880fee8688c32269c2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 0.4.2 装进 live profile、**重启桌面版后**复跑门禁，结果写进兼容表：
  
  - 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**
  - web 端到端冒烟 **54 PASS / 0 SKIP / 0 FAIL**
  - `pnpm gate:all --plugins projects` 全绿（64s）
  
  并在**真实界面**里用截图确认了本次修复：空项目的「线程 (0)」页签同时出现
  「新建线程」输入框与空态提示（修之前输入框被空态挡住，页面无处起线程）。
  
  另把 README 里的「317 项单测 / 52 项冒烟」更新为 **385 / 54**。

## 0.4.2

### Patch Changes

- [#283](https://github.com/kangyishuai/dsh-plugins/pull/283) [`4b409ab`](https://github.com/kangyishuai/dsh-plugins/commit/4b409ab290503a466c2b96bb740508315761c341) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个可用性缺陷：**新建的项目在面板里无法起线程**。
  
  详情页的「线程」页签在**没有线程时直接 return 空态**，而「新建线程」输入框和按钮就渲染在那个分支里——
  于是空项目的页面上根本没有入口，用户只能绕道会话行的「…」菜单去归属一个已有会话。
  现在把输入行提到判空之前，空态也带着它。
  
  顺带：web 冒烟的详情页截图改用 CDP `Page.captureScreenshot`
  （ego 的 `page.screenshot()` 在本版本返回空数据，存下来的 png 只有 56 字节），
  新增一张 `02-detail-thread-stats.png`，把线程行摘要与两块新 UI 一起留档。
  
  冒烟新增 1 项断言（空项目的详情页仍有建线程入口），共 **54** 项。

## 0.4.1

### Patch Changes

- [#281](https://github.com/kangyishuai/dsh-plugins/pull/281) [`e23ed5e`](https://github.com/kangyishuai/dsh-plugins/commit/e23ed5ee25bceadad2283aca147634c0136d7e4f) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个从 M2 起就存在的回收缺陷：**合并过的线程 worktree 永远回收不掉**。
  
  原来「有没有未推送提交」用的是 `git rev-list --count <base>..HEAD`，也就是「相对创建时的基线有没有
  新提交」。问题是**基线不会因为合并而前移**——线程只要提交过，这个数就永远是 1 以上，
  于是合并完成、PR 已合入主干的线程，worktree 仍然被判定为"有未推送提交"而拒绝回收。
  B5（分支生命周期）只能自己绕开这一步。
  
  现在改成按**是否已在某个远端**判断：`git rev-list --count HEAD --not --remotes` 为 0 才算"都推上去了"。
  没有配置远端的仓库（本地临时仓库、离线项目）无处可推，退回旧判据，避免永远拒绝回收。
  
  新增 2 项测试：有远端且已推送 → 允许回收（修复点）；有远端但提交只在本地 → 拒绝（内容不能丢）。
  负向验证：退回旧判据后第一条立即变红。

## 0.4.0

### Minor Changes

- [#280](https://github.com/kangyishuai/dsh-plugins/pull/280) [`4210c95`](https://github.com/kangyishuai/dsh-plugins/commit/4210c9517b28a7d5376452ab578b4543520b8109) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补上「分支生命周期」（规格 §7.7.5 / 计划 B5）：worktree 会回收，分支以前**永不删除**，会一路累积。
  
  **新判据（三条全满足才删）**，刻意**不用** `git branch --merged`——它在两个方向都会误判
  （未提交的新分支被当"已合并"、squash 合并的分支被当"未合并"，见 runtime §11.15）：
  
  1. 分支是插件建的（`dsh/` 前缀且与线程记录一致）
  2. 该线程**确有合并结果**：记录里有 `mergedAt`，或 `git merge-base --is-ancestor <branch> HEAD` 成立
  3. **没有未推送提交**：`git rev-list --count <branch> --not --remotes` 为 0
  
  **worktree 先处理**：分支若仍被 worktree 占用，`git branch -d` 会被拒。所以只在 worktree
  **干净**（`git status --porcelain` 为空）时用 `git worktree remove`（不加 `--force`）移除它，
  脏 worktree 一律保留并报告 `worktree-dirty`。
  
  **删除只用 `git branch -d`，永不用 `-D`**；失败保留并写审计。
  提供 RPC `cleanupBranches(projectId, { dryRun })`（默认 dry-run，真删需 `confirm: true`），
  并在**归档项目**时自动按同一判据清理一次（失败不影响归档）。
  
  真机验证（临时裸远端）：已合并+已推送的分支被删；未合并的分支保留（`not-merged`）；worktree 脏时保留。
  新增 6 项单测（三判据真值表 + 两种历史误判场景 + `-d` 断言）。

- [#273](https://github.com/kangyishuai/dsh-plugins/pull/273) [`4d8dcd1`](https://github.com/kangyishuai/dsh-plugins/commit/4d8dcd1642155b65743aa76c8bf3dd3f5359ca1e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补齐规格 §7.5 行 3 漏实现的合并硬前提，并落地项目级预授权（规格 §7.7.2）。
  
  **合并的三道硬前提**（此前只查「非 draft / 无冲突」）
  - **CI 绿**：`statusCheckRollup` 必须全部通过；空列表按「未配置检查」**拒绝**（`merge/ci-unknown`），不猜
  - **人工批准**：统计 `reviews` 里不同作者的 APPROVED 数 ≥ `policy.merge.minApprovals`（默认 1）
  - **合并方式**：仓库 `allowed_merge_methods` 必须含 `squash`，否则拒绝而不改用 merge/rebase
  - 阈值改从 `policy.merge` 读（`minApprovals` / `maxDiffFiles` / `maxDiffLines`），不再写死
  
  **项目级预授权**：`policy.preapprove` 列出可被 `policy-grant` 直接放行的动作；三条全满足才生效
  （在列表里、授权来源是 policy-grant、危险开关已开）。命中后自动 approved 并**立即执行**——
  闸门一条不跳过，只省掉「等人点一下」。`merge`（approval-event）与直推保护分支（per-incident）
  **永不**被预授权覆盖。执行结果会如实回报给协调器（`executed` / `auto-approved-not-executed` + 原因）。
  
  **顺带**：`delete-thread` 之前也是「可申请但执行只会 deferred」，现在真正走 `reclaimThread`（三重判据不变）。
  
  **一处旧结论纠正**：宿主没有 `ctx.approval.setPolicy`（`dsh-authorization` 是凭据流程，不是审批），
  所以预授权是本插件用政策授权自己实现的，不是宿主能力。
  
  341 项单测（新增 19 项：CI/批准数/合并方式/预授权/工具回报）、真机验过五种拒绝与两种放行路径。

- [#276](https://github.com/kangyishuai/dsh-plugins/pull/276) [`83910f7`](https://github.com/kangyishuai/dsh-plugins/commit/83910f76c1f22f6f0aca32f7246cf24ea54aa6f2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补上「可观测」（规格 §7.7.3）：面板不再只有线程状态，还能看到这一步花了什么、改了什么。
  
  - 从**持久会话事件**累积每个线程的：步骤数（`assistant/attempt`）、工具调用与命令明细
    （`tool/call` + `tool/result` 回填成功与否，保留最近 12 条）、token 用量
  - 新增 RPC `threadStats(projectId, sessionId)`：在事件统计之外现算 worktree 的
    `git diff --numstat <base>..HEAD`（文件数 / +增 / -删）
  - 详情页线程行显示一行摘要：`N 步 · N 次工具 · diff N 文件 +a/-b · N tokens`
  - **缺失数据显式 n/a**：二进制文件的 numstat 是 `-/-`、宿主没上报 usage 时，都写 `n/a`，
    不用估算值冒充测量值
  
  新增 13 项单测（事件归约、命令上限、token 字段兼容、numstat 解析、n/a 语义）；
  web 冒烟 53 项（新增 1 项断言线程行摘要）。

- [#279](https://github.com/kangyishuai/dsh-plugins/pull/279) [`49ef2bb`](https://github.com/kangyishuai/dsh-plugins/commit/49ef2bb829987e6a198c0790e3e007254133a233) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补「一键建项目模板」（规格 §7.7.6 / 计划 B6）：`createProject(name, { dirs, template: true })`
  会建目录、写一份 `instructions.md` 骨架。
  
  - **绝不覆盖**：写盘用 `writeFileSync(..., { flag: "wx" })`，已有 `instructions.md` 直接跳过并记审计
  - **已有 `AGENTS.md` 时不动它**，只在新骨架里加一行「两者都会注入，请避免写重复内容」，
    与 spec §3.3 的去重口径一致
  - 重复调用幂等；模板创建失败**不阻断**建项目（只写审计 `project/template-failed`）
  
  真机验证：新目录被建且骨架写入；已有 AGENTS.md 内容逐字节未变；同目录再建一次不覆盖。
  新增 6 项单测。

- [#277](https://github.com/kangyishuai/dsh-plugins/pull/277) [`8fc72fd`](https://github.com/kangyishuai/dsh-plugins/commit/8fc72fd4cb1e5b016843c6b7bddf1ce3f0285d19) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补「周预算」与「单线程步数上限」（规格 §7.7.4）。
  
  - **周预算**：`policy.budget.weeklyTokens`，按**自然周（周一 00:00，本地时区）**聚合 token 用量，
    到线即拒建新线程（`budget/weekly-tokens`）。为此把 token 用量从「单日桶」改成**按天分桶**
    （保留最近 21 天，旧形状自动迁移，不丢历史数）
  - **单线程步数**：`policy.budget.maxStepsPerThread`，按 `assistant/attempt` 计步；
    超限**只停协调器唤醒**（审计 `wake/skipped` + `budget/steps-per-thread`），
    **不杀会话、不阻止人继续**——这是刻意的：预算是防止无人值守的无限烧，不是惩罚使用者
  - `threadStats` 增加 `overBudget` / `budgetReason`，面板可据此提示
  
  新增 9 项单测（周界计算、周预算边界、步数边界、按天分桶、旧形状迁移、21 天修剪）。

## 0.3.2

### Patch Changes

- [#271](https://github.com/kangyishuai/dsh-plugins/pull/271) [`8c983c7`](https://github.com/kangyishuai/dsh-plugins/commit/8c983c742318daa441e5f0ca587636f26422e163) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修「被拒绝的申请也被占用」：把幂等占位与执行结果拆开（claim / release）。
  
  **之前的行为**：`executedAt` 在闸门之前就写入，所以只要点过一次「执行」——哪怕因开关没开、
  影响面超阈值而被拒——这张申请就再也不能执行，必须让协调器重新申请。
  
  **现在**：
  - `claimApproval()` 只占位（`claimedAt`），并发第二次得 `already-claimed`
  - 执行**成功**才落 `executedAt`（+ evidence），并清掉占位
  - 被拒绝或失败一律 `releaseApproval()`，**同一张申请可重试**
  - 已执行的申请不能占位、也不会被释放（`already-executed`）
  
  真机验证（临时宿主）：同一张 `purge-trash` 申请先返回 `switch-off`，打开开关后再次执行
  **同一张申请**返回 `executed:true`，第三次返回 `already-executed`；最终
  `{status:"approved", claimedAt:null, executed:true}`。
  
  322 项单测（新增 5 项 claim/release 语义）全绿。

## 0.3.1

### Patch Changes

- [#269](https://github.com/kangyishuai/dsh-plugins/pull/269) [`619c93a`](https://github.com/kangyishuai/dsh-plugins/commit/619c93ab4f5729933e7e2a68827bdbfc4723573a) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 0.3.0 装进 live profile、**重启桌面版后**复跑门禁，结果写进兼容表：
  
  - 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**
  - web 端到端冒烟 **52 PASS / 0 SKIP / 0 FAIL**（含 0.3.0 新增的执行按钮/仓库授权/回收站清理两块）
  - `pnpm gate:all --plugins projects` 全绿（64s）
  
  0.3.0 改了 client 半，所以这次特别确认了「重启后新 UI 真的加载」：项目面板正常渲染
  （该 profile 里没有项目，详情页两块由临时宿主的 web 冒烟覆盖）。
  另把 README 的「309 项单测 / 50 项冒烟」更新为 317 / 52。

## 0.3.0

### Minor Changes

- [#267](https://github.com/kangyishuai/dsh-plugins/pull/267) [`d6e3830`](https://github.com/kangyishuai/dsh-plugins/commit/d6e3830daf39327f37011774dd104b194051a8d8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 接通「审批 → 执行」闭环，并补齐新能力的两个界面入口。
  
  **审批 → 执行（修一个实质缺口）**
  - 之前 `executeApproval` 已导出为 RPC 却**没有任何调用方**：用户点「批准」只改状态，
    没有任何入口真正执行，整套开关/阈值/审计形同虚设
  - 详情页现在把「已批准未执行」的申请单独渲染，带「执行」按钮（`data-projects-approval-execute`），
    点击后把 `executed:true` 或拒绝原因回显在行内
  - 服务端补 `purge-trash` 与 `change-settings` 两条执行路径（此前只会 `execution-deferred`）
  
  **改本插件自己的配置（规格 §7.5 行 5a）**
  - `change-settings` 从「有开关、无实现」变成真可用：白名单只放 `persona` / `routing` / `goal`
  - 安全面一律拒：`danger` / `autonomy` / `preapprove` / `budget` / `repoGrants` 等
    （`settings/forbidden:<key>`），防自我提权
  
  **界面补漏**
  - 详情页新增「仓库授权」：`policy.repoGrants` 的 per-repo 授予以前只能手编 JSON
  - 详情页新增「回收站清理」：先 dry-run 预览、再确认；只处理本项目超保留期条目
  
  **已知取舍**：幂等占位写在闸门之前，所以被拒绝的申请也会被占用（需重新申请）。
  换成 claim/release 可两全，但涉及 14 处拒绝点，留作后续。
  
  317 项单测（新增 8 项配置白名单）+ web 冒烟 52 项（新增 2 项）全绿。

## 0.2.2

### Patch Changes

- [#265](https://github.com/kangyishuai/dsh-plugins/pull/265) [`bdd0e86`](https://github.com/kangyishuai/dsh-plugins/commit/bdd0e86555edc4210908a5d56f45dee541cdade8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把 0.2.1 装进 live profile 并在**重启桌面版之后**复跑桌面只读回归，结果写进兼容表：
  
  - 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**（`pnpm gate:all --plugins projects`，64s 全绿）
  - web 端到端冒烟 50 PASS / 0 SKIP / 0 FAIL
  
  此前 0.2.0 的兼容表如实写着「桌面回归尚未复跑」，现在这条已补齐（0.2.0 与 0.2.1 的 client 半一致）。
  另记一条环境事实：该 live profile 里 `ui-settings` 为 `enabled: false`，设置页打不开，
  因此开关文案无法在界面上目视确认（磁盘产物已确认是新文案）。

## 0.2.1

### Patch Changes

- [#263](https://github.com/kangyishuai/dsh-plugins/pull/263) [`3b5c030`](https://github.com/kangyishuai/dsh-plugins/commit/3b5c030640628873c78c553014f8ac99ae02e756) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 兼容表补 `0.2.0` 一行，并如实写清它验证到什么程度：309 项单测 + `pnpm verify` + web 冒烟 50/0/0，
  三项危险动作在临时宿主上真机验证（本地 bare 远端 + 桩 `gh`）；**桌面只读回归尚未对 0.2.0 复跑**
  （本次 client 半只改了开关文案，上次全绿是 0.1.1）。
  
  顺带把 README 里过时的「276 项单测」更新为 309。

## 0.2.0

### Minor Changes

- [#261](https://github.com/kangyishuai/dsh-plugins/pull/261) [`374cf69`](https://github.com/kangyishuai/dsh-plugins/commit/374cf69add8cb71ef6d2b285f176cb9c890e1365) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把规格 §7.5 里剩下三项危险动作从「只有开关、没有实现」补成真正可用，全部默认关：
  
  - **强推自建分支**（`push-branch` 带 `force`）：只走 `git push --force-with-lease=<branch>:<sha>`，
    不接受裸 `--force`；分支必须是插件记录过的 `dsh/` 分支、非保护分支、旧 SHA 已知；
    远端被动过时 lease 会 fail-closed 拒绝。成功后记录 `lastPushedSha`，审计里带旧 SHA 供恢复。
  - **直推默认/保护分支**（`push-protected-branch`）：推前查 `branches/<b>/protection` 与 `rulesets`，
    服务端要求 PR 时直接拒绝；需要项目策略里对该仓库 **per-repo 授予**（`policy.repoGrants`）；
    每次审计带仓库/分支/提交者数，检测到多人协作时返回 `warning: multi-collaborator`。
  - **回收站保留期清理**（`purgeTrash` RPC）：只处理已在回收站且超 `retentionDays`（默认 30 天）的条目，
    认不出时间的条目一律保留；**默认 dry-run**，真删需开关打开 + `confirm: "purge"`，
    执行前写出 `trash/purge-<ts>.md` 可恢复清单并审计。
  
  配套：`repoGrants` 进项目策略（只认显式 `true`）；线程记录新增 `lastPushedSha`/`baseSha`；
  设置页三个开关的文案从「暂未实现」改为真实行为说明；新增 22 项纯逻辑单测与「动作↔开关↔可申请」
  一致性守卫单测（309 项单测全绿）。

## 0.1.3

### Patch Changes

- [#259](https://github.com/kangyishuai/dsh-plugins/pull/259) [`4eadd4b`](https://github.com/kangyishuai/dsh-plugins/commit/4eadd4bb23039d2aaa5a1efe9acf53f91cc7a4b6) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修两个只在**真实 GitHub** 上才会暴露的合并缺陷（此前只用桩 `gh` 验证，抓不到）：
  
  1. **合并会打到错误的仓库。** `gh pr merge` 原本没带 `--repo`，于是按「宿主进程当前目录所在的
     git 仓库」解析目标；同时 `gh pr merge` 对已合并的 PR 仍返回 exit 0，导致插件误报成功。
     现在合并前必须从项目目录的 `git remote get-url origin` 解析 `owner/repo` 并要求带上
     `--repo`，解析不到直接拒绝（`merge/repo-unknown`）。
  2. **draft PR 被当作可合并。** 新增 `checkMergePreflight()`：合并前用
     `gh pr view --json isDraft,mergeable,state` 校验「非 draft / 可合并 / 仍 open」，
     任一不满足就拒绝并写审计；`mergeable=UNKNOWN`（GitHub 刚建 PR 时的正常状态）做有界重试。
  
  真实仓库实测：draft PR 保持 open 未合并（`merge/pr-is-draft`）；ready 档 PR 成功 squash 合并，
  main 上出现合并提交。单测 284 项（新增 9 项覆盖上述判定）。

## 0.1.2

### Patch Changes

- [#257](https://github.com/kangyishuai/dsh-plugins/pull/257) [`15b7295`](https://github.com/kangyishuai/dsh-plugins/commit/15b7295c7fdd2dd098a7e5929dd356479c490292) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 在 DSH 0.2.2-rc.5 上完成复验，并把桌面只读回归第一次跑绿。**不需要改代码**。
  
  - 桌面只读回归：**11 PASS / 0 SKIP / 0 FAIL**（此前该项目一直未绿）
  - web 端到端冒烟：**50 PASS / 0 SKIP / 0 FAIL**
  - 单测 276 / 276、`pnpm probe:runtime` 72/72
  - 本插件依赖的私有 seam（`dsh-session`、`dsh-workspace`、`dsh-api-gateway`、`dsh-typert-protocol`、
    `dsh-agent` 等）在 rc.3 与 rc.5 之间逐字节相同（43 包逐包 diff，见 docs/runtime/0.2.2-rc.5.md §1.1）
  
  同时修正文档里的两个数字：web 冒烟断言实为 **50**（旧文档把收尾汇总行也算成了第 51 项），
  单测为 **276**（旧文档写 274）。

## 0.1.1

### Patch Changes

- [#175](https://github.com/kangyishuai/dsh-plugins/pull/175) [`e8ce691`](https://github.com/kangyishuai/dsh-plugins/commit/e8ce69140925baa3d5c98eb7021de1e53ea08101) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修桌面版 `projects: store is unavailable`：DSH 桌面进程不导出 `DSH_HOME`，旧的 `resolveDataRoot` 在没有配置 `dataRoot` 时直接抛错。现按「配置 `dataRoot` → `$DSH_HOME/projects` → `~/.dsh/projects`」解析，并把解析器抽到可单测的 `lib/paths.js`（新增回归测试）。

## 0.1.0

### Minor Changes

- [#144](https://github.com/kangyishuai/dsh-plugins/pull/144) [`f660cb0`](https://github.com/kangyishuai/dsh-plugins/commit/f660cb01c1d1d7a959e7291b8ac2cf592c68ee3c) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 首发版本：把「项目」做成一等上下文单元，并给它一个**可审计、默认可控**的协调器。
  
  **项目与上下文**
  - 项目仓储：数据根可注入、原子写、损坏文件改名隔离（不删除）、未来格式版本拒绝
  - 项目级上下文注入：归属会话在每次请求前收到常设规则与 `MEMORY.md` 索引（16k 预算）。
    实现是**全局注册一次、按会话求值**（函数式 provider），只有归属且未归档的会话才渲染；
    不属于任何项目的会话拿到的始终是空串，不会被污染
  
  **并行工作**
  - 线程隔离：先建 Git worktree 再建会话；非 git 或建失败一律降级共享目录并说明原因
  - 回收：归档即回收，但三重判据（脏工作区 / 有未推送提交 / 当前会话目录）任一命中就保留；
    启动对账，磁盘上未记录的目录只报告、不删除
  - Overview：五态（待你处理 > 失败 > 进行中 > 已完成 > 空闲）全部从持久会话事件推导，可重启重建
  
  **协调器（默认只提议）**
  - 唤醒：线程跑完一轮就把结构化信封（含线程真实结果、项目规则与记忆摘要、人格）投给协调器会话。
    每轮最多一次：`decideWake()` 三态判定（水位重复 / 并发去重 / 发送），并发 `turn/end` 不会重复投递；
    未配协调器时记 `wake/skipped` 而不是静默
  - 冷会话唤醒：应用关着时线程跑完、或线程跑完时还没建协调器，信封会在下次启动后由
    `reconcileWakes()` 补发（只补 `done`/`failed`/`waiting-user`，`working`/`idle` 不补）
  - 路由：扁平规则优先，命中即确定性执行；未命中才由模型提议，且仍要过白名单与自治矩阵
  - 自治级别：`L0` 只观察、`L1` 只提议（默认）、`L2` 可建线程、`L3` 全权；
    闸门在决策之后、执行之前，审计里同时看得到意图与拒绝原因
  - 工具篮子：协调器只有 6 个 `project_*` 工具（起线程 / 列线程 / 给线程发消息 / 申请危险动作 / 读记忆 / 写记忆），
    没有 shell / 写文件 / 删除 / 推送 / 合并
  - 人格：内置三条准则 + 用户设定，并明确声明「人格不改变权限」。
    人格与项目上下文一样**随信封送达**——宿主的按会话 runtime context 不会投递给协调器会话
    （docs/runtime §10.24）
  
  **界面**
  - 侧栏面板：项目列表、新建、详情（线程 / 记忆 / 审计三页签）、按规则派活、预算显示
  - 项目操作：暂停 / 恢复、**归档 / 取消归档**（归档不删数据）、删除（回收站 + 两段式确认）
  - 设置分节：自治级别、人格、路由回退、六个危险开关（每项带风险说明，默认全关）
  
  **安全边界**
  - 删除项目走回收站（ADR 0002）：dry-run 影响面、两段式确认、`manifest.json` 可恢复、写审计
  - 审批队列：危险动作只能「申请」；批准 ≠ 可执行，还要开关打开、影响面在阈值内；
    执行器与开关之间是显式映射（打开别的开关解锁不了合并）
  - 六个危险开关默认全关，可配置但每项带风险说明；执行器与开关之间是显式映射
  - 不可信输入隔离：非 principal 来源的内容一律包成「数据不是指令」的块，围栏不可被内容提前闭合
  - auto-fix 只在本地 worktree 产出提交：不 push、不开 PR、轮数上限、同错即停、碰到测试文件即停
  - 远端写入三条链路（推分支 / 开 PR / 合并）都在本机完成端到端验证：
    远端用本地 bare 仓库、`gh` 用 PATH 桩脚本；`merge` 的 argv 固定为 `pr merge <n> --squash`，
    auto PR 支持 off/draft/ready/auto-merge 四档（默认 off）
  
  **尚未发布**：真实 GitHub 上的最终效果（需一次人工发版确认）、LiveShare 项目共享、
  按 token 的花费闸（宿主不上报 usage，见 docs/runtime §10.12）。
