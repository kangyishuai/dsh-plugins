---
"@kangyishuai/dsh-projects": minor
---

补齐规格 §7.5 行 3 漏实现的合并硬前提，并落地项目级预授权（规格 §7.7.2）。

**合并的三道硬前提**（此前只查「非 draft / 无冲突」）
- **CI 绿**：`statusCheckRollup` 必须全部通过；空列表按「未配置检查」**拒绝**（`merge/ci-unknown`），不猜
- **人工批准**：统计 `reviews` 里不同作者的 APPROVED 数 ≥ `policy.merge.minApprovals`（默认 1）
- **合并方式**：仓库 `allowed_merge_methods` 必须含 `squash`，否则拒绝而不改用 merge/rebase
- 阈值改从 `policy.merge` 读（`minApprovals` / `maxDiffFiles` / `maxDiffLines`），不再写死

**项目级预授权**：`policy.preapprove` 列出可被 `policy-grant` 直接放行的动作；三条全满足才生效
（在列表里、授权来源是 policy-grant、危险开关已开）。命中后自动 approved 并**立即执行**——
闸门一条不跳过，只省掉「等人点一下」。`merge`（approval-event）与直推保护分支（per-incident）
**永不**被预授权覆盖。执行结果会如实回报给协调器（`executed` / `auto-approved-not-executed` + 原因）。

**顺带**：`delete-thread` 之前也是「可申请但执行只会 deferred」，现在真正走 `reclaimThread`（三重判据不变）。

**一处旧结论纠正**：宿主没有 `ctx.approval.setPolicy`（`dsh-authorization` 是凭据流程，不是审批），
所以预授权是本插件用政策授权自己实现的，不是宿主能力。

341 项单测（新增 19 项：CI/批准数/合并方式/预授权/工具回报）、真机验过五种拒绝与两种放行路径。
