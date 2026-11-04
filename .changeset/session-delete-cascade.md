---
"@kangyishuai/dsh-session-delete": minor
---

删除确认框支持级联：通过 parentSession 血缘（任意深度）+ live 子代理活动
发现子会话，默认不删，勾选后父会话与子会话分别进入回收站（可分别恢复），
回执里记录每个子会话的结果。
