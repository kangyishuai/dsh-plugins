---
"@kangyishuai/dsh-advisor": patch
---

审计（2026-11-28）P2/P3 修复：钱与预算层改为**原子追加 + 串行写队列**（usage/advice/decisions 不再「读全文 + 覆盖写」，工作区预算池的读-改-写不再丢更新），账本行记录**本地日键**并在重启时恢复会话/小时计数；`timeoutMs` 改为插件侧**硬超时**（到点 abort、提前返回 `timeout`、不落账），日预算/工作区池在发送前把**本次预估花费**算进去且两个闸统一为「已达上限即拒绝」。

决策日志现在能真正回填三种下场（`accepted` / `user-typed-other` / `no-action`，并过滤宿主注入的 `user/message`），`/advisor report` 会显示可追踪分母；脱敏补上小写键名、JWT 与裸 `Bearer` token；client 内嵌字典与 `LOCALE_EXTRA` 的 30 个重复键已去重。残余风险（硬超时是插件侧执行、`/advisor` 在空白会话不可见、决策日志只记主会话）已写进 README「副作用、限制与风险」。
