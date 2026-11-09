---
"@kangyishuai/dsh-session-rewind": minor
---

Add non-destructive composer prompt recall: bare `↑` / `↓` in the focused composer walks back and forth through the prompts you already sent in the session (first-line gated, draft stashed and restored at the bottom, IME- and menu-safe), filling the draft only — it never rewinds, sends or writes to the session log. Wired through the host's fixed-input channel instead of registering shortcuts, with a Settings toggle and bilingual docs (ADR 0008).
