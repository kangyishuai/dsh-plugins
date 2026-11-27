---
"@kangyishuai/dsh-session-rewind": minor
---

session-rewind 审计剩余 P2/P3 收口（AUD-REW-04/06/07/08/09/10/11 + P3 选做），并修复用户模拟发现的 **回溯不可持久**（USIM-U3-01）：

- **重启后仍截断**：冷启动时 chat builder 可能在「当前会话未知」时创建，旧实现把 null 会话 id 永久捕获；`cuts` RPC 又会在宿主 resume 完成前失败一次并被静默吞掉，导致重启后对话流里被撤回的消息重新可见、面板却仍标「已撤回」。现在 builder 在 rebuild 时动态解析并记住会话 id，`cuts` 拉取失败会有限次退避重试，打开回溯面板时也会补种一次。宿主 replay 侧已用真实 v4 日志 + `foldSurface` 验证：marker 的 `surfaceOp.replace` 会让模型上下文保持截断（物理格式把 `sourceEventSeqs` 压缩成 `[start,end]` 区间属正常编码）。
- **确认框**：新增「可恢复」一行（撤回内容留在已撤回页签；文件写入前建救援点、新建文件进插件回收站）；主按钮默认聚焦（不可执行时回落到取消）、Tab 在框内环绕、关闭后焦点归还触发元素。
- **回收站有了入口**：`listTrash/restoreTrash` 暴露成 Remote，并入面板「救援点」页签（可恢复，恢复前先建 rescue-of-rescue；也可在影响面预览后清空并写 `trash-clear` 审计）。
- **`/rewind @<seq> both` 不再直接写文件**：先回执影响面（文件数/跳过数/可恢复性），必须显式带 `confirm` 才执行；会话运行中一律拒绝（提示改用界面确认框）。
  - **迁移说明（破坏性行为变化，故本版本按 minor 发布）**：旧用法 `/rewind @<seq> both` 原先会直接执行；升级后它只回显影响面，执行需 `/rewind @<seq> both confirm`；会话运行中请改用界面确认框（它会先停止当前回合并展示完整影响面）。
- **被跳过的文件可见**：符号链接 / 工作区外 / 排除目录 / 捕获失败也落 `skipped` entry（相对路径），预览按原因分组报数，成功 toast 报跳过数；`file-tracking` 不再忽略 `recordChange` 返回值。
- **编排可测**：`executeRewind` 状态机下沉到 `rewind-flow.js`（preview → 救援点 → marker → apply → 部分失败 → 审计），补 14 条单测；删除生产未使用的 `*Response` 死代码，`service.test.js` 改名为 `operations.test.js`。
- **P3**：恢复侧 8 MiB stat 预检（不再整块读超大文件）、marker 失败丢弃救援点、收回被创建的空目录、诊断文案中英双语、设置低频项与诊断收进「更多设置」、启动时清一次无引用 blob（`gc-blobs` 审计，`gcOnStartup: false` 可关）。
- **裸 `/rewind` 打开插件自己的候选对话框**（USIM-U2-26）：宿主 `commandUi.decorate` 的 `popupSelect` 在这条路径上实测 ↑/↓/Enter 失效，改用宿主支持的 `ui.kind:"action"`，直接复用与 `Esc` `Esc` 同一套候选对话框（键盘导航、搜索、只列会话消息）。
- **统计口径统一**（USIM-U2-20）：toast/确认框写「截断 N 条上下文记录（撤回 M 条用户/助手消息）」，面板与回溯记录用同一个 M，不再出现同一动作两个数字。
- **面板提供「选择消息回退」**（USIM-U2-10）：抽屉不再只能关掉再点行内 ↶；头部提示 + 按钮直接关闭面板并打开候选列表。
- **追踪范围写进确认框**（USIM-U2-03 / U3-08）：「无文件变更」改为「本轮没有可追踪的文件改动」，并常驻一行说明只追踪本会话工作目录内 `write` / `edit` / `apply_patch`，bash/脚本、子代理与工作区外改动不追踪。
- **诊断计数如实**（USIM-U3-06）：健康检查曾用 `readAudit({ limit: 1 })` 再把长度当条数，审计永远显示 1 条；现在按真实行数统计（上限 1000，超出显示「至少 N 条」），检查项构造下沉到可单测的 `health.js`。
- **测试/门禁**：web 冒烟新增 10 条确定性断言（48→58）、桌面只读 +9（51→68 静态断言中只读分节）、`--deep` 新增「修改还原 / 删除文件 / 冲突拒绝」8 条（**脚本未在本分支运行**）；`docs/testing/session-rewind.md` 修正「文件模式已自动化」的失真表述并补 §2.7 重启复核步骤。

- **本批未做 / 后续**：AUD-REW-18（偏好从 localStorage 迁到数据根）defer，原因是需要新增 host 侧配置读写 RPC + 旧 localStorage 迁移，且只影响 `dsh web`（端口随机）的偏好持久性，与本批安全修复无耦合；复审 N3（回收站内联清空确认的默认聚焦）、N4（回收站错误码语义/不可达 partial toast）、N8（`commandUi` `ui.kind:"action"` 未进 runtime 文档/探针）、N9（本 defer 已在此写明）、N10（启动 GC 对 entries 读失败的 fail-closed）、N11（历史 audit 行旧口径回落）均为 P3/P4 follow-up，未在本 PR 阻塞。
