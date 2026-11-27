---
"@kangyishuai/dsh-projects": patch
---

复审 follow-up（2026-11-28 `batch-ui-2` A2/A3/A4/A10）：

- **IME 守卫补全**：除 composer 外，其余 8 个「Enter 即提交」的输入框（新建项目名 / 新目录 / 新仓库、Library 搜索、线程 steer、记忆追加、route 派单、详情加目录）统一复用 `isImeConfirmKey`，中文输入法上词不再误触发提交（steer / route 会真的发消息 / 起协调者回合）。
- **目录超限 toast**：`detail.dirLimit` 补上 `used` 占位符参数，不再渲染裸 `已加 {used} 个`。
- 双语 README 单测数更新（825）并新增「卸载后残留 / What remains after uninstall」一节：数据根（`projects.json` / `trash/` / `workspaces/<id>/`）、仓库同级的 `.dsh-worktrees/`、宿主 workspace 绑定的残留与手工清理方式。
