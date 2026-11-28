---
"@kangyishuai/dsh-artifacts": patch
"@kangyishuai/dsh-session-delete": patch
"@kangyishuai/dsh-casefile": patch
---

复审 P3 backlog 收尾（三条低风险、可验证项）：

- **artifacts**：右栏工件库空态不再只报「还没有工件。」，补一行解释「工件是什么、怎么让 AI 用 `artifact` 工具发布一个」（`data-dsh-artifact-empty-hint`；项目范围同理）。对应 USIM-U1-20 的「空态不解释」部分；入口发现性（右上角图标）与页签英文名仍归宿主/i18n backlog。
- **session-delete**：体检（设置 → 会话回收站 → 维护）新增一条 finding，列出操作日志里**读不出来**（截断/形状不对的 `<id>.json`）与 `writeAtomic` 崩溃残留（`<id>.json.tmp`）的记录；只报告、不自动删除，坏文件仍在原处。此前这些记录连体检都看不见（复审 F4）。
- **casefile**：「最近打开」与 `session-pointers.json` 落盘改为尽力而为——数据根只读或磁盘写满时只告警，`case_project get` 这类纯读动作不再跟着失败（复审 F6）；指针文件版本高于本插件（降级场景）时按「无指针」处理，不再让所有省略 `projectId` 的工具调用整片失败（复审 F7）。
