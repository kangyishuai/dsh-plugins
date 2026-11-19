---
"@kangyishuai/dsh-casefile": patch
---

修一个**真机才暴露的枚举错配**：摄入契约里的 `evidence.kind` 白名单与 `core/model.js` 的枚举**不一致**。

- 契约里多了 `network` / `artifact`，模型里没有 → 摄入被模型层拒绝：
  `kind 必须是 pseudocode | assembly | … 之一，收到 "network"`；
- Craft 适配器把 `capture.network` 映射成 `network`，于是**第一条网络类证据之后的摄入全部失败**（先写入的 1 条留在库里，看起来像"部分成功"）。

修法：契约的 kind 列表**对齐模型枚举**；Craft 的 `network/capture` 映射为 `har`。

新增回归测试：把适配器可能产出的**所有 operation 家族**逐个过 `validateIngestPayload` + `normalizeEvidence`——枚举一旦再错配就会红。反证过（把 `har` 改回 `network`，5 条测试立刻失败）。

## 为什么之前没抓到

既有测试只断言"映射出的 kind 等于我期望的值"，而"我期望的值"本身就错了。这次让测试**真的过一遍模型校验**，才把契约与模型焊在一起。
