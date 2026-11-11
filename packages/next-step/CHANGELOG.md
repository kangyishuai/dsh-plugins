# @kangyishuai/dsh-next-step

## 0.2.0

### Minor Changes

- [#49](https://github.com/kangyishuai/dsh-plugins/pull/49) [`86e2cea`](https://github.com/kangyishuai/dsh-plugins/commit/86e2cea940e9c5cb2e6d8c15bba3bdf56bb50bcd) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Send exactly what the pill says, show which one you picked, gate cards on a model judgement, and make the primary keycap real.
  
  - Clicking a pill now sends that pill's text verbatim (`label`, 4–60 chars) instead of a hidden longer `text`; a "sent" card keeps the picked option in a selected state (✓ + its text) instead of a generic grey line.
  - The extra model call now returns `needed` + `reason`: when the model judges the turn is not worth continuing, no card is written and the reason appears in the settings diagnostics ("Last skipped").
  - When no card appears, the latest answer shows a small "Generate a next-step card" button that forces one through the new `nextStep/generateNow` RPC (respects the global switch and the per-session budget, bypasses the pause / queue / `needed` gates).
  - `⌘↵` / `Ctrl+↵` now sends the primary pill, but only while the composer is clean (no draft, attachments, references or open menus), the session is idle and the card is interactive; otherwise the host's Queue/Steer meaning is untouched.
  - Settings hide the card / ghost / pause / budget / diagnostics rows while the plugin is off, and diagnostics gained the last skip reason.

## 0.1.2

### Patch Changes

- [#44](https://github.com/kangyishuai/dsh-plugins/pull/44) [`dc99025`](https://github.com/kangyishuai/dsh-plugins/commit/dc99025564f43ef6a0d160652e01db1eca768e22) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Skip card generation while the user already has queued messages (2 or more, same rule as the official action cards), so a card never competes with input the user has already sent.

[Release notes](https://github.com/kangyishuai/dsh-plugins/releases/tag/%40kangyishuai%2Fdsh-next-step%400.1.2)

## 0.1.1

### Patch Changes

- [#41](https://github.com/kangyishuai/dsh-plugins/pull/41) [`1c84d29`](https://github.com/kangyishuai/dsh-plugins/commit/1c84d29f46237bc031b18422fd9fa363e326de3e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - `nextStep/diagnostics` now reports `version` and `buildHash` (the package.json version plus a sha256 over the behavior-carrying files), and the settings row shows them, so the running build can identify itself without a startup log.

## 0.1.0

### Minor Changes

- [#39](https://github.com/kangyishuai/dsh-plugins/pull/39) [`c3d085b`](https://github.com/kangyishuai/dsh-plugins/commit/c3d085b00143d9b2baa137e20f9d6abbd08e00ed) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Add next-step: a decision card under every completed answer (state summary, one question, two mutually exclusive suggestions that are sent as your user message with one click) plus an optional composer ghost hint accepted with Tab/→ — both produced by a single extra model call, persisted as plugin records in the session log, and fully stoppable by the global switch.
