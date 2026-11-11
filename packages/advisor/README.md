# @kangyishuai/dsh-advisor

> A separately configured advisor model the main model can consult when _it_ decides to — before committing to an approach, when an error keeps recurring, before declaring a task done. Advisory only: it reads the conversation, returns structured advice, and never approves, blocks or runs anything.

[![npm](https://img.shields.io/npm/v/@kangyishuai/dsh-advisor?color=cb3837&logo=npm)](https://www.npmjs.com/package/@kangyishuai/dsh-advisor) [![DSH](https://img.shields.io/badge/verified%20on%20DSH-0.2.2--rc.1-4b6bfb)](#compatibility) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: early.** Verified against the current target DSH version — see the [Compatibility](#compatibility) table. The tool, the picker and the model lookup sit on host seams that are semi-public at best, so a DSH upgrade can silently disable them (read [Side effects, limitations & risks](#side-effects-limitations--risks) first). Young software — start in `shadow` mode and keep an eye on the ledger.

## What it does

This is an **on-demand** advisor, not a passive reviewer. The main model decides when a second opinion is worth a call; the plugin does not re-read every turn on a schedule, so cost and latency grow with the number of _decisions_, not with the length of the conversation.

- **A tool the model calls.** The plugin registers one tool, `advisor` (no required parameters; an optional `focus` string names the specific doubt). The tool description tells the main model to consult before substantive work, when the same error keeps recurring, before changing approach after a failure, and before declaring the task done — and to stop calling on short reactive tasks.
- **A second model reads the whole conversation.** On a consultation the plugin renders the session transcript — user messages, assistant messages, **tool calls and their results** — into one bounded text and sends it to the advisor route you configured. Advisor and main model can be the same model, another model on the same route, or a different provider.
- **Structured advice, in the same turn.** The advisor answers with one JSON object: a verdict (`reviewed` / `declined`), a severity (`nit` / `concern` / `blocker`), advice capped at 900 characters, up to five risks, up to five acceptance checks, and evidence anchors (tool-call ids, message ids, paths). "Nothing to add" is a valid answer. The result comes back as a normal tool result, so the main model continues without a new turn.
- **Advisory only.** The advisor cannot approve, deny or run tools, and its output never authorizes an action. The main model still decides and still owns the result.
- **`off` / `shadow` / `advisory`.** Off by default. `shadow` runs one consultation after each normally completed turn and records it without injecting it; `advisory` is the live mode.
- **Cross-provider by design.** The advisor route is independent of the main model. Different model families miss different things, which is the point of a second opinion — but read [Cost & privacy](#cost--privacy) before pointing it at another vendor.
- **Budgets and a ledger.** Per turn, per session, per hour and a per-day cost ceiling, plus a token ledger at `<DSH_HOME>/advisor/usage.jsonl`. DSH does not record usage for extra model calls, so the plugin records it itself.

### What it is not

| Not this                                        | Why                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A per-turn reviewer that re-checks every answer | Cost and latency would scale with the conversation, and repeated "looks fine" reviews add noise, not signal. |
| A permission or approval gate                   | Advisory means advisory: nothing here can block or allow a tool call.                                        |
| A multi-model voting panel                      | One advisor, one answer — no aggregation rules to argue with.                                                |
| A model router                                  | It never switches the main model; it only answers.                                                           |

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-advisor
```

To run the working tree instead of a published version, pack it first — `link:` installs do not work (the host's `@deepseek-ai/*` resolution only covers packages whose real path is inside the profile):

```bash
cd packages/advisor
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-advisor-*.tgz
```

Re-run `pnpm pack` + `add` after changing the code. The plugin has a host half and a thin client half: **restart the DSH desktop app** for host changes and **refresh the page** for client changes. Nothing is sent anywhere until you configure an advisor route and turn the plugin on.

## Configure

**The advisor model's base URL, API key and wire protocol are not managed by this plugin.** Configure them in DSH _Settings → Models_ — the `dsh-llm-pi-ai` `providers` map, where each key is one route. This plugin only stores the **route name** and a model id; it never reads or writes credentials.

Settings live in one JSON file, `<DSH_HOME>/advisor.settings.json` (`DSH_HOME` defaults to `~/.dsh`; the plugin's `dataRoot` config overrides it). The host re-reads the file before each consultation (1 s cache), so editing it applies to the next call without a restart. Unknown keys are dropped, out-of-range numbers are clamped, and a corrupt file falls back to the defaults. **The default is `off`** — a plugin that spends money and sends conversation content stays opt-in.

| Key                  | Default     | Range / values                                     | Meaning                                                                                                           |
| -------------------- | ----------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `mode`               | `"off"`     | `off` / `shadow` / `advisory`                      | Whether the plugin may call the advisor at all.                                                                   |
| `provider`           | `""`        | route name from Settings → Models, up to 300 chars | Advisor route. Empty means never call.                                                                            |
| `model`              | `""`        | model id under that route, up to 300 chars         | Advisor model. Empty means never call.                                                                            |
| `reasoningEffort`    | `""`        | an effort id from the model, `""` = model default  | Thinking effort for the advisor. An unsupported value is retried once without an effort; `doctor` warns about it. |
| `maxTokens`          | `4096`      | 256–32000                                          | Output cap per consultation.                                                                                      |
| `temperature`        | `null`      | 0–2, `null` = not sent                             | `null` lets the model adapter decide.                                                                             |
| `maxCallsPerTurn`    | `1`         | 0–8, `0` = unlimited                               | Consultations per turn.                                                                                           |
| `maxCallsPerSession` | `32`        | 0–1000, `0` = unlimited                            | Consultations per session.                                                                                        |
| `maxCallsPerHour`    | `12`        | 0–500, `0` = unlimited                             | Sliding one-hour window.                                                                                          |
| `maxCostPerDayUsd`   | `0`         | 0–10000, `0` = unlimited                           | Daily spend ceiling in USD. Only meaningful once the two prices below are set.                                    |
| `priceInputPerMTok`  | `0`         | 0–1000                                             | Your advisor model's input price, USD per million tokens. `0` = do not estimate money.                            |
| `priceOutputPerMTok` | `0`         | 0–1000                                             | Output price, USD per million tokens.                                                                             |
| `privacyScope`       | `"summary"` | `full` / `summary` / `off`                         | How much of the conversation is sent — see [Cost & privacy](#cost--privacy).                                      |
| `redact`             | `true`      | boolean                                            | Best-effort scrubbing of token-shaped strings before anything is sent.                                            |
| `immuneTurns`        | `3`         | 0–20                                               | Turns to stay quiet after a delivery. Used by shadow delivery; reserved in this MVP — see the note below.         |
| `dedupe`             | `true`      | boolean                                            | Suppress repeated suggestions. Used by shadow delivery; reserved for the tool path — see the note below.          |
| `sessionCap`         | `24`        | 0–200                                              | Max advice items delivered per session; once reached only `blocker` still gets through.                           |
| `tiers`              | `{}`        | map of `"provider/model"` → number                 | Capability ranks for the pairing check. Without an entry the pairing is reported as unverified, never as passed.  |
| `pairingEnforcement` | `"warn"`    | `warn` / `block`                                   | What to do when the advisor's declared tier is lower than the main model's.                                       |
| `timeoutMs`          | `90000`     | 5000–600000                                        | Per-consultation timeout; `/advisor cancel` aborts sooner.                                                        |
| `maxInputChars`      | `60000`     | 4000–400000                                        | Total transcript budget; excess in the middle is elided and head/tail are kept.                                   |

> **Note on `sessionCap`, `dedupe`, `immuneTurns`:** `sessionCap` is enforced — after that many delivered items in one session only `blocker` advice is still returned. `dedupe` and `immuneTurns` are persisted and used by the shadow path, but the tool path does not suppress a consultation because of them (you asked for it explicitly). The ceilings that stop _calls_ altogether are `maxCallsPerTurn` / `maxCallsPerSession` / `maxCallsPerHour` / `maxCostPerDayUsd`.

Example (placeholder route and model names — use the ones the picker shows you):

```json
{
  "mode": "shadow",
  "provider": "my-router",
  "model": "large-model",
  "priceInputPerMTok": 3,
  "priceOutputPerMTok": 15
}
```

**Picking a model.** `/advisor` opens a picker listing the routes and models already configured in DSH, plus _off_ and _add / configure provider_. Choosing a model switches `mode` to `advisory`. `/advisor doctor` tells you line by line what is still missing.

## Commands

| Command                                | What it does                                                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/advisor`                             | Opens the model picker (client half). Routes and models are re-read every time; nothing is cached across openings.                                                                                                               |
| `/advisor status`                      | Mode, chosen route, consultations this session and this turn against the limits, cumulative tokens, the last result, and why the last consultation was skipped.                                                                  |
| `/advisor on`                          | Sets `advisory`. Refuses with a pointer to the picker when no advisor model is configured.                                                                                                                                       |
| `/advisor off`                         | Sets `off`: no consultation is made, no request is sent.                                                                                                                                                                         |
| `/advisor shadow`                      | Sets `shadow`: consult after each completed turn and record it, without feeding it back.                                                                                                                                         |
| `/advisor ask`                         | Runs one consultation **now** and returns the advice as command output.                                                                                                                                                          |
| `/advisor cancel`                      | Aborts the in-flight consultation — the request is aborted, not merely ignored.                                                                                                                                                  |
| `/advisor doctor`                      | Self-check: host `llm` service, registered routes, route resolution and context window, supported efforts, mode, session budget, ledger state, last failure. Each line states its conclusion and, where relevant, the next step. |
| `/advisor <provider>/<model> [effort]` | Sets the advisor route directly, with the same validation as the picker (unknown route, missing credentials and unsupported effort are rejected with a readable reason).                                                         |

The `advisor` **tool** is separate from the command: the model calls it, not you. It takes no required arguments; its optional `focus` is one sentence naming the doubt you want settled — not the task itself, because the transcript always is.

## Cost & privacy

This is the section to read before turning it on.

- **Every consultation is an extra model call**, billed by the advisor route against that provider's quota. The main model's own usage is unaffected.
- **Token accounting is ours.** DSH records usage only for the main loop's assistant messages, so the plugin writes its own ledger: `<DSH_HOME>/advisor/usage.jsonl`, one JSON object per consultation (time, session id, trigger `tool` / `shadow` / `manual`, provider, model, effort, verdict, severity, input/output/cache tokens, estimated cost, duration, error code). The file is append-only, rolls over to `usage.jsonl.1` at 2 MiB, and totals are restored from its tail on startup.
- **Money needs your prices.** DSH's model metadata has no price field. Set `priceInputPerMTok` and `priceOutputPerMTok`; with zeros the ledger records tokens only and no dollar amount is shown. The plugin never guesses prices.
- **The daily budget counts spend already recorded**, so the one consultation that crosses the ceiling still completes and is charged.
- **Conversation content leaves the machine when the advisor route is external.** The transcript — with tool calls and results, bounded by `privacyScope` and `maxInputChars` — is sent to whatever base URL that route points at. If that is another vendor, your conversation leaves this machine. Only a route pointing at a local gateway keeps it local. The plugin sends nothing else: no telemetry, no analytics, no network access besides the consultation itself.
- **`privacyScope` decides how much is sent.** `summary` (default): each text block up to 2,000 characters, tool arguments up to 300, tool results up to 700. `off`: user and assistant text only, up to 1,200 characters, with no tool traffic at all. `full`: text up to 4,000, tool arguments up to 1,200, tool results up to 3,500. The rendered transcript is then capped at `maxInputChars` (60,000 by default): the first 30% and the tail are kept and the middle is replaced by an elision marker.
- **Redaction is best-effort.** With `redact: true` (default) the plugin scrubs common token-shaped strings, `Authorization` headers, `KEY=` / `TOKEN:`-style assignments, credentials embedded in URLs and PEM private-key blocks **before** clipping. It is a heuristic filter, **not a secret scanner**: it will miss things, it cannot guarantee that a secret never leaves, and it is no substitute for deciding whether this repository may be sent to that provider at all.
- **Start in `shadow`.** It answers "what would it have said, and what would that have cost" without putting model output back into your session. Read the ledger for a few days, then switch to `advisory`.

## Compatibility

| DSH version | Status                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2-rc.1  | Verified on this version: unit tests (settings clamping, route selection and pairing, budget guard, transcript rendering, redaction, output contract) and `pnpm probe:runtime`; the desktop read-only regression is `pnpm smoke:advisor-desktop`. Other DSH versions are not verified. |

The plugin declares no `engines.dsh` and no `@deepseek-ai/*` peer range: DSH is pre-release and semver ranges over prereleases are unreliable (see [ADR 0005](../../docs/adr/0005-dsh-version-compatibility.md)). Treat this table as the compatibility statement. After a DSH upgrade run `pnpm probe:runtime`, `pnpm smoke:advisor-desktop` and the unit tests, then check `/advisor doctor`.

## Side effects, limitations & risks

**What it writes**

| Path                                      | What                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<DSH_HOME>/advisor.settings.json`        | Plugin settings; written by `/advisor` and the picker, re-read before every consultation. |
| `<DSH_HOME>/advisor/usage.jsonl` (+ `.1`) | One line per consultation; append-only, rotated at 2 MiB.                                 |

Nothing else: no workspace files, no session-log records of its own (a consultation shows up as an ordinary tool call and tool result in the transcript), no telemetry.

- **The advice is model output.** It can be wrong, vague, or confidently wrong. The plugin validates the _shape_ — a JSON object, a known verdict and severity, length caps, declared evidence anchors — not the content. Weigh it and verify it; the main model still owns the decision.
- **Semi-public host seams.** `llm.prepareCall`, `llm.resolveModelInfo`, `session.deriveMessages`, `tools.register`, `commands.register` and `session/event` on the host side, and `commandUi.decorate` (the picker) on the client side, are not a stable public API. A DSH upgrade can silently disable the tool, the picker or the command. Run `pnpm probe:runtime` after every upgrade; installation failures are logged rather than thrown, so check `/advisor doctor` and the host logs.
- **Pairing needs your declaration.** DSH has no cross-vendor capability catalog, so "is the advisor at least as strong as the main model" can only come from your `tiers`. Without an entry the result says **unverified** and the consultation proceeds; it never pretends the check passed. With `pairingEnforcement: "block"` a lower declared tier rejects the consultation.
- **Token counts can be low on an aborted call.** If a consultation is cancelled or times out, no usage chunk may arrive; the ledger then records the call with zero tokens and a cost budget can lag real spend. Treat the ledger as a good estimate, not an invoice.
- **The advisor route can be broken from outside this plugin** (wrong base URL, missing key, rate limit). Every failure becomes a structured tool result (`MISSING_CREDENTIAL`, `rate_limited`, `overloaded`, `prompt_too_long`, `timeout`, `aborted`, …) and never breaks the turn.
- **No settings card in this MVP.** Configuration is the JSON file plus the picker; there is no Settings → General page yet.
- **Partially enforced knobs.** `sessionCap` caps delivered advice per session (blockers exempt); `dedupe` / `immuneTurns` only matter on the shadow path — see [Configure](#configure).
- **One attempt, not a retry loop.** A malformed advisor answer is reported as unavailable rather than retried; an unsupported thinking effort is retried exactly once without an effort.
- **`shadow` mode still spends quota.** It skips the injection, not the call. And while `shadow` is on, an explicit `advisor` tool call still returns its advice: the mode suppresses the automatic end-of-turn review, not a model-initiated consultation. Use `off` to stop all calls.
- **Subagent sessions** are skipped by the automatic shadow review; only top-level turns are reviewed.

## Testing & verification

```bash
pnpm verify                  # repo-wide gates: lint, typecheck, plugin conventions, docs, unit tests
cd packages/advisor && pnpm test   # unit tests for this plugin (node --test)
pnpm smoke:advisor-desktop   # desktop (Electron) read-only regression over CDP
pnpm smoke:agent-tool        # repo-wide real-model tool smoke (needs credentials; SKIPs without them)
```

- `pnpm verify` is the release gate and must pass before a PR.
- `pnpm smoke:advisor-desktop` is the desktop (Electron) read-only regression, required because the plugin has a client half. It attaches to the running app over CDP, confirms the plugin's client half actually loaded, and never triggers a paid consultation. Pass `--require` in release gates so an unreachable debug port fails instead of silently skipping. It expects the app started with `open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`.
- `pnpm smoke:agent-tool` exercises a registered tool with a real model in a throwaway DSH home. It needs model credentials and exits as SKIP without them — a SKIP is not a pass.

Manual end-to-end check, the only way to confirm a real advisor call:

1. `cd packages/advisor && pnpm pack --pack-destination /tmp`, then `dsh plugin --profile desktop add /tmp/kangyishuai-dsh-advisor-*.tgz`.
2. Restart the DSH desktop app; configure the advisor route in _Settings → Models_ if you have not already.
3. `/advisor doctor` should explain every line; `/advisor` lists your models; choose one.
4. `/advisor shadow`, then work one normal turn. Confirm a line appeared in `<DSH_HOME>/advisor/usage.jsonl` and that no advice was injected.
5. `/advisor on` (or `/advisor ask` for a single consultation). Confirm the advice arrives in the tool card / command output and that `/advisor status` counters move.
6. `/advisor off` when done. `dsh plugin --profile desktop remove @kangyishuai/dsh-advisor` uninstalls the code; the settings file and ledger stay.

Test layers, assertions and the full manual GUI checklist: [docs/testing/advisor.md](../../docs/testing/advisor.md) (Chinese, like the rest of the repository docs). Design notes: [ADR 0010](../../docs/adr/0010-advisor-architecture.md).

## License

MIT. Source, issues and release notes: [kangyishuai/dsh-plugins → packages/advisor](https://github.com/kangyishuai/dsh-plugins/tree/main/packages/advisor).
