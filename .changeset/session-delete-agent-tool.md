---
"@kangyishuai/dsh-session-delete": minor
---

新增模型工具 session_delete：两段式 plan → 一次性 token → delete。
拒绝删除调用者自己的会话；会话在预览后变化会让 token 失效；回执记录
operator=agent，便于区分人工与模型操作。
