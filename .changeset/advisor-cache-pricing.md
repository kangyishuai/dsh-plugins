---
"@kangyishuai/dsh-advisor": minor
---

Add cache-token pricing: `priceCacheReadPerMTok` / `priceCacheWritePerMTok` (0 = unpriced, with a status warning), include cache read/write tokens in cost and budget accounting, record cache-write tokens in the ledger, and recompute/charge the two-pass evidence call after its usage is merged.
