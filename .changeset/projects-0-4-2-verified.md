---
"@kangyishuai/dsh-projects": patch
---

0.4.2 装进 live profile、**重启桌面版后**复跑门禁，结果写进兼容表：

- 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**
- web 端到端冒烟 **54 PASS / 0 SKIP / 0 FAIL**
- `pnpm gate:all --plugins projects` 全绿（64s）

并在**真实界面**里用截图确认了本次修复：空项目的「线程 (0)」页签同时出现
「新建线程」输入框与空态提示（修之前输入框被空态挡住，页面无处起线程）。

另把 README 里的「317 项单测 / 52 项冒烟」更新为 **385 / 54**。
