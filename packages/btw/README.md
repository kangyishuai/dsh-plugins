# @kangyishuai/dsh-btw

> **Read-only side questions that do not interrupt the main task.**

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

## What it does

`/btw <question>` asks a side question about the current work **without interrupting the main task and without adding to the conversation history**.

- **Available while the agent is working.** The command dispatches immediately instead of queueing behind the running turn (measured: 215 ms, no user message created).
- **Read-only.** The side question runs in a forked child agent with **no tools**; a tool guard is armed on that child's own scope and denies any tool call from it, and `send_message` is always denied.
- **Cheap.** The fork reuses the parent conversation's prompt prefix, so the provider serves most of it from cache (measured: 57% on the first fork, 94% on a repeat). Cache writes are not billed.
- **Kept.** Answers are written to a per-session JSONL history so you can reopen the last one with a bare `/btw`.
- **Threads.** Follow up on a side question without losing the earlier exchange; the thread's history is replayed to the model each turn.
- **Streaming.** The drawer renders the answer as it is generated instead of waiting for the whole reply (the host buffers the child's text deltas; the panel reads them through `btw/live`).
- **Markdown.** Headings, lists, tables, quotes, fenced code and inline styles render properly. The promote draft keeps its Markdown source, so it renders correctly once you send it.
- **Readable numbers.** The cost badge adapts tokens to `K/M/B/T` and duration to `ms/s/m/h` (for example `new 12.3K · cached 988K · 32.5s`).
- **Promote to draft.** Turn the **whole thread** into a four-section Markdown draft (first question / latest conclusion / key details including every follow-up / still unresolved) and **insert it into the composer — never send it**. You decide whether to send.
- **Native right sidebar.** The「旁问」button opens a tab in the DSH right sidebar: the conversation becomes narrower but is **never covered**.the sidebar's own collapse button (⌥⌘B) collapses the column and clicking the「旁问」button expands it again. Hosts without the sidebar service fall back to a right-edge overlay drawer.
- **Chat order.** Threads list oldest first with every turn expanded, the newest answer at the bottom, and the view follows the latest content.
- **Honest scope badge.** The drawer states how many side questions exist and reminds you that **the model can see the whole conversation**; a scope choice only narrows the instruction, it does not cut context.

## How it works

A third-party DSH plugin cannot reach a provider adapter through `ctx.llm` (every access path resolves to an instance without adapters). The supported path is a **forked subagent**:

1. `ctx.subagents.startActivation({ provider: 'fork', parent: agent, … })` — the parent `Agent` comes from the command invocation.
2. A `tools.guard(...)` is armed **on the child's own context** (`ctx.agents.get(childId).ctx.tools`) so the side question stays read-only. The host registers a guard in the calling scope and checks `[global, ...agent scope chain]`, so a guard armed through the child only constrains that side question (agent scopes have no parent link, so the chain is just that agent's own layer — nothing else inherits it). The plugin never arms one through its own unscoped context: that would land in the host's **global** layer and deny tool calls for **every** agent in the process while the side question runs. If the child context cannot be resolved, no guard is armed at all — the internal run result records `guardScope: "none"` (no RPC field or UI shows it) — and the prompt still forbids tool use.
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

The panel opens from the「旁问」button left of the composer as a tab in the **native DSH right sidebar**:
the conversation becomes narrower but the panel never covers it. Use the sidebar's own collapse button (⌥⌘B) to collapse the column (the tab is
kept), and the「旁问」button to expand it again; close the tab with its own × or the panel's「关闭」button.
Hosts that do not load the sidebar service fall back to a right-edge overlay drawer that collapses to a
thin edge rail.

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

