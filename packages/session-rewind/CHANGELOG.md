# @kangyishuai/dsh-session-rewind

## 0.8.1

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

## 0.8.0

### Minor Changes

- [#366](https://github.com/kangyishuai/dsh-plugins/pull/366) [`66fa453`](https://github.com/kangyishuai/dsh-plugins/commit/66fa453310e2d9299429ba099c89cd676e144302) Thanks [@kangyishuai](https://github.com/kangyishuai)! - session-rewind 审计剩余 P2/P3 收口（AUD-REW-04/06/07/08/09/10/11 + P3 选做），并修复用户模拟发现的 **回溯不可持久**（USIM-U3-01）：
  
  - **重启后仍截断**：冷启动时 chat builder 可能在「当前会话未知」时创建，旧实现把 null 会话 id 永久捕获；`cuts` RPC 又会在宿主 resume 完成前失败一次并被静默吞掉，导致重启后对话流里被撤回的消息重新可见、面板却仍标「已撤回」。现在 builder 在 rebuild 时动态解析并记住会话 id，`cuts` 拉取失败会有限次退避重试，打开回溯面板时也会补种一次。宿主 replay 侧已用真实 v4 日志 + `foldSurface` 验证：marker 的 `surfaceOp.replace` 会让模型上下文保持截断（物理格式把 `sourceEventSeqs` 压缩成 `[start,end]` 区间属正常编码）。
  - **确认框**：新增「可恢复」一行（撤回内容留在已撤回页签；文件写入前建救援点、新建文件进插件回收站）；主按钮默认聚焦（不可执行时回落到取消）、Tab 在框内环绕、关闭后焦点归还触发元素。
  - **回收站有了入口**：`listTrash/restoreTrash` 暴露成 Remote，并入面板「救援点」页签（可恢复，恢复前先建 rescue-of-rescue；也可在影响面预览后清空并写 `trash-clear` 审计）。
  - **`/rewind @<seq> both` 不再直接写文件**：先回执影响面（文件数/跳过数/可恢复性），必须显式带 `confirm` 才执行；会话运行中一律拒绝（提示改用界面确认框）。
    - **迁移说明（破坏性行为变化，故本版本按 minor 发布）**：旧用法 `/rewind @<seq> both` 原先会直接执行；升级后它只回显影响面，执行需 `/rewind @<seq> both confirm`；会话运行中请改用界面确认框（它会先停止当前回合并展示完整影响面）。
  - **被跳过的文件可见**：符号链接 / 工作区外 / 排除目录 / 捕获失败也落 `skipped` entry（相对路径），预览按原因分组报数，成功 toast 报跳过数；`file-tracking` 不再忽略 `recordChange` 返回值。
  - **编排可测**：`executeRewind` 状态机下沉到 `rewind-flow.js`（preview → 救援点 → marker → apply → 部分失败 → 审计），补 14 条单测；删除生产未使用的 `*Response` 死代码，`service.test.js` 改名为 `operations.test.js`。
  - **P3**：恢复侧 8 MiB stat 预检（不再整块读超大文件）、marker 失败丢弃救援点、收回被创建的空目录、诊断文案中英双语、设置低频项与诊断收进「更多设置」、启动时清一次无引用 blob（`gc-blobs` 审计，`gcOnStartup: false` 可关）。
  - **裸 `/rewind` 打开插件自己的候选对话框**（USIM-U2-26）：宿主 `commandUi.decorate` 的 `popupSelect` 在这条路径上实测 ↑/↓/Enter 失效，改用宿主支持的 `ui.kind:"action"`，直接复用与 `Esc` `Esc` 同一套候选对话框（键盘导航、搜索、只列会话消息）。
  - **统计口径统一**（USIM-U2-20）：toast/确认框写「截断 N 条上下文记录（撤回 M 条用户/助手消息）」，面板与回溯记录用同一个 M，不再出现同一动作两个数字。
  - **面板提供「选择消息回退」**（USIM-U2-10）：抽屉不再只能关掉再点行内 ↶；头部提示 + 按钮直接关闭面板并打开候选列表。
  - **追踪范围写进确认框**（USIM-U2-03 / U3-08）：「无文件变更」改为「本轮没有可追踪的文件改动」，并常驻一行说明只追踪本会话工作目录内 `write` / `edit` / `apply_patch`，bash/脚本、子代理与工作区外改动不追踪。
  - **诊断计数如实**（USIM-U3-06）：健康检查曾用 `readAudit({ limit: 1 })` 再把长度当条数，审计永远显示 1 条；现在按真实行数统计（上限 1000，超出显示「至少 N 条」），检查项构造下沉到可单测的 `health.js`。
  - **测试/门禁**：web 冒烟新增 10 条确定性断言（48→58）、桌面只读 +9（51→68 静态断言中只读分节）、`--deep` 新增「修改还原 / 删除文件 / 冲突拒绝」8 条（**脚本未在本分支运行**）；`docs/testing/session-rewind.md` 修正「文件模式已自动化」的失真表述并补 §2.7 重启复核步骤。
  
  - **本批未做 / 后续**：AUD-REW-18（偏好从 localStorage 迁到数据根）defer，原因是需要新增 host 侧配置读写 RPC + 旧 localStorage 迁移，且只影响 `dsh web`（端口随机）的偏好持久性，与本批安全修复无耦合；复审 N3（回收站内联清空确认的默认聚焦）、N4（回收站错误码语义/不可达 partial toast）、N8（`commandUi` `ui.kind:"action"` 未进 runtime 文档/探针）、N9（本 defer 已在此写明）、N10（启动 GC 对 entries 读失败的 fail-closed）、N11（历史 audit 行旧口径回落）均为 P3/P4 follow-up，未在本 PR 阻塞。

### Patch Changes

- [#373](https://github.com/kangyishuai/dsh-plugins/pull/373) [`8d8fe50`](https://github.com/kangyishuai/dsh-plugins/commit/8d8fe502b48bad0789d580c3f4b6e9e384193678) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 确认框默认焦点修正（真机抓到的 §7.4.2 偏差）：打开时预览还在 loading，主按钮 disabled、「取消」拿 `data-modal-autofocus`；预览到达后 autofocus 回到主按钮，但聚焦 effect 只在 overlay 打开时跑一次，焦点就永远停在「取消」上。现在 effect 依赖 `previewLoading/executing/loading`，状态变化会重新聚焦当前 `data-modal-autofocus`。

- [#356](https://github.com/kangyishuai/dsh-plugins/pull/356) [`519537d`](https://github.com/kangyishuai/dsh-plugins/commit/519537dd0a3c70181f25b741d258f05410595244) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修复 2026-11-28 只读审计里的三处 P1 与一处 P2（含独立复审收窄/加固）：
  
  - **AUD-REW-01 孤儿清理不再误删真实会话数据**：枚举存活会话时不再用安全字符集过滤宿主的工作区目录名（`--Users-…--` 首字符是 `-`，旧实现把 46/46 个工作区都滤掉，`existing` 恒为空，每次插件加载就把 `sessions/ trash/ rescues/` 全删）。现在按目录结构枚举（会话目录是叶子目录，`sessions/<workspace>/<session-id>/`）：宿主布局不是该形态（扁平、多一层嵌套、中间层用 project id 等）时得到 0 个存活 id，视为「枚举失败」；**逐 workspace 护栏**——某个非空 workspace 里一个能识别的会话目录都没有，或混进了「不像会话目录」的安全字符集条目（混合/局部未知布局），也记为 `incomplete`/`unknownWorkspaces`；任一 workspace 不可读同样 `incomplete`。这些情况都跳过清理并记 warning，不再当成「全部都是孤儿」。不认识的插件条目保留、列入 `unknownIds` 并告警（诊断里也计数）。启动清理仍然保留，但先把 dry-run 计划写审计（`cleanup-orphans-plan`）再执行，删除失败逐条记录并告警。
  - **AUD-REW-02 删除的文件会被还原（收窄版）**：`planRestore` 只对「agent 删除」（`afterHash === null`）或「上一次回溯自己把该 afterHash 移入回收站」的缺失文件生成 restore 动作并允许重建（父目录 `mkdir -p`）；外部删除的已改动文件仍按 ADR 0007 决策 5 / 冻结设计 §2.3 报 `missing` 冲突、整体拒绝，不静默复活（「上次回溯移入回收站」的重建依赖回收站记录仍在，回收站记录被保留策略清理后会退化为 `missing` 冲突）。预览/确认框新增「其中 N 个文件已被删除，将按记录重建」。重命名（delete + add）回退后源名字恢复、目标名字进回收站。
  - **AUD-REW-03 第二次回溯不再被上一次回溯挡住**：恢复计划改按「目标状态」判定——当前已等于 `beforeHash`（或新建路径已不存在）视为已满足、不产生冲突；当前内容等于该路径记录过的某个状态（例如上次回溯的结果）时继续还原，只有真正既不是 before 也不是任何记录状态的内容才报 `modified-externally` 冲突。
  - **AUD-REW-05 恢复侧补上 canonical 路径校验**：`applyRestore` / `restoreRescue` / `restoreTrash`（以及回滚）在每次写入前共用 `assertWriteTarget`，对父目录重跑 `realpath` + 工作区包含检查、`lstat` 拒绝 symlink。这关掉「计划/预览 → 执行」和「面板任意时刻点恢复」的长窗口；校验与写入之间被并发替换目录不在本插件防护范围（纵深防御，不是沙箱）。

## 0.7.0

### Minor Changes

- [#96](https://github.com/kangyishuai/dsh-plugins/pull/96) [`d3873e7`](https://github.com/kangyishuai/dsh-plugins/commit/d3873e7dcc3d76657207c867684440a2b25adbd8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把「设置」从回溯抽屉里挪出来，做成 设置 → 会话回溯 分节：
  
  - 抽屉只剩三个会话级页签（已撤回 / 回溯记录 / 救援点），不再和主操作抢同一个面板。
  - 偏好（默认回退范围、每页数量、列表确认、输入框召回）与诊断（只读工具、数据目录与占用）
    统一放进设置分节，和其它插件的设置页形态一致。
  - 旧状态里的 `settings` 页签会安全回落到「已撤回」，不会白屏。

## 0.6.2

### Patch Changes

- [#72](https://github.com/kangyishuai/dsh-plugins/pull/72) [`695a2c6`](https://github.com/kangyishuai/dsh-plugins/commit/695a2c6d460c16bd4b773f34f5267dc3d18855ee) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Fix unreadable primary button text in the dark theme and the remaining theme-token misuses in the injected stylesheet.
  
  `--dsw-alias-brand-primary` is DSH's inverted surface colour (near-black `#0f1115` in the light theme, near-white `#f9fafb` in the dark one), not a saturated brand accent. The confirm button paired it with a hardcoded `color: #fff`, so in the dark theme it rendered white-on-white at **1.05:1** and its label was invisible. The button now uses the host's semantic pair, `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` (18.1:1 dark / 18.9:1 light), and `--dsw-alias-button-primary-hover` replaces the `brightness()` hover hack.
  
  Same class of problem elsewhere in the stylesheet:
  
  - Link and action buttons (`加载更早`, the toast action, audit and rescue actions) used `--dsw-alias-brand-primary`, which equals the body text colour in both themes, so they had no link affordance at all. They now use `--dsw-alias-link`; the toast action uses `--dsw-alias-toast-label` plus an underline, because the toast surface is dark in both themes and `--dsw-alias-link` would be 2.86:1 there.
  - `--dsw-alias-state-warning-primary` does not exist in the host theme (the real name is `--dsw-alias-state-warn-primary`), so four rules silently fell back to a hardcoded `#c08a2e` that never followed the theme. Warning *text* now uses `--dsw-alias-state-warn-label` (the host's own text token) and the confirmation border uses `--dsw-alias-state-warn-primary`.
  - Three more non-existent tokens are replaced with the real ones: `--dsw-alias-border-secondary` → `--dsw-alias-border-l3` (timeline rail), `--dsw-alias-bg-primary` → `--dsw-alias-bg-layer-2` (timeline dot ring, which previously fell back to `transparent` and disappeared), `--dsw-font-mono` → `--ds-font-family-code`.
  
  Regression guards: a unit test now asserts that the injected stylesheet only references host tokens that really exist and never pairs an inverted fill with a hardcoded white foreground, and the desktop read-only suite computes the confirm button's WCAG contrast in the real Electron renderer (24 assertions now, was 23).

## 0.6.1

### Patch Changes

- [#68](https://github.com/kangyishuai/dsh-plugins/pull/68) [`0fd4faa`](https://github.com/kangyishuai/dsh-plugins/commit/0fd4faa2c8ed893961d9b4bffac29ba0efd5ba5d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - macOS：回溯抽屉与确认框声明 `data-window-drag-exclude`。此前浮层覆盖页头时，拖动浮层会变成拖动整个 DSH 窗口（0.2.2-rc.2 上用真实鼠标拖动复现并复验修复）。

## 0.6.0

### Minor Changes

- [#38](https://github.com/kangyishuai/dsh-plugins/pull/38) [`9753de2`](https://github.com/kangyishuai/dsh-plugins/commit/9753de2a0466317d25d0a67f93bc9f262e05d7cf) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add non-destructive composer prompt recall: bare `↑` / `↓` in the focused composer walks back and forth through the prompts you already sent in the session (first-line gated, draft stashed and restored at the bottom, IME- and menu-safe), filling the draft only — it never rewinds, sends or writes to the session log. Wired through the host's fixed-input channel instead of registering shortcuts, with a Settings toggle and bilingual docs (ADR 0008).

## 0.5.1

### Patch Changes

- [#35](https://github.com/kangyishuai/dsh-plugins/pull/35) [`01070d1`](https://github.com/kangyishuai/dsh-plugins/commit/01070d1f53e78aed4bc162de2123b23488264b9c) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Repository description and topics now cover both plugins (rewind and delete), so the packages are discoverable from the GitHub side as well.

- [#33](https://github.com/kangyishuai/dsh-plugins/pull/33) [`0246dee`](https://github.com/kangyishuai/dsh-plugins/commit/0246dee767b972bedbb87ff197de229344199e5f) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Ship the README screenshots to npm and keep them sanitized: the confirmation dialog and the rewind panel are generated from a throwaway DSH home containing only a synthetic workspace and session, cropped to the dialog/panel, and have their PNG metadata stripped. No documentation or behaviour change.

## 0.5.0

### Minor Changes

- [#25](https://github.com/kangyishuai/dsh-plugins/pull/25) [`bc13a04`](https://github.com/kangyishuai/dsh-plugins/commit/bc13a0411afd51cd74dc612a5b9633277b2a128d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Keep every open view of a session in sync after a rewind.
  
  Rewinding in one tab (or window) now immediately hides the withdrawn rows in other views of the same session, without a reload. After a successful rewind the plugin publishes a small notice through `localStorage`; other same-origin views pick it up on the `storage` event and re-read the authoritative cuts from the host — the notice itself is never trusted for rendering, so a stale or forged payload can only trigger an unnecessary refresh.

## 0.4.0

### Minor Changes

- [#18](https://github.com/kangyishuai/dsh-plugins/pull/18) [`1ee4490`](https://github.com/kangyishuai/dsh-plugins/commit/1ee44900f534752b5b82f7713e68a8ca3c4fe5cf) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Rewind history as a timeline, and warn when a rewind would leave session state behind.
  
  - **History → timeline.** The History tab is now a vertical timeline instead of a plain list. It merges rewinds and rescue-point file restores (file restores are now audited too), newest first, with a mode/kind badge, counts, file results and expandable paths.
  - **Session-state hint.** The confirmation dialog now lists session state changed inside the withdrawn range — plan mode, goal, todo list, model selection, permission/sandbox presets, agent preset, scheduled tasks, working directory — and says plainly that rewinding only withdraws messages and does **not** roll that state back.
  
  Both are informational: no extra writes, no behaviour change to the rewind itself.

## 0.3.0

### Minor Changes

- [#16](https://github.com/kangyishuai/dsh-plugins/pull/16) [`7cda33a`](https://github.com/kangyishuai/dsh-plugins/commit/7cda33aa327a195c2374db322e3aebb25bc928c2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add a read-only agent tool, `session_rewind_candidates`.
  
  The model can list the messages this conversation can be rewound to (optionally filtered) and preview the impact of rewinding to one of them — how many messages would be withdrawn and whether an unfinished tool call would be truncated. The tool never rewinds, never touches files and never appends to the session log; the actual rewind stays a user action in the UI. Disable it with `readOnlyTool: false`; diagnostics now reports whether it registered.

## 0.2.0

### Minor Changes

- [#14](https://github.com/kangyishuai/dsh-plugins/pull/14) [`fb07180`](https://github.com/kangyishuai/dsh-plugins/commit/fb0718078e5864187435b5a3cac9c0aed3cac3fc) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Rewind through a running turn, and resend right after rewinding.
  
  - A running turn no longer blocks rewinding: the host cancels it (`keepInbox`), waits for idle, drops queued steering messages, then re-plans against the settled surface. The confirm dialog explains this and shows progress instead of refusing.
  - Optional "send this message again right after rewinding" for conversation-only rewinds (off by default), for one-click retries.
  - Audit entries and the toast record whether a turn was stopped and how many steering messages were dropped.
  - Set `cancelRunning: false` to restore the old refuse-when-busy behaviour.

## 0.1.1

### Patch Changes

- [#11](https://github.com/kangyishuai/dsh-plugins/pull/11) [`64822d3`](https://github.com/kangyishuai/dsh-plugins/commit/64822d3cc734524818d55441f7be6a6960543134) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Clean up plugin data for sessions that no longer exist (entries, trash and rescue points) on startup, and report orphan data in the diagnostics tab. Audit history is kept.

## 0.1.0

### Minor Changes

- [#9](https://github.com/kangyishuai/dsh-plugins/pull/9) [`5e4ee0d`](https://github.com/kangyishuai/dsh-plugins/commit/5e4ee0d285ded285857a44802b1b75eb82014199) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Initial release: in-place conversation rewind with an optional file mode.
  
  - Two entries: `Esc` `Esc` opens a searchable candidate dialog, and a ↶ button sits next to Copy on every user message. Both open a dry-run preview (message count, token estimate, scope).
  - Conversation rewind is append-only: one `session-rewind` marker replaces the target and everything after it on the model-visible surface, the log keeps every event, and the composer is refilled with the target text (draft never overwritten).
  - File mode restores files changed by `write` / `edit` / `apply_patch` in the withdrawn turns using pre-write snapshots, refuses to overwrite externally changed files, creates a rescue point before writing (with rollback on failure), moves files created after the target to a plugin trash, and keeps bounded retention/GC.
  - Rewind panel: Withdrawn messages (search, copy, put back in composer), History (append-only audit), Rescue points (restore files), and Settings/diagnostics.
  - `/rewind` / `/rewind @<seq> [chat|both]` commands, image refill, busy/subagent/compaction refusals, and zh/en UI.
