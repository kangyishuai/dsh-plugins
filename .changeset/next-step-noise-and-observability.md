---
"@kangyishuai/dsh-next-step": minor
---

本批审计（AUD-NS-01…08）的行为修复：下一轮开始时不再取消在途生成，而是让它跑完并把候选以 `shown:false` 落库（**这不是省钱改动**：跑完会比中止多付输出 token；换来的是接近完成的调用不再被丢弃、诊断与报表里记为 `superseded`；该候选不进对话流、不占 `maxCardsPerSession`、不进曝光、不可揭示）；更早轮次、未决策的卡默认折叠成一行「更早的一轮 · 摘要首句」，`maxCardsPerSession` 默认从 120 降到 60（旧设置文件里恰好等于 120 的值随 v3 迁移更新，你自己设的其它数字不动）。复盘报表的「第几条」分母改成该位置被展示的次数（`second-option-useless` 判读第一次真正可达），`closeFollowup` 接线（下一轮结束 / TTL 15 分钟 / 会话级上限 32 都结算 `typed:false`），非 completed 的回合也会落 `gate:"turn-error"` 事件（不再在进入闸之前被丢掉）。`error.aborted` 补进两份 locale 文件并新增内联字典 ↔ locale 文件的键集 parity 测试，README 隐私段补充「胶囊文案会原样记录」。
