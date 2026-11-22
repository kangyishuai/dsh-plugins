---
"@kangyishuai/dsh-projects": patch
---

真实 GitHub 仓库端到端验证（含真 CI、真 PR、真合并）抓到并修掉两个只有真机才暴露的缺陷。

- **`gh` 调用没有工作目录** → **自动开 PR 在真实仓库上从来没成功过**。
  `gh pr create` / `gh pr merge` 会在 cwd 里解析 git 上下文，而从宿主进程 cwd（不是仓库）调用会直接报
  `fatal: not a git repository`。桩 gh 不关心 cwd，所以单测与 web 冒烟一直是绿的。
  现在 `runGh(args, cwd)` 支持 cwd，`openPr` 用 worktree（没有则项目目录）、合并链路用项目目录。
- **合并方式字段读错**：REST `GET /repos/{owner}/{repo}` 返回 `allow_squash_merge` 等三个布尔，
  **没有** `allowed_merge_methods`。代码一直读后者 → 永远得到空数组 → 真实仓库上合并永远被拒
  （`merge/method-unknown`）。新增纯函数 `allowedMergeMethodsFromRepo`（两种形态都认）并加 4 项单测。

**真机验证结果**（私有测试仓库 + 真实 Actions CI）：

| 场景 | 结果 |
| --- | --- |
| 开 PR（真 GitHub） | `opened:true`，PR #3 创建成功 |
| CI 绿检测 | `statusCheckRollup` 读到 `SUCCESS` |
| `minApprovals=0` + CI 绿 | `executed:true`（真合并发生在真实仓库上） |
| `minApprovals=1`（无人 review） | `merge/not-approved`（真人批准门槛生效） |
| L2 自治 + 规则命中 `new-thread` | `executed:true`，真的新建了线程 |

单测 392 → **397**。
