# @kangyishuai/dsh-session-rewind

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
