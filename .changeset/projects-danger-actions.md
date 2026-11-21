---
"@kangyishuai/dsh-projects": minor
---

把规格 §7.5 里剩下三项危险动作从「只有开关、没有实现」补成真正可用，全部默认关：

- **强推自建分支**（`push-branch` 带 `force`）：只走 `git push --force-with-lease=<branch>:<sha>`，
  不接受裸 `--force`；分支必须是插件记录过的 `dsh/` 分支、非保护分支、旧 SHA 已知；
  远端被动过时 lease 会 fail-closed 拒绝。成功后记录 `lastPushedSha`，审计里带旧 SHA 供恢复。
- **直推默认/保护分支**（`push-protected-branch`）：推前查 `branches/<b>/protection` 与 `rulesets`，
  服务端要求 PR 时直接拒绝；需要项目策略里对该仓库 **per-repo 授予**（`policy.repoGrants`）；
  每次审计带仓库/分支/提交者数，检测到多人协作时返回 `warning: multi-collaborator`。
- **回收站保留期清理**（`purgeTrash` RPC）：只处理已在回收站且超 `retentionDays`（默认 30 天）的条目，
  认不出时间的条目一律保留；**默认 dry-run**，真删需开关打开 + `confirm: "purge"`，
  执行前写出 `trash/purge-<ts>.md` 可恢复清单并审计。

配套：`repoGrants` 进项目策略（只认显式 `true`）；线程记录新增 `lastPushedSha`/`baseSha`；
设置页三个开关的文案从「暂未实现」改为真实行为说明；新增 22 项纯逻辑单测与「动作↔开关↔可申请」
一致性守卫单测（309 项单测全绿）。
