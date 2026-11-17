---
"@kangyishuai/dsh-btw": minor
---

答案渲染与追问体验：

- **代码块与链接**：答案按段渲染（`answerSegments`）——``` 围栏渲染成等宽 `<pre>`（不再把 ``` 显示给用户），URL 变成可点链接（之前是死文本）。刻意**不做**完整 Markdown 渲染（表格/标题/粗体已由 `stripMarkdown` 变成可读标点），避免在无构建的前提下手写渲染器。
- **追问不再把 `--thread` 暴露在输入框**：浮层点「追问」时先把 `{threadId, question, scope}` 通过 `queueFollowUp` 交给 host 暂存，再提交**裸 `/btw`**；host 处理裸命令时先查队列，取不到才走「重开上一条」。host 未升级时自动回退到旧命令文本（优雅降级）。
- 新增 `packages/btw/lib/followup-queue.js`（按 session 分槽、一次性取出、TTL 60s）。
