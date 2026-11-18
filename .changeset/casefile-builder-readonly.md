---
"@kangyishuai/dsh-casefile": patch
---

修一个真实的隔离漏洞：**builder 子会话可以写账本**。实测中一次 `case_build cycle` 起的 builder 会话自己建了一个项目（`casefile-replica`），这与「builder 只收到规格包」的设计直接矛盾，也让净室 attestation 失去意义。

现在 `startBuilder` 会把子会话 id 记进数据根级 `builder-sessions.jsonl`，所有写类工具（项目/证据/结论/功能/未知项/义务/构建/检查）开跑前统一过一道守卫：命中 builder 登记就返回 `builder-readonly`。读类与导出不受影响。
