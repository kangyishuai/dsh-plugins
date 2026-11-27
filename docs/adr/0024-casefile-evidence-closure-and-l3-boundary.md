# 0024. casefile：证据-义务闭包与 L3 无人值守的边界

- 状态：已接受
- 日期：2026-11-28
- 涉及：casefile

## 背景

`casefile` 是八个发布插件里**架构取舍最多、却一条 ADR 都没有**的那个（其余七个都有 0003–0023 的记录）。它的验收语义直接决定「一句话能不能被算作已验证」，如果只散落在 `docs/testing/casefile.md` 和实现注释里，下一个人改「什么算新鲜 PASS」「L3 能自动跑到哪」时只能靠猜，很容易把一条**诚实**的约束改成「自动变绿」。

要解决两个问题：

1. **结论不能随会话消失，也不能被凭空升级。** REA 的观察很好，但它们只活在一次工具结果里。casefile 要把观察变成可引用的证据、把结论变成可导出的 claim；同时**不重新判定** REA 给的 `confidence` / `authority`——casefile 不是第二个分析引擎，它只是账本与验收层。
2. **「自动完成」必须有硬边界。** `runCycle` 能自动跑「构建 → 检查 → 关闭义务」，但无人值守地跑等于「全自动复刻」，那是明确不做的非目标。需要一个不可配置放宽的边界，写清哪些义务允许自动关闭、什么条件下才允许升到 L3。

约束：

- 不引入分析引擎、不让 casefile 自己注册 REA 的 MCP 行（会与 `rea-mcp` 冲突）；外部 agent 的报告只能「记录，不背书」。
- 破坏性动作遵循 [ADR 0002](0002-destructive-operations.md)（trash + 审计）。
- 一个实现改动后，之前「已验证」的结论必须**自动失效**，而不是靠人记得重跑。

## 可选方案

1. **方案 A：自动立即关闭义务。** 构建成功换一次退出码，就把对应义务标记为 PASS。
   - 优点：流程短，用户看到「全绿」。
   - 缺点：绿色来自「跑过一次」，不来自「验对了」。实现一变，绿仍然留着——这是本仓库最反对的那种假绿。
2. **方案 B：义务关闭需要人工点按钮。** 所有关闭都走人。
   - 优点：绝不会自动说谎。
   - 缺点：小项目的确需要一个能跑「构建→检查→关闭」闭环的最小自动化，否则每一条都要点一次，L3 也就无从谈起。
3. **方案 C（采纳）：把「关闭」绑定到具体证据。** 关闭义务必须有一条**新鲜 PASS 检查**，且检查结果绑定了**当前实现 digest**；实现 digest 一变，已关闭的义务自动回到 stale（重开），要重新过检查才能再关。L3 无人值守只在硬边界内放开这个动作。

## 决定

采用方案 C，并把边界写死：

1. **闭包语义（evidence → claim → obligation → project close）**
   - `Evidence` 保留 REA 自己的 `confidence`（observed / derived / inferred）与 `authority`（shipped-artifact / controlled-replay / live-observation / external），casefile **不重判**；`Claim` 必须引用 evidence id，`Feature` 是 claim 的作用域分组。
   - **义务关闭 = 新鲜 PASS + digest 一致。** `closeObligation` 没有 `no-fresh-check` / digest 不符时直接拒绝（`obligationTooTall`），并给出可操作 blocker，而不是「先关了再说」。`coverage`（覆盖率）与 `open-unknowns` 是独立硬门，不满足时项目 `close` 被拒。
   - **未知项随包交付。** 未解决 unknown 进 spec pack；静默丢掉 unknown 的包等于骗人。导出默认脱敏（家目录、绝对路径、常见 token 形状）。
   - **实现变了就让旧结论失效。** `case_build` 记录 64 位实现 digest；`case_check` 把结论绑定到该 digest；下一次 build 的 digest 不同 → 自动重开已关闭义务。这是「模型上下文正确、界面也正确」的那条不变量。
   - **检查新鲜度按时间 + digest 双条件。** 只按时间新鲜不够（同一 digest 才可比），只按 digest 不够（旧结论可能早于实现）。
2. **L3 无人值守的硬边界（不可配置放宽）**
   - 只有 `scope: "selected"` 的项目能升到 L3；
   - 只有 `existence` / `structure` / `behavior` / `visual` 四类义务允许自动关闭；`coverage` 与 `regression` **永远人工复核**；
   - **每条义务必须有可执行检查配方（`check`）**，否则「没人验」会被自动跑成绿灯；
   - 必须有预算上限（`maxRounds` / `maxBuilds` / `maxWallClockMs`），预算耗尽或任一轮 fail/unknown 立即停。
3. **明确非目标**：不做分析引擎、不做 DRM 规避、不自己注册 REA 的 MCP 行、不把外部报告当已验证结论（`case_ingest` 只记录 + 给出契约，`kind/status` 里保持「记录、不背书」）。

## 影响

- 「全绿」的代价是**必须先有检查、且检查绑定实现**；改实现后旧绿会消失——这正是想要的，不要在改实现后抱怨义务被重开。
- L3 不是「更强的自动完成」，它是「在选定范围内、有检查、有预算的重复劳动自动化」；`coverage` / `regression` 这两类门永远需要人。
- 外部 agent 报告可以进案卷，但它们进入的是「已记录的外部证据」层，而不是 casefile 自己的 observation 层；调用方必须自己区分。
- 以后若要加新的自动关闭义务类型，或让 L3 越过 `scope=selected`，必须**新写一条 ADR 推翻本条**，不能改实现顺手放宽——`docs/testing/casefile.md` 与实现注释里的硬规则是验收面的一部分。
- 本 ADR 只记录取舍，不改变任何接口；接口与计数见 [docs/testing/casefile.md](../testing/casefile.md)。
