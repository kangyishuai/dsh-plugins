---
"@kangyishuai/dsh-projects": patch
---

删除确认框默认焦点真正生效（0.10.6 只改了 `data-modal-autofocus` 属性，列表弹窗没有 focus 逻辑）：

- 列表行 `⋯ → 删除` 弹窗打开后自动聚焦「确认删除」（真机实测 `activeElement` 从 BODY → 确认删除按钮）
- 同一弹窗补 Esc 关闭（此前只有详情页弹窗支持）
- 验证：verify 710、web 冒烟 270 PASS/0/0
