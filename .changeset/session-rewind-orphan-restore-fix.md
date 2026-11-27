---
"@kangyishuai/dsh-session-rewind": patch
---

修复 2026-11-28 只读审计里的三处 P1 与一处 P2（含独立复审收窄/加固）：

- **AUD-REW-01 孤儿清理不再误删真实会话数据**：枚举存活会话时不再用安全字符集过滤宿主的工作区目录名（`--Users-…--` 首字符是 `-`，旧实现把 46/46 个工作区都滤掉，`existing` 恒为空，每次插件加载就把 `sessions/ trash/ rescues/` 全删）。现在按目录结构 + 安全字符集枚举：宿主布局不是 `sessions/<workspace>/<session>`（扁平、多一层嵌套等）时得到 0 个存活 id，视为「枚举失败」；任一 workspace 不可读记为 `incomplete`；两种情况都跳过清理并记 warning，不再当成「全部都是孤儿」。不认识的插件条目保留、列入 `unknownIds` 并告警。启动清理仍然保留，但先把 dry-run 计划写审计（`cleanup-orphans-plan`）再执行，删除失败逐条记录并告警。
- **AUD-REW-02 删除的文件会被还原（收窄版）**：`planRestore` 只对「agent 删除」（`afterHash === null`）或「上一次回溯自己把该 afterHash 移入回收站」的缺失文件生成 restore 动作并允许重建（父目录 `mkdir -p`）；外部删除的已改动文件仍按 ADR 0007 决策 5 / 冻结设计 §2.3 报 `missing` 冲突、整体拒绝，不静默复活。预览/确认框新增「其中 N 个文件已被删除，将按记录重建」。重命名（delete + add）回退后源名字恢复、目标名字进回收站。
- **AUD-REW-03 第二次回溯不再被上一次回溯挡住**：恢复计划改按「目标状态」判定——当前已等于 `beforeHash`（或新建路径已不存在）视为已满足、不产生冲突；当前内容等于该路径记录过的某个状态（例如上次回溯的结果）时继续还原，只有真正既不是 before 也不是任何记录状态的内容才报 `modified-externally` 冲突。
- **AUD-REW-05 恢复侧补上 canonical 路径校验**：`applyRestore` / `restoreRescue` / `restoreTrash`（以及回滚）在每次写入前共用 `assertWriteTarget`，对父目录重跑 `realpath` + 工作区包含检查、`lstat` 拒绝 symlink。这关掉「计划/预览 → 执行」和「面板任意时刻点恢复」的长窗口；校验与写入之间被并发替换目录不在本插件防护范围（纵深防御，不是沙箱）。
