---
"@kangyishuai/dsh-advisor": patch
---

区分「超时」与「取消」两个失败码：`AbortSignal.timeout(timeoutMs)` 触发的**超时**现在返回
`code: "timeout"` 与文案「顾问调用超时（N 秒）」，只有用户 `/advisor cancel` 或回合中断才叫
`aborted`。此前两者都归成 `aborted`，与 README 承诺的失败码清单（`timeout` 与 `aborted` 分列）
对不上，真机上把一次 90 秒超时误报成了「被中止」。

新增纯函数模块 `lib/abort-reason.js`（`classifyAbort` / `formatTimeout`）以便单测覆盖——`call.js`
本身 import 宿主包，测试环境加载不起来。
