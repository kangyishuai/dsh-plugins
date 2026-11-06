# @kangyishuai/dsh-session-rewind

> In-place conversation rewind for DeepSeek Harness: send the conversation back to before any user message, withdraw everything after it from the model context and the transcript, and put that message back into the composer.

[![npm](https://img.shields.io/npm/v/@kangyishuai/dsh-session-rewind?color=cb3837&logo=npm)](https://www.npmjs.com/package/@kangyishuai/dsh-session-rewind) [![DSH](https://img.shields.io/badge/verified%20on%20DSH-0.2.2--rc.1-4b6bfb)](#compatibility) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: early.** Verified on DSH 0.2.2-rc.1 with `pnpm smoke:session-rewind` (17 end-to-end assertions in a throwaway DSH home: two entry points, truncation, composer refill, reload persistence, and the append-only session log). The desktop Electron keyboard path has not been regressed separately. Young software — keep backups of anything you cannot lose.

## What it does

Long conversations drift. A few turns later you wish you had answered a prompt differently, but starting a new session loses everything before it, and continuing keeps the unwanted turns in the context window forever. This plugin rewinds **in place**:

- **Two entries.** Press `Esc` `Esc` to open the rewind dialog and pick a user message; or click the ↶ button in any user message's action row (next to Copy).
- **Withdraws the target and everything after it** from the model-visible context and from the rendered transcript. The conversation now looks the way it did before that message.
- **Refills the composer** with the target message's text, so you can edit it and send again.
- **Same session, no branch.** The session id, title, workspace and history before the target are untouched. No new session, no window switch, no leftover copy.
- **Append-only safety.** History is never deleted or rewritten: the plugin appends one marker event. The withdrawn content stays in the session log (visible in Trajectory), and disabling the plugin makes it visible in the transcript again.

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

**Keyboard — `Esc` `Esc`.** In an idle conversation, press Escape twice quickly. The rewind dialog lists the conversation's user messages, newest first: pick one with ↑/↓ and Enter, or click it. The conversation rewinds immediately. While a turn is running, `Esc` `Esc` keeps its native meaning (stop the turn); press it again once the turn has stopped to open the rewind dialog.

**Message action — ↶.** Every user message has a ↶ button in its action row next to Copy. Hovering shows **回退到此处 / Rewind to here**; clicking opens a confirmation dialog that states what will be withdrawn, then rewinds.

**After a rewind** the target message's text is placed in the composer and the composer is focused. If the composer already held a draft, it is not overwritten — the rewind still happens and a notice tells you the draft was kept.

**What is refused**

| Situation                                             | What happens                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The session has a running turn                        | The host refuses (`session-rewind/busy`); stop the turn first (`Esc` `Esc` while running) and retry. |
| The session is a subagent child                       | No ↶ button and no `Esc` `Esc` dialog: the Harness refuses generic session RPCs there.               |
| The target message was already shadowed by compaction | Refused; the rewind boundary must still be in the model context.                                     |
| A running rewind on the same session                  | Refused; one at a time.                                                                              |

## How it works

DSH keeps sessions as append-only event logs and derives the model-visible history from an ordered _surface_. A message-producing event declares how it joins that surface; a `replace` operation can substitute a whole range of existing surface nodes — `/compact` uses exactly that to replace history with a summary.

Rewind appends one `user/message` marker whose `surfaceOp` replaces the target message and every surface node after it. The model now sees only the part before the target. The marker carries a constant `(empty message)` text (so strict OpenAI-compatible gateways accept it) and a producer-owned `source: { kind: "session-rewind", targetSeq }`.

On the browser side the plugin wraps the registered Chat view builder and marks the nodes in `[targetSeq, markerSeq]` as `visibility: "hidden"` before the builder sees them. Hidden rows leave the transcript, Turn navigation and grouping but stay in the node store, which is what lets the composer still read the withdrawn text. The ↶ button is injected by taking over the `conversation.chat.node` slot's user renderer and adding one child to the official actions row.

Both are private client seams, not public APIs. They are checked for shape at install time; if a future DSH changes them, the plugin degrades to “context rewound, transcript not hidden” or “button missing” instead of breaking the session.

## Side effects & risks

- **One event appended per rewind.** A `user/message` marker (text `(empty message)`, source `session-rewind`) is added to the current session log. Nothing is deleted or rewritten, and no other file is touched.
- **The marker is visible to the model** as a short user message placed where the withdrawn turns used to be. Models ignore it; it is not shown in the transcript.
- **No workspace file restore.** This plugin only rewinds the conversation. Files edited by the withdrawn turns stay as they are; use git or a snapshot plugin for files.
- **No in-place undo.** Rewind is append-only, so there is no “redo”: the content is still in the log (Trajectory) and disabling the plugin reveals the rows again.
- **Not-on-surface targets are refused.** Rewinding past a compaction boundary cannot place the cut in the model context, so it is rejected with an explanation.
- **Text only in the composer.** If the withdrawn message had images or file attachments, they are not restored to the composer in this version; the text is.
- **No network, no telemetry.** The host half only appends to the live session; the browser half talks to it over the local `/api` channel.

## Compatibility

| DSH version | Status                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| 0.2.2-rc.1  | Verified: `pnpm smoke:session-rewind` (17/17) in a temporary DSH home; desktop Electron not regressed separately |

The plugin declares no `engines.dsh` and no `@deepseek-ai/*` peer range: DSH is pre-release and semver ranges over prereleases are unreliable (see [ADR 0005](../../docs/adr/0005-dsh-version-compatibility.md)). Treat the table as the compatibility statement. When a DSH upgrade changes the Chat builder or slot ledger, the plugin's degraded modes above are the fallback; run the smoke test after upgrading.

## Development

```bash
pnpm test           # unit tests (host pure modules + client helpers)
pnpm verify         # repo-wide gates
pnpm smoke:session-rewind   # temp DSH home + real GUI end-to-end (needs dsh & ego-browser)
```

Design notes: [ADR 0006](../../docs/adr/0006-session-rewind-architecture.md) (Chinese; the repository's docs are written in Chinese).

## License

MIT
