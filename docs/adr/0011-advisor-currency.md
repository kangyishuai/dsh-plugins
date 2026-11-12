# ADR 0011：advisor 的币种与金额口径

- 状态：已接受
- 日期：2026-11-12
- 涉及：`packages/advisor`（`@kangyishuai/dsh-advisor`）

## 背景

0.3.0 之前所有金额字段都隐含 USD：`maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd`、单价
`priceInputPerMTok` / `priceOutputPerMTok`（USD / 百万 token），账本与预算池也记 `costUsd`。
用户要求能按人民币填写预算和单价，同时金额要支持小数。

候选：

- **A. 仅显示换算**：内部继续 USD，UI 按汇率显示人民币；预算本质仍是美元。
- **B. 人民币一等公民**：设置里的金额/单价按所选币种存储；账本、预算池、守卫内部仍用 USD；
  调用时把设置金额换算成 USD，展示时再换回所选币种。
- **C. 不做币种**：只保留小数。

## 决策

采用 **B**：

1. 新增 `currency: "USD"|"CNY"` 与 `usdToCny`（1 USD = ? CNY，手动，0.1–100，默认 7.2）。
2. 金额/单价字段按 `currency` 解释：`maxCostPerDay`、`workspaceMaxCostPerDay`、
   `priceInputPerMTok`、`priceOutputPerMTok`。
3. 账本（`usage.jsonl`）、工作区预算池（`budget.json`）、`guard`/`budget` 的比较、内置参考价
   内部**始终是 USD**。`checkBudget` / `checkPool` 先用 `toUsd()` 换算限额，
   `effectivePrice()` 先把用户单价换算成 USD；展示时用 `fromUsd()` 换回。
4. 设置页切换币种时按当前汇率折算四个金额字段，再让用户保存；只改汇率不改金额。
5. 旧键 `maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd` 按 USD 自动迁移到新键；保存时写新键。
6. 内置参考价是 USD；人民币展示时按同一个汇率折算。汇率不联网获取，手动维护。
7. 历史账本/预算池不因汇率变化重写；历史 `usage` 字符串保留调用时的币种。

## 后果

- 预算/单价可以按用户直觉的币种填写；账本口径稳定，历史数据无需迁移。
- 所有金额展示都必须走 `formatMoney()`，不能再手拼 `$`；设置键重命名需要迁移。
- 手动改 JSON 时只改 `currency` 而不改金额，会改变真实预算；README 与设置页帮助里写明。
- 忘记在预算比较处 `toUsd()` 会让人民币限额被当成美元，预算闸失效；`guard`/`budget`/`catalog`
  的单测覆盖了 7.2 CNY / 7.2 汇率的边界。

## 备选

- **A**：改动小，但预算不是真正按人民币锚定；用户明确要人民币预算，故不采用。
- **C**：不满足人民币需求。
- **按账本条目存汇率**：能冻结历史人民币展示，但账本格式与迁移成本更大；当前选择“内部 USD、
  展示按当前汇率”，历史 `usage` 字符串保留调用时币种作为折中。

## 验证

- `money` / `settings`（迁移）/ `catalog`（单价换算）/ `guard`（日预算）/ `budget`（工作区池）单测。
- 客户端 `convertCurrency()` 的 USD↔CNY 往返测试。
- `pnpm verify`、web 冒烟、桌面只读回归。
- 手工：人民币设置、`/advisor preview` 单价/预算显示 `¥`、预算闸按汇率比较、切回 USD 金额折回。
