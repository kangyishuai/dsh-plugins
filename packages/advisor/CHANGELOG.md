# @kangyishuai/dsh-advisor

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
