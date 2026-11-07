---
"@kangyishuai/dsh-session-rewind": minor
---

Rewind through a running turn, and resend right after rewinding.

- A running turn no longer blocks rewinding: the host cancels it (`keepInbox`), waits for idle, drops queued steering messages, then re-plans against the settled surface. The confirm dialog explains this and shows progress instead of refusing.
- Optional "send this message again right after rewinding" for conversation-only rewinds (off by default), for one-click retries.
- Audit entries and the toast record whether a turn was stopped and how many steering messages were dropped.
- Set `cancelRunning: false` to restore the old refuse-when-busy behaviour.
