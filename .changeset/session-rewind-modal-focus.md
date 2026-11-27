---
"@kangyishuai/dsh-session-rewind": patch
---

确认框默认焦点修正（真机抓到的 §7.4.2 偏差）：打开时预览还在 loading，主按钮 disabled、「取消」拿 `data-modal-autofocus`；预览到达后 autofocus 回到主按钮，但聚焦 effect 只在 overlay 打开时跑一次，焦点就永远停在「取消」上。现在 effect 依赖 `previewLoading/executing/loading`，状态变化会重新聚焦当前 `data-modal-autofocus`。
