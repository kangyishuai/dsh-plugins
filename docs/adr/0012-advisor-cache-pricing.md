# ADR 0012：advisor 的缓存 token 计价

- 状态：已接受
- 日期：2026-11-12
- 涉及：`packages/advisor`（`@kangyishuai/dsh-advisor`）

## 背景

DSH 的 `call.usage` 里有 `cacheReadTokens` / `cacheWriteTokens`，两者都是**输入侧**的缓存 token；
没有缓存输出 token。真实账本已经出现过 `173 in / 512 cache read / 34 out` 的记录：`inputTokens`
不包含缓存读取 token，成本公式却只乘输入/输出单价，导致 512 个缓存 token 完全没有计价。

用户要求补缓存输入/输出价格配置。由于宿主没有缓存输出 token，实际可配置的是**缓存读取**和
**缓存写入**两个输入侧单价。另一个相关问题是两阶段取证的第二轮 `extraUsage` 在成本计算之后才合并，
第二轮 token 会被少算。

## 决策

1. 新增 `priceCacheReadPerMTok` / `priceCacheWritePerMTok`，跟随 `currency`，内部换算 USD。
2. 缓存 token 是**额外**的输入 token，不从 `inputTokens` 扣；成本公式：
   `input × 输入价 + output × 输出价 + cacheRead × 缓存读取价 + cacheWrite × 缓存写入价`。
3. 两个缓存单价默认 `0`：**0 = 不计缓存部分**，不偷偷回落到输入价。账本里有缓存 token 但两个
   单价都是 0 时，顾问线/状态区提示「缓存未计价」，避免静默少算。
4. 内置参考价表只有输入/输出价，没有缓存价；内置价不猜缓存，缓存价只来自用户设置。
5. 账本补记 `cacheWriteTokens`（之前只记 `cacheReadTokens`），累计数也累计缓存读/写 token。
6. 两阶段取证的 `extraUsage` 合并后，用合并后的 token 重算成本、usage 行和工作区池记账；
   调用计数与成本只记一次，不再只记第一轮。

## 后果

- 有缓存 token 的调用在配置缓存单价后能正确计入预算/账本；未配置时保持原有口径，但会提示未计价。
- 缓存价与输入/输出价分开配置，人民币切换时一起折算。
- 账本历史记录没有 `cacheWriteTokens` 时按 0 处理；旧记录的成本不会被重算。
- 两阶段调用的成本、池计数和展示 token 会变多（这是修正，不是回归）。

## 备选

- **缓存价 0 时回落输入价**：能避免少算，但会改变未配置用户的既有成本口径，且缓存读取通常更便宜；
  需要用户显式配置，故不采用。
- **不记录缓存写 token**：会继续丢失缓存写入成本；不采用。
- **按 provider 判断缓存 token 是否已包含在 inputTokens 里**：当前宿主 usage 的实测语义是额外 token，
  再按 provider 分支会增加复杂度；不采用。

## 验证

- `estimateCostUsd`：输入 + 输出 + 缓存读/写；缓存价 0 不计。
- `effectivePrice`：缓存价只来自用户设置，内置价不猜；CNY 折算。
- `settings` 归一化、客户端币种切换、locale 一致性。
- 桌面/web 冒烟；真实账本中的缓存 token 在配置后出现在顾问线并计入成本。
