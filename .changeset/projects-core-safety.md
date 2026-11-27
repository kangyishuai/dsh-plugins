---
"@kangyishuai/dsh-projects": minor
---

核心/后端安全修复（2026-11-28 审计 AUD-PROJ-01…30）：

- **无目录项目的会话 cwd 不再落在插件数据根**：协调者 / routine 投递 / `schedule` 提醒统一改用
  `<dataRoot>/workspaces/<id>`，数据根（`projects.json`、`trash/`、其它项目记忆）不再交给
  `danger-full-access` 的 agent，也不再出现在宿主 Workspace 列表里。
- **暂停/归档/删除真的会停宿主定时任务**：`pauseProject` / `archiveProject` / `unarchiveProject` /
  `deleteProject` 会暂停、恢复或删除对应的 routines 与 `schedule` 提醒，并且用的是宿主真实契约
  （`SchedulePatch.active: boolean`，不是会被静默忽略的 `status`）；暂停/归档项目下新建的自动档
  routine 采用**建但按住**——宿主条目建成 `paused`（可停用/可删除/可回读，恢复项目时由对账放开），
  `schedule` 档一次性提醒仍直接拒绝新建；**删除先做完所有校验（在跑线程等）再动宿主定时**，
  删除影响面会写明「会删除 N 条宿主定时任务」，条目停不掉时拒绝删除并提示去宿主 Automation
  页面处理。
- **`policy.repoGrants` 可以撤销了**（显式空列表会落盘，不再回落旧授权）；`repoGrants` /
  `preapprove` / `pr.tier` 的变更都会写 `project/policy-changed` 审计。
- **`budget.weeklyTokens` 成为真正的预算字段**：设置页有输入框、读盘不丢、建线程与自动暂停两处执行；
  token 用量桶改按**本地日期**（与日/周闸同口径）。
- **PR 四档可在设置里选择**，`auto-merge` 档在 CI 通过后把合并**排进审批队列**（不再落到重复开
  PR、也不再永远不会合并），PR 卡新增「继续 PR 流程」按钮把这个决策真正变得可达（还需项目的 `autoMerge` 危险开关同时打开，
  否则如实返回 `merge/danger-off`）；合并审批必须命中本项目线程记录的 PR 号，否则
  `merge/pr-not-ours`，不再回落 `dirs[0]`。
- **审批卡片显示纯文本影响面**（PR 号 / 仓库 / 分支 / 目录 / 变更键），批准与执行前能看到影响范围。
- **预授权（`preapprove`）终于有界面入口**，并明示「勾上即自动执行、不可逆动作没有二次确认」。
- **没配协调者的项目不再产生唤醒噪音**：线程结束时不再构造信封、不调模型，`wake/skipped` 审计
  从「每个 `turn/end` 一条」改为「同项目 + 同理由每 6 小时一条」；项目详情的协调者卡片会明确写出
  「未配置协调者，线程结束不会唤醒任何会话」。
- 一并修掉：审批队列上限与分页、超时占位回收、删项目清 token 桶（恢复时放回）、恢复校验 manifest id、
  记忆去重改为块级精确匹配、线程 worktree 建成功但建会话失败时回滚、线程序号不复用旧分支名、
  协调器 `project_thread_message` 校验会话归属、项目默认模型不可用时界面提示、token 入账合并写盘。
- **独立复审修正**：`Routines` 的启停开关同样改用宿主 `active` 契约（它从 0.10.x 起其实从未生效）；
  宿主没有 `schedule` 服务时「无可停」不再把项目卡成不可删；`detail.noDirHint` 文案改为
  「项目专用工作区（workspaces/&lt;id&gt;）」；删除影响面披露宿主定时数量。

回归修正（2026-11-28 复审后测试暴露）：① 项目默认模型/协调者默认模型允许「手填目录外的 provider + 部署特有
effort」，不再因为 provider 不在可用目录里把整条写入清空（AUD-PROJ-24 的校验只拒绝「provider 在目录里但模型不在」）；
② 暂停/归档项目下新建自动档 routine 由「硬拒绝」改为「建但按住」，修复「建完看不到行、没有可回读状态」的死锁，
同时仍然不会到点投递。
