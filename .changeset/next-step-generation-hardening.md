---
"@kangyishuai/dsh-next-step": patch
---

空输出恢复链的可观测性与可测性加固（不改对外契约）：设置页「诊断」新增一行「预算升级：N 次」（`nextStep/diagnostics` 的 `stats.budgetEscalations`，每次生成最多 +1），`turn` 事件的 `cand` 在真的升级过预算时带 `esc: true`（`parse` 口径不变，旧报表不受影响）。内部把 `generate()` 里的「首次 → 空输出升级预算重试 → 带对话 JSON-only 修复」抽成 host-free、可注入 `callModel` 的 `lib/generation-recovery.js`，并用脚本化 fake model 补 14 项契约测试（预算序列、重发请求等价、修复请求带对话与真实畸形输出、失败诊断的最后实际 finish/usage/预算、预算上限），单包单测 253 → 274。`service.js` 的失败 detail 仍是 `json:empty`，报告分桶不变。
