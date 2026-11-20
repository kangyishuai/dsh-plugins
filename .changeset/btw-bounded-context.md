---
"@kangyishuai/dsh-btw": patch
---

新增**可选**的 bounded-context 模式（ADR-0022，默认关）：会话上下文超过 400K tokens 时，`/btw`
可以改用 `spawn` 子代理，只带最近 12 条 user/assistant 消息（单条 ≤700 字、总 ≤4000 字）+ 问题，
把单次成本封顶；答案 meta 与面板标记 `bounded`，此时不再追加 fork 成本警告。

- 设置分节「更多设置」新增复选框 `boundedContext`（默认 false）；开启后仅在 `contextPressure ≥ 400K`
  时生效，其余情况仍是 full fork。
- digest 过滤 system-reminder、工具调用/结果、非 user 来源；digest 为空时安全回退 full fork；
  线程追问的历史 Q/A 也会带进 prompt。
- spawn 不继承父会话、不复用父会话前缀缓存；因此默认关闭，属于用户显式取舍。
- 新增 5 条 `lib/bounded.js` 纯逻辑单测 + settings 断言（单测 70 → 75）。
- 临时宿主真实大会话 e2e：父 668K，bounded 单次 `cost.totalTokens=21,503`（同会话 fork 为 762,526），
  命令结果含 `· bounded`。
