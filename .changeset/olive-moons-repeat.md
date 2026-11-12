---
"@kangyishuai/dsh-session-delete": patch
---

Fix the trash-count badge's text colour in the dark theme.

The badge paired its theme-adaptive fill (`--dsw-alias-state-error-primary`) with a hardcoded `color: #fff`. In the dark theme that fill is a *light* red (`#f25a5a`, designed for a dark foreground), so white-on-red dropped to **3.29:1**; pairing it with the host's `--dsw-alias-label-primary-foreground` gives 5.75:1 there and keeps 4.5:1 in the light theme.

The foreground is now a named token (`dangerText`) next to the fill, and a regression test asserts the pair, plus that every theme token in the design map really exists in the host theme (a misspelt `var()` silently falls back to a hardcoded colour and stops following the theme).
