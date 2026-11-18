---
"@kangyishuai/dsh-casefile": minor
---

两件事，都来自真实使用中撞到的问题：

**1. 产物归档（修根因）：`case_evidence` 新增 `artifactPath`**
外部采集产物默认落在 `/tmp`，一清理就再也算不出 sha256，项目只能永远停在 `investigating`——实测有三个项目因此关闭被硬门拒绝。现在传 `artifactPath` 会把产物**接管进项目目录**（`projects/<id>/artifacts/<sha256前16位><ext>`），记录 `sha256` / `bytes` / `originalName`；同内容只存一份，文件缺失直接报 `invalid-input`。

**2. 等登录（人机协作）：新增工具 `case_access`，动作 `await-login`**
登录态页面要人参与，agent 既不能干等、更不能假装成功：
- 轮询 CDP 页面上的**就绪判据**（默认「页面里没有密码输入框」，可自定义 JS 表达式）；
- 三态返回：`ready` / `timeout` / `error`，带 `attempts`、`waitedMs` 与**可直接转述给人的 hint**；
- 浏览器还没起（连接被拒）算"可以继续等"，等满 `timeoutMs`（默认 3 分钟）报 `timeout` 并保留现场；
- 每次调用写审计 `access/await-login`。

限制：等待发生在单次工具调用生命周期内；`case_access` 属写类工具，builder 会话会被 `builder-readonly` 拒绝。
