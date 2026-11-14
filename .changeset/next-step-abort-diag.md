---
"@kangyishuai/dsh-next-step": patch
---

生成被中止时留下可诊断的痕迹。此前「20 秒超时 / 被取消」的中止路径**既不计数也不写 `lastSkip`**，
诊断面板里完全看不到，2026-11-14 一次「卡片没出来」因此无法定位。

- 新增 `counters.aborted`（诊断行显示「已中止 N」）；
- 中止时写 `lastSkip`：超时记 `kind: "timeout"` + 「generation timeout after Ns」，取消记 `cancelled`；
- 超时与取消不再混进 `failed` / `lastError`；
- 用户可见的失败文案从笼统的「操作失败，请重试」改为「生成超时或被取消，请重试」（`error.aborted`）。

新增纯函数模块 `lib/abort-reason.js`（`abortReasonOf` / `abortSkipKind` / `abortReasonText`）供单测覆盖。
