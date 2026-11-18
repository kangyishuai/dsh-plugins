---
"@kangyishuai/dsh-casefile": patch
---

修掉一处会让 CI 偶发变红的测试：`slugify` 对无法拉丁化的标题（如「中文标题」）会回落到 `project-<时间戳>`，而旧断言把两次调用的结果直接比较，跨毫秒必失败。改为断言前缀与 `ID_RE` 形状。
