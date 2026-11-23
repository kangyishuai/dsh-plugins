---
"@kangyishuai/dsh-projects": minor
---

本地优势 + 设置 + 记忆（B3）：记忆碎片（`MEMORY.md` 索引 + 独立 `.md`，可预览、可逐条 forget）；instructions 16k 预算与宿主 `dsh-agent-instructions` 去重（重复段落省略并在注入里注明）；`<project-context>` 注入包裹标签与「这是项目记忆，不是 AGENTS.md」的显式说明；goal 上限 8,000 + 计数；预算默认值（日线程 20 / 并发 2 / 步数 60 / token 不限）与设置项；**暂停语义修正**（暂停不再中断上下文注入，只停新建线程）；设置页四分区（General/Memory/Usage/Debug access），Usage 只报 token 与上下文占用、**不显示金额**；按项目的通知开关（失败/等你/完成，完成默认关）；`gh` 只读连接检查（未装/未登录/缺 scope 都给出可操作提示）；项目模板受管 AGENTS.md 区块（幂等、不覆盖用户内容）；线程重命名与 `@` 候选 RPC；生命周期验证补 19 条单测与 15 条 web 冒烟断言。
