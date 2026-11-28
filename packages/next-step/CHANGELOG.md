# @kangyishuai/dsh-next-step

## 0.5.0

### Minor Changes

- [#354](https://github.com/kangyishuai/dsh-plugins/pull/354) [`7d07c33`](https://github.com/kangyishuai/dsh-plugins/commit/7d07c3369982d2df26d8bda4a3fcc9cf90f7bf07) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 本批审计（AUD-NS-01…08）的行为修复：下一轮开始时不再取消在途生成，而是让它跑完并把候选以 `shown:false` 落库（**这不是省钱改动**：跑完会比中止多付输出 token；换来的是接近完成的调用不再被丢弃、诊断与报表里记为 `superseded`；该候选不进对话流、不占 `maxCardsPerSession`、不进曝光、不可揭示）；更早轮次、未决策的卡默认折叠成一行「更早的一轮 · 摘要首句」，`maxCardsPerSession` 默认从 120 降到 60（旧设置文件里恰好等于 120 的值随 v3 迁移更新，你自己设的其它数字不动）。复盘报表的「第几条」分母改成该位置被展示的次数（`second-option-useless` 判读第一次真正可达），`closeFollowup` 接线（下一轮结束 / TTL 15 分钟 / 会话级上限 32 都结算 `typed:false`），非 completed 的回合也会落 `gate:"turn-error"` 事件（不再在进入闸之前被丢掉）。`error.aborted` 补进两份 locale 文件并新增内联字典 ↔ locale 文件的键集 parity 测试，README 隐私段补充「胶囊文案会原样记录」。

### Patch Changes

- [#369](https://github.com/kangyishuai/dsh-plugins/pull/369) [`ce891fa`](https://github.com/kangyishuai/dsh-plugins/commit/ce891faab4df498ba3eb37f2e127f832c8c05ae9) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 生成失败现在会在补生成入口给出可见、可操作的反馈（USIM-U2-04）：按钮变成「重试」+ 一行原因摘要，「查看详情」展开服务端技术原因（`json:empty`、模型错误、超时秒数等）；自动生成失败（含整页刷新后）也会显示，不再静默恢复原状；`inflight` 回执不再是一句永久的「正在生成」，而是等待态轮询后台状态。新增客户端兜底超时（默认 30 秒、最多 60 秒）：超时先取消服务端在途生成，再显示「生成超时，可重试」。宿主新增只读的 `nextStep/generateState` 与 `nextStep/cancelGenerate` 两个 Remote（不写会话日志、不写决策），默认仍只读。
  
  限制：`generateState` 的「最近一次失败」记在**进程内**；宿主进程重启后该记录丢失，刷新页面（同进程）仍可见，重启 DSH 后不再显示历史失败（按钮回到首生成态）。

- [#359](https://github.com/kangyishuai/dsh-plugins/pull/359) [`2513267`](https://github.com/kangyishuai/dsh-plugins/commit/2513267ae60b20c608f685d421678e8e5a8de788) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 复盘报表把 `schema` 失败拆成「模型返回空文本」（`json:empty`）与「非空格式失败」：`schemaShare` 只算后者，新增 `emptyShare`，判读新增 `empty-generations`（空输出属 provider / 输出长度问题，不是「解析要放宽」；同一请求重发实测只救回 2/81）。补生成不再被已 superseded 的在途生成挡住（异回合 / 已被取代时先取消再生成），旧卡折叠首句补上英文句号切句。

## 0.4.3

### Patch Changes

- [#253](https://github.com/kangyishuai/dsh-plugins/pull/253) [`82141d5`](https://github.com/kangyishuai/dsh-plugins/commit/82141d5d1a1452b01dcffbc047149f48ae02f19d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修掉「这一轮没有拿到任何对话内容……把对话贴进来」这类空卡（根因在**修复调用丢了对话**）：
  
  - **修复请求现在带着同一段对话。** 首次补全返回**空字符串**时，原逻辑把「空 + 缺少 summary/question」当成格式问题再问一次模型，而那次请求里只有这两样材料——模型只能把这条元信息写成卡片。本机 135 个会话日志里的 95 条这类卡片全部来自这条路径（被引用回合的上一条回复实际有 1393 字）。
  - **空输出不再「修格式」，而是重发原请求**（`recoveryPlan`：空 → 重采样，有内容才修复）；恢复仍然只允许一次。
  - **落地校验**（`isGroundedIn`）：卡片要么引用了对话里原样出现的具体对象（文件、命令、版本号、PR 号、标识符），要么与对话共享至少 2 条中文 4 字片段（短回答里的改写式卡片也算数），否则丢弃并计 `ungrounded`。离线用 1038 条历史卡片验证：正常卡通过 919/919，自我指涉卡拦下 98/119；只留具体对象一条通道时正常卡是 918/919，故 4 字片段通道只赚不亏。
  - **没有对话就不调模型**：新增便宜闸 `no-context`（transcript < 40 字），补生成路径同样检查——`deriveMessages()` 被宿主改名或为空时，诊断里会写「最近跳过 · no-context」，而不是产出一张空卡。
  - 提示词 v4：删掉「信息不足时先补信息」这条方向，新增「这段对话就是你手上的全部材料」与「不要描述你自己这次生成的过程」。
  - 修复请求补「可执行的收紧信息」：label 超长时把上一次的实际字数与压缩目标写进去（模型数不准自己的字数，只提示「2–20 字」修不回来；2026-11-21 web 冒烟实测两次都是 21–22 字 → 整张卡作废）。
  - 诊断与复盘：新增 error kind `ungrounded`、`parse` 取值 `retried`、报表指标 `ungroundedShare` 与对应判读句；补生成按钮对 `no-context` / `ungrounded` 各给一句文案。单测 176 → 194。

## 0.4.2

### Patch Changes

- [#133](https://github.com/kangyishuai/dsh-plugins/pull/133) [`a0c34e2`](https://github.com/kangyishuai/dsh-plugins/commit/a0c34e2c78203ab7b9db39deef2dd6b555d34fe3) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 卡片快捷键 `⌘↵` / `Ctrl+↵` 现在也认**小键盘回车**。此前只判断 `event.code === "Enter"`，而外接键盘小键盘上的回车是 `NumpadEnter`——同一组手势在那种键盘上静默失效（卡片可点、点胶囊正常，只有快捷键不响应）。现在两者同等对待，并补了一条单测（去掉修复即红）。

## 0.4.1

### Patch Changes

- [#123](https://github.com/kangyishuai/dsh-plugins/pull/123) [`45bc54a`](https://github.com/kangyishuai/dsh-plugins/commit/45bc54aa94e257a56c25c3eb6faf83acc726dc4e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 卡片快捷键 `⌘↵` / `Ctrl+↵` 在真实会话里会静默失效：登记到宿主 fixed-input 通道的 effect 只依赖 `[sessionId, status]`，而卡片数据是投影**晚到**的（回合尾部先挂载、status 先变 interactive，卡片随后才进来），effect 不会为晚到的卡片重跑，于是卡片看着可点、点胶囊也正常，`⌘↵` 却没有登记上。把「卡片可见 / 有候选」纳入 effect 依赖修掉这个时序竞态，并补 `test/client-card-shortcut.test.js`（迷你 hooks 运行时驱动真实 client 源码，覆盖晚到卡、草稿非空、未揭示、已决策四种情形）。

## 0.4.0

### Minor Changes

- [#118](https://github.com/kangyishuai/dsh-plugins/pull/118) [`dc9cdf8`](https://github.com/kangyishuai/dsh-plugins/commit/dc9cdf8f4a61b60f93833fb51679ca0aa657ce9d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 三档判定 + 出卡档位、抑制候选可瞬时揭示、本地事件采集与复盘报告。
  
  - **出卡频率变成用户可选的档位**：严格（只出 must）/ 平衡（默认，must + could）/ 积极（含 no）。
    判定语言从 `needed: boolean` 改成三档 `value`，提示词明写「拿不准一律判 could」。
  - **被档位拦下的卡一键揭示**：候选照样落库（`shown: false`），点「生成下一步建议」直接显示它，
    **不再额外调一次模型**；只有压根没生成过候选时才真的重新生成。
  - **宽容解析 + 一次修复调用**：超长展示文本截断、单条不合格 option 只丢这一条，
    格式失败时带着原文与问题再要一次，不再让整张卡凭空消失。
  - **本地复盘日志**：`<dataRoot>/next-step/events.jsonl`（2 MB 滚动）记录每个合格回合的闸门、
    三档判定、耗时/token、用户后续动作与曝光；不写消息原文、不联网、默认开、设置里可关。
  - **复盘报告**：设置页「回顾」块 + `report-YYYYMMDD-HHmmss.md`（保留 20 份），
    比例给 Wilson 95% 区间，样本不足（<80 回合 / <25 张卡）时只列计数不下结论。
  - **修掉三处确定性丢失**：预算默认 30 → 120 且只统计出过的卡；短答闸改为「字数 <80 且无工具调用」；
    格式超长不再废卡。
  - **设置页按约定收敛**：首屏 3 行（启用 / 出卡频率 / 决策卡）+「更多设置」折叠；设置文件升级到 v2
    （v1 里等于旧默认的 30 会被抬到 120，显式 v2 文件不动）。

## 0.3.1

### Patch Changes

- [#113](https://github.com/kangyishuai/dsh-plugins/pull/113) [`653bdb5`](https://github.com/kangyishuai/dsh-plugins/commit/653bdb5d21ac2c7ced31db1094f97069975f9333) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 生成被中止时留下可诊断的痕迹。此前「20 秒超时 / 被取消」的中止路径**既不计数也不写 `lastSkip`**，
  诊断面板里完全看不到，2026-11-14 一次「卡片没出来」因此无法定位。
  
  - 新增 `counters.aborted`（诊断行显示「已中止 N」）；
  - 中止时写 `lastSkip`：超时记 `kind: "timeout"` + 「generation timeout after Ns」，取消记 `cancelled`；
  - 超时与取消不再混进 `failed` / `lastError`；
  - 用户可见的失败文案从笼统的「操作失败，请重试」改为「生成超时或被取消，请重试」（`error.aborted`）。
  
  新增纯函数模块 `lib/abort-reason.js`（`abortReasonOf` / `abortSkipKind` / `abortReasonText`）供单测覆盖。

## 0.3.0

### Minor Changes

- [#100](https://github.com/kangyishuai/dsh-plugins/pull/100) [`c3e06fd`](https://github.com/kangyishuai/dsh-plugins/commit/c3e06fd13b0fff4d68f8e8aeddfb632cd51c8a74) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 提升建议卡的内容质量（不改形态）：
  
  - **按钮收紧**：`label` 从 4–60 字收到 **2–20 字**，必须是「动词 + 具体对象」；
    找不到对话里具体对象的泛化按钮（「检查定义是否准确」）会被直接丢弃，一条都不剩就整卡不出。
  - **选项 1–2 条**：下一步很明确时只给一条，不再强行凑两个方向；两件事都做可以合并成一条。
  - **摘要写事实**：提示词明确禁止「用户要求……助手已经……」这种旁白，要求写文件名/命令/数值/测试结果。
  - **多两道便宜闸**：上一轮报错/中断不出卡；回答短于 80 字不出卡（没有上下文，生成出来必然是套话）。
  - **幽灵提示**：上限放宽到 150 字（关键信息前 60 字），并要求与推荐按钮共享具体对象，
    不一致时退化成该按钮文案——同一个建议的两种入口，不会互相打脸。

- [#101](https://github.com/kangyishuai/dsh-plugins/pull/101) [`d2fd5e3`](https://github.com/kangyishuai/dsh-plugins/commit/d2fd5e3205964cd70ab5c332f0dd3b3f9edd6216) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把设置从「通用设置里的一行」搬到**独立设置分节 设置 → 下一步建议**：
  
  - 卡片 / 幽灵提示两个面、全局开关、暂停、每会话预算和诊断都在这一页；
  - 和「会话回收站」「顾问」「会话回溯」的形式保持一致，通用设置不再被插件设置撑长。

## 0.2.0

### Minor Changes

- [#49](https://github.com/kangyishuai/dsh-plugins/pull/49) [`86e2cea`](https://github.com/kangyishuai/dsh-plugins/commit/86e2cea940e9c5cb2e6d8c15bba3bdf56bb50bcd) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Send exactly what the pill says, show which one you picked, gate cards on a model judgement, and make the primary keycap real.
  
  - Clicking a pill now sends that pill's text verbatim (`label`, 4–60 chars) instead of a hidden longer `text`; a "sent" card keeps the picked option in a selected state (✓ + its text) instead of a generic grey line.
  - The extra model call now returns `needed` + `reason`: when the model judges the turn is not worth continuing, no card is written and the reason appears in the settings diagnostics ("Last skipped").
  - When no card appears, the latest answer shows a small "Generate a next-step card" button that forces one through the new `nextStep/generateNow` RPC (respects the global switch and the per-session budget, bypasses the pause / queue / `needed` gates).
  - `⌘↵` / `Ctrl+↵` now sends the primary pill, but only while the composer is clean (no draft, attachments, references or open menus), the session is idle and the card is interactive; otherwise the host's Queue/Steer meaning is untouched.
  - Settings hide the card / ghost / pause / budget / diagnostics rows while the plugin is off, and diagnostics gained the last skip reason.

## 0.1.2

### Patch Changes

- [#44](https://github.com/kangyishuai/dsh-plugins/pull/44) [`dc99025`](https://github.com/kangyishuai/dsh-plugins/commit/dc99025564f43ef6a0d160652e01db1eca768e22) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Skip card generation while the user already has queued messages (2 or more, same rule as the official action cards), so a card never competes with input the user has already sent.

[Release notes](https://github.com/kangyishuai/dsh-plugins/releases/tag/%40kangyishuai%2Fdsh-next-step%400.1.2)

## 0.1.1

### Patch Changes

- [#41](https://github.com/kangyishuai/dsh-plugins/pull/41) [`1c84d29`](https://github.com/kangyishuai/dsh-plugins/commit/1c84d29f46237bc031b18422fd9fa363e326de3e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - `nextStep/diagnostics` now reports `version` and `buildHash` (the package.json version plus a sha256 over the behavior-carrying files), and the settings row shows them, so the running build can identify itself without a startup log.

## 0.1.0

### Minor Changes

- [#39](https://github.com/kangyishuai/dsh-plugins/pull/39) [`c3d085b`](https://github.com/kangyishuai/dsh-plugins/commit/c3d085b00143d9b2baa137e20f9d6abbd08e00ed) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add next-step: a decision card under every completed answer (state summary, one question, two mutually exclusive suggestions that are sent as your user message with one click) plus an optional composer ghost hint accepted with Tab/→ — both produced by a single extra model call, persisted as plugin records in the session log, and fully stoppable by the global switch.
