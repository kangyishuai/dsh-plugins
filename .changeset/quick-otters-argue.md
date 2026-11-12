---
"@kangyishuai/dsh-advisor": patch
---

Fix the warning text in the settings card and the per-turn warning, which never followed the light/dark theme.

Both rules used `--dsw-alias-state-warning-primary`, a token the host theme does not define — the real name is `--dsw-alias-state-warn-primary`. A misspelled `var()` does not fail loudly: it silently falls back to the hardcoded `#b7791f`, so the "unsaved changes" hint and the per-turn warning kept the same colour in both themes instead of using the host's warning palette.

They now use `--dsw-alias-state-warn-label` (the host's own warning *text* token) with `--dsw-alias-state-warn-primary` as the fallback, matching how the host styles warning copy.

A regression test now asserts that the injected stylesheet only references theme tokens that really exist in the host theme, and that both warning rules use the host warning tokens.
