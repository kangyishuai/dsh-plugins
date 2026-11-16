---
"@kangyishuai/dsh-btw": minor
---

新增 `/btw` 只读旁问：命令在回合进行中立即派发，答案由 fork 出来的只读子代理生成（执行期 `tools.guard` 强制，不靠提示词），不进对话历史；复用主会话前缀缓存（实测命中 57%→94%，写缓存 0）；答案按会话落盘，裸 `/btw` 可重开上一条。v0.1 为 host-only，暂无 client 半。
