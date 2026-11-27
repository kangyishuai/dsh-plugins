---
"@kangyishuai/dsh-session-rewind": patch
---

修复 2026-11-28 只读审计里的三处 P1 与一处 P2：

- **AUD-REW-01 孤儿清理不再误删真实会话数据**：枚举存活会话时不再用安全字符集过滤宿主的工作区目录名（`--Users-…--` 首字符是 `-`，旧实现把 46/46 个工作区都滤掉，`existing` 恒为空，每次插件加载就把 `sessions/ trash/ rescues/` 全删）。现在一个存活会话都枚举不到时视为「枚举失败」：跳过清理并记 warning，不再当成「全部都是孤儿」；不认识的条目保留不删。启动清理仍然保留，但先把 dry-run 计划写审计（`cleanup-orphans-plan`）再执行，删除失败逐条记录并告警。
- **AUD-REW-02 删除的文件现在会被还原**：`planRestore` 对「改动前存在、被 agent 删除、当前仍不存在」的路径生成 restore 动作，`applyRestore` 允许重建（父目录 `mkdir -p`）；预览/确认框新增「其中 N 个文件已被删除，将按记录重建」。重命名（delete + add）回退后源名字恢复、目标名字进回收站。
- **AUD-REW-03 第二次回溯不再被上一次回溯挡住**：恢复计划改按「目标状态」判定——当前已等于 `beforeHash`（或新建路径已不存在）视为已满足、不产生冲突；当前内容等于该路径记录过的某个状态（例如上次回溯的结果）时继续还原，只有真正既不是 before 也不是任何记录状态的内容才报 `modified-externally` 冲突。
- **AUD-REW-05 恢复侧补上 canonical 路径校验**：`applyRestore` / `restoreRescue` / `restoreTrash` 三处共用 `assertWriteTarget`，写入前对父目录重跑 `realpath` + 工作区包含检查、`lstat` 拒绝 symlink，父目录被换成指向工作区外的符号链接时一律拒绝，不再写到工作区外。