| Key              | Default | Meaning                                                                                                                                                                                             |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedTools`   | `[]`    | Overrides the plugin config above when non-empty.                                                                                                                                                   |
| `historyLimit`   | `50`    | Records kept per session (1–200). The plugin reads this value on every history read and write: lowering it hides older records immediately and physically trims the file on the next side question. |
| `echoAnswer`     | `true`  | Also show the full answer in the conversation; off = panel only.                                                                                                                                    |
| `boundedContext` | `false` | Above 400K tokens of session context, use a spawn child with the last 12 messages instead of forking the whole session. Opt-in; answers may miss older context.                                     |

The settings file is re-read on every use, so edits take effect without restarting the host.

Promotion inserts an **unsent draft** only; it never sends. The draft is fitted to the current composer width and capped at six lines: a short thread keeps the four-section Markdown source, a long thread becomes a question-plus-conclusion summary that ends with a pointer to the side-question panel (the full answer stays there).

Panel details: the bottom「New question」input hides while a thread follow-up is open (no two similar inputs); the follow-up button reads「Follow up」/「Cancel follow-up」. `Esc` closes the panel unless the settings dialog owns focus; the input is focused when the panel opens; long answers can be expanded and collapsed without losing the reading position. The panel footer has an「Answer only in this panel」toggle (same as `echoAnswer`, no need to open Settings).

## Side effects & risks

- **Spends one model call** per side question (a fork of the current conversation).
- **Creates a child session**, then archives it. If archiving is unavailable the child stays visible in the session list — the answer itself is unaffected.
- **Writes** `<dataRoot>/btw/<parentSessionId>.jsonl` (up to `historyLimit` records per session; default 50, configurable 1–200; atomically replaced). Two side questions in the same session cannot lose each other's record: appends are serialized per file inside the host process. It never copies the main conversation to disk.
- **Read-only is enforced in-process by a tool guard**, not by prompt text: the guard is armed on the side-question child's own scope, so a tool call from that child is denied with a model-facing reason while other sessions stay unaffected. The scope mechanics are confirmed against the shipped host source on DSH 0.2.2-rc.5 (`tools.guard()` registers in the calling scope; `checkGuards()` walks `[global, ...agent scope chain]`); an end-to-end live denial was not re-run for this release (**pending live verification**). If the child context cannot be resolved — not observed in practice — no guard is armed, a warning is logged, and read-only falls back to the prompt only.
- **Cost warning on very large sessions**: above a 250K-token parent context (the host's context pressure), the panel shows one warning line with the projected 0.75–1.2× range and the last actual side-question prompt size; `/btw` appends the same line to its result. It never blocks the question.
- **Optional bounded mode (`boundedContext`)**: above 400K tokens, a side question can run on a `spawn` child that only sees the last 12 user/assistant messages (700 chars each, 4000 total) plus the question. Cost is bounded by the digest plus the host's fixed subagent overhead (tens of thousands of tokens; ~119K on a heavily loaded profile, vs 762K for a full fork on the same session), but older context is dropped and answers are marked `bounded`. Off by default; fork cache reuse is lost in this mode. The parent transcript is read only when the mode triggers (previously every side question materialized it, even with the mode off). If the digest ends up with no messages, the run logs a warning and falls back to a full fork — and that fallback costs the usual fork amount.

## Uninstall & leftovers

Removing the plugin removes **code only**; it never deletes data it wrote:

- `<dataRoot>/btw/<parentSessionId>.jsonl` — side-question history, one file per parent session;
- `<dataRoot>/btw/settings.json` — the settings saved from **Settings → Side questions**.

`<dataRoot>` defaults to `~/.dsh` (configurable with the `dataRoot` plugin config). To clean up completely after uninstalling, delete `<dataRoot>/btw/`. Side questions also leave **archived child sessions** in the host's own session store — that data belongs to DSH, not to this plugin, and is managed with the host's session list.

## Compatibility

| Plugin | Verified on DSH                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------- |
| 0.6.0  | 0.2.2-rc.3                                                                                          |
| 0.6.0  | 0.2.2-rc.5                                                                                          |
| 0.6.1  | 0.2.2-rc.5                                                                                          |
| 0.6.2  | 0.2.2-rc.5（发布后 `--npm` web 复验 + 线上索引 13/13 + live 桌面重启后复验）                        |
| 0.6.3  | 0.2.2-rc.5（发布后 `--npm` web 复验 + 线上索引 13/13 + 临时宿主 bounded e2e + live 桌面重启后手测） |

The underlying host seams (command dispatch while busy, fork cache reuse, `tools.guard`, `workspaceRegistry.archiveSession`) were verified on DSH 0.2.2-rc.3 and re-checked unchanged on 0.2.2-rc.5 ([runtime rc.5](../../docs/runtime/0.2.2-rc.5.md): a 43-package diff found no change in any seam this plugin uses).

End-to-end status: for the published 0.6.0, the web smoke passes **15 PASS / 3 SKIP / 0 FAIL** and the deep smoke (real model calls) passes **30 PASS / 1 SKIP / 0 FAIL**; on DSH 0.2.2-rc.5 both were re-run (15/3/0 and **30 PASS / 1 SKIP / 0 FAIL**, the deep run leaving a `status=done` history record), plus the live desktop regression **18 PASS / 1 SKIP** (and **22 PASS / 1 SKIP** with `--deep`, which writes a real `~/.dsh/btw` record). The remaining deep SKIP is a data-dependent branch (the thread-card assertion runs before the first submit). The deep smoke warms the session up with one ordinary message first, because a slash command renders no conversation card in a **blank** session ([runtime rc.5 §5.2](../../docs/runtime/0.2.2-rc.5.md#52-命令卡片只在非空白会话里渲染2026-11-20-实测)). The desktop regression against the **installed 0.6.0** (real desktop profile, after restart) passes **25 PASS / 0 SKIP / 0 FAIL**, and `pnpm gate btw` passes the full 4-step gate.

**0.6.1** fixes two 0.6.0 leftovers: promotion no longer blows up the main composer (a long thread used to insert a 1262-character draft that rendered ~62 lines; it is now fitted to at most six lines at the measured composer width, with the full answer left in the panel), and the host half now actually reads its Chinese/English locale files (0.6.0 kept showing the English `FALLBACK` for `/btw` command results because the nested locale table never matched the flat keys). On DSH 0.2.2-rc.5: web **15 PASS / 3 SKIP / 0 FAIL**, web `--deep` **30 PASS / 1 SKIP / 0 FAIL**, desktop **25 PASS / 0 SKIP / 0 FAIL**, desktop `--deep` **23 PASS / 1 SKIP / 0 FAIL** (the extra assertion is the composer-height threshold). DSH has **no host-side locale service** and passes command text through verbatim ([runtime rc.5 §8.1](../../docs/runtime/0.2.2-rc.5.md)), so a plugin must localize itself; and replacing `client.js` in a live desktop may keep serving the previously cached bundle until the app restarts ([runtime rc.5 §8.2](../../docs/runtime/0.2.2-rc.5.md)). The **published 0.6.3** was verified from npm: web `--npm` **15 PASS / 3 SKIP / 0 FAIL**, `--npm --deep` **30 PASS / 1 SKIP / 0 FAIL**, online index **13/13**, and a bounded e2e on a real 668K-token session produced a `mode="bounded"` record with **21,503** total tokens (vs 762,526 for a full fork) and `· bounded` in the command result. The live desktop was restarted and re-checked: the bounded checkbox in settings persists to `settings.json`, and a 668K-token session produced a `mode="bounded"` record with **118,730** total tokens (vs 762,526 for a full fork on the same session) whose result carries `· bounded` and no fork-cost warning ([runtime rc.5 §8.2](../../docs/runtime/0.2.2-rc.5.md)). The **published 0.6.2** was verified from npm: web `--npm` **15 PASS / 3 SKIP / 0 FAIL**, `--npm --deep` **30 PASS / 1 SKIP / 0 FAIL**, online index **13/13** (lists 0.6.2); its panel warning was e2e-checked on a real 668K-token session in a temporary host. The live desktop was restarted and re-checked: the panel warning renders on a real 668K-token session (`[data-btw-cost-hint="warn"]`), and desktop `--deep` passes **30 PASS / 0 SKIP / 0 FAIL** ([runtime rc.5 §8.2](../../docs/runtime/0.2.2-rc.5.md)). The **published 0.6.1** was re-verified from npm: web smoke **15 PASS / 3 SKIP / 0 FAIL**, web `--deep` **30 PASS / 1 SKIP / 0 FAIL**, desktop regression **23 PASS / 1 SKIP** (blank session), and the online plugin index lists 0.6.1 (index smoke **13/13**).

## License

MIT
