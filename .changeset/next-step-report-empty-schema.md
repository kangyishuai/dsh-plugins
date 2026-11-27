---
"@kangyishuai/dsh-next-step": patch
---

复盘报表把 `schema` 失败拆成「模型返回空文本」（`json:empty`）与「非空格式失败」：`schemaShare` 只算后者，新增 `emptyShare`，判读新增 `empty-generations`（空输出属 provider / 输出长度问题，不是「解析要放宽」；同一请求重发实测只救回 2/81）。补生成不再被已 superseded 的在途生成挡住（异回合 / 已被取代时先取消再生成），旧卡折叠首句补上英文句号切句。
