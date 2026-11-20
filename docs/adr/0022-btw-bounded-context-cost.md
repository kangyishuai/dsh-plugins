# 0022. btw：超大会话的 bounded-context（草案）

- 状态：提议中
- 日期：2026-11-20
- 涉及：btw（0.6.2 已发成本提示；本 ADR 决定是否进一步做 bounded 模式）
- 上游：[0016](0016-btw-fork-subagent.md)（建在 fork 子代理上）

## 背景

btw 的每一次旁问都 fork 整个父会话（[0016](0016-btw-fork-subagent.md) 的路径）。这在小会话里
既便宜又保真（前缀缓存命中 57%→94%），但在**大会话**里会变成一个几十万 tokens 的单次支出：

| 父会话日志（压缩） | 形态         | 旁问 prompt tokens | 其中新增 | 命中缓存 |
| ------------------ | ------------ | ------------------ | -------- | -------- |
| ~0 MB（空）        | 冷 fork      | 114,261            | 114,261  | 0        |
| 3.3 MB             | 1 小时内用过 | 359,627            | 249,291  | 110,336  |
| 5.1 MB             | 隔约 8 小时  | 524,414            | 524,414  | 0        |
| 8.8 MB             | 隔 3 天      | 762,526            | 762,526  | 0        |

2026-11-20 的临时 `DSH_HOME` 只读探针（真实会话 + 一次真实 fork 对账）还发现：

- 固定开销约 **114K tokens**（system prompt + tools + AGENTS/技能目录），空会话也要付；
- fork 子代理的真实 prompt 与宿主 `tokenMeter.contextPressure` 的比值在 **0.75–1.2×**，
  所以 `contextPressure` 只能做量级提示，不能当精确账单；
- 缓存是否命中决定了**实际计费**：同会话近期再问可低至新增 5.5K；隔天再问基本全冷、全额计费。

0.6.2 已经交付 **Phase 1：成本提示**（阈值 250K，给 0.75–1.2 倍区间 + 上次实际值，不阻断）。
但警告只是让用户「知道贵」，**没有提供更便宜的路径**：大会话里的用户要么按原价问、要么放弃。
本 ADR 讨论是否、以及在什么护栏下提供一条 bounded 路径。

### 探针结果（2026-11-20，已通过）

临时 `DSH_HOME` + 只读探针插件（真实大会话 358，`contextPressure ≈ 668K`，一次真实 spawn 调用）：

