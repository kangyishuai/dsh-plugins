---
"@kangyishuai/dsh-session-rewind": minor
---

Rewind history as a timeline, and warn when a rewind would leave session state behind.

- **History → timeline.** The History tab is now a vertical timeline instead of a plain list. It merges rewinds and rescue-point file restores (file restores are now audited too), newest first, with a mode/kind badge, counts, file results and expandable paths.
- **Session-state hint.** The confirmation dialog now lists session state changed inside the withdrawn range — plan mode, goal, todo list, model selection, permission/sandbox presets, agent preset, scheduled tasks, working directory — and says plainly that rewinding only withdraws messages and does **not** roll that state back.

Both are informational: no extra writes, no behaviour change to the rewind itself.
