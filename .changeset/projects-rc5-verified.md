---
"@kangyishuai/dsh-projects": patch
---

在 DSH 0.2.2-rc.5 上完成复验，并把桌面只读回归第一次跑绿。**不需要改代码**。

- 桌面只读回归：**11 PASS / 0 SKIP / 0 FAIL**（此前该项目一直未绿）
- web 端到端冒烟：**50 PASS / 0 SKIP / 0 FAIL**
- 单测 276 / 276、`pnpm probe:runtime` 72/72
- 本插件依赖的私有 seam（`dsh-session`、`dsh-workspace`、`dsh-api-gateway`、`dsh-typert-protocol`、
  `dsh-agent` 等）在 rc.3 与 rc.5 之间逐字节相同（43 包逐包 diff，见 docs/runtime/0.2.2-rc.5.md §1.1）

同时修正文档里的两个数字：web 冒烟断言实为 **50**（旧文档把收尾汇总行也算成了第 51 项），
单测为 **276**（旧文档写 274）。
