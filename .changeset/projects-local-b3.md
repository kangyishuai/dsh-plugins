---
"@kangyishuai/dsh-projects": minor
---

本地优势 + 设置 + 记忆（B3）。数据面：记忆碎片（`MEMORY.md` 索引 + 独立 `.md`，可预览、可逐条 forget）、instructions 16k 预算与宿主 `dsh-agent-instructions` 去重、`<project-context>` 包裹 + 「这是项目记忆，不是 AGENTS.md」、goal ≤8,000 + 计数、预算默认值（日线程 20 / 并发 2 / 步数 60 / token 不限）、**暂停语义修正**（暂停不再中断上下文注入）、设置四分区（General/Memory/Usage/Debug access，Usage 只报 token 不报金额）、按项目通知开关、`gh` 只读连接检查、模板受管 AGENTS.md 区块、线程重命名、`@` 候选与 `setThreadDefaults` RPC。

UI 面：详情右栏「上下文」新增本地优势卡（@ 候选预览、碎片计数）（**本地文件夹授权卡三键 Deny / Set as default folder / Allow once（一次性凭据用掉即失效）**、线程默认模型 / effort 下拉（`modelCatalog`，默认值落项目 store 并在建线程时套用）、从会话开线程（`recentSessions` + 挂为线程）、`@` 源状态）；记忆页签新增碎片列表（新增 / 预览 / 逐条忘掉）与 `MEMORY.md` 索引条目逐条忘掉；既有线程 ⋯ 菜单补上「重命名」（内联输入，写 `renameThread`）与「复制 ID」，并注册 `contextMenus` 自定义 target 族 `projects.thread`；`@` 源通过 client `inputTriggers.registerSource` 注册（插入 `@thread:<id>` / `@project:<id>`）；客户端的完成通知（`completed`）接到 `shell.overlay` toast 并按项目开关过滤。验证：projects 单测 472（新增断言并入既有用例），web 冒烟 172 → 180。
