# @kangyishuai/dsh-advisor

## 0.5.1

### Patch Changes

- [#80](https://github.com/kangyishuai/dsh-plugins/pull/80) [`3d05174`](https://github.com/kangyishuai/dsh-plugins/commit/3d05174af557f2f912494cd5935d320fe27425a2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Fix the warning text in the settings card and the per-turn warning, which never followed the light/dark theme.
  
  Both rules used `--dsw-alias-state-warning-primary`, a token the host theme does not define — the real name is `--dsw-alias-state-warn-primary`. A misspelled `var()` does not fail loudly: it silently falls back to the hardcoded `#b7791f`, so the "unsaved changes" hint and the per-turn warning kept the same colour in both themes instead of using the host's warning palette.
  
  They now use `--dsw-alias-state-warn-label` (the host's own warning *text* token) with `--dsw-alias-state-warn-primary` as the fallback, matching how the host styles warning copy.
  
  A regression test now asserts that the injected stylesheet only references theme tokens that really exist in the host theme, and that both warning rules use the host warning tokens.

## 0.5.0

### Minor Changes

- [#64](https://github.com/kangyishuai/dsh-plugins/pull/64) [`cf76f4d`](https://github.com/kangyishuai/dsh-plugins/commit/cf76f4d2cccb2c5968d4ebaf671c5bf25f6e4041) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add cache-token pricing: `priceCacheReadPerMTok` / `priceCacheWritePerMTok` (0 = unpriced, with a status warning), include cache read/write tokens in cost and budget accounting, record cache-write tokens in the ledger, and recompute/charge the two-pass evidence call after its usage is merged.

## 0.4.0

### Minor Changes

- [#62](https://github.com/kangyishuai/dsh-plugins/pull/62) [`ebd331e`](https://github.com/kangyishuai/dsh-plugins/commit/ebd331e0dd4b93ce74f90691ba39720f4b9ecce8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add first-class CNY support: `currency` (USD/CNY) plus a manual `usdToCny` rate; budget and unit-price settings are stored in the selected currency while the ledger, workspace pool and guards stay in USD. Old `maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd` keys migrate as USD, switching currency converts the form amounts at the rate, and status/preview/doctor/advisor-line output uses the selected currency.

## 0.3.0

### Minor Changes

- [#58](https://github.com/kangyishuai/dsh-plugins/pull/58) [`f2ac925`](https://github.com/kangyishuai/dsh-plugins/commit/f2ac925dc633ee90fa41320a308921998d0a0def) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Rework the settings card: `off` shows a compact state, basics and advanced settings are separated with advanced folded by default, field help moved behind an inline `?` button, and money fields now accept decimals (budgets 2, unit prices 4).

- [#61](https://github.com/kangyishuai/dsh-plugins/pull/61) [`962a735`](https://github.com/kangyishuai/dsh-plugins/commit/962a735ce7b02da6a8de61606c45d2379bdaea36) Thanks [@kangyishuai](https://github.com/kangyishuai)! - The advisor line can show a bounded preview of what was actually sent: `tracePrompt` (default `preview`) stores the first and last 2,000 characters of the redacted transcript in the session record, with a “View sent content” toggle in the expanded line; `off` stores metadata only.

- [#60](https://github.com/kangyishuai/dsh-plugins/pull/60) [`9e58651`](https://github.com/kangyishuai/dsh-plugins/commit/9e586511e9fffe804a2753c4a03879f6c732ab82) Thanks [@kangyishuai](https://github.com/kangyishuai)! - The advisor turn line now shows the trigger, local time, advisor model, characters sent and the usage/cost summary for each consultation; new advice records store `requestChars` so the line can show the sent size.

## 0.2.0

### Minor Changes

- [#55](https://github.com/kangyishuai/dsh-plugins/pull/55) [`7a750a7`](https://github.com/kangyishuai/dsh-plugins/commit/7a750a7875798cd4df3ea8df87011f32bf26f8fd) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Close the gaps that previously depended on users declaring everything by hand, and make the advisor able to check facts.
  
  - Built-in model catalog: capability ranks and reference unit prices used as a fallback when `tiers` / prices are not declared. Unknown models stay "unverified" instead of being guessed.
  - `allowedModels` allowlist (filtered in the picker, enforced in `setModel` / `updateSettings`) and a shared **workspace budget pool** (`<DSH_HOME>/advisor/budget.json`) counting calls and estimated cost per local day across sessions.
  - `/advisor preview` shows exactly what would be sent (nothing is sent) and `/advisor confirm` authorises the first cross-provider consultation.
  - Opt-in two-pass evidence (`advisorTools`): the advisor may request files from the session working directory (≤5 files, ≤64 KiB each, read-only, `../` and symlink escapes rejected) and revise its advice against the quoted evidence.
  - Optional post-answer review (`postAnswer: "card"`), dedupe + immune window for passive deliveries, adoption confidence levels, a cross-session advice ledger with `/advisor report all`.
  - The settings card exposes every new field (workspace ceilings, allowlist, post-answer, evidence, preview and confirm).

## 0.1.0

### Minor Changes

- [#47](https://github.com/kangyishuai/dsh-plugins/pull/47) [`488a0c3`](https://github.com/kangyishuai/dsh-plugins/commit/488a0c3e1bcc3ce44a6e666c5ff82da788b5fc83) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add `@kangyishuai/dsh-advisor`: the main model can consult a separately configured (usually stronger) model at key moments — before committing to an approach, when an error keeps recurring, and before declaring a task done.
  
  - Registers an `advisor` tool (no required parameters) and an `/advisor` command (`status` / `on` / `off` / `shadow` / `ask` / `cancel` / `report` / `doctor` / `<provider>/<model> [effort]`).
  - The advisor reads the rendered conversation **including tool calls and results**, and answers with a structured verdict (`reviewed` / `declined`, severity, risks, acceptance criteria, evidence anchors).
  - `off` / `shadow` / `advisory` modes; shadow runs the advisor after a completed turn and only records it, never feeding it back.
  - Token ledger at `<DSH_HOME>/advisor/usage.jsonl` plus four budget ceilings (per turn, session, hour, per-day cost), because the host does not record usage for extra model calls.
  - Model and thinking effort are chosen from the providers already configured in DSH (Settings → Models); the plugin never stores base URLs or API keys.
  - Breaks nothing by default: the plugin starts in `off` mode.
  - A settings card in **Settings → General**: mode, provider/model picker, thinking effort from the model's real metadata, four budget ceilings with unit prices, privacy scope, ledger summary and `doctor` output.
  - Evidence-anchor verification (a cited tool-call id / message id / path that does not exist downgrades the advice) and a conservative adoption report (`/advisor report`), plus a compact advisor line under each turn.
