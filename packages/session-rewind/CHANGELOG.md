# @kangyishuai/dsh-session-rewind

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
