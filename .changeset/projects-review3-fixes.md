---
"@kangyishuai/dsh-projects": patch
---

第 3 轮独立复审修复（功能/安全 P0 + UI P1）：

- **P0 回收/归档 worktree 不再无视 ignored 文件**：`reclaimThreadWorktree` 改用 `status --porcelain --ignored`，`.env`/模型缓存存在即保留（`dirty`）。
- **P0 回收站恢复不再丢 workspace**：删除时的 manifest 记录 `workspaceDir`，`restoreTrash` 把 `workspace/` 搬回 `dataRoot/workspaces/<id>`。
- **P1 删除回滚不丢已搬内容**：`moveInto` 失败先把已移动目录搬回原位，再清回收站（不再整目录 `rmSync`）。
- **P1 归档钩子的 busy 保护真正生效**：`threadBusy(thread, states, sessionId)` 显式接收 id（store 原始记录没有 `sessionId`）；且 busy 判定移到 `setThreadState(archived)` 之前。
- **P1 `cleanupBranches` 的 worktree 删除要求 `confirm`**：未确认时返回 `confirm-required`、不动磁盘；真删写 `worktree/removed` 审计。
- **P1 合并/推仓库解析补 `thread.dir`**：worktree 被回收后不再回落 `dirs[0]`（多目录项目不会合错仓库）；merge 的文件夹授权闸也按线程 worktree/dir 判（`deny` 不再被绕过）。
- **P2 显示与 busy 口径统一**：宿主明确 `running=false` 且无 turn 事实时，记录里的 `working` 不再永久显示「在跑」。
- **UI（同步修复）**：新建项目/编辑详情两个模态补**焦点陷阱 + 全局 Esc + 初始聚焦**；详情页头部 ⚙ 改为真正打开项目设置抽屉；tablist 补 `aria-label`；列表删除弹窗关闭后焦点归还行菜单；设置抽屉/删除确认的 a11y 断言随冒烟覆盖。

验证：`pnpm verify` **719** 单测；web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**。
