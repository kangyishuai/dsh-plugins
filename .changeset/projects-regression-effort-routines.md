---
"@kangyishuai/dsh-projects": patch
---

修复 2026-11-28 审计修复批次自己引入的两处回归（web 冒烟 `pnpm smoke:projects` 从 270 PASS
掉到 262 PASS / 8 FAIL）：

- **手填部署特有的 `reasoningEffort` 又被挡在门外（F42 回归）**：`AUD-PROJ-24` 在
  `setThreadDefaults` 写入口按模型目录硬校验，而宿主目录只列「当前部署可用」的 provider。
  于是「手填一个目录外的 `provider/model` + 部署特有 effort（`max`/`xhigh`/`off`）」整条写入被
  判成 `model/unavailable` 拒掉（UI 回读是空串，审计里也没有三次写入）。现在
  `checkCatalogChoice()` 先判** provider 权威性**：目录里根本没有这个 provider →
  `checked:false / provider-unknown`（无法判断就不拦，符合「目录拿不到不校验」的既有口径）；
  provider 在目录里而模型不在 → 仍然拒绝（`AUD-PROJ-24` 的原意：换 provider 后默认模型失效）。
  effort 没有、也不该有白名单，原样保存（`max` / `xhigh` / `off` 回读一致）。
- **暂停项目下建不了自动档 routine（Routines 回归）**：`AUD-PROJ-02` 原先在
  `createRoutine` / `updateRoutine` 里对暂停/归档项目**硬拒绝**，结果是「建完之后列表里没有行、
  也没有可回读的状态」——静默死锁，还会连带打掉 History / 停用 / 删除 / 落盘一串断言。
  现在改成**建但按住**：宿主条目照常建出来，紧接着发 `patch.active:false`（`holdSchedulePaused()`）
  并回读 `status:'paused'`，按不住就撤掉条目并如实失败；本地记录 `enabled` 仍是 `true`
  （可停用/可删除/可回读），`resumeProject` 的宿主对账会把它放开，用户显式停用的保持停用。
  花钱的路径仍然被堵住：`paused` 条目不会到点投递。同一批也补上了**「停用 → 启用」这条绕过路径**：
  暂停/归档项目里点「启用」只写本地 `enabled`，宿主条目强制留在 `paused`（回执带 `heldPaused`），
  项目恢复时才真正放开——否则点两下开关就把项目暂停绕过去了。`schedule` 档一次性提醒保持原来的
  拒绝新建（按住再恢复时 `at` 时点大概率已过期，宿主会以 `not_future` 拒掉）。

顺带：`model/defaults-checked` 审计补 `reason` 字段（区分 `provider-unknown` / `catalog-unavailable`）；
`pnpm smoke:projects` 的浏览器脚本修了一处**模板内正则转义**（`/workspaces\/<id>/` 在模板字符串里
少了反斜杠，生成的 `browser.mjs` 直接语法错误、冒烟 INFRA 失败）。
