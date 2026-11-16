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

## How it works

A third-party DSH plugin cannot reach a provider adapter through `ctx.llm` (every access path resolves to an instance without adapters). The supported path is a **forked subagent**:

1. `ctx.subagents.startActivation({ provider: 'fork', parent: agent, … })` — the parent `Agent` comes from the command invocation.
2. A `ctx.tools.guard(...)` is armed on the child so the side question stays read-only.
3. The child's answer is read from the activation result, the child session is archived so it does not clutter the session list, and the Q&A is appended to history.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-btw
```

Restart the DSH desktop app afterwards.

## Usage

```
/btw what was the name of that config file again?
/btw                      # reopen the last answer
```

## Configuration

| Key            | Default                | Meaning                                                                                             |
| -------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `allowedTools` | `[]`                   | Tool names the side question may use. Empty means fully read-only. `send_message` is never allowed. |
| `language`     | `auto`                 | `en` / `zh`; `auto` follows the system locale.                                                      |
| `dataRoot`     | `$DSH_HOME` → `~/.dsh` | Where the history file lives (`<dataRoot>/btw/<session>.jsonl`).                                    |

## Side effects & risks

- **Spends one model call** per side question (a fork of the current conversation).
- **Creates a child session**, then archives it. If archiving is unavailable the child stays visible in the session list — the answer itself is unaffected.
- **Writes** `<dataRoot>/btw/<parentSessionId>.jsonl` (up to 50 records per session, atomically replaced). It never copies the main conversation to disk.
- **Read-only is enforced at runtime**, not by prompt text: a tool call from the side question is denied with a model-facing reason.

## Compatibility

| Plugin | Verified on DSH |
| ------ | --------------- |
| 0.1.0  | 0.2.2-rc.3      |

The underlying host seams (command dispatch while busy, fork cache reuse, `tools.guard`, `workspaceRegistry.archiveSession`) were verified on DSH 0.2.2-rc.3. **The plugin itself has not yet been installed into a live profile** — that end-to-end check is still pending.

## License

MIT
