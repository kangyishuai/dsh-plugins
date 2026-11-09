---
"@kangyishuai/dsh-session-rewind": patch
---

Ship the README screenshots to npm and keep them sanitized: the confirmation dialog and the rewind panel are generated from a throwaway DSH home containing only a synthetic workspace and session, cropped to the dialog/panel, and have their PNG metadata stripped. No documentation or behaviour change.
