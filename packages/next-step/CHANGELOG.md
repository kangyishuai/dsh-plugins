# @kangyishuai/dsh-next-step

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
