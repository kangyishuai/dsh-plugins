---
"@kangyishuai/dsh-session-rewind": minor
---

Initial release: in-place conversation rewind with an optional file mode.

- Two entries: `Esc` `Esc` opens a searchable candidate dialog, and a ↶ button sits next to Copy on every user message. Both open a dry-run preview (message count, token estimate, scope).
- Conversation rewind is append-only: one `session-rewind` marker replaces the target and everything after it on the model-visible surface, the log keeps every event, and the composer is refilled with the target text (draft never overwritten).
- File mode restores files changed by `write` / `edit` / `apply_patch` in the withdrawn turns using pre-write snapshots, refuses to overwrite externally changed files, creates a rescue point before writing (with rollback on failure), moves files created after the target to a plugin trash, and keeps bounded retention/GC.
- Rewind panel: Withdrawn messages (search, copy, put back in composer), History (append-only audit), Rescue points (restore files), and Settings/diagnostics.
- `/rewind` / `/rewind @<seq> [chat|both]` commands, image refill, busy/subagent/compaction refusals, and zh/en UI.
