---
"@kangyishuai/dsh-casefile": minor
---

新增 **外部报告摄入契约 v1**：新工具 `case_ingest`
- `case_ingest schema`：返回契约形状与规则，方便别的 agent（Craft 等）生成正确格式；
- `case_ingest ingest`：把外部 agent 的报告写进案卷，`dryRun` 可先预演。

**立场写死在实现里**：`authority` 固定 `external`、`producer.confirmationNote` 注明"外部 agent 产出，casefile 只记录与引用，不背书"。casefile 不解释对方语义，也不替它补不确定性。

契约要点：
- `claims[].evidenceIds` 用**数组下标**引用本次 payload 的 evidence，摄入时映射成真实 id；**越界直接报错**（不静默丢引用，那会让结论变成无出处）；
- `source.reportPath` 若给出，会归档进项目目录并记 sha256（`/tmp` 会过期）；
- 未知项保留对方给的严重度。

顺带两处小改：`addEvidence` 允许直接复用已归档的 `artifact`（同一份外部报告可以同时是多条证据的出处）；`case_ingest` 纳入写类工具的 builder 只读守卫。

**真机验证**：用 REA 真实导出的证据包（14,138 字节 / 2 条记录）作输入，先 `dryRun` 再摄入 → 归档 sha256 `5568fd27…`、2 证据 / 2 结论 / 2 未知项、producer 与 claim↔evidence 映射全部正确。web 端到端 52 → **56 项断言全绿**。
