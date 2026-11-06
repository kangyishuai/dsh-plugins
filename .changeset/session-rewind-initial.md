---
"@kangyishuai/dsh-session-rewind": minor
---

Initial release: in-place conversation rewind. `Esc` `Esc` opens a candidate dialog and a ↶ button sits next to Copy on every user message; a rewind withdraws the target message and everything after it from the model-visible surface and the rendered transcript, keeps the session id and history, and refills the composer with the target text. History is append-only — one `session-rewind` marker event is appended per rewind, nothing is deleted.
