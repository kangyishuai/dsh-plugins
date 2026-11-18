---
"@kangyishuai/dsh-casefile": minor
---

**采集边界与外部生产者记录（A 方案）**

- 证据新增 `producer`：工具、版本、获取方式（`headful` / `headless` / `api` / `archive` / `manual` / `stealth` / `unknown`）、产物类型、`accessConfirmedByUser` 与说明。casefile 不采集内容，只摄入并记录生产者——所以任何外部工具（REA、Scrapling、代理 HAR、手动截图）的产物都能喂进来。
- 规格包与验收报告都带生产者信息；报告新增「证据生产者」表，并声明采集方式由操作者选择与执行、责任归操作者。
- `DISCLAIMER.md` 改写为三段式采集边界：Tier 1 直接支持（人类等价浏览 / 官方 API / 公开归档 / 摄入外部产物）；Tier 2 需明示确认并只记录（自己的会话、标为 `stealth` 的方式）；Tier 3 完全不提供（打码、指纹伪造、代理轮换、高频批量抓取），且明确「把手段挪到别的工具里，性质不变」。
