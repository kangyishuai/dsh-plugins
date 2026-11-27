---
"@kangyishuai/dsh-casefile": minor
---

安全与契约修复（AUD-CASEFILE 簇）：`case_project` 新增 `trash` / `restore` / `purge` 三个回收站动作与 `dryRun` 参数（`drop` 增加 dry-run、影响面与数据根审计，`purge` 硬删需显式 `confirm`），工作台新增回收站入口；`report` 新增 `redact` 选项并默认脱敏（与规格包/bundle 共用脱敏，报告页脚标注脱敏状态；脱敏范围扩展到通用系统根路径、`~/`、带扩展名的绝对路径与 AIza/JWT/私钥块等 token 形态）。回收站恢复会先校验条目里的 `project.json`（坏条目——包括版本高于本插件的条目——保留在回收站并写失败审计）；回收站列表对不可读/更高版本的条目降级为「元数据未知」而不是整表报错；`drop` 的 dry-run 返回 `previewTrashPath`（预览路径，实际落点会重新取时间戳），`purge` 的 dry-run 返回 `trashRoot`。`case_project` 的 action 枚举补齐 `autonomy`/`bundle`/`trash`/`restore`/`purge`；`case_evidence.input.kind` 改为枚举且未知种类落 `other` 并记 `kindRaw`；`open` 可打开已有项目，任何显式 `projectId` 调用都会建立可持久化的会话指针；新增 `maxArtifactBytes`（默认 64 MiB）与「先校验后归档」；`settings.section` order 改为 96。
