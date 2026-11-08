---
"@kangyishuai/dsh-session-rewind": minor
---

Add a read-only agent tool, `session_rewind_candidates`.

The model can list the messages this conversation can be rewound to (optionally filtered) and preview the impact of rewinding to one of them — how many messages would be withdrawn and whether an unfinished tool call would be truncated. The tool never rewinds, never touches files and never appends to the session log; the actual rewind stays a user action in the UI. Disable it with `readOnlyTool: false`; diagnostics now reports whether it registered.
