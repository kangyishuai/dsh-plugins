---
"@kangyishuai/dsh-btw": patch
---

在超大上下文会话里给出**旁问成本量级提示**（Phase 1，只提示不阻断）：

- 父会话 `contextPressure` ≥ **250K tokens** 时，面板顶部显示一行警告（预计为上下文的 0.75–1.2 倍），
  并在 `/btw` 结果末尾追加同一句提示；不发请求、不拦截。
- 同时展示本会话**上一次旁问的真实 prompt 总量**（`inputTokens + cacheReadTokens`）方便对账。
- 依据 2026-11-20 的临时 `DSH_HOME` 探针（真实会话 + 一次真实 fork 对账）：fork 子代理 prompt 约为
  父会话 contextPressure 的 **0.75–1.2 倍**，空会话固定开销 ~114K，所以只给区间、不假装精确账单。
- 新增 5 条纯逻辑单测（`lib/cost-hint.js`），单测 65 → 70；默认 web 冒烟计数不变（提示只在大会话出现）。
