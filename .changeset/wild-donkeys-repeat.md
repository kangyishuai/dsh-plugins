---
"@kangyishuai/dsh-session-rewind": patch
---

Fix unreadable primary button text in the dark theme and the remaining theme-token misuses in the injected stylesheet.

`--dsw-alias-brand-primary` is DSH's inverted surface colour (near-black `#0f1115` in the light theme, near-white `#f9fafb` in the dark one), not a saturated brand accent. The confirm button paired it with a hardcoded `color: #fff`, so in the dark theme it rendered white-on-white at **1.05:1** and its label was invisible. The button now uses the host's semantic pair, `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` (18.1:1 dark / 18.9:1 light), and `--dsw-alias-button-primary-hover` replaces the `brightness()` hover hack.

Same class of problem elsewhere in the stylesheet:

- Link and action buttons (`加载更早`, the toast action, audit and rescue actions) used `--dsw-alias-brand-primary`, which equals the body text colour in both themes, so they had no link affordance at all. They now use `--dsw-alias-link`; the toast action uses `--dsw-alias-toast-label` plus an underline, because the toast surface is dark in both themes and `--dsw-alias-link` would be 2.86:1 there.
- `--dsw-alias-state-warning-primary` does not exist in the host theme (the real name is `--dsw-alias-state-warn-primary`), so four rules silently fell back to a hardcoded `#c08a2e` that never followed the theme. Warning *text* now uses `--dsw-alias-state-warn-label` (the host's own text token) and the confirmation border uses `--dsw-alias-state-warn-primary`.
- Three more non-existent tokens are replaced with the real ones: `--dsw-alias-border-secondary` → `--dsw-alias-border-l3` (timeline rail), `--dsw-alias-bg-primary` → `--dsw-alias-bg-layer-2` (timeline dot ring, which previously fell back to `transparent` and disappeared), `--dsw-font-mono` → `--ds-font-family-code`.

Regression guards: a unit test now asserts that the injected stylesheet only references host tokens that really exist and never pairs an inverted fill with a hardcoded white foreground, and the desktop read-only suite computes the confirm button's WCAG contrast in the real Electron renderer (24 assertions now, was 23).
