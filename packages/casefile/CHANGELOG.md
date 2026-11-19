# @kangyishuai/dsh-casefile

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
