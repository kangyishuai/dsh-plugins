---
"@kangyishuai/dsh-projects": minor
---

接通「审批 → 执行」闭环，并补齐新能力的两个界面入口。

**审批 → 执行（修一个实质缺口）**
- 之前 `executeApproval` 已导出为 RPC 却**没有任何调用方**：用户点「批准」只改状态，
  没有任何入口真正执行，整套开关/阈值/审计形同虚设
- 详情页现在把「已批准未执行」的申请单独渲染，带「执行」按钮（`data-projects-approval-execute`），
  点击后把 `executed:true` 或拒绝原因回显在行内
- 服务端补 `purge-trash` 与 `change-settings` 两条执行路径（此前只会 `execution-deferred`）

**改本插件自己的配置（规格 §7.5 行 5a）**
- `change-settings` 从「有开关、无实现」变成真可用：白名单只放 `persona` / `routing` / `goal`
- 安全面一律拒：`danger` / `autonomy` / `preapprove` / `budget` / `repoGrants` 等
  （`settings/forbidden:<key>`），防自我提权

**界面补漏**
- 详情页新增「仓库授权」：`policy.repoGrants` 的 per-repo 授予以前只能手编 JSON
- 详情页新增「回收站清理」：先 dry-run 预览、再确认；只处理本项目超保留期条目

**已知取舍**：幂等占位写在闸门之前，所以被拒绝的申请也会被占用（需重新申请）。
换成 claim/release 可两全，但涉及 14 处拒绝点，留作后续。

317 项单测（新增 8 项配置白名单）+ web 冒烟 52 项（新增 2 项）全绿。
