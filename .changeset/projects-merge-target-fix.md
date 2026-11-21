---
"@kangyishuai/dsh-projects": patch
---

修两个只在**真实 GitHub** 上才会暴露的合并缺陷（此前只用桩 `gh` 验证，抓不到）：

1. **合并会打到错误的仓库。** `gh pr merge` 原本没带 `--repo`，于是按「宿主进程当前目录所在的
   git 仓库」解析目标；同时 `gh pr merge` 对已合并的 PR 仍返回 exit 0，导致插件误报成功。
   现在合并前必须从项目目录的 `git remote get-url origin` 解析 `owner/repo` 并要求带上
   `--repo`，解析不到直接拒绝（`merge/repo-unknown`）。
2. **draft PR 被当作可合并。** 新增 `checkMergePreflight()`：合并前用
   `gh pr view --json isDraft,mergeable,state` 校验「非 draft / 可合并 / 仍 open」，
   任一不满足就拒绝并写审计；`mergeable=UNKNOWN`（GitHub 刚建 PR 时的正常状态）做有界重试。

真实仓库实测：draft PR 保持 open 未合并（`merge/pr-is-draft`）；ready 档 PR 成功 squash 合并，
main 上出现合并提交。单测 284 项（新增 9 项覆盖上述判定）。
