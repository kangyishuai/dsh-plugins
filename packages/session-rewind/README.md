# @kangyishuai/dsh-session-rewind

> In-place conversation rewind for DeepSeek Harness: send the conversation back to before any user message, withdraw everything after it from the model context and the transcript, optionally restore the workspace files those turns changed, and put the message back into the composer.

[![npm](https://img.shields.io/npm/v/@kangyishuai/dsh-session-rewind?color=cb3837&logo=npm)](https://www.npmjs.com/package/@kangyishuai/dsh-session-rewind) [![DSH](https://img.shields.io/badge/verified%20on%20DSH-0.2.2--rc.1-4b6bfb)](#compatibility) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: early.** Verified end to end on DSH 0.2.2-rc.1: 34 GUI assertions in a throwaway DSH home, 185 unit tests, and a CDP-driven desktop pass (conflict refusal, conversation + file rewind, created-file trash, modified-file restore, rescue restore, panel/audit/diagnostics). Young software — keep backups of anything you cannot lose.

## What it does

Long conversations drift. A few turns later you wish you had answered a prompt differently, but starting a new session loses everything before it, and continuing keeps the unwanted turns in the context window forever. This plugin rewinds **in place**:

- **Two entries.** Press `Esc` `Esc` to open the rewind dialog, or click the ↶ button in any user message's action row (next to Copy).
- **Running turns are not a dead end.** Confirming a rewind while a turn is running cancels that turn (keeping the queue), waits for it to go idle, then re-plans against the settled history.
- **State-change warnings.** If the withdrawn range changed session state that lives outside the transcript — plan mode, goal, todo list, model selection, permission/sandbox presets, agent preset, scheduled tasks, working directory — the dialog lists it and says that rewinding does not roll that state back.
- **Two scopes, chosen per rewind.** The confirmation dialog offers **Rewind conversation only** (default) and **Rewind conversation and files**. The dialog first shows a dry-run preview: how many messages and roughly how many tokens will be withdrawn, which files will be restored or moved to the trash, conflicts, and skipped files.
- **Conversation.** The target message and everything after it are withdrawn from the model-visible context and from the transcript. The session id, title and earlier history are untouched. Nothing is deleted from the log — one marker event is appended.
- **Files (optional).** Files changed by `write` / `edit` / `apply_patch` in the withdrawn turns are restored to their pre-change content. Files created after the target are moved to the plugin's trash instead of deleted. A rescue point of the current files is created before anything is written; failures roll back from it.
- **Composer.** The target message's text (and images) is put back into the composer, ready to edit and send again. An existing draft is never overwritten. Tick **Send this message again right after rewinding** in the confirmation dialog to retry the turn in one click (conversation-only rewinds).
- **Rewind panel.** A new header action opens a panel with four tabs: **Withdrawn** (every message each rewind removed, searchable, copy or put back in the composer), **History** (a timeline of each rewind and each rescue-point file restore, newest first: scope, message count, tokens, file results), **Rescue points** (restore files from an earlier rescue), and **Settings** (default scope, page size, confirm-on-list, diagnostics).

## Read-only agent tool

The plugin also registers one **read-only** tool, `session_rewind_candidates`, so the model can reason about rewinding without performing it:

| Call                                       | Result                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_rewind_candidates {}`             | Newest-first list of messages this conversation can be rewound to (`query` filters, `limit` caps at 50).                                       |
| `session_rewind_candidates { target_seq }` | Impact preview for one message: how many messages would be withdrawn, whether an unfinished tool call would be truncated, and the target text. |

The tool never rewinds, never edits files and never appends to the session log — the rewind itself stays a user action (that is the point of the ADR 0006 design). Set `readOnlyTool: false` to unregister it; **Settings → Diagnostics** reports whether it registered.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-session-rewind
```

To run the working tree instead of a published version, pack it first — `link:` installs do not work (the host's `@deepseek-ai/*` resolution only covers packages whose real path is inside the profile):

```bash
cd packages/session-rewind
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-session-rewind-*.tgz
```

Re-run `pnpm pack` + `add` after changing the code. The plugin has a host half, so restart the DSH desktop app and refresh the page.

## Usage

**Keyboard — `Esc` `Esc`.** In an idle conversation, press Escape twice quickly. The rewind dialog lists user messages, newest first; search, page to older messages with ↑/↓, Enter or click to choose. Then the preview opens; pick a scope and confirm. While a turn is running, `Esc` `Esc` keeps its native meaning (stop the turn); press it again when idle.

**Message action — ↶.** Every user message has a ↶ button next to Copy. It opens the same preview/confirmation dialog. Nothing is rewound until you confirm.

**Commands.** `/rewind` opens the same candidate list. `/rewind @<seq> [chat|both]` executes directly (the preview's seq is shown in the list). `/rewind` is decorated by the client; the bare form never sends text to the model.

**After a rewind** the target text returns to the composer (images are re-attached best-effort) and the composer is focused. If the composer already held a draft, the draft is kept and a notice says so.

**What is refused**

| Situation                                                                | What happens                                                                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The session has a running turn                                           | It is cancelled first (queued steering messages are dropped), then the rewind runs. Set `cancelRunning: false` to refuse instead (`session-rewind/busy`). |
| The session is a subagent child                                          | No ↶ button and no `Esc` `Esc` dialog: the Harness refuses generic session RPCs there.                                                                    |
| The target message was shadowed by compaction                            | Refused; the rewind boundary must still be in the model context.                                                                                          |
| A file was changed outside the agent since the last recorded state       | File mode is refused with a conflict list; no file is touched.                                                                                            |
| A file is larger than 8 MiB, a symlink, or under `.git` / `node_modules` | That file is skipped and reported; other files still proceed.                                                                                             |
| A rewind is already running on this session                              | Refused; one at a time.                                                                                                                                   |

## File restore scope & safety

- **Tracked changes only.** Only DSH file tools `write`, `edit` and `apply_patch` are tracked, and only under the session's working directory. Changes made by `bash`, scripts, external programs or subagents are **not** tracked; the plugin never claims a complete workspace snapshot.
- **Before every write.** The engine records the content before the tool runs, deduplicated by SHA-256 under `<DSH_HOME>/session-rewind/blobs/`. Before restoring, it verifies the current file still matches the last recorded state; any mismatch aborts the whole file operation with a conflict list.
- **Rescue before mutation.** All current affected files are copied to a rescue point first. If that fails, nothing is written. A failed restore rolls back applied files from the rescue point; failed rollbacks are reported. The five latest rescue points per session can be restored from the Rewind panel (a new rescue is created first).
- **Destructive operations go to trash.** Files created after the rewind target are moved to `<DSH_HOME>/session-rewind/trash/<session>/<auditId>/`, never `rm`'d. Files larger than 8 MiB, symlinks and excluded trees are left alone and reported.
- **No undo.** This plugin deliberately does not implement conversation undo/redo (it would require patching DSH internals). The withdrawn content stays in the session log and the Rewind panel; file-level recovery is available through rescue points and trash.
- **Order.** Preview and conflict checks run before anything is written; then the rescue point; then the conversation marker; then file writes. Once the marker is appended the conversation rewind stands even if file writes fail (they are reported and audited).

## Data & retention

All plugin data lives under `<DSH_HOME>/session-rewind/` (`DSH_HOME` defaults to `~/.dsh`):

| Path                            | Contents                                             |
| ------------------------------- | ---------------------------------------------------- |
| `blobs/`                        | content-addressed file contents (SHA-256)            |
| `sessions/<id>/entries.jsonl`   | per-session file change records (newest shown first) |
| `trash/<session>/<auditId>/`    | files created after a rewind target                  |
| `rescues/<session>/<rescueId>/` | rescue points (current files before a restore)       |
| `audit.jsonl`                   | one line per rewind (append-only)                    |

On startup the plugin also removes data for sessions that no longer exist (they were deleted); the audit log is kept. Retention: the 20 latest message anchors per session, the 5 latest rescue points, the 20 latest trash operations (30 days), and a 1 GiB soft cap across blobs/trash/rescues. When the cap is exceeded, old trash → old rescues → unreferenced blobs → oldest anchors are cleaned in that order; if still over the cap, new captures stop and diagnostics report it (no referenced data is deleted). Uninstalling keeps the data. The data root can be overridden with the plugin's `dataRoot` config.

## Side effects & risks

- **Appends one marker event per rewind** to the current session log; nothing is deleted or rewritten.
- **Writes and deletes workspace files only in file mode**, after confirmation, with the safety described above.
- **The marker is visible to the model** as a short `(empty message)` user message where the withdrawn turns used to be. It is not shown in the transcript.
- **No network, no telemetry.** Everything is local; file snapshots may contain sensitive content, so treat `<DSH_HOME>/session-rewind/` like your workspace.
- **Private client seams.** Hiding rows and injecting the ↶ button rely on DSH's internal view/slot registries. They are shape-checked at install and degrade to “context rewound, transcript not hidden” or “button missing” rather than breaking a session.
- **POSIX/macOS paths only** in this version; Windows separators and permission bits are not verified.

## Compatibility

| DSH version | Status                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2-rc.1  | Verified: `pnpm smoke:session-rewind` (34/34) + 185 unit tests + CDP-driven desktop pass (conversation-only and file modes) |

The plugin declares no `engines.dsh` and no `@deepseek-ai/*` peer range: DSH is pre-release and semver ranges over prereleases are unreliable (see [ADR 0005](../../docs/adr/0005-dsh-version-compatibility.md)). Treat the table as the compatibility statement. After a DSH upgrade run `pnpm probe:runtime`, `pnpm smoke:session-rewind`, and check the plugin's diagnostics tab; if a private seam changed, the plugin degrades instead of breaking the session.

## Development

```bash
pnpm test                     # unit tests (host engine, host RPC, client helpers)
pnpm verify                   # repo-wide gates
pnpm smoke:session-rewind           # temp DSH home + real GUI end-to-end (needs dsh & ego-browser)
pnpm smoke:session-rewind-desktop   # read-only desktop (Electron) check; add --require for a release gate
```

Design notes: [ADR 0006](../../docs/adr/0006-session-rewind-architecture.md) and [ADR 0007](../../docs/adr/0007-session-rewind-file-restore.md) (Chinese; the repository docs are written in Chinese).

## License

MIT
