---
"@kangyishuai/dsh-projects": minor
---

把桩接通（B2）：协调者区（项目页里一个长期会话，可建会话 / 发一句话 / 重开会话，**不是**宿主 composer）、协调者汇报渲染（结论上浮 + thread chip）、上下文策略（`compaction` 一律 `ctx.get()` 判空兜底 + wake 信封新增「最近线程」「记忆索引」两段）、线程 Tasks 清单（`todo/write` 整表快照 → ✓/◌ + n/m）、线程内 steering（`prompt({mode:'steer'})`）、每线程模型 / effort（`session/selectModel`，下拉取 `modelCatalog`，改后读 `modelSelection`）、Create PR 条与分支条、PR 徽章 + CI 状态点、展开面板里的 thread 起始卡与行内 chip、禁止跨项目移动（`store.attachThread` 对「已在 A 项目」的会话直接拒绝，只允许 attach 空槽 / 先 detach，含单测）、PR/CI 默认轮询（只对有开放 PR 的项目，30–90s 退避，应用关闭即停）与设置里的「实验性实时监听」占位开关（写明它会建临时 webhook、需要仓库管理员权限），以及设置页的 Restart 行。web 端到端冒烟 133 → 157 条；单测 428 → 453 条。另修 B1 审查的 3 个 P0 / 5 个 P1：宿主侧持久化断言改成具体值（不再有恒真式）、六态词表两端统一（`waiting-user` 不再被丢弃、冷启动 `failed`/`working` 读得回来）、`dirs` 在 load 时不再静默截断（超限只由写入口拒绝）、`~Nm` 的 `firstActivityAt` 用最早时间（估得出非 null）、桌面回归首启步骤改只读、`thread.dir` 在行内显示短名；F35 口径写明「本批只做多目录」。

F35 口径：本批**只做多目录**（每项目 ≤10 个 root，全部生效；每条线程记录自己跑在哪个 root，行内显示 `thread.dir` 短名）。Claude 的 1000 文件 / 单项目 2 GB / 单文件 480 MB 属于它的上传能力，DSH 没有上传通道，随上传能力一起**后置**，本批不做也不宣称。
