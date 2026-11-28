# @kangyishuai/dsh-casefile

## 0.9.1

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

## 0.9.0

### Minor Changes

- [#358](https://github.com/kangyishuai/dsh-plugins/pull/358) [`5506115`](https://github.com/kangyishuai/dsh-plugins/commit/5506115dee9af5b17ea46645bc77a8a72dff28a9) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 安全与契约修复（AUD-CASEFILE 簇）：`case_project` 新增 `trash` / `restore` / `purge` 三个回收站动作与 `dryRun` 参数（`drop` 增加 dry-run、影响面与数据根审计，`purge` 硬删需显式 `confirm`），工作台新增回收站入口；`report` 新增 `redact` 选项并默认脱敏（与规格包/bundle 共用脱敏，报告页脚标注脱敏状态；脱敏范围扩展到通用系统根路径、`~/`、带扩展名的绝对路径与 AIza/JWT/私钥块等 token 形态）。回收站恢复会先校验条目里的 `project.json`（坏条目——包括版本高于本插件的条目——保留在回收站并写失败审计）；回收站列表对不可读/更高版本的条目降级为「元数据未知」而不是整表报错；`drop` 的 dry-run 返回 `previewTrashPath`（预览路径，实际落点会重新取时间戳），`purge` 的 dry-run 返回 `trashRoot`。`case_project` 的 action 枚举补齐 `autonomy`/`bundle`/`trash`/`restore`/`purge`；`case_evidence.input.kind` 改为枚举且未知种类落 `other` 并记 `kindRaw`；`open` 可打开已有项目，任何显式 `projectId` 调用都会建立可持久化的会话指针；新增 `maxArtifactBytes`（默认 64 MiB）与「先校验后归档」；`settings.section` order 改为 96。

### Patch Changes

- [#375](https://github.com/kangyishuai/dsh-plugins/pull/375) [`a8b7b2f`](https://github.com/kangyishuai/dsh-plugins/commit/a8b7b2fcb717b8f41ab7e237398e003f0267d49a) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 复审 follow-up（2026-11-28 `batch-ui-1` A1–A4/A6）：
  
  - **审计来源可区分**：危险操作（drop / restore / purge / restore-failed）不再把所有审计行硬编码成 `actor:"user"`。`case_project` 工具路径显式记 `actor:"agent"` 并带上会话 `sessionId`，回收站 UI（Remote）显式记 `actor:"user"`，直接调用的脚本没传来源则如实记 `unknown`——`audit.jsonl` 现在能回答「这次 drop 是用户点的还是模型自己决定的」。
  - **危险操作可访问性**：展开「危险操作」时焦点进主按钮；dry-run 影响面出现时焦点移到「取消」（以前焦点掉到 `document.body`），预览卡带 `role="alert"` + `aria-live="polite"`；取消后焦点还回入口。vm 测试驱动真实 `client.js` 断言三条焦点路径。
  - **文档**：双语 README 的卸载残留清单补 `builder-sessions.jsonl`，数据布局树与卸载清单对齐。
  - **冒烟诚实性**：桌面只读脚本新增「危险操作默认收起（`details.open === false`）」断言；空 profile 上 4 条危险操作断言由「记 PASS」改为 SKIP 并计数，不再假绿。

- [#365](https://github.com/kangyishuai/dsh-plugins/pull/365) [`c1d8c1b`](https://github.com/kangyishuai/dsh-plugins/commit/c1d8c1b9a771ea2b435e1bd1b92074efa366d5a5) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 工作台 UX 修复（用户模拟审计 USIM-U1-04/05/16、U2-16、U3-07/11）：空态改成「是什么 / 适合谁 / 第一步」的人话引导，工具名收进「给开发者 / AI 的说明」折叠；设置里 REA 未接入改为可选/不可用说明而不是红色错误；新建项目表单补齐标签与必填校验（失焦/提交高亮 + 可读错误、提交中禁用、失败提示）；「运行」tab 重复的空态文案去重；自主性悬浮提示改人话并保留 L0–L3 副标题；项目详情页新增默认收起的「危险操作 → 移入回收站」（先 dry-run 影响面再显式确认），`case_project drop` 的工具描述要求「用户明确同意、不得自行调用」；双语 README 新增「卸载后残留 / Uninstall」与手工清理说明。

## 0.8.1

### Patch Changes

- [#224](https://github.com/kangyishuai/dsh-plugins/pull/224) [`2d457bb`](https://github.com/kangyishuai/dsh-plugins/commit/2d457bb48eb2ff063c4ed78567c1998ce2dd1080) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个**真机才暴露的枚举错配**：摄入契约里的 `evidence.kind` 白名单与 `core/model.js` 的枚举**不一致**。
  
  - 契约里多了 `network` / `artifact`，模型里没有 → 摄入被模型层拒绝：
    `kind 必须是 pseudocode | assembly | … 之一，收到 "network"`；
  - Craft 适配器把 `capture.network` 映射成 `network`，于是**第一条网络类证据之后的摄入全部失败**（先写入的 1 条留在库里，看起来像"部分成功"）。
  
  修法：契约的 kind 列表**对齐模型枚举**；Craft 的 `network/capture` 映射为 `har`。
  
  新增回归测试：把适配器可能产出的**所有 operation 家族**逐个过 `validateIngestPayload` + `normalizeEvidence`——枚举一旦再错配就会红。反证过（把 `har` 改回 `network`，5 条测试立刻失败）。
  
  ## 为什么之前没抓到
  
  既有测试只断言"映射出的 kind 等于我期望的值"，而"我期望的值"本身就错了。这次让测试**真的过一遍模型校验**，才把契约与模型焊在一起。

## 0.8.0

### Minor Changes

- [#222](https://github.com/kangyishuai/dsh-plugins/pull/222) [`59c8d4a`](https://github.com/kangyishuai/dsh-plugins/commit/59c8d4ae0d843fea576cd05337ce26b1a7c7d221) Thanks [@kangyishuai](https://github.com/kangyishuai)! - `case_ingest` 支持**自动识别并映射 Craft Anything 的报告**（证据账本形状）。
  
  依据 Craft 的公开文档字段（`subject / operation / result / confidence / authority / limitations / locations` + 独立的 `unknowns`）做**纯字段搬运**：
  
  | Craft 字段 | 映射到 |
  |---|---|
  | `operation` + `subject` | evidence 的一句话 summary |
  | `operation` 前缀（disasm/analy/parse/string/js/network/screenshot/plist/signature…） | evidence.kind |
  | `limitations` | 原样保留 + 追加一句"由 Craft 产出、casefile 未复核" |
  | `locations[].path` | refs |
  | `unknowns[]` | 案卷未知项（保留 severity） |
  
  只搬运、不解释：`authority` 仍固定 `external`，producer 仍注明"不背书"。
  
  ⚠️ **未用真实样例验证**：本机没有装 Craft，映射按公开文档字段写。拿到真实报告后若字段改名会报 `invalid-input`（而不是静默丢字段）。已符合契约的 payload 不会被误判成 Craft 报告（有测试）。

## 0.7.1

### Patch Changes

- [#220](https://github.com/kangyishuai/dsh-plugins/pull/220) [`778d281`](https://github.com/kangyishuai/dsh-plugins/commit/778d2814d0465e4be64d32e722e1b2c24a802963) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 bundle 里的一处真实缺陷：**同一产物被多条证据引用时，`artifacts` 清单会重复列出同一条**。
  
  实测触发：用 REA 导出的证据包做外部摄入时，一份报告被挂到 2 条证据上 → bundle 的 `artifacts` 出现两次 `5568fd27e50f`（各 14,138 字节）。
  
  清单的语义是「有哪些产物」，不是「被引用了几次」，所以现在按 `sha256` 去重。有测试固定；反证过（去掉去重该测试立刻红）。

## 0.7.0

### Minor Changes

- [#218](https://github.com/kangyishuai/dsh-plugins/pull/218) [`db9b102`](https://github.com/kangyishuai/dsh-plugins/commit/db9b1024ab7390d6ef1b9c4801c2259852177f23) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 新增 **外部报告摄入契约 v1**：新工具 `case_ingest`
  - `case_ingest schema`：返回契约形状与规则，方便别的 agent（Craft 等）生成正确格式；
  - `case_ingest ingest`：把外部 agent 的报告写进案卷，`dryRun` 可先预演。
  
  **立场写死在实现里**：`authority` 固定 `external`、`producer.confirmationNote` 注明"外部 agent 产出，casefile 只记录与引用，不背书"。casefile 不解释对方语义，也不替它补不确定性。
  
  契约要点：
  - `claims[].evidenceIds` 用**数组下标**引用本次 payload 的 evidence，摄入时映射成真实 id；**越界直接报错**（不静默丢引用，那会让结论变成无出处）；
  - `source.reportPath` 若给出，会归档进项目目录并记 sha256（`/tmp` 会过期）；
  - 未知项保留对方给的严重度。
  
  顺带两处小改：`addEvidence` 允许直接复用已归档的 `artifact`（同一份外部报告可以同时是多条证据的出处）；`case_ingest` 纳入写类工具的 builder 只读守卫。
  
  **真机验证**：用 REA 真实导出的证据包（14,138 字节 / 2 条记录）作输入，先 `dryRun` 再摄入 → 归档 sha256 `5568fd27…`、2 证据 / 2 结论 / 2 未知项、producer 与 claim↔evidence 映射全部正确。web 端到端 52 → **56 项断言全绿**。

## 0.6.0

### Minor Changes

- [#214](https://github.com/kangyishuai/dsh-plugins/pull/214) [`460b2f1`](https://github.com/kangyishuai/dsh-plugins/commit/460b2f1f78dfc0366e065fe7453cfe2b8c45f37e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - `case_project report` 支持 HTML 输出：`format: "md" | "html" | "both"`（默认 `md`，行为不变）。
  
  HTML 是**单文件归档件**：内联样式、零外部资源（无脚本、无 CDN、无字体外链），十年后离线打开仍是这个样子。内容含概览、计数、义务、检查、证据生产者（带责任声明）、未知项、循环状态。
  
  安全：所有插值经 `escapeHtml`（`& < > " '`）。真浏览器验证过——标题里塞 `<b>加粗</b>` 会被当**字面文本**显示，不会渲染，因此可以放心发给别人。
  
  零依赖，符合 ADR 0001（无打包器）。

- [#216](https://github.com/kangyishuai/dsh-plugins/pull/216) [`567ec25`](https://github.com/kangyishuai/dsh-plugins/commit/567ec25236f436a2ee385988184344c2bceeab2e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - **L3 无人值守**（用户已批准的范围）+ 两个由冒烟暴露的真实缺陷。
  
  ### L3 无人值守
  `case_project autonomy`：查看当前级别（不带 `level`）或设置级别（带 `level`）。
  
  **硬条件**（不可配置放宽，不满足就返回 `autonomy-blocked` 并列出 blocker）：
  - 只有 `scope: "selected"` 的项目能升 L3；
  - 只有 `existence` / `structure` / `behavior` / `visual` 四类义务允许 L3；`coverage`（覆盖率硬门）与 `regression`（回归门）**永远人工复核**；
  - 每条义务必须有可执行的检查配方（`check`），否则"没人验"会被自动跑成绿灯；
  - 必须有预算上限（默认 5 轮 / 20 次 build / 30 分钟），预算耗尽或**任一轮 fail/unknown 立即停**。
  
  解锁与停止都写审计（`autonomy/unlock` / `autonomy/stop`）；**降级永远允许且立即生效**——这是"停"的开关。面板顶部显示当前级别（`data-casefile-autonomy`）。
  
  ### 顺带修掉两个冒烟暴露的真缺陷
  1. **`process` checker 遇到非零退出报 internal**：`service.runner` 在"非零退出且无输出"时直接 reject，checker 拿不到退出码，本该判 `fail` 的变成了 internal 错误。现在 runner 只对"命令根本没跑起来"（`exec` 的 127/126 且无输出，注意它是**数字**不是 `ENOENT` 字符串）reject，其余一律返回 `exitCode`。
  2. **命令不存在应判 `unknown` 而不是 `fail`**：checker 对 runner 抛错做兜底 → `verdict: "unknown"`、`reason: "runner-error"`，避免把"没跑起来"误报成"构建失败"。
  
  ### 冒烟夹具
  `casefile-png-fixture.mjs` 新增 `texturedPng`（渐变+棋盘）；`web` checker 冒烟改用有纹理的图——**纯色图现在会被 blank-image 规则直接拦下**（那是另一条断言的事）。web 端到端重回 **52 PASS / 0 FAIL**。

- [#215](https://github.com/kangyishuai/dsh-plugins/pull/215) [`3e677a4`](https://github.com/kangyishuai/dsh-plugins/commit/3e677a439fb578dba5aeb28aef1d7c7992f5653d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 新增**机器可读证据包**：`case_project bundle`（`redact` 默认 true）→ `bundles/<时间戳>/bundle.json`。
  
  与规格包的分工：
  - **spec pack**（`case_brief`）= 只含被选中的结论，面向"交给编码 agent 去复刻"；
  - **bundle** = 全量账本（证据/结论/义务/检查/未知项/产物清单），面向"整段交接给另一个 agent，或几个月后自己回看"。
  
  硬要求是**确定性**：
  - `generatedAt` 取自数据自身的最大时间戳，**不是** `Date.now()`；
  - 键排序规范化后写入，同一份数据导出两次**字节一致**（有测试断言）；
  - 自带 `integrity = { algorithm, canonical, digest }`，接收方可去掉 `integrity` 后独立重算校验（已用一个不依赖 casefile 代码的独立消费者脚本验证通过）。
  
  顺带补上 `case_obligation` 的 `claimIds`：义务可以声明"我验证的是哪条结论"，这样 bundle 接收方能直接回答**「哪条结论还没人验」**——这是交接时最常被问的问题。

### Patch Changes

- [#211](https://github.com/kangyishuai/dsh-plugins/pull/211) [`50028ea`](https://github.com/kangyishuai/dsh-plugins/commit/50028ea382386db5ba5ae1148a82d9854f7e8792) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个**假成功防护缺口**（`spec/03-acceptance.md` 防护清单第 5 条，代码此前缺失）：
  
  **空白/纯色截图会被判 pass。** 实测两张纯白图（各 64×64）走 `web` checker 得到相似度 1.0 → 判 `pass`。也就是说：如果页面渲染失败、截图输出一张白图，而原件恰好也是白图（或对比的两次都白），验收会**绿灯**。
  
  现在 `web` checker 在比较前先判「图有没有信息量」：主色占比 ≥ 99.5% **且** 颜色种类 ≤ 8 → `fail`，`detail.reason = "blank-image"` 并指出是哪一边（`reference` / `candidate`）。
  
  阈值刻意保守：带小图标的真实页面颜色种类远多于 8、主色占比也到不了 99.5%，不会被误伤（有测试覆盖「两色各半 → 仍 pass」）。
  
  实现顺序上的一个细节：**必须两张图都解码成功才做空白判定**，否则「候选图是坏 PNG」会被误报成 blank-image，而正确结论是 `unknown`（有对应测试）。

## 0.5.1

### Patch Changes

- [#208](https://github.com/kangyishuai/dsh-plugins/pull/208) [`377aa2a`](https://github.com/kangyishuai/dsh-plugins/commit/377aa2a5b24eb5c146d07be9b474e6deed07e7f4) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 `case_app inspect` 的一个真实 bug：**Info.plist 可能是 XML 或二进制，不能直接 `JSON.parse`**。
  
  实测拿 Bob.app 跑就炸了（`Unexpected token '<', "<?xml vers"... is not valid JSON`）。现在统一先用 `plutil -convert json -o -` 转换；runner 不可用时，只在文件本身就是 JSON 形式时接受，否则报 `invalid-input` 并说明需要在 macOS 上用 plutil。
  
  回归测试直接用 XML plist 构造应用包（反证过：把 plutil 那行去掉测试立刻红）。

## 0.5.0

### Minor Changes

- [#206](https://github.com/kangyishuai/dsh-plugins/pull/206) [`0922acf`](https://github.com/kangyishuai/dsh-plugins/commit/0922acfd193f1ef912d4ce33bf9535000bf4fb70) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 两件事，都来自 Bob.app 那一轮真实使用暴露的问题：
  
  **1. 项目溯源锚点**
  开项目时记录 `reaVersion` + `capabilityHash`（REA 工具面名字集合的 sha256 前 16 位）。
  版本来源是 profile patch 文件里实际被启动的 `rea-agents@x.y.z`（读不到就留 `null`，不猜）；
  工具面哈希始终可算。新 Remote `provenanceInfo` 可随时查当前探测结果。
  之前 `project.json` 的 `reaVersion`/`capabilityHash` 一直是 `null`——半年后没人知道当时用的是哪套工具。
  
  **2. 应用勘察第一跳：新工具 `case_app`**
  `case_app inspect` 读 macOS `.app` 的 `Info.plist` 与可执行架构（`plutil`/`lipo`），一次给出一屏摘要：
  bundle id、版本/build、最低系统、`LSUIElement`、沙盒声明、ATS 是否放开、URL scheme、文档扩展名、
  导出 UTI 前缀，并自动判定**归属域一致性**（bundle id 域 vs UTI 域），最后顺手写一条结构证据。
  
  动机：`inspect_desktop_application` 对纯原生 Swift 应用返回 `candidates: 0`，等于没回答"这是什么 app"，
  当时只能手工 `file`/`plutil`/`ls`。现在这一跳有答复，且字段读不到一律 `null`，不编造。

## 0.4.1

### Patch Changes

- [#204](https://github.com/kangyishuai/dsh-plugins/pull/204) [`7d018c3`](https://github.com/kangyishuai/dsh-plugins/commit/7d018c343af4a3d0f5f598b896a33f4aab984a0d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修等待登录横幅不出现的根因：`installSessions()` 重建 actions 时**漏了 `onWaitChange`**，于是 `await-login` 期间 host 的等待状态从未被设置，`accessState` 恒为 `{active:false}`，client 覆盖层自然不渲染。
  
  - 抽出 `actionOptions()`，构造函数与 `installSessions()` 共用同一份选项（含 `onWaitChange`）；
  - 新增单测：`await-login` 必须上报一次等待态（`active:true`）并在结束时清空（`null`）。
  
  实测证据：重启后跑真实 `await-login`（18s 超时路径），DSH 窗口里连采 18 次、`active` 全为 false、横幅 0 次出现 —— 定位到 host 侧状态根本没设。

## 0.4.0

### Minor Changes

- [#202](https://github.com/kangyishuai/dsh-plugins/pull/202) [`f2dfd99`](https://github.com/kangyishuai/dsh-plugins/commit/f2dfd99a29e52489b50fa8e219a65784abd9cba6) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 两件事：
  
  **1. 等待登录的界面提醒（`shell.overlay` 覆盖层）**
  `case_access await-login` 现在会在等待期间把状态挂到 host（`accessState`），client 半在 `shell.overlay` 注册一个右下角小横幅：「案卷：等待登录 / 请在弹出的浏览器窗口里完成登录；就绪后会自动继续 / 已等待 Ns」。每 2 秒轮询一次，就绪即消失；**是非阻塞提醒，不是模态框**，不打断任何操作。文案双语。
  
  **2. 项目生命周期：`archive` 与 `drop`**
  - `case_project archive`（`reason` 可选）：状态转 `archived`，文件全留，写审计。用于误建/暂存项目。
  - `case_project drop`（**必须 `confirm: true`**）：把 `projects/<id>` 整个移进 `<dataRoot>/trash/<时间戳>-<id>`，**可手动移回**；不传 confirm 直接 `confirm-required` 拒绝，且项目不会消失。
  - 两者都进审计（`project/archive`）。
  
  背景：实测中 `case_build cycle` 起的 builder 会话误建过一个项目（`casefile-replica`），当时既没有"归档"也没有"移除"，只能卡在 `investigating`。builder 侧已由 `builder-readonly` 守卫修复，项目侧的出口由这次补上。

## 0.3.0

### Minor Changes

- [#200](https://github.com/kangyishuai/dsh-plugins/pull/200) [`cce7979`](https://github.com/kangyishuai/dsh-plugins/commit/cce797975d36b0aa1a474dd19855f61fdcfa4a2d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 两件事，都来自真实使用中撞到的问题：
  
  **1. 产物归档（修根因）：`case_evidence` 新增 `artifactPath`**
  外部采集产物默认落在 `/tmp`，一清理就再也算不出 sha256，项目只能永远停在 `investigating`——实测有三个项目因此关闭被硬门拒绝。现在传 `artifactPath` 会把产物**接管进项目目录**（`projects/<id>/artifacts/<sha256前16位><ext>`），记录 `sha256` / `bytes` / `originalName`；同内容只存一份，文件缺失直接报 `invalid-input`。
  
  **2. 等登录（人机协作）：新增工具 `case_access`，动作 `await-login`**
  登录态页面要人参与，agent 既不能干等、更不能假装成功：
  - 轮询 CDP 页面上的**就绪判据**（默认「页面里没有密码输入框」，可自定义 JS 表达式）；
  - 三态返回：`ready` / `timeout` / `error`，带 `attempts`、`waitedMs` 与**可直接转述给人的 hint**；
  - 浏览器还没起（连接被拒）算"可以继续等"，等满 `timeoutMs`（默认 3 分钟）报 `timeout` 并保留现场；
  - 每次调用写审计 `access/await-login`。
  
  限制：等待发生在单次工具调用生命周期内；`case_access` 属写类工具，builder 会话会被 `builder-readonly` 拒绝。

## 0.2.2

### Patch Changes

- [#197](https://github.com/kangyishuai/dsh-plugins/pull/197) [`edbee04`](https://github.com/kangyishuai/dsh-plugins/commit/edbee041d81f3df6f9e3b101e651a4be44741a58) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个真实的隔离漏洞：**builder 子会话可以写账本**。实测中一次 `case_build cycle` 起的 builder 会话自己建了一个项目（`casefile-replica`），这与「builder 只收到规格包」的设计直接矛盾，也让净室 attestation 失去意义。
  
  现在 `startBuilder` 会把子会话 id 记进数据根级 `builder-sessions.jsonl`，所有写类工具（项目/证据/结论/功能/未知项/义务/构建/检查）开跑前统一过一道守卫：命中 builder 登记就返回 `builder-readonly`。读类与导出不受影响。

## 0.2.1

### Patch Changes

- [#196](https://github.com/kangyishuai/dsh-plugins/pull/196) [`ed7d12f`](https://github.com/kangyishuai/dsh-plugins/commit/ed7d12ff6352ad40a5f7035cabf644fe74204b21) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 规格包 `brief.md` 的证据段现在显示**生产者**（工具 · 版本 · 获取方式 · 用户是否确认）。此前只写进 `spec.json`，人类可读的那份看不到"谁采的"——外部工具（Scrapling 等）摄入时就少了一环可核对信息。

- [#194](https://github.com/kangyishuai/dsh-plugins/pull/194) [`a315193`](https://github.com/kangyishuai/dsh-plugins/commit/a3151931e0ff48b6bb42715a9e2dea997505d645) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补「证据生产者」的报告层测试：`summarizeProducers` 的去重与"未声明不补 true"，以及 `report.md` 里的生产者表 + 责任声明。此前只有模型层测试，报告渲染无覆盖。

## 0.2.0

### Minor Changes

- [#192](https://github.com/kangyishuai/dsh-plugins/pull/192) [`0f8987a`](https://github.com/kangyishuai/dsh-plugins/commit/0f8987a1390444fcc24db6aa2bdb9e4df919ce98) Thanks [@kangyishuai](https://github.com/kangyishuai)! - **采集边界与外部生产者记录（A 方案）**
  
  - 证据新增 `producer`：工具、版本、获取方式（`headful` / `headless` / `api` / `archive` / `manual` / `stealth` / `unknown`）、产物类型、`accessConfirmedByUser` 与说明。casefile 不采集内容，只摄入并记录生产者——所以任何外部工具（REA、Scrapling、代理 HAR、手动截图）的产物都能喂进来。
  - 规格包与验收报告都带生产者信息；报告新增「证据生产者」表，并声明采集方式由操作者选择与执行、责任归操作者。
  - `DISCLAIMER.md` 改写为三段式采集边界：Tier 1 直接支持（人类等价浏览 / 官方 API / 公开归档 / 摄入外部产物）；Tier 2 需明示确认并只记录（自己的会话、标为 `stealth` 的方式）；Tier 3 完全不提供（打码、指纹伪造、代理轮换、高频批量抓取），且明确「把手段挪到别的工具里，性质不变」。

## 0.1.2

### Patch Changes

- [#190](https://github.com/kangyishuai/dsh-plugins/pull/190) [`9a9b389`](https://github.com/kangyishuai/dsh-plugins/commit/9a9b3899c5a337a42f90586227e62d9bcd4054cb) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修三处真实缺陷（0.1.1 起存在）：
  
  1. **`case_project` 的 `close` / `report` 动作不可用**：schema 里声明了这两个值，但工具实现里没有对应分支，调用直接返回「未知 action」。已在 `switch` 里补齐（`close` 先做只读预览、被闸门拒绝时带回卡点）。新增静态守卫：任何工具声明了 action 枚举，就必须有 `case` 分支或 `assertAction` 白名单覆盖每个值。
  2. **`case_build cycle` 只传 `cwd` 会误启 builder 会话**：`cwd` 本是构建目录，却被当成「要 builder」的信号，白起一个子会话并等它超时。改为只有显式给 `prompt` 或 `featureIds` 才起 builder。
  3. **`screen_judge` 被错列为 REA 必需/可选工具**：它不在 `mcp__rea__*` 工具面里（是 build-computer 的检查类型），导致 `diagnose` 永远报「可选能力缺失 1 项」。换成真实存在的 `check_build_task`，诊断不再误导。

## 0.1.1

### Patch Changes

- [#188](https://github.com/kangyishuai/dsh-plugins/pull/188) [`046df92`](https://github.com/kangyishuai/dsh-plugins/commit/046df92596e16fd394b1e8ea0c9a9a29dd257816) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修掉一处会让 CI 偶发变红的测试：`slugify` 对无法拉丁化的标题（如「中文标题」）会回落到 `project-<时间戳>`，而旧断言把两次调用的结果直接比较，跨毫秒必失败。改为断言前缀与 `ID_RE` 形状。

- [#186](https://github.com/kangyishuai/dsh-plugins/pull/186) [`d54e1ae`](https://github.com/kangyishuai/dsh-plugins/commit/d54e1ae5752bafb010a8b677f809d07e51afc295) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修正 npm/插件索引里显示的英文描述：`package.json#description` 之前写成了中文，导致 Discover 卡片的 `description.en` 显示中文。改成英文一行说明（中文描述仍由 `scripts/index-meta.json#descriptionZh` 提供）。

## 0.1.0

### Minor Changes

- [#151](https://github.com/kangyishuai/dsh-plugins/pull/151) [`a898e41`](https://github.com/kangyishuai/dsh-plugins/commit/a898e41480b55bc7a1f4a3d4f852a1f96b82e335) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 新增 casefile：REA 之上的循证逆向工作台（不做桥、不带引擎）。
  
  - **项目与证据**：项目态（目标 + 授权档 + 范围）、证据账本（保留 REA 的 confidence/authority/limitations）、结论（claim）与勾选、功能分组、未知项。
  - **交付物**：规格包 `spec.json` + `brief.md`（默认脱敏：本机路径、token 形态），未知项随包；验收报告 `report.md` + `report.json`（全局与按功能覆盖率、义务表、带实现 digest 的检查表）。
  - **验收**：五类 checker —— `build` / `cli` / `web`（自带 PNG 解码，无第三方依赖）/ `process`（退出码、输出、文件副作用与 SHA-256）/ `selfTest`（项目自测 JSON 契约）。崩溃、超时、缺图、报告不可解析一律 `unknown`，永不默认通过。
  - **闭环**：`case_build cycle` 一次调用完成（可选 builder 会话 → 构建 → 检查 → 关闭）；实现变化后旧 PASS 自动 stale 重开；接近但不对的改动必须判失败（near-miss 测试覆盖）。
  - **硬门**：关闭项目要求无未关闭义务、无未解决未知项、覆盖率达标、检查新鲜且实现 digest 一致，逐条报出卡点。
  - **授权档**：`research` 档默认禁止起复刻构建，需显式覆盖并留审计。
  - **净室 attestation**：记录投喂给 builder 的 prompt/规格摘要与「不要读取原件」指令是否在 prompt 里，并如实标注工具面未做白名单隔离。
  - **界面**：侧栏「案卷」入口、工作台（证据/义务/运行三页签）、跨项目总览条、设置分节（数据根、REA 能力状态）。
  - **工具**：9 个模型工具（`case_project` / `case_evidence` / `case_claim` / `case_feature` / `case_unknown` / `case_obligation` / `case_build` / `case_check` / `case_brief`）。
  
  数据只落本机；不做 MCP 桥、不做 token 网关、不带分析引擎、无 DRM/反调试绕过。
