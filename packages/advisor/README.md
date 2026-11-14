# @kangyishuai/dsh-advisor

> A separately configured advisor model the main model can consult when _it_ decides to — before committing to an approach, when an error keeps recurring, before declaring a task done. Advisory only: it reads the conversation, returns structured advice, and never approves, blocks or runs anything.

[![npm](https://img.shields.io/npm/v/@kangyishuai/dsh-advisor?color=cb3837&logo=npm)](https://www.npmjs.com/package/@kangyishuai/dsh-advisor) [![DSH](https://img.shields.io/badge/verified%20on%20DSH-0.2.2--rc.2-4b6bfb)](#compatibility) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

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
- **A decision log, so "should it have asked?" can be answered with data.** `<DSH_HOME>/advisor/decisions.jsonl` gets
  **one row per turn** (including turns with no consultation): whether it consulted, the reason code when it did not,
  answer length / tool calls / errors, and whether the user's next message followed the advice.
  `pnpm advisor:review` reports consult and acceptance rates per bucket and lists two kinds of suspects:
  probably-missed and probably-wasted. Local file only — no network, no change to when it consults.

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

**Settings UI.** Settings → **Advisor** (its own section now, no longer buried in General). The first screen is three rows: mode, route, budget; everything else sits in a “More settings” fold that starts collapsed. With the default `off`, the card shows only the mode, a one-line status and “Configure advisor”. Enabling it reveals:

- **Basics**: mode, currency, provider, model, reasoning effort, daily budget, send scope, redaction.
- **Advanced** (folded by default): call limits, workspace limits, CNY-per-USD rate, prices (including cache read/write), output/input caps, advice-item cap, allowlist, auto-review, file reading, shadow dedupe, sent-content recording. The heading shows “Defaults” or “N changed”.
- **Status & diagnostics** (folded by default): calls/tokens/cost, last result/skip reason, send preview, diagnostics, settings and ledger paths.

The “?” next to an advanced field expands an inline help block (click or activate with the keyboard) with the description, default/range and technical key; hover is only a supplement. Click **Save** to apply changes to the next consultation.

Money fields accept decimals: budgets up to 2, unit prices up to 4.

| Key                       | UI label                       | Default     | Range / values                                | Meaning                                                                                                                          |
| ------------------------- | ------------------------------ | ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                    | Mode                           | `"off"`     | off / shadow / advisory                       | Whether the plugin may consult at all. Off by default; opt in explicitly.                                                        |
| `provider`                | Provider                       | `""`        | route name from Settings → Models, ≤300 chars | Advisor route. Empty means never call.                                                                                           |
| `model`                   | Model                          | `""`        | model id under that route, ≤300 chars         | Advisor model. Empty means never call.                                                                                           |
| `reasoningEffort`         | Reasoning effort               | `""`        | a supported effort id, `""` = model default   | An unsupported value is retried once without an effort.                                                                          |
| `maxTokens`               | Output limit                   | `4096`      | 256–32000                                     | Maximum output tokens per consultation.                                                                                          |
| `temperature`             | Randomness                     | `null`      | 0–2, `null` = not sent                        | Empty lets the model decide.                                                                                                     |
| `maxCallsPerTurn`         | Calls per turn                 | `1`         | 0–8, 0 = unlimited                            | Maximum consultations per turn.                                                                                                  |
| `maxCallsPerSession`      | Calls per session              | `32`        | 0–1000, 0 = unlimited                         | Maximum consultations per session.                                                                                               |
| `maxCallsPerHour`         | Calls per hour                 | `12`        | 0–500, 0 = unlimited                          | Sliding one-hour window.                                                                                                         |
| `currency`                | Currency                       | `"USD"`     | USD / CNY                                     | Amounts and prices are entered in this currency; the ledger/pool stay in USD internally.                                         |
| `usdToCny`                | CNY per USD                    | `7.2`       | 0.1–100                                       | 1 USD = ? CNY; used only for CNY conversion; manual, never fetched.                                                              |
| `maxCostPerDay`           | Daily budget                   | `0`         | 0–10000, 0 = unlimited; up to 2 decimals      | Daily spend ceiling in the selected currency; only counted when prices are set.                                                  |
| `priceInputPerMTok`       | Input price                    | `0`         | 0–1000; up to 4 decimals                      | Advisor input price in the selected currency per 1M tokens; 0 = do not price.                                                    |
| `priceOutputPerMTok`      | Output price                   | `0`         | 0–1000; up to 4 decimals                      | Output price in the selected currency per 1M tokens.                                                                             |
| `priceCacheReadPerMTok`   | Cache-read price               | `0`         | 0–1000; up to 4 decimals                      | Input-token price for cache reads/hits in the selected currency; 0 = do not price cache tokens.                                  |
| `priceCacheWritePerMTok`  | Cache-write price              | `0`         | 0–1000; up to 4 decimals                      | Input-token price for cache writes/creations in the selected currency; 0 = do not price cache tokens.                            |
| `privacyScope`            | Send scope                     | `"summary"` | off / summary / full                          | How much conversation content is sent — see Cost & privacy.                                                                      |
| `redact`                  | Redact before sending          | `true`      | boolean                                       | Best-effort masking of common key formats; not a guarantee.                                                                      |
| `immuneTurns`             | JSON only: Immune turns        | `3`         | 0–20                                          | Turns to stay quiet after a delivery; used by shadow delivery.                                                                   |
| `dedupe`                  | Dedupe in shadow mode          | `true`      | boolean                                       | In shadow mode, the same advice is recorded once; the tool path does not block on it.                                            |
| `sessionCap`              | Advice items per session       | `24`        | 0–200                                         | Max advice items shown per session; once reached only blockers get through.                                                      |
| `tiers`                   | JSON only: Tiers               | `{}`        | `"provider/model"` → number                   | Capability ranks for the pairing check; without an entry the pairing is unverified.                                              |
| `allowedModels`           | Model allowlist                | `[]`        | string array                                  | Empty = no limit; accepts provider/model or a bare model id.                                                                     |
| `confirmedHosts`          | JSON/button: Confirmed hosts   | `[]`        | string array                                  | Cross-provider confirmation list; the settings-card button writes it.                                                            |
| `pairingEnforcement`      | JSON only: Pairing enforcement | `"warn"`    | warn / block                                  | When the advisor tier is lower: warn allows and warns; block refuses.                                                            |
| `workspaceMaxCallsPerDay` | Workspace calls per day        | `200`       | 0–100000, 0 = unlimited                       | Workspace-wide, shared across sessions, resets on the local day.                                                                 |
| `workspaceMaxCostPerDay`  | Workspace daily budget         | `0`         | 0–10000, 0 = unlimited; up to 2 decimals      | Workspace-wide daily ceiling in the selected currency.                                                                           |
| `postAnswer`              | Auto-review after each turn    | `"off"`     | off / card                                    | In advisory mode, runs once after each answer; records only, never inserts.                                                      |
| `advisorTools`            | Let the advisor read files     | `false`     | boolean                                       | Lets it read working-directory files (up to 5, read-only); costs one extra call.                                                 |
| `tracePrompt`             | Keep sent content              | `"preview"` | `preview` / `off`                             | Stores the first/last 2,000 chars of the text actually sent (after redaction) in the session record; `off` stores metadata only. |
| `timeoutMs`               | JSON only: Timeout             | `90000`     | 5000–600000                                   | Per-consultation timeout; `/advisor cancel` aborts sooner.                                                                       |
| `maxInputChars`           | Input limit                    | `60000`     | 4000–400000                                   | Total transcript budget; excess in the middle is elided, head/tail kept.                                                         |

**Cache prices.** The host usage exposes `cacheReadTokens` / `cacheWriteTokens`, both input-side; there is no cache-output token. Cache tokens are additional input tokens and are not subtracted from `inputTokens`. `priceCacheReadPerMTok` / `priceCacheWritePerMTok` = 0 means cache tokens are not priced; if the ledger has cache tokens while both are 0, the status area warns that cache tokens are unpriced. Built-in reference prices have no cache prices and the plugin does not guess.

**Currency and ledger.** Amounts and prices in settings are entered in `currency` (USD/CNY); `usdToCny` is a manual rate. The ledger and workspace pool always store USD: limits/prices are converted to USD at call time and displayed back in the selected currency. Switching currency converts the form amounts at the rate before saving; old `maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd` keys migrate as USD to the new keys. A rate change affects future conversion/display, not the historical ledger.

> **Note on `sessionCap`, `dedupe`, `immuneTurns`:** `sessionCap` is enforced — after that many delivered items in one session only `blocker` advice is still returned. `dedupe` and `immuneTurns` are persisted and used by the shadow path, but the tool path does not suppress a consultation because of them (you asked for it explicitly). The ceilings that stop _calls_ altogether are `maxCallsPerTurn` / `maxCallsPerSession` / `maxCallsPerHour` / `maxCostPerDay`.

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

**Two-pass evidence (opt-in).** With `advisorTools: true` the advisor may answer with `needs: [{kind:"file", ref:"path"}]`. The plugin reads those files **inside the session working directory only** (≤5 files, ≤64 KiB each, `../` and symlink escapes rejected), then calls the advisor once more with the quoted evidence so it can revise. This is the "advisor can check the facts" mode; it costs one extra model call. A rejected or unreadable path is reported back as unavailable evidence instead of failing the consultation.

**Workspace budget.** Besides the per-session ceilings, a shared pool (`<DSH_HOME>/advisor/budget.json`) counts calls and estimated cost per local day across sessions (`workspaceMaxCallsPerDay`, `workspaceMaxCostPerDay`).

**Evidence anchors.** Each advice item may cite `{kind, ref}` anchors (a tool-call id, a message id, a file path). The plugin checks every ref against the session and marks the item unverified when nothing matches; if **none** of the cited anchors exist, the severity is downgraded one step and the advice says so. This is how a hallucinated "that failing command" gets caught.

**Advice line and report.** Each consultation is recorded as a session plugin record (not part of the model-visible surface), so the turn gets a compact advisor line in the chat and `/advisor report` can attribute adoption over time. Attribution is deliberately conservative: no signal, no credit. Expanding the line shows the trigger, local time, advisor model, characters sent and the usage/cost summary for that consultation. When a sent-content preview was stored, the expanded line also offers a “View sent content” toggle.

**Picking a model.** `/advisor` opens a picker listing the routes and models already configured in DSH, plus _off_ and _add / configure provider_. Choosing a model switches `mode` to `advisory`. `/advisor doctor` tells you line by line what is still missing.

## Commands

| Command                                | What it does                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/advisor`                             | Opens the model picker (client half). Routes and models are re-read every time; nothing is cached across openings.                                                                                                                                                              |
| `/advisor status`                      | Mode, chosen route, consultations this session and this turn against the limits, cumulative tokens, the last result, and why the last consultation was skipped.                                                                                                                 |
| `/advisor on`                          | Sets `advisory`. Refuses with a pointer to the picker when no advisor model is configured.                                                                                                                                                                                      |
| `/advisor off`                         | Sets `off`: no consultation is made, no request is sent.                                                                                                                                                                                                                        |
| `/advisor shadow`                      | Sets `shadow`: consult after each completed turn and record it, without feeding it back.                                                                                                                                                                                        |
| `/advisor ask`                         | Runs one consultation **now** and returns the advice as command output.                                                                                                                                                                                                         |
| `/advisor cancel`                      | Aborts the in-flight consultation — the request is aborted, not merely ignored.                                                                                                                                                                                                 |
| `/advisor preview`                     | **Sends nothing.** Prints exactly what the next consultation would transmit: target route, scope, character/token estimate, omitted host context, tool traffic, redaction hits, allowlist verdict, cross-provider confirmation state, price source and today's workspace usage. |
| `/advisor confirm`                     | Allows sending the conversation to the current provider when it differs from the main model's provider.                                                                                                                                                                         |
| `/advisor report all`                  | Cross-session report from the advice ledger (`<DSH_HOME>/advisor/advice.jsonl`): totals by severity, model and day.                                                                                                                                                             |
| `/advisor report`                      | Per-session advice report: how many were delivered, how many were **adopted** (heuristic: a path / backticked command / anchored ref from the advice shows up in later events), and how many evidence anchors verified.                                                         |
| `/advisor doctor`                      | Self-check: host `llm` service, registered routes, route resolution and context window, supported efforts, mode, session budget, ledger state, last failure. Each line states its conclusion and, where relevant, the next step.                                                |
| `/advisor <provider>/<model> [effort]` | Sets the advisor route directly, with the same validation as the picker (unknown route, missing credentials and unsupported effort are rejected with a readable reason).                                                                                                        |

The `advisor` **tool** is separate from the command: the model calls it, not you. It takes no required arguments; its optional `focus` is one sentence naming the doubt you want settled — not the task itself, because the transcript always is.

## Cost & privacy

This is the section to read before turning it on.

- **Every consultation is an extra model call**, billed by the advisor route against that provider's quota. The main model's own usage is unaffected.
- **Token accounting is ours.** DSH records usage only for the main loop's assistant messages, so the plugin writes its own ledger: `<DSH_HOME>/advisor/usage.jsonl`, one JSON object per consultation (time, session id, trigger `tool` / `shadow` / `manual`, provider, model, effort, verdict, severity, input/output/cache-read/cache-write tokens, estimated cost, duration, error code). The file is append-only, rolls over to `usage.jsonl.1` at 2 MiB, and totals are restored from its tail on startup.
- **Money needs your prices.** DSH's model metadata has no price field. Set `priceInputPerMTok`, `priceOutputPerMTok`, `priceCacheReadPerMTok` and `priceCacheWritePerMTok` in the selected `currency`; with zeros the ledger records tokens only and no money amount is shown. The ledger stores the USD equivalent; built-in reference prices are USD and are converted for CNY display, but there are no built-in cache prices. The plugin never guesses prices.
- **The daily budget counts spend already recorded**, so the one consultation that crosses the ceiling still completes and is charged.
- **Conversation content leaves the machine when the advisor route is external.** The transcript — with tool calls and results, bounded by `privacyScope` and `maxInputChars` — is sent to whatever base URL that route points at. If that is another vendor, your conversation leaves this machine. Only a route pointing at a local gateway keeps it local. The plugin sends nothing else: no telemetry, no analytics, no network access besides the consultation itself.
- **`privacyScope` decides how much is sent.** `summary` (default): each text block up to 2,000 characters, tool arguments up to 300, tool results up to 700. `off`: user and assistant text only, up to 1,200 characters, with no tool traffic at all. `full`: text up to 4,000, tool arguments up to 1,200, tool results up to 3,500. The rendered transcript is then capped at `maxInputChars` (60,000 by default): the first 30% and the tail are kept and the middle is replaced by an elision marker.
- **Redaction is best-effort.** With `redact: true` (default) the plugin scrubs common token-shaped strings, `Authorization` headers, `KEY=` / `TOKEN:`-style assignments, credentials embedded in URLs and PEM private-key blocks **before** clipping. It is a heuristic filter, **not a secret scanner**: it will miss things, it cannot guarantee that a secret never leaves, and it is no substitute for deciding whether this repository may be sent to that provider at all.
- **The sent-content preview is written to the session record.** With `tracePrompt: "preview"` (default), the first and last 2,000 characters of the text actually sent (after redaction and `maxInputChars` clipping) are stored in the session plugin record and can be opened from the advisor line; `off` stores metadata only. With `redact` off, the preview is raw text.
- **Start in `shadow`.** It answers "what would it have said, and what would that have cost" without putting model output back into your session. Read the ledger for a few days, then switch to `advisory`.

## Compatibility

| DSH version | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.2-rc.2  | **0.6.0 → 0.6.1** (2026-11-14): adds the decision log `decisions.jsonl` plus `pnpm advisor:review`; settings moved to their own "Settings → Advisor" section (three-row summary + collapsed "More settings"). Verified: unit tests (20 of them cover the decision log) + `pnpm probe:runtime` 72/72 + web `pnpm smoke:advisor` **14/14** (throwaway DSH home, no model calls). The settings section was additionally checked on a live desktop build via read-only CDP (DOM + screenshot); the desktop read-only regression reports **19 PASS + 1 SKIP** (the SKIP is a session with no advisor record — the script never fabricates a consultation). 0.6.1 only fixes the decision-log reason codes (`aborted`/`blocked` no longer fall through to `skipped-other`); 18 unit tests cover it and the desktop regression was not re-run. |
| 0.2.2-rc.1  | Verified on this version: unit tests (settings clamping, route selection and pairing, budget guard, transcript rendering, redaction, output contract) and `pnpm probe:runtime`; the desktop read-only regression is `pnpm smoke:advisor-desktop`. Other DSH versions are not verified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The plugin declares no `engines.dsh` and no `@deepseek-ai/*` peer range: DSH is pre-release and semver ranges over prereleases are unreliable (see [ADR 0005](../../docs/adr/0005-dsh-version-compatibility.md)). Treat this table as the compatibility statement. After a DSH upgrade run `pnpm probe:runtime`, `pnpm smoke:advisor-desktop` and the unit tests, then check `/advisor doctor`.

## Side effects, limitations & risks

**What it writes**

| Path                                      | What                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<DSH_HOME>/advisor.settings.json`        | Plugin settings; written by `/advisor` and the picker, re-read before every consultation. |
| `<DSH_HOME>/advisor/usage.jsonl` (+ `.1`) | One line per consultation; append-only, rotated at 2 MiB.                                 |

Nothing else: no workspace files, no session-log records of its own (a consultation shows up as an ordinary tool call and tool result in the transcript), no telemetry.

- **The advice is model output.** It can be wrong, vague, or confidently wrong. The plugin validates the _shape_ — a JSON object, a known verdict and severity, length caps, declared evidence anchors — not the content. Weigh it and verify it; the main model still owns the decision.
- **Command surface is UI-only.** `ctx.commands` is a human command registry: UI-less hosts (headless `-p`, ACP automation) provide no command adapter, so `/advisor` is unavailable there. The tool, the settings file and the RPCs still work; "three-end parity" for the command surface is not achievable by design, not a missing feature.
- **Semi-public host seams.** `llm.prepareCall`, `llm.resolveModelInfo`, `session.deriveMessages`, `tools.register`, `commands.register` and `session/event` on the host side, and `commandUi.decorate` (the picker) on the client side, are not a stable public API. A DSH upgrade can silently disable the tool, the picker or the command. Run `pnpm probe:runtime` after every upgrade; installation failures are logged rather than thrown, so check `/advisor doctor` and the host logs.
- **Pairing needs your declaration.** DSH has no cross-vendor capability catalog, so "is the advisor at least as strong as the main model" can only come from your `tiers`. Without an entry the result says **unverified** and the consultation proceeds; it never pretends the check passed. With `pairingEnforcement: "block"` a lower declared tier rejects the consultation.
- **Token counts can be low on an aborted call.** If a consultation is cancelled or times out, no usage chunk may arrive; the ledger then records the call with zero tokens and a cost budget can lag real spend. Treat the ledger as a good estimate, not an invoice.
- **The advisor route can be broken from outside this plugin** (wrong base URL, missing key, rate limit). Every failure becomes a structured tool result (`MISSING_CREDENTIAL`, `rate_limited`, `overloaded`, `prompt_too_long`, `timeout`, `aborted`, …) and never breaks the turn.
- **The settings live in their own Settings → Advisor section**, with a three-row summary on top and a collapsed “More settings” fold. Keys marked JSON-only still need the settings file, and the `/advisor` picker remains available.
- **Partially enforced knobs.** `sessionCap` caps delivered advice per session (blockers exempt); `dedupe` / `immuneTurns` only matter on the shadow path — see [Configure](#configure).
- **One attempt, not a retry loop.** A malformed advisor answer is reported as unavailable rather than retried; an unsupported thinking effort is retried exactly once without an effort.
- **`shadow` mode still spends quota.** It skips the injection, not the call. And while `shadow` is on, an explicit `advisor` tool call still returns its advice: the mode suppresses the automatic end-of-turn review, not a model-initiated consultation. Use `off` to stop all calls.
- **Subagent sessions** are skipped by the automatic shadow review; only top-level turns are reviewed.

## Testing & verification

```bash
pnpm verify                  # repo-wide gates: lint, typecheck, plugin conventions, docs, unit tests
cd packages/advisor && pnpm test   # unit tests for this plugin (node --test)
pnpm smoke:advisor           # web end-to-end smoke in a throwaway DSH home (spends nothing)
pnpm smoke:advisor-desktop   # desktop (Electron) read-only regression over CDP
pnpm smoke:agent-tool        # repo-wide real-model tool smoke (needs credentials; SKIPs without them)
```

- `pnpm verify` is the release gate and must pass before a PR.
- `pnpm smoke:advisor` starts a real host in a throwaway `DSH_HOME` (one temporary workspace, no credentials needed), installs the packed plugin and asserts: the client half loads, `/` lists `advisor`, the settings card renders, and `/advisor doctor` / `preview` / `confirm` / `report all` produce output — then checks that **no ledger file was created**, i.e. it spent nothing. Command output is read from the session log because the host renders command cards collapsed.
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
