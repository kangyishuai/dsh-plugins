---
"@kangyishuai/dsh-next-step": minor
---

Send exactly what the pill says, show which one you picked, gate cards on a model judgement, and make the primary keycap real.

- Clicking a pill now sends that pill's text verbatim (`label`, 4–60 chars) instead of a hidden longer `text`; a "sent" card keeps the picked option in a selected state (✓ + its text) instead of a generic grey line.
- The extra model call now returns `needed` + `reason`: when the model judges the turn is not worth continuing, no card is written and the reason appears in the settings diagnostics ("Last skipped").
- When no card appears, the latest answer shows a small "Generate a next-step card" button that forces one through the new `nextStep/generateNow` RPC (respects the global switch and the per-session budget, bypasses the pause / queue / `needed` gates).
- `⌘↵` / `Ctrl+↵` now sends the primary pill, but only while the composer is clean (no draft, attachments, references or open menus), the session is idle and the card is interactive; otherwise the host's Queue/Steer meaning is untouched.
- Settings hide the card / ghost / pause / budget / diagnostics rows while the plugin is off, and diagnostics gained the last skip reason.
