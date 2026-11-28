---
"@kangyishuai/dsh-advisor": patch
"@kangyishuai/dsh-btw": patch
"@kangyishuai/dsh-casefile": patch
"@kangyishuai/dsh-next-step": patch
"@kangyishuai/dsh-projects": patch
"@kangyishuai/dsh-session-delete": patch
"@kangyishuai/dsh-session-rewind": patch
---

设置分节的保存方式与反馈统一（用户模拟 U1-10）：

- 每个设置分节固定一行保存状态（`data-<plugin>-settings-status`，`data-state` = `clean` / `dirty` / `saving` / `saved` / `error` / `readonly`），中英双语。
- 显式保存（advisor / btw / projects 预算）：无改动时保存按钮禁用并显示「已保存」；有改动显示「有未保存更改」；失败显示「保存失败：原因」，按钮仍可重试。
- 自动保存（session-delete / session-rewind / next-step / projects 策略开关）：落盘后短暂显示「已保存」再回落「· 已保存」；失败显示原因并给可点的重试入口（`data-<plugin>-settings-retry`）。
- casefile 的诊断分节明确标为只读（「无可保存设置」），不再让人找不到保存按钮。
- `artifacts` 没有 `settings.section`（只提供右栏工具页签），本次不涉及、不发版。
- 存储与 RPC 契约未改，只改界面反馈与按钮可用性；每包新增 `test/settings-save-status.test.js`（node:vm 驱动真实 client 组件）。
