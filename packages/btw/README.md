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
- **Promote to draft.** Turn the latest side question into a four-section draft (question / conclusion / key details / still unresolved) and **insert it into the composer — never send it**. You decide whether to send.
- **Honest scope badge.** The overlay states how many side questions exist and reminds you that **the model can see the whole conversation**; a scope choice only narrows the instruction, it does not cut context.

## How it works

A third-party DSH plugin cannot reach a provider adapter through `ctx.llm` (every access path resolves to an instance without adapters). The supported path is a **forked subagent**:

1. `ctx.subagents.startActivation({ provider: 'fork', parent: agent, … })` — the parent `Agent` comes from the command invocation.
2. A `ctx.tools.guard(...)` is armed on the child so the side question stays read-only.
3. The child's answer is read from the activation result, the child session is archived so it does not clutter the session list, and the Q&A is appended to history.

Follow-ups re-fork each turn and replay the thread's own Q&A into the prompt — a fork is single-turn, so keeping one child alive would degenerate into a full side session with its own lifecycle.

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

The panel opens as a **centered dialog** from the「旁问」button left of the composer
(it lives in the frame-wide overlay layer, so it is not clipped by the composer).
It lists threads with cost badges, lets you follow up or promote one to a draft, and shows the
scope badge at the bottom. Use「＋ 新旁问」to reveal the new-question input.

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
| 0.3.0  | 0.2.2-rc.3      |

The underlying host seams (command dispatch while busy, fork cache reuse, `tools.guard`, `workspaceRegistry.archiveSession`) were verified on DSH 0.2.2-rc.3.

End-to-end status: the plugin has been installed into a live desktop profile and its desktop regression suite (`pnpm smoke:btw-desktop --require`) passes 18 assertions with zero skips; a `/btw` round trip was also verified against a real model, including the on-disk history record.

## License

MIT
