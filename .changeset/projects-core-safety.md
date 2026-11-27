---
"@kangyishuai/dsh-projects": minor
---

核心/后端安全修复（2026-11-28 审计 AUD-PROJ-01…30）：

- **无目录项目的会话 cwd 不再落在插件数据根**：协调者 / routine 投递 / `schedule` 提醒统一改用
  `<dataRoot>/workspaces/<id>`，数据根（`projects.json`、`trash/`、其它项目记忆）不再交给
  `danger-full-access` 的 agent，也不再出现在宿主 Workspace 列表里。
- **暂停/归档/删除真的会停宿主定时任务**：`pauseProject` / `archiveProject` / `deleteProject` 会
  暂停或删除对应的 routines 与 `schedule` 提醒（以前照旧到点投递、继续花 token）；暂停/归档项目下
  不能再新建自动投递的 routine/提醒；删除时若宿主条目停不掉会拒绝删除。
- **`policy.repoGrants` 可以撤销了**（显式空列表会落盘，不再回落旧授权）；`repoGrants` /
  `preapprove` / `pr.tier` 的变更都会写 `project/policy-changed` 审计。
- **`budget.weeklyTokens` 成为真正的预算字段**：设置页可写、读盘不丢、建线程与自动暂停两处执行；
  token 用量桶改按**本地日期**（与日/周闸同口径）。
- **PR 四档可在设置里选择**，`auto-merge` 档在 CI 通过后把合并**排进审批队列**（不再落到重复开
  PR、也不再永远不会合并）；合并审批必须命中本项目线程记录的 PR 号，否则 `merge/pr-not-ours`，
  不再回落 `dirs[0]`。
- **审批卡片显示纯文本影响面**（PR 号 / 仓库 / 分支 / 目录 / 变更键），批准与执行前能看到影响范围。
- **预授权（`preapprove`）终于有界面入口**，并明示「勾上即自动执行、不可逆动作没有二次确认」。
- 一并修掉：审批队列上限与分页、超时占位回收、删项目清 token 桶（恢复时放回）、恢复校验 manifest id、
  记忆去重改为块级精确匹配、线程 worktree 建成功但建会话失败时回滚、线程序号不复用旧分支名、
  协调器 `project_thread_message` 校验会话归属、项目默认模型不可用时界面提示、token 入账合并写盘。
