---
"@kangyishuai/dsh-casefile": minor
---

**L3 无人值守**（用户已批准的范围）+ 两个由冒烟暴露的真实缺陷。

### L3 无人值守
`case_project autonomy`：查看当前级别（不带 `level`）或设置级别（带 `level`）。

**硬条件**（不可配置放宽，不满足就返回 `autonomy-blocked` 并列出 blocker）：
- 只有 `scope: "selected"` 的项目能升 L3；
- 只有 `existence` / `structure` / `behavior` / `visual` 四类义务允许 L3；`coverage`（覆盖率硬门）与 `regression`（回归门）**永远人工复核**；
- 每条义务必须有可执行的检查配方（`check`），否则"没人验"会被自动跑成绿灯；
- 必须有预算上限（默认 5 轮 / 20 次 build / 30 分钟），预算耗尽或**任一轮 fail/unknown 立即停**。

解锁与停止都写审计（`autonomy/unlock` / `autonomy/stop`）；**降级永远允许且立即生效**——这是"停"的开关。面板顶部显示当前级别（`data-casefile-autonomy`）。

### 顺带修掉两个冒烟暴露的真缺陷
1. **`process` checker 遇到非零退出报 internal**：`service.runner` 在"非零退出且无输出"时直接 reject，checker 拿不到退出码，本该判 `fail` 的变成了 internal 错误。现在 runner 只对"命令根本没跑起来"（`exec` 的 127/126 且无输出，注意它是**数字**不是 `ENOENT` 字符串）reject，其余一律返回 `exitCode`。
2. **命令不存在应判 `unknown` 而不是 `fail`**：checker 对 runner 抛错做兜底 → `verdict: "unknown"`、`reason: "runner-error"`，避免把"没跑起来"误报成"构建失败"。

### 冒烟夹具
`casefile-png-fixture.mjs` 新增 `texturedPng`（渐变+棋盘）；`web` checker 冒烟改用有纹理的图——**纯色图现在会被 blank-image 规则直接拦下**（那是另一条断言的事）。web 端到端重回 **52 PASS / 0 FAIL**。
