---
"@kangyishuai/dsh-advisor": minor
---

Close the gaps that previously depended on users declaring everything by hand, and make the advisor able to check facts.

- Built-in model catalog: capability ranks and reference unit prices used as a fallback when `tiers` / prices are not declared. Unknown models stay "unverified" instead of being guessed.
- `allowedModels` allowlist (filtered in the picker, enforced in `setModel` / `updateSettings`) and a shared **workspace budget pool** (`<DSH_HOME>/advisor/budget.json`) counting calls and estimated cost per local day across sessions.
- `/advisor preview` shows exactly what would be sent (nothing is sent) and `/advisor confirm` authorises the first cross-provider consultation.
- Opt-in two-pass evidence (`advisorTools`): the advisor may request files from the session working directory (≤5 files, ≤64 KiB each, read-only, `../` and symlink escapes rejected) and revise its advice against the quoted evidence.
- Optional post-answer review (`postAnswer: "card"`), dedupe + immune window for passive deliveries, adoption confidence levels, a cross-session advice ledger with `/advisor report all`.
- The settings card exposes every new field (workspace ceilings, allowlist, post-answer, evidence, preview and confirm).
