---
"@kangyishuai/dsh-casefile": minor
---

两件事，都来自 Bob.app 那一轮真实使用暴露的问题：

**1. 项目溯源锚点**
开项目时记录 `reaVersion` + `capabilityHash`（REA 工具面名字集合的 sha256 前 16 位）。
版本来源是 profile patch 文件里实际被启动的 `rea-agents@x.y.z`（读不到就留 `null`，不猜）；
工具面哈希始终可算。新 Remote `provenanceInfo` 可随时查当前探测结果。
之前 `project.json` 的 `reaVersion`/`capabilityHash` 一直是 `null`——半年后没人知道当时用的是哪套工具。

**2. 应用勘察第一跳：新工具 `case_app`**
`case_app inspect` 读 macOS `.app` 的 `Info.plist` 与可执行架构（`plutil`/`lipo`），一次给出一屏摘要：
bundle id、版本/build、最低系统、`LSUIElement`、沙盒声明、ATS 是否放开、URL scheme、文档扩展名、
导出 UTI 前缀，并自动判定**归属域一致性**（bundle id 域 vs UTI 域），最后顺手写一条结构证据。

动机：`inspect_desktop_application` 对纯原生 Swift 应用返回 `candidates: 0`，等于没回答"这是什么 app"，
当时只能手工 `file`/`plutil`/`ls`。现在这一跳有答复，且字段读不到一律 `null`，不编造。
