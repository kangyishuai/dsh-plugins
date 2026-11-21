---
"@kangyishuai/dsh-projects": minor
---

「记忆」页签从只读变成可写。

走查发现：用户能看到「常设规则（instructions.md）」和「记忆索引（MEMORY.md）」，却没有任何编辑入口——
规则只能靠协调器工具写，人想加一句"这个仓库测试用 pnpm test"都无处下手。

- RPC `setProjectInstructions({ projectId, text })`：写 `instructions.md`（0o600）；
  空文本视为清空（删文件，而不是留个空文件让人分不清有没有规则）；上限 20k 字符（每次请求都会注入，太长持续吃上下文）
- 界面：「编辑常设规则」→ 文本域 →「保存规则」；另有「追加一条记忆」输入框（回车即追加，重复条目会如实提示"已经记过了"）
- 两个动作都写审计（`project/instructions-saved` / `project/instructions-cleared` / `memory/appended`）

**踩坑记录**：给 `appendMemory` 加行内类型注释会让 SRC 网关拒绝注册该方法，
表现为运行时 `typert gateway: ...`。`pnpm check` 里的 SRC 守卫当场拦住了——改用上方 JSDoc `@param`。

冒烟 62 → **61**（本分支基于 main，新增 2 条记忆编辑断言）。
