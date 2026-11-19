---
"@kangyishuai/dsh-casefile": minor
---

`case_ingest` 支持**自动识别并映射 Craft Anything 的报告**（证据账本形状）。

依据 Craft 的公开文档字段（`subject / operation / result / confidence / authority / limitations / locations` + 独立的 `unknowns`）做**纯字段搬运**：

| Craft 字段 | 映射到 |
|---|---|
| `operation` + `subject` | evidence 的一句话 summary |
| `operation` 前缀（disasm/analy/parse/string/js/network/screenshot/plist/signature…） | evidence.kind |
| `limitations` | 原样保留 + 追加一句"由 Craft 产出、casefile 未复核" |
| `locations[].path` | refs |
| `unknowns[]` | 案卷未知项（保留 severity） |

只搬运、不解释：`authority` 仍固定 `external`，producer 仍注明"不背书"。

⚠️ **未用真实样例验证**：本机没有装 Craft，映射按公开文档字段写。拿到真实报告后若字段改名会报 `invalid-input`（而不是静默丢字段）。已符合契约的 payload 不会被误判成 Craft 报告（有测试）。
