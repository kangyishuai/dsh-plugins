---
"@kangyishuai/dsh-advisor": patch
---

修决策日志的原因码归类：`aborted` / `blocked` 的回合现在直接记 `skipped-aborted` / `skipped-blocked`，
不再落到 `skipped-other`。真实日志里出现过「回合被中断」被归为未识别的情况。
