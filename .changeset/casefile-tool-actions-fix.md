---
"@kangyishuai/dsh-casefile": patch
---

修三处真实缺陷（0.1.1 起存在）：

1. **`case_project` 的 `close` / `report` 动作不可用**：schema 里声明了这两个值，但工具实现里没有对应分支，调用直接返回「未知 action」。已在 `switch` 里补齐（`close` 先做只读预览、被闸门拒绝时带回卡点）。新增静态守卫：任何工具声明了 action 枚举，就必须有 `case` 分支或 `assertAction` 白名单覆盖每个值。
2. **`case_build cycle` 只传 `cwd` 会误启 builder 会话**：`cwd` 本是构建目录，却被当成「要 builder」的信号，白起一个子会话并等它超时。改为只有显式给 `prompt` 或 `featureIds` 才起 builder。
3. **`screen_judge` 被错列为 REA 必需/可选工具**：它不在 `mcp__rea__*` 工具面里（是 build-computer 的检查类型），导致 `diagnose` 永远报「可选能力缺失 1 项」。换成真实存在的 `check_build_task`，诊断不再误导。
