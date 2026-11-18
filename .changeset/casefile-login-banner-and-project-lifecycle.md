---
"@kangyishuai/dsh-casefile": minor
---

两件事：

**1. 等待登录的界面提醒（`shell.overlay` 覆盖层）**
`case_access await-login` 现在会在等待期间把状态挂到 host（`accessState`），client 半在 `shell.overlay` 注册一个右下角小横幅：「案卷：等待登录 / 请在弹出的浏览器窗口里完成登录；就绪后会自动继续 / 已等待 Ns」。每 2 秒轮询一次，就绪即消失；**是非阻塞提醒，不是模态框**，不打断任何操作。文案双语。

**2. 项目生命周期：`archive` 与 `drop`**
- `case_project archive`（`reason` 可选）：状态转 `archived`，文件全留，写审计。用于误建/暂存项目。
- `case_project drop`（**必须 `confirm: true`**）：把 `projects/<id>` 整个移进 `<dataRoot>/trash/<时间戳>-<id>`，**可手动移回**；不传 confirm 直接 `confirm-required` 拒绝，且项目不会消失。
- 两者都进审计（`project/archive`）。

背景：实测中 `case_build cycle` 起的 builder 会话误建过一个项目（`casefile-replica`），当时既没有"归档"也没有"移除"，只能卡在 `investigating`。builder 侧已由 `builder-readonly` 守卫修复，项目侧的出口由这次补上。
