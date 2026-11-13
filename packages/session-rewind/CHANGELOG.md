# @kangyishuai/dsh-session-rewind

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
