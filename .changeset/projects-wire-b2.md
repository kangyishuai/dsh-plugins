---
"@kangyishuai/dsh-projects": minor
---

把桩接通（B2）：协调者区（项目页里一个长期会话，可建会话 / 发一句话 / 重开会话，**不是**宿主 composer）、协调者汇报渲染（结论上浮 + thread chip）、上下文策略（`compaction` 一律 `ctx.get()` 判空兜底 + wake 信封新增「最近线程」「记忆索引」两段）、线程 Tasks 清单（`todo/write` 整表快照 → ✓/◌ + n/m）、线程内 steering（`prompt({mode:'steer'})`）、每线程模型 / effort（`session/selectModel`，下拉取 `modelCatalog`，改后读 `modelSelection`）、Create PR 条与分支条、PR 徽章 + CI 状态点、展开面板里的 thread 起始卡与行内 chip、禁止跨项目移动（`store.attachThread` 对「已在 A 项目」的会话直接拒绝，只允许 attach 空槽 / 先 detach，含单测）、PR/CI 默认轮询（只对有开放 PR 的项目，30–90s 退避，应用关闭即停）与设置里的「实验性实时监听」占位开关（写明它会建临时 webhook、需要仓库管理员权限），以及设置页的 Restart 行。web 端到端冒烟 133 → 149 条；单测 428 → 443 条。