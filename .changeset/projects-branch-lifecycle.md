---
"@kangyishuai/dsh-projects": minor
---

补上「分支生命周期」（规格 §7.7.5 / 计划 B5）：worktree 会回收，分支以前**永不删除**，会一路累积。

**新判据（三条全满足才删）**，刻意**不用** `git branch --merged`——它在两个方向都会误判
（未提交的新分支被当"已合并"、squash 合并的分支被当"未合并"，见 runtime §11.15）：

1. 分支是插件建的（`dsh/` 前缀且与线程记录一致）
2. 该线程**确有合并结果**：记录里有 `mergedAt`，或 `git merge-base --is-ancestor <branch> HEAD` 成立
3. **没有未推送提交**：`git rev-list --count <branch> --not --remotes` 为 0

**worktree 先处理**：分支若仍被 worktree 占用，`git branch -d` 会被拒。所以只在 worktree
**干净**（`git status --porcelain` 为空）时用 `git worktree remove`（不加 `--force`）移除它，
脏 worktree 一律保留并报告 `worktree-dirty`。

**删除只用 `git branch -d`，永不用 `-D`**；失败保留并写审计。
提供 RPC `cleanupBranches(projectId, { dryRun })`（默认 dry-run，真删需 `confirm: true`），
并在**归档项目**时自动按同一判据清理一次（失败不影响归档）。

真机验证（临时裸远端）：已合并+已推送的分支被删；未合并的分支保留（`not-merged`）；worktree 脏时保留。
新增 6 项单测（三判据真值表 + 两种历史误判场景 + `-d` 断言）。
