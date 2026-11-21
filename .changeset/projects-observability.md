---
"@kangyishuai/dsh-projects": minor
---

补上「可观测」（规格 §7.7.3）：面板不再只有线程状态，还能看到这一步花了什么、改了什么。

- 从**持久会话事件**累积每个线程的：步骤数（`assistant/attempt`）、工具调用与命令明细
  （`tool/call` + `tool/result` 回填成功与否，保留最近 12 条）、token 用量
- 新增 RPC `threadStats(projectId, sessionId)`：在事件统计之外现算 worktree 的
  `git diff --numstat <base>..HEAD`（文件数 / +增 / -删）
- 详情页线程行显示一行摘要：`N 步 · N 次工具 · diff N 文件 +a/-b · N tokens`
- **缺失数据显式 n/a**：二进制文件的 numstat 是 `-/-`、宿主没上报 usage 时，都写 `n/a`，
  不用估算值冒充测量值

新增 13 项单测（事件归约、命令上限、token 字段兼容、numstat 解析、n/a 语义）；
web 冒烟 53 项（新增 1 项断言线程行摘要）。
