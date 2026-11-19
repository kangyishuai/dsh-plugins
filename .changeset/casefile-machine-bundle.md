---
"@kangyishuai/dsh-casefile": minor
---

新增**机器可读证据包**：`case_project bundle`（`redact` 默认 true）→ `bundles/<时间戳>/bundle.json`。

与规格包的分工：
- **spec pack**（`case_brief`）= 只含被选中的结论，面向"交给编码 agent 去复刻"；
- **bundle** = 全量账本（证据/结论/义务/检查/未知项/产物清单），面向"整段交接给另一个 agent，或几个月后自己回看"。

硬要求是**确定性**：
- `generatedAt` 取自数据自身的最大时间戳，**不是** `Date.now()`；
- 键排序规范化后写入，同一份数据导出两次**字节一致**（有测试断言）；
- 自带 `integrity = { algorithm, canonical, digest }`，接收方可去掉 `integrity` 后独立重算校验（已用一个不依赖 casefile 代码的独立消费者脚本验证通过）。

顺带补上 `case_obligation` 的 `claimIds`：义务可以声明"我验证的是哪条结论"，这样 bundle 接收方能直接回答**「哪条结论还没人验」**——这是交接时最常被问的问题。
