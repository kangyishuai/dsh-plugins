# @kangyishuai/dsh-advisor

## 0.6.4

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

## 0.6.3

### Patch Changes

- [#352](https://github.com/kangyishuai/dsh-plugins/pull/352) [`5a9bc5b`](https://github.com/kangyishuai/dsh-plugins/commit/5a9bc5bb606cfda427fabded5e0113b3d4fed4bd) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 审计（2026-11-28）P2/P3 修复：钱与预算层改为**原子追加 + 串行写队列**（usage/advice/decisions 不再「读全文 + 覆盖写」，工作区预算池的读-改-写不再丢更新），账本行记录**本地日键**并在重启时恢复会话/小时计数；`timeoutMs` 改为插件侧**硬超时**（到点 abort、提前返回 `timeout`、不落账），日预算/工作区池在发送前把**本次预估花费**算进去且两个闸统一为「已达上限即拒绝」。
  
  决策日志现在能真正回填三种下场（`accepted` / `user-typed-other` / `no-action`，并过滤宿主注入的 `user/message`），`/advisor report` 会显示可追踪分母；脱敏补上小写键名、JWT 与裸 `Bearer` token；client 内嵌字典与 `LOCALE_EXTRA` 的 30 个重复键已去重。残余风险（硬超时是插件侧执行、`/advisor` 在空白会话不可见、决策日志只记主会话）已写进 README「副作用、限制与风险」。

- [#371](https://github.com/kangyishuai/dsh-plugins/pull/371) [`c02cae9`](https://github.com/kangyishuai/dsh-plugins/commit/c02cae9c61758fa52cebc6b5e4ed6f12cd8e979f) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 用户模拟审计（2026-11-28）的 advisor 交互修复：`/advisor status|doctor|on` 等命令回执现在**第一行就是用户实际敲的命令行**（宿主通用命令卡片只显示命令名、单行省略号截断，多行输出要点第二层折叠），并新增插件自己的命令卡片（`conversation.chat.commandview` 的 `advisor` 渲染器）显示原始命令行 + 完整多行输出、不省略；宿主会在本地命令执行成功后广播 `command/executed`，插件据此把多行输出放进右下角的**命令回执面板**（常驻到手动关闭，空白会话里也能看到）。设置页首屏的「模式」行新增**生效状态徽标**：保存的 `mode` 只是偏好，`advisory` 但没选模型时显示「已关闭：未选择顾问模型」，`/advisor status` 与 `/advisor doctor` 同样分开报「模式」（保存值）和「生效」（真实状态）；`/advisor on` 在未配置模型时不再偷偷把保存的 `mode` 改成 `advisory`。工具结果不再把「顾问已关闭 / 未配置 / shadow」这类内部开关状态交给主模型，改成中性跳过并明确要求模型不要把它写进给用户的回复。斜杠菜单里的命令描述改为中英双语（host 半自己读 `locale/*.json` 的 `host` 段，宿主没有 locale 服务），并统一了用户可见文案里的繁体字「徵询」→「征询」。

## 0.6.2

### Patch Changes

- [#113](https://github.com/kangyishuai/dsh-plugins/pull/113) [`653bdb5`](https://github.com/kangyishuai/dsh-plugins/commit/653bdb5d21ac2c7ced31db1094f97069975f9333) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 区分「超时」与「取消」两个失败码：`AbortSignal.timeout(timeoutMs)` 触发的**超时**现在返回
  `code: "timeout"` 与文案「顾问调用超时（N 秒）」，只有用户 `/advisor cancel` 或回合中断才叫
  `aborted`。此前两者都归成 `aborted`，与 README 承诺的失败码清单（`timeout` 与 `aborted` 分列）
  对不上，真机上把一次 90 秒超时误报成了「被中止」。
  
  新增纯函数模块 `lib/abort-reason.js`（`classifyAbort` / `formatTimeout`）以便单测覆盖——`call.js`
  本身 import 宿主包，测试环境加载不起来。

## 0.6.1

### Patch Changes

- [#108](https://github.com/kangyishuai/dsh-plugins/pull/108) [`0863809`](https://github.com/kangyishuai/dsh-plugins/commit/086380951e59dbf57132943bb72fb51c1016bd68) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修决策日志的原因码归类：`aborted` / `blocked` 的回合现在直接记 `skipped-aborted` / `skipped-blocked`，
  不再落到 `skipped-other`。真实日志里出现过「回合被中断」被归为未识别的情况。

## 0.6.0

### Minor Changes

- [#98](https://github.com/kangyishuai/dsh-plugins/pull/98) [`87182b9`](https://github.com/kangyishuai/dsh-plugins/commit/87182b95f6ae22b439e967242d3e61d9c40386ef) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 新增**决策日志与复盘**，用来回答「该徵询的时候有没有徵询」：
  
  - `<DSH_HOME>/advisor/decisions.jsonl` 一个回合一行（没徵询的回合也记）：是否徵询、原因码、
    回答长度 / 工具调用数 / 是否报错、徵询后的 severity 与成本，以及用户下一条消息是否照着建议做（outcome）。
  - `pnpm advisor:review` 按「长/短回答 × 有无工具 × 有无报错」分桶给出徵询率与采纳率，
    并列出两类可疑样本：疑似漏徵询（有工具 + 长回答却没问）与疑似无效徵询（问了但用户另说别的）。
  - 只写本地文件：不联网、不改变徵询时机、不增加模型调用（仍是 `postAnswer: off` 的工作方式）。

- [#99](https://github.com/kangyishuai/dsh-plugins/pull/99) [`9204f38`](https://github.com/kangyishuai/dsh-plugins/commit/9204f38d39d35639357994b5a946fb3910e3d3e4) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把设置从「通用设置里的一大张卡」搬到**独立设置分节 设置 → 顾问**：
  
  - 首屏只留三行摘要：模式（可直接改）、路由、预算；
  - 其余项（基础 / 预算 / 隐私 / 高级与状态 / 状态诊断）收进「更多设置」折叠，默认收起；
  - 保存 / 重新加载动作条位置不变，行为不变；不看设置的人少滚动一屏。

## 0.5.1

### Patch Changes

- [#80](https://github.com/kangyishuai/dsh-plugins/pull/80) [`3d05174`](https://github.com/kangyishuai/dsh-plugins/commit/3d05174af557f2f912494cd5935d320fe27425a2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Fix the warning text in the settings card and the per-turn warning, which never followed the light/dark theme.
  
  Both rules used `--dsw-alias-state-warning-primary`, a token the host theme does not define — the real name is `--dsw-alias-state-warn-primary`. A misspelled `var()` does not fail loudly: it silently falls back to the hardcoded `#b7791f`, so the "unsaved changes" hint and the per-turn warning kept the same colour in both themes instead of using the host's warning palette.
  
  They now use `--dsw-alias-state-warn-label` (the host's own warning *text* token) with `--dsw-alias-state-warn-primary` as the fallback, matching how the host styles warning copy.
  
  A regression test now asserts that the injected stylesheet only references theme tokens that really exist in the host theme, and that both warning rules use the host warning tokens.

## 0.5.0

### Minor Changes

- [#64](https://github.com/kangyishuai/dsh-plugins/pull/64) [`cf76f4d`](https://github.com/kangyishuai/dsh-plugins/commit/cf76f4d2cccb2c5968d4ebaf671c5bf25f6e4041) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add cache-token pricing: `priceCacheReadPerMTok` / `priceCacheWritePerMTok` (0 = unpriced, with a status warning), include cache read/write tokens in cost and budget accounting, record cache-write tokens in the ledger, and recompute/charge the two-pass evidence call after its usage is merged.

## 0.4.0

### Minor Changes

- [#62](https://github.com/kangyishuai/dsh-plugins/pull/62) [`ebd331e`](https://github.com/kangyishuai/dsh-plugins/commit/ebd331e0dd4b93ce74f90691ba39720f4b9ecce8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add first-class CNY support: `currency` (USD/CNY) plus a manual `usdToCny` rate; budget and unit-price settings are stored in the selected currency while the ledger, workspace pool and guards stay in USD. Old `maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd` keys migrate as USD, switching currency converts the form amounts at the rate, and status/preview/doctor/advisor-line output uses the selected currency.

## 0.3.0

### Minor Changes

- [#58](https://github.com/kangyishuai/dsh-plugins/pull/58) [`f2ac925`](https://github.com/kangyishuai/dsh-plugins/commit/f2ac925dc633ee90fa41320a308921998d0a0def) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Rework the settings card: `off` shows a compact state, basics and advanced settings are separated with advanced folded by default, field help moved behind an inline `?` button, and money fields now accept decimals (budgets 2, unit prices 4).

- [#61](https://github.com/kangyishuai/dsh-plugins/pull/61) [`962a735`](https://github.com/kangyishuai/dsh-plugins/commit/962a735ce7b02da6a8de61606c45d2379bdaea36) Thanks [@kangyishuai](https://github.com/kangyishuai)! - The advisor line can show a bounded preview of what was actually sent: `tracePrompt` (default `preview`) stores the first and last 2,000 characters of the redacted transcript in the session record, with a “View sent content” toggle in the expanded line; `off` stores metadata only.

- [#60](https://github.com/kangyishuai/dsh-plugins/pull/60) [`9e58651`](https://github.com/kangyishuai/dsh-plugins/commit/9e586511e9fffe804a2753c4a03879f6c732ab82) Thanks [@kangyishuai](https://github.com/kangyishuai)! - The advisor turn line now shows the trigger, local time, advisor model, characters sent and the usage/cost summary for each consultation; new advice records store `requestChars` so the line can show the sent size.

## 0.2.0

### Minor Changes

- [#55](https://github.com/kangyishuai/dsh-plugins/pull/55) [`7a750a7`](https://github.com/kangyishuai/dsh-plugins/commit/7a750a7875798cd4df3ea8df87011f32bf26f8fd) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Close the gaps that previously depended on users declaring everything by hand, and make the advisor able to check facts.
  
  - Built-in model catalog: capability ranks and reference unit prices used as a fallback when `tiers` / prices are not declared. Unknown models stay "unverified" instead of being guessed.
  - `allowedModels` allowlist (filtered in the picker, enforced in `setModel` / `updateSettings`) and a shared **workspace budget pool** (`<DSH_HOME>/advisor/budget.json`) counting calls and estimated cost per local day across sessions.
  - `/advisor preview` shows exactly what would be sent (nothing is sent) and `/advisor confirm` authorises the first cross-provider consultation.
  - Opt-in two-pass evidence (`advisorTools`): the advisor may request files from the session working directory (≤5 files, ≤64 KiB each, read-only, `../` and symlink escapes rejected) and revise its advice against the quoted evidence.
  - Optional post-answer review (`postAnswer: "card"`), dedupe + immune window for passive deliveries, adoption confidence levels, a cross-session advice ledger with `/advisor report all`.
  - The settings card exposes every new field (workspace ceilings, allowlist, post-answer, evidence, preview and confirm).

## 0.1.0

### Minor Changes

- [#47](https://github.com/kangyishuai/dsh-plugins/pull/47) [`488a0c3`](https://github.com/kangyishuai/dsh-plugins/commit/488a0c3e1bcc3ce44a6e666c5ff82da788b5fc83) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add `@kangyishuai/dsh-advisor`: the main model can consult a separately configured (usually stronger) model at key moments — before committing to an approach, when an error keeps recurring, and before declaring a task done.
  
  - Registers an `advisor` tool (no required parameters) and an `/advisor` command (`status` / `on` / `off` / `shadow` / `ask` / `cancel` / `report` / `doctor` / `<provider>/<model> [effort]`).
  - The advisor reads the rendered conversation **including tool calls and results**, and answers with a structured verdict (`reviewed` / `declined`, severity, risks, acceptance criteria, evidence anchors).
  - `off` / `shadow` / `advisory` modes; shadow runs the advisor after a completed turn and only records it, never feeding it back.
  - Token ledger at `<DSH_HOME>/advisor/usage.jsonl` plus four budget ceilings (per turn, session, hour, per-day cost), because the host does not record usage for extra model calls.
  - Model and thinking effort are chosen from the providers already configured in DSH (Settings → Models); the plugin never stores base URLs or API keys.
  - Breaks nothing by default: the plugin starts in `off` mode.
  - A settings card in **Settings → General**: mode, provider/model picker, thinking effort from the model's real metadata, four budget ceilings with unit prices, privacy scope, ledger summary and `doctor` output.
  - Evidence-anchor verification (a cited tool-call id / message id / path that does not exist downgrades the advice) and a conservative adoption report (`/advisor report`), plus a compact advisor line under each turn.
