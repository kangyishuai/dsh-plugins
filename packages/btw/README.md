# @kangyishuai/dsh-btw

> **Read-only side questions that do not interrupt the main task.**

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

## What it does

`/btw <question>` asks a side question about the current work **without interrupting the main task and without adding to the conversation history**.

- **Available while the agent is working.** The command dispatches immediately instead of queueing behind the running turn (measured: 215 ms, no user message created).
- **Read-only.** The side question runs in a forked child agent with **no tools**; a runtime guard denies any tool call that slips through, and `send_message` is always denied.
- **Cheap.** The fork reuses the parent conversation's prompt prefix, so the provider serves most of it from cache (measured: 57% on the first fork, 94% on a repeat). Cache writes are not billed.
- **Kept.** Answers are written to a per-session JSONL history so you can reopen the last one with a bare `/btw`.
- **Threads.** Follow up on a side question without losing the earlier exchange; the thread's history is replayed to the model each turn.
- **Streaming.** The drawer renders the answer as it is generated instead of waiting for the whole reply (the host buffers the child's text deltas; the panel reads them through `btw/live`).
- **Markdown.** Headings, lists, tables, quotes, fenced code and inline styles render properly. The promote draft keeps its Markdown source, so it renders correctly once you send it.
- **Readable numbers.** The cost badge adapts tokens to `K/M/B/T` and duration to `ms/s/m/h` (for example `new 12.3K · cached 988K · 32.5s`).
- **Promote to draft.** Turn the latest side question into a four-section Markdown draft (question / conclusion / key details / still unresolved) and **insert it into the composer — never send it**. You decide whether to send.
- **Right-side drawer.** The panel docks against the right edge above the composer instead of covering the middle of the conversation; collapse it to a thin edge rail and click the rail to bring it back.
- **Chat order.** Threads list oldest first with every turn expanded, the newest answer at the bottom, and the view follows the latest content.
- **Honest scope badge.** The drawer states how many side questions exist and reminds you that **the model can see the whole conversation**; a scope choice only narrows the instruction, it does not cut context.

## How it works

A third-party DSH plugin cannot reach a provider adapter through `ctx.llm` (every access path resolves to an instance without adapters). The supported path is a **forked subagent**:

1. `ctx.subagents.startActivation({ provider: 'fork', parent: agent, … })` — the parent `Agent` comes from the command invocation.
2. A `ctx.tools.guard(...)` is armed on the child so the side question stays read-only.
3. The child's answer is read from the activation result, the child session is archived so it does not clutter the session list, and the Q&A is appended to history.

Follow-ups re-fork each turn and replay the thread's own Q&A into the prompt — a fork is single-turn, so keeping one child alive would degenerate into a full side session with its own lifecycle.

Live text never leaves the host process as raw history: an `llm/stream` observer keyed by the child session keeps at most 12k characters in memory, the panel polls `btw/live`, and the buffer is dropped when the run ends. The panel deliberately does not subscribe to the child session from the client: a forked child is seeded with the parent's completed transcript, so retaining it would download that whole history into the browser just to read the tail. Markdown is parsed on the host into a JSON block tree and the client only maps it to React elements — no HTML injection, no bundler, and no import of host UI packages.

Promote only **returns text** from the host and inserts it with the composer's `setDraft`; `submit` is never called. If the composer already has content the action is refused instead of overwriting what you were typing.

Scope is deliberately **advisory**: a fork inherits every completed turn of the parent, and a plugin cannot inherit a subset. The badge says so instead of pretending the context was trimmed.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-btw
```

Restart the DSH desktop app afterwards.

## Usage

```
/btw what was the name of that config file again?
/btw                      # reopen the last answer
/btw --thread <threadId>  # continue an existing thread
/btw --scope recent <q>   # hint the answer to focus (session | recent | selection)
```

The panel opens as a **right-side drawer** from the「旁问」button left of the composer (it lives in
the frame-wide overlay layer, so it is not clipped by the composer). It sits against the right edge,
above the composer, and never covers the middle of the conversation. Click「收起」to collapse it to a
thin rail at the right edge; click the rail to expand it again; `Esc` closes it.

Threads are listed oldest first with every turn expanded, and the newest answer is at the bottom —
the view scrolls to the latest content when you open the drawer or when new content arrives. Each
answer renders Markdown; a long answer is clamped with「Show all」. The composer at the bottom starts
a new side question, while「Follow up」inside a thread opens that thread's own input.

## Configuration

Plugin config (set when adding the plugin to a profile):

| Key            | Default                | Meaning                                                                                             |
| -------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `allowedTools` | `[]`                   | Tool names the side question may use. Empty means fully read-only. `send_message` is never allowed. |
| `language`     | `auto`                 | `en` / `zh`; `auto` follows the system locale.                                                      |
| `dataRoot`     | `$DSH_HOME` → `~/.dsh` | Where history and settings live (`<dataRoot>/btw/`).                                                |

Runtime settings (editable in **Settings → Side questions**, stored in `<dataRoot>/btw/settings.json`):

| Key            | Default | Meaning                                           |
| -------------- | ------- | ------------------------------------------------- |
| `allowedTools` | `[]`    | Overrides the plugin config above when non-empty. |
| `historyLimit` | `50`    | Records kept per session (1–200).                 |

The settings file is re-read on every use, so edits take effect without restarting the host.

## Side effects & risks

- **Spends one model call** per side question (a fork of the current conversation).
- **Creates a child session**, then archives it. If archiving is unavailable the child stays visible in the session list — the answer itself is unaffected.
- **Writes** `<dataRoot>/btw/<parentSessionId>.jsonl` (up to 50 records per session, atomically replaced). It never copies the main conversation to disk.
- **Read-only is enforced at runtime**, not by prompt text: a tool call from the side question is denied with a model-facing reason.

## Compatibility

| Plugin | Verified on DSH |
| ------ | --------------- |
| 0.4.0  | 0.2.2-rc.3      |

The underlying host seams (command dispatch while busy, fork cache reuse, `tools.guard`, `workspaceRegistry.archiveSession`) were verified on DSH 0.2.2-rc.3.

End-to-end status: verified with the web smoke (temporary `DSH_HOME`, drawer geometry, collapse rail, Markdown rendering) and the desktop regression suite (`pnpm smoke:btw-desktop --require`) against the live desktop app; a `/btw` round trip was also verified against a real model, including the on-disk history record.

## License

MIT
