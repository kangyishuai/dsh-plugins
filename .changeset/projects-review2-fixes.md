---
"@kangyishuai/dsh-projects": patch
---

第二轮独立复审（功能/性能/安全 + UI/UX）修复：

- **P0 归档不再删 worktree**：`archiveProject` 只做元数据操作；`cleanupBranches` 先判「已合并 + 无未推送」再谈 worktree，默认只报告不删（显式 `removeWorktrees` 且无任何含 ignored 文件才删）。归档钩子（`session-archived`）补 `threadBusy`，在跑会话不回收 cwd。
- **P0 审批合并与 UI 同一仓库解析**：按线程 `worktree` 找仓库（多目录项目不再把 repoB 的 PR 合到 repoA 同号 PR）；审批路径改用 `assessMergePr`（CI/批准数/draft/改动量同一套判据），删掉不存在的 `policy.danger.merge` 读法；`delete-project` 审批补 `await`（失败不再报 executed）。
- **P1 直推保护分支 refname 校验**：拒绝 `--force` / `src:dst` refspec / `..` / 非 heads ref；强推前置检查用实际 worktree 仓库。
- **P1 `waiting-user` 不再粘住**：记录里的 `waiting-user` 只在「没有任何 turn 事实」时兜底；`isThreadBusy` 对无 turn 事实且宿主 `running=false` 的 `working` 记录不再判忙。
- **P2**：`rollupState` 的 PENDING/EXPECTED 归 pending；已合并 PR 不再轮询；`threadStates` 与 `buildThreadRow` 同口径；回收站条目拒绝 `.`；`isSafeRecordKey` 拒绝 `.`/`..`；无目录项目模板不再写进程 CWD；`workspaces/<id>` 随删项目进回收站；`mergePr` 先判完门禁再 `pr ready`；`deleteTrashEntry`/`threadStates` 等小修。
- **UI**：新项目对话框聚焦第一步 + Tab 环 clamp（Esc 可关闭）；补 `detail.groupCollapse/Expand` 两个 locale；危险文字用 `light-dark()` 成对颜色（浅 #b3261e / 深 #ff8c8c，两主题 ≥4.5:1）；`not-a-git-repository` 降级改中性提示并自动消失；「打开产物库」成功也给反馈（跨视图可见性说明）；空输入时发送按钮禁用；行尾时长与项目列表统一相对文案。

验证：`pnpm verify` **706** 单测；web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**；`pnpm gate projects` EXIT=0（probe 72/72、桌面 17 PASS）。
