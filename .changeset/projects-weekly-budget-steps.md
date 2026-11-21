---
"@kangyishuai/dsh-projects": minor
---

补「周预算」与「单线程步数上限」（规格 §7.7.4）。

- **周预算**：`policy.budget.weeklyTokens`，按**自然周（周一 00:00，本地时区）**聚合 token 用量，
  到线即拒建新线程（`budget/weekly-tokens`）。为此把 token 用量从「单日桶」改成**按天分桶**
  （保留最近 21 天，旧形状自动迁移，不丢历史数）
- **单线程步数**：`policy.budget.maxStepsPerThread`，按 `assistant/attempt` 计步；
  超限**只停协调器唤醒**（审计 `wake/skipped` + `budget/steps-per-thread`），
  **不杀会话、不阻止人继续**——这是刻意的：预算是防止无人值守的无限烧，不是惩罚使用者
- `threadStats` 增加 `overBudget` / `budgetReason`，面板可据此提示

新增 9 项单测（周界计算、周预算边界、步数边界、按天分桶、旧形状迁移、21 天修剪）。
