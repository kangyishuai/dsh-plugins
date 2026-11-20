# 架构决策记录（ADR）

记录**为什么**这么做。每条决策一个文件，编号递增，已接受的不再改内容；要推翻就新写一条，并把旧的状态改成「已被 ADR-xxxx 取代」。

| 编号                                                  | 标题                                                  | 状态   |
| ----------------------------------------------------- | ----------------------------------------------------- | ------ |
| [0001](0001-plain-js-with-jsdoc.md)                   | 纯 JS + JSDoc，不引入构建步骤                         | 已接受 |
| [0002](0002-destructive-operations.md)                | 破坏性操作的统一处理方式                              | 已接受 |
| [0003](0003-session-delete-product-shape.md)          | session-delete 的产品形态                             | 已接受 |
| [0004](0004-session-delete-architecture.md)           | session-delete 的架构：三内核 + 两阶段提交 + 能力降级 | 已接受 |
| [0005](0005-dsh-version-compatibility.md)             | 插件与 DSH 版本的兼容与升级策略                       | 已接受 |
| [0006](0006-session-rewind-architecture.md)           | session-rewind：只追加的回溯标记                      | 已接受 |
| [0007](0007-session-rewind-file-restore.md)           | session-rewind：文件还原的写前快照与救援点            | 已接受 |
| [0008](0008-session-rewind-non-destructive-recall.md) | session-rewind：非破坏性召回（召回 vs 回溯分工）      | 已接受 |
| [0009](0009-next-step-architecture.md)                | next-step：一个包两个面，状态属于会话数据             | 已接受 |
| [0010](0010-advisor-architecture.md)                  | advisor：模型自主时机的按需顾问，成本与原因必须可见   | 已接受 |
| [0011](0011-advisor-currency.md)                      | advisor：人民币设置与 USD 内部账本口径                | 已接受 |
| [0012](0012-advisor-cache-pricing.md)                 | advisor：缓存读/写 token 的单价与两阶段成本           | 已接受 |
| [0013](0013-next-step-gating-telemetry.md)            | next-step：三档判定、展示与生成解耦、本地事件与复盘   | 已接受 |
| [0014](0014-automerge-tiers.md)                       | 自动合并分级：release / 文档 / 证据齐全的单插件改动   | 已接受 |
| [0016](0016-btw-fork-subagent.md)                     | btw：建在 fork 子代理上，而不是直接调用 llm           | 已接受 |
| [0015](0015-plugin-index-source.md)                   | 自建插件索引源：发版后用 npm 数据包 + jsDelivr 发布   | 已接受 |
| [0016](0016-artifacts-local-first.md)                 | artifacts：本地优先，发布目标可插拔                   | 已接受 |
| [0017](0017-artifacts-update-mechanism.md)            | artifacts：摘要行 + 右栏面板 + 元数据封面             | 已接受 |
| [0018](0018-projects-defer-liveshare-sharing.md)      | projects：项目共享推迟到宿主提供稳定 LiveShare 接口   | 已接受 |
| [0019](0019-projects-authorization-model.md)          | projects：危险动作可配置，授权来源不可伪造            | 已接受 |
| [0020](0020-projects-no-cloud-execution.md)           | projects：不做云端执行 / 多租户 / 多设备同步          | 已接受 |
| [0021](0021-projects-auto-fix-boundary.md)            | projects：auto-fix 只改实现、不碰测试                 | 已接受 |
| [0022](0022-btw-bounded-context-cost.md)              | btw：超大会话的 bounded-context（草案）               | 提议中 |
| [0023](0023-next-step-grounded-cards.md)              | next-step：卡片必须落在对话上（落地不变量）           | 已接受 |

新建：复制 [0000-template.md](0000-template.md)。
