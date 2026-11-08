---
"@kangyishuai/dsh-session-rewind": minor
---

Keep every open view of a session in sync after a rewind.

Rewinding in one tab (or window) now immediately hides the withdrawn rows in other views of the same session, without a reload. After a successful rewind the plugin publishes a small notice through `localStorage`; other same-origin views pick it up on the `storage` event and re-read the authoritative cuts from the host — the notice itself is never trusted for rendering, so a stale or forged payload can only trigger an unnecessary refresh.