| 检查                                                                         | 结果                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ctx.subagents.getProvider("spawn")`                                         | 存在，`inheritsParentContext: false`；capabilities `agentOptions/agentPreset/outputSchema/depthLimit` |
| `startActivation({provider:"spawn", parent, prompt:[…], delivery:"caller"})` | 成功，返回 childId；调用方提供的两段 text 材料被模型读到（回答 `ZEBRA-42`）                           |
| 子代理是否继承父会话                                                         | **否**：父会话 668K，spawn 子代理 usage 仅 **input 20,283 / output 68**（约 20K，未含父会话）         |
| 工具 guard（btw 的只读做法）                                                 | 子代理 ctx 上 `tools.guard` 可用（返回 disposer）                                                     |
| 工具/上下文依赖                                                              | 结论：可以从插件侧用 spawn 实现「bounded context = 最近 N 轮原文 + 问题」                             |

限制/未验证：spawn 子代理结果 settle 后 child session 已不可读（`sessions.get(childId)` 拿不到事件），
所以「零父上下文」由 `inheritsParentContext` + usage 对账判定，而不是读子会话日志；`agentPreset`
选择、超长 digest 的成本上限、以及答案质量的取舍仍需在实现时用单测/冒烟覆盖。

## 可选方案

1. **维持现状（只警告）**：0.6.2 已做，零质量风险；但大会话用户没有低成本选项，可能因此不敢用。
2. **只压缩旁问历史回放（replayRecords → token 预算）**：实现简单、纯本地；但父会话 prefix 才是
   大头（最多 20 条旁问历史通常只有几 K–几十 K tokens），**收益有限**，只能作为 bounded 模式的一部分。
3. **bounded-context（本草案）**：父会话超过阈值时，不再 fork 全量父会话，而是起一个 fresh 子代理，
   只带「最近 N 轮对话 + 本次问题 + 明确的裁剪说明」，把 prompt 压到可控上限。
   - 优点：成本上限可承诺；大会话不再需要为一次旁问付 50–80 万 tokens。
   - 缺点：**丢上下文、答案质量下降**；fresh 子代理不再复用父会话前缀缓存（缓存经济性反转）；
     宿主侧 provider 是否支持「fresh + 自定义材料 + caller delivery」**尚未验证**（见决定 1）。
4. **上游请求**：请 DSH 提供「fork 可裁剪边界/上下文窗口」或「不落 transcript 的一次性调用」。
   最干净，但取决于上游排期。

## 决定（提议，未实施）

**1. 不默认切换、不静默切换。** bounded 模式默认关闭；只有用户显式开启，或显式传命令参数时才用。
不允许出现「同样一条 `/btw`，有时全量、有时裁剪」而用户不知道的情况——那会让答案质量不可解释。

**2. provider 探针已通过（2026-11-20，见上）。** 宿主 base 组合同时挂载 `spawn`（fresh）与
`fork`（继承父会话）两个 provider；spawn 可从插件命令上下文调用，能携带调用方材料、支持
`delivery: "caller"` 与工具 guard，且不读父会话（668K vs ~20K usage）。因此选定 **spawn +
digest prompt** 作为 bounded 实现路径；若未来宿主提供更原生的「fork 裁剪」，应改回复用上游。

**3. 即使可用，也只做「opt-in + 有上限 + 有标记」：**

- 设置项 `boundedContext`：`off`（默认）/ `aboveThreshold`（仅当 `contextPressure` 超过阈值）；
- 阈值保守（建议 400K，远高于 0.6.2 的 250K 警告线）：bounded 只在「贵到值得牺牲上下文」时启用；
- bounded prompt 的组成固定为：**最近 N 轮原文（可配 token 预算，按 `ContentBlock[]` 传）+ 本次问题
  - 一句明确说明「上下文被裁剪，缺信息请直接说明」**；裁剪说明必须让模型知道自己在看部分上下文；
    不为 bounded 模式单独造 persona（不传 `agentPreset`，沿用父级 generation）；
- 回放旁问历史同样受 token 预算约束（方案 2 合并进来）；
- 答案墨迹里标记 `bounded`（面板 meta 与 `/btw` 结果都可见），用户能分辨这次答案来自哪种上下文；
- **不做**：把 full fork 的答案降级成 bounded、把 bounded 失败静默回退成 full（成本不可预测）。

**4. 质量护栏：** bounded 模式必须给出可验证的测试与文档——至少覆盖「问题能从最近 N 轮回答」
与「问题依赖更早上下文时应显式说不知道」两类用例；README 写清「bounded 可能答不全」，
并在设置分节里回答「什么时候值得开」。

**5. 经济性护栏：** bounded 只在父会话「大」时启用。小会话继续 full fork（缓存命中高、更保真）；
若 bounded 的 fresh prompt 本身仍会超过 full fork 的冷启动成本，则该会话直接维持 full fork + 警告。

## 影响

- **不会**改变默认行为与现有 smoke/桌面回归计数；新增路径是 opt-in。
- 需要新增：设置分节字段、bounded prompt 构造与纯逻辑单测、面板/命令 meta 标记、README/测试手册。
- 需要先做一次 provider 探针（只读、临时 `DSH_HOME`），结论无论正负都记进 `docs/runtime/` 或本 ADR 的后续。
- 若未来 DSH 开放「fork 上下文裁剪」或「插件级一次性调用」，应重新评估：方案 3 可能是过渡态，
  上游能力可用后，bounded 模式的实现应尽量复用上游而不是自己拼 messages。
- 本 ADR 不解决「如何精确预估」：0.6.2 的提示仍是量级估算；bounded 模式反而让估算变得可控（有硬上限）。

## 待办（决定后）

1. ~~provider 探针~~：已通过（2026-11-20，见上）。
2. 写 `feat(btw)` 实现：`boundedContext` 设置（默认 off）、digest 构造（最近 N 轮 + token 预算）、
   spawn 执行路径、答案 meta 标记 `bounded`、两类质量用例 + 纯逻辑单测、README/测试手册；
   按 feat 档人工合并。
3. 以 0.6.3 或 0.7.0 发布前，用真实大会话做一次 bounded vs full 的对照手测（成本与答案质量各记一组）。
