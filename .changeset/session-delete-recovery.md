---
"@kangyishuai/dsh-session-delete": minor
---

修复审计发现的恢复、对账与可观测性缺口：启动时扫 journal 未完成记录，按落盘事实补完或回滚并写 `recover` 审计（此前只写 intent、界面却声称「重启后自愈」）；恢复回执与界面如实报告引用/置顶/校验结果（新增 `refs`/`checks`/`partial`，`meta.pinned` 真正落盘）；删除已移动但收尾失败时写 `partial` 回执并以 `session-delete/partial` 区分；plan 阶段与 agent 工具的拒绝进制审计；跨卷回退改为逐项校验后才删源；复活守卫真的再移一次。设置页体检改为按需运行并缓存结果（打开设置不再扫全库），toast 撤销失败常驻提示；关键节点补稳定的 `data-sdel-*` 锚点。新增界面行为，故按 minor 发布。
