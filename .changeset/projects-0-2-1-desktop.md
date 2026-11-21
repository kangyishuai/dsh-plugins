---
"@kangyishuai/dsh-projects": patch
---

把 0.2.1 装进 live profile 并在**重启桌面版之后**复跑桌面只读回归，结果写进兼容表：

- 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**（`pnpm gate:all --plugins projects`，64s 全绿）
- web 端到端冒烟 50 PASS / 0 SKIP / 0 FAIL

此前 0.2.0 的兼容表如实写着「桌面回归尚未复跑」，现在这条已补齐（0.2.0 与 0.2.1 的 client 半一致）。
另记一条环境事实：该 live profile 里 `ui-settings` 为 `enabled: false`，设置页打不开，
因此开关文案无法在界面上目视确认（磁盘产物已确认是新文案）。
