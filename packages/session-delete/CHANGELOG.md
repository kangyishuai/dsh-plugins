# @kangyishuai/dsh-session-delete

## 0.6.2

### Patch Changes

- [#403](https://github.com/kangyishuai/dsh-plugins/pull/403) [`c90356f`](https://github.com/kangyishuai/dsh-plugins/commit/c90356f038cd00ba3f263e5605647f1c368be4fa) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 复审 P3 backlog 收尾（三条低风险、可验证项）：
  
  - **artifacts**：右栏工件库空态不再只报「还没有工件。」，补一行解释「工件是什么、怎么让 AI 用 `artifact` 工具发布一个」（`data-dsh-artifact-empty-hint`；项目范围同理）。对应 USIM-U1-20 的「空态不解释」部分；入口发现性（右上角图标）归宿主 backlog，页签英文名由本插件 `client.js` 注册、归本插件 i18n 批次。
  - **session-delete**：体检（设置 → 会话回收站 → 维护）新增一条 finding，列出操作日志里**读不出来**（截断/形状不对的 `<id>.json`）与 `writeAtomic` 崩溃残留（`<id>.json.tmp`）的记录；只报告、不自动删除，坏文件仍在原处。此前这些记录连体检都看不见（复审 F4）。
  - **casefile**：「最近打开」与 `session-pointers.json` 落盘改为尽力而为——数据根只读或磁盘写满时只告警，`case_project get` 这类纯读动作不再跟着失败（复审 F6）；指针文件版本高于本插件（降级场景）时按「无指针」处理，不再让所有省略 `projectId` 的工具调用整片失败（复审 F7）。

## 0.6.1

### Patch Changes

- [#380](https://github.com/kangyishuai/dsh-plugins/pull/380) [`483e815`](https://github.com/kangyishuai/dsh-plugins/commit/483e8151a7867aff613bfa967b5cba0fa2787f8d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 插件身份（U1-01/U1-19）：8 个包在 `locale/en.json`、`locale/zh.json` 根对象新增 `meta.title` / `meta.description`（英文短描述 + `scripts/index-meta.json` 的中文描述），并用 `"./locale/*.json": "./locale/*.json"` 通配把 locale 目录加进 `exports`（宿主经 Node 解析器读 locale，通配能覆盖未来新增语言，漏文件会让整套 meta/icon 丢失），让「插件 → 已安装」不再只显示 npm 包名 + 英文长描述；每个包新增自绘 `icon.svg`（36×36、透明背景、无文字），在 `package.json` 顶层 `icon` 声明并加入 `files`，8 个插件的图标互不相同。`scripts/check-plugins.mjs` 新增对应机械检查（exports 通配/覆盖、locale 身份与索引源一致、icon 存在/白名单/体积/文件头）。已在 DSH 0.2.2-rc.5 隔离桌面实例实测（暗色主题、中文界面），并用真实 `readPluginMeta()` 复核 8/8 无 error。

- [#382](https://github.com/kangyishuai/dsh-plugins/pull/382) [`95ec48e`](https://github.com/kangyishuai/dsh-plugins/commit/95ec48e24132a310e70928fa4ea5d1c76d887487) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 设置分节的保存方式与反馈统一（用户模拟 U1-10）：
  
  - 每个设置分节固定一行保存状态（`data-<plugin>-settings-status`，`data-state` = `clean` / `dirty` / `saving` / `saved` / `error` / `readonly`），中英双语。
  - 显式保存（advisor / btw / projects 预算）：无改动时保存按钮禁用并显示「已保存」；有改动显示「有未保存更改」；失败显示「保存失败：原因」，按钮仍可重试。
  - 自动保存（session-delete / session-rewind / next-step / projects 策略开关）：落盘后短暂显示「已保存」再回落「· 已保存」；失败显示原因并给可点的重试入口（`data-<plugin>-settings-retry`）。
  - casefile 的诊断分节明确标为只读（「无可保存设置」），不再让人找不到保存按钮。
  - `artifacts` 没有 `settings.section`（只提供右栏工具页签），本次不涉及、不发版。
  - projects 额外保留既有「预算已保存：{summary}」回执（`data-projects-settings-b3-result`，`pnpm smoke:projects`
    有断言），与统一状态行并存；通知开关也改走状态行，不再各自一套反馈。
  - 保存失败后的重试/迟到响应严格绑定**保存时的 projectId**：切换项目会作废旧 pending（草稿/错误态/重试），
    状态行提示「项目已切换，请重新保存」，不会把上一次的 patch 写到另一个项目上。
  - advisor 保留旧锚点 `data-advisor-dirty`（dirty 时出现，语义不变），错误原因也进状态行。
  - 已知（不做）：自动保存**不是串行队列**——同一项目连续快速修改时，最终以最后一次成功的写为准；
    过期响应按保存序号 + projectId 丢弃，不会污染状态行或写错项目。
  - 存储与 RPC 契约未改，只改界面反馈与按钮可用性；每包新增 `test/settings-save-status.test.js`（node:vm 驱动真实 client 组件）。

- [#383](https://github.com/kangyishuai/dsh-plugins/pull/383) [`ca82d56`](https://github.com/kangyishuai/dsh-plugins/commit/ca82d5697132a2a7b5abb3e0cd53cfeac9ce1d0e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 发版后真机复审发现的一组用户可见缺陷：
  
  - **advisor（P2，遮挡输入区）**：命令回执/轻提示原来固定在 `right:24px;bottom:24px`，1280×820 有会话时
    回执盖住 composer（y=700–736）与发送按钮（y=748–782）。改为渲染时测量 `[data-composer-input]` 顶部、
    `bottom = innerHeight - composerTop + 12`（无 composer 回退 24px），resize / composer 变高时重算；
    回执 `max-height` 按可用空间收缩，避免顶出视口。纯函数（`toastBottomOffset` 等）有单测，桌面冒烟新增
    「回执与 composer/发送按钮无重叠」几何断言。
  - **projects（O1/O3/O4）**：① 列表页删除项目后回收站区块不即时刷新（仍显示「回收站是空的」直到整页刷新）——
    删除成功 bump `trashEpoch`，回收站按 `reloadToken` 复用既有 `listTrash` 路径重载；② Routine 删除没有确认框
    （会撤掉宿主定时任务并丢历史，违反 ADR 0002）——新增一行影响面（routines 名/频率/宿主 scheduleId/投递状态/
    不可恢复性）、默认聚焦主按钮、Esc/取消，确认后才执行；③ Routine 创建成功后表单不清空、容易重复建——
    成功清空名字/指令并把频率/时间回默认，失败保留输入。
  - **casefile（A5）**：概览卡渲染服务端中文 summary 与原始 kind 枚举（`binary × 1`）。改为按结构化字段 +
    locale 组装摘要，kind 走本包既有 `vocab` 中英映射；补 i18n parity 与真实页面渲染测试（中英两套断言）。
  - **btw（B7）**：`/btw` 执行回执是 `div + onClick`，键盘不可达。改为 `role="button"` + `tabIndex=0` +
    Enter/Space 触发、默认聚焦环样式；点击开面板的既有行为与 toast 样式不变。
  - **session-delete（O2，真机复审归到 projects 条目但代码在本包）**：删除确认框写「正在运行，会先停止」，
    但侧栏同一会话显示「空闲」——`plan.live` 实为「会话已在本机宿主进程注册」而非「回合在跑」。影响面改述为
    「本机已打开，会先关闭」（英文 `open in this window; closed first`），不再声称正在运行；确认时 digest
    校验继续拦截预览后变化。
  
  另修正两条与本次改动无关、但会让 `pnpm verify` 随本地时段/并行负载随机变红的既有计时用例
  （advisor 账本恢复注入可测时钟、btw 设置保存态改状态轮询），生产行为不变。

## 0.6.0

### Minor Changes

- [#355](https://github.com/kangyishuai/dsh-plugins/pull/355) [`1a41a76`](https://github.com/kangyishuai/dsh-plugins/commit/1a41a7692ea4deff1b10837fc8783d9a2ece51cc) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修复审计发现的恢复、对账与可观测性缺口：启动时扫 journal 未完成记录，按落盘事实补完或回滚并写 `recover` 审计（此前只写 intent、界面却声称「重启后自愈」）；恢复回执与界面如实报告引用/置顶/校验结果（新增 `refs`/`checks`/`partial`，`meta.pinned` 真正落盘）；删除已移动但收尾失败时写 `partial` 回执并以 `session-delete/partial` 区分；plan 阶段与 agent 工具的拒绝进制审计；跨卷回退改为逐项校验后才删源；复活守卫真的再移一次。设置页体检改为按需运行并缓存结果（打开设置不再扫全库），toast 撤销失败常驻提示；关键节点补稳定的 `data-sdel-*` 锚点。新增界面行为，故按 minor 发布。

### Patch Changes

- [#368](https://github.com/kangyishuai/dsh-plugins/pull/368) [`4ffd91a`](https://github.com/kangyishuai/dsh-plugins/commit/4ffd91afea4df0051b77109ff52c08aa47570c49) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 恢复/删除后的可用性与可解释性（用户模拟 U2/U3，含独立复审跟进）：恢复成功后自动重新打开会话并刷新界面（不再停在「会话不可用」）；恢复失败逐项列出引用名与下一步动作，回执可展开、审计写清单，并新增「重试未通过的引用」（恢复时也会先自动重试一次）；宿主接口缺失改记「跳过」，不再假报失败；宿主服务晚挂载时能力探测会自动跟上（删除仍走归档/停止闸门，恢复能挂回工作区）；删除当前会话后自动切到下一个会话或新会话页并提示可恢复；恢复成功后回收站面板自动关闭。
  批量恢复改为只刷新一次、不逐条跳转会话；旧版本写的恢复回执（缺少恢复前引用快照）会被拒绝重检而不是假报「全部恢复」，解除归档/置顶失败也会给出中文下一步。

## 0.5.0

### Minor Changes

- [#92](https://github.com/kangyishuai/dsh-plugins/pull/92) [`b258eb9`](https://github.com/kangyishuai/dsh-plugins/commit/b258eb930ceb9f4cddabe64a8faaf3fed0f5d6e9) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 删除会话接上官方菜单与快捷键体系，并支持「一键清空工作区」：
  
  - **会话「…」菜单走官方 contextMenus 贡献**（不再是旧兼容 slot）：条目排在「复制会话 ID」与「归档」之间，并显示快捷键；拿不到该服务的旧宿主自动退回旧 slot，功能不减。
  - **`⌘⌥⌫` 删除当前会话**（桌面与 Web 的 macOS/Windows；可在 设置 → 通用 → 快捷键 里改键）。它打开的就是同一个确认框，所以默认焦点、回车即执行、级联记忆都一致。Linux 不预置默认键：宿主的保留键规则会拒绝「修饰键 + Backspace」，硬写会让整条快捷键注册失败。
  - **工作区「…」→「删除此工作区的全部会话…」**：先给出整组影响面（会话数、总体积、正在运行数、子会话数、失效的登记条目），确认后逐条删除、汇总部分失败，一条卡住不会让其余会话留在磁盘上。工作区级快捷键不预置默认键，需要时自己绑。
  - 工作区批量复用同一份摘要与防漂移机制：预览与执行之间会话集合或体积变化会中止，而不是删掉你没看到的东西。

- [#91](https://github.com/kangyishuai/dsh-plugins/pull/91) [`acee8b0`](https://github.com/kangyishuai/dsh-plugins/commit/acee8b0e1d8d547c39d23e7bc1a7e9ebb8015232) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 重新组织删除会话的界面，把「确认」这一步做得更顺手、更安静：
  
  - **default-focus / Enter**：删除确认框的默认焦点落在「移入回收站」上，敲回车即生效；不可删除时焦点回落到「取消」，Esc 依旧取消。
  - **记住级联选择**：确认框里「同时删除子会话」的初值沿用上次的选择，存在宿主侧 `~/.dsh/session-trash/preferences.json`（Web 的 origin 带随机端口，localStorage 不可靠）；设置页可重置为默认不勾选。
  - **回收站单页化**：审计 / 体检 / 回执从面板里的三个页签搬到 **设置 → 会话回收站**；面板只剩列表 + 吸顶批量条，行内操作 hover 才出现。
  - **批量彻底删除不再被整单拒绝**：宿主单次上限 50 → 200，界面按 20 条分批执行，显示「处理中 n/total」、可中途停止、完成后汇总成功/失败并保留失败条目的选中状态。
  - **确认框精简**：正文压成「约 N KB · N 个子会话 · 正在运行」一行 + 一行引用数 + 级联勾选，「详情」折叠里放引用清单、子会话列表与回收站路径。

## 0.4.9

### Patch Changes

- [#81](https://github.com/kangyishuai/dsh-plugins/pull/81) [`d8e4c5a`](https://github.com/kangyishuai/dsh-plugins/commit/d8e4c5a94d28d4b725018c4dacb3f24bea43ec55) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Fix the trash-count badge's text colour in the dark theme.
  
  The badge paired its theme-adaptive fill (`--dsw-alias-state-error-primary`) with a hardcoded `color: #fff`. In the dark theme that fill is a *light* red (`#f25a5a`, designed for a dark foreground), so white-on-red dropped to **3.29:1**; pairing it with the host's `--dsw-alias-label-primary-foreground` gives 5.75:1 there and keeps 4.5:1 in the light theme.
  
  The foreground is now a named token (`dangerText`) next to the fill, and a regression test asserts the pair, plus that every theme token in the design map really exists in the host theme (a misspelt `var()` silently falls back to a hardcoded colour and stops following the theme).

## 0.4.8

### Patch Changes

- [#68](https://github.com/kangyishuai/dsh-plugins/pull/68) [`0fd4faa`](https://github.com/kangyishuai/dsh-plugins/commit/0fd4faa2c8ed893961d9b4bffac29ba0efd5ba5d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - macOS：自绘确认框 fallback 的遮罩声明 `data-window-drag-exclude`，覆盖页头时拖动不会再拖走整个 DSH 窗口。

## 0.4.7

### Patch Changes

- [#36](https://github.com/kangyishuai/dsh-plugins/pull/36) [`9bb615e`](https://github.com/kangyishuai/dsh-plugins/commit/9bb615e7369a604200d50333835eb154ce9e5354) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Use a template literal for the health-cleanup audit detail (Biome `useTemplate`), so `biome ci --error-on-warnings` stays clean on CI.

## 0.4.6

### Patch Changes

- [#35](https://github.com/kangyishuai/dsh-plugins/pull/35) [`01070d1`](https://github.com/kangyishuai/dsh-plugins/commit/01070d1f53e78aed4bc162de2123b23488264b9c) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Repository description and topics now cover both plugins (rewind and delete), so the packages are discoverable from the GitHub side as well.

## 0.4.5

### Patch Changes

- [#31](https://github.com/kangyishuai/dsh-plugins/pull/31) [`52d86f0`](https://github.com/kangyishuai/dsh-plugins/commit/52d86f02372073d8fe7ee471881b125ed7e7d356) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Tag the injected stylesheet with `data-plugin` so it is identifiable in DevTools (and by tests) as belonging to this plugin, matching the sibling plugin.

## 0.4.4

### Patch Changes

- [#6](https://github.com/kangyishuai/dsh-plugins/pull/6) [`83b4bd3`](https://github.com/kangyishuai/dsh-plugins/commit/83b4bd38d989e1f27302296cbb2231698f374b67) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 兼容性记录：补充 DSH 0.2.2-rc.1 的验证结果（`pnpm smoke:session-delete` 24 项断言全绿、插件在桌面版正常激活），README 徽章与兼容表更新到新宿主版本。

## 0.4.3

### Patch Changes

- [`03fc41b`](https://github.com/kangyishuai/dsh-plugins/commit/03fc41bb526ee0bf08e284dc2f48196c73f4090e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - README 增加截图（演示数据生成）与 npm / DSH 版本徽章。

## 0.4.2

### Patch Changes

- 文档同步：兼容性章节改为「三层防线 + 四档能力」（api/internal/minimal/unknown），
  补齐 0.4.x 的批量与刷新行为说明，并标注仅 macOS 实测、Windows 路径未验证。

## 0.4.1

### Patch Changes

- 批量操作移到回收站页签：勾选条目后可以全选、清空、批量恢复、批量彻底删除；
  移除原先那个列出活跃会话的「批量」页签。对话框内容区限制高度并支持内部滚动。

## 0.4.0

### Minor Changes

- 回收站面板新增「批量」页签：列出会话、多选后一次删除（逐条进回收站，
  单条失败不影响其它），结果写进回执（action=trash-many）。一次最多 50 条。

- 新增 minimal 能力档：宿主没有 workspaceRegistry（如 headless 组合）时仍允许删除，
  归档闸门与工作区记账步骤跳过并在回执中标记；只有持久化本体缺失才进入只读模式。

## 0.3.0

### Minor Changes

- 新增模型工具 session_delete：两段式 plan → 一次性 token → delete。
  拒绝删除调用者自己的会话；会话在预览后变化会让 token 失效；回执记录
  operator=agent，便于区分人工与模型操作。

- 删除确认框支持级联：通过 parentSession 血缘（任意深度）+ live 子代理活动
  发现子会话，默认不删，勾选后父会话与子会话分别进入回收站（可分别恢复），
  回执里记录每个子会话的结果。

### Patch Changes

- 模型工具对已删除的会话再 plan 时返回 code=not-found，而不是笼统的 error。

- 修复外部删除（agent 工具、另一个窗口、CLI）后列表不刷新的问题：
  客户端每 10 秒轮询一次会话列表、页面重新可见时立即拉取，已删除的行会自动消失；
  同一轮询也会刷新侧栏页脚回收站的计数（agent 工具/另一个窗口的删除同样反映）。

## 0.2.0

### Minor Changes

- 新增两个页签：**体检**对账会话存储与工作区记账，报告归档/置顶幽灵、工作区
  记账失效条目、孤儿会话目录、损坏的回收站条目与未完成操作（清理只动登记表，
  写入审计）；**回执**展示每次删除/恢复/彻底删除/清理的机器可读记录。

## 0.1.0

### Minor Changes

- 首个版本：真正的会话删除能力——默认移入回收站（可恢复）、删除前列出影响面的
  plan 预演、每次操作写审计日志，以及删除后的对账回执。
  
  版本从 0.0.0 起步，本 changeset 在发版时产出 0.1.0。
