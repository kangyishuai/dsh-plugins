# ADR 0009：next-step —— 一个包两个面，状态属于会话数据

- 状态：已接受
- 日期：2026-11-10

## 背景

目标是在 DSH 里做两件相关的事：

- **A｜决策卡**：一轮回答正常结束后，在回答下方给一张卡片——一段现状摘要、一句提问、两条方向互斥的建议；点任意一条，就把该条文本当作**用户消息**发出。
- **B｜幽灵提示**：输入框为空时，框内给一条灰色下一条 prompt 建议；`Tab`/`→` 接受成可编辑文本，`Enter` 才发送。

生态调研（2026-11-09/10，90 个同区域项目 + 5 个 A 类实现）显示：B 已经饱和（15 个实现、头部 30 天 3.5k 下载），A 有 5 个实现但都缺「摘要 + 提问 + 恰好两条互斥动作 + 严格门控」的组合；宿主还有 opt-in 的 `dsh-action-cards`（主模型通过 `propose_action` 工具出卡，卡片动词不是发文本）。

另一个关键事实：用户提供的参照实现（Claude 桌面版）里，点击按钮后**卡片还在、按钮消失、点击文本变成一条右侧用户消息**，往上滚还能看到更早的卡片——说明卡片状态属于**会话数据**，不是界面层的浮层。

## 决策

1. **一个包，两个可独立开关的面。** `card`（默认开）与 `ghost`（默认关）共用一个包 `@kangyishuai/dsh-next-step`，共享触发点、一次模型调用、设置与预算。理由：两者的触发时刻相同（轮末）、产物同源（同一次补全）、必须互斥（卡在时不显示幽灵）；拆两个包会重复一遍触发/调用/开关，并把「互斥」变成跨插件协调，且仓库硬性要求每个带 client 半的包各有一份桌面冒烟。
2. **一次调用产出三个结果。** 同一次补全返回 `{summary, question, options[2], nextPrompt}`：卡片用前三个，幽灵提示用最后一个。相邻生态的成熟做法（Open WebUI 把 `followUps[0]` 直接当输入框灰字候选）证明这样省一半 token。
3. **状态属于会话数据：插件记录 + 会话投影。** 卡片与决策分别用 `appendPluginRecord(session, "plugin:next-step/card" | "plugin:next-step/decision", data)` 写进会话日志；host 半注册 `ctx.sessionProjections.register({key:"nextStep", …})`，客户端用 `useProjection("nextStep")` 读。刷新、切会话、fork 之后状态都还在；「点击后卡片保留、按钮消失」不再是界面技巧，而是记录了 `phase: "sent"` 的自然结果。
4. **卡片是对话的一部分，不是浮层。** 渲染在 `conversation.chat.turnTail`（宿主官方 slot，官方 action-cards/plan/deliverables/schedule 都用它），位置天然在回答正文与消息操作行之间。历史轮次的卡片**保留但只读**；任何时刻最多一张可交互卡（只对最后一轮渲染胶囊）。这复刻了 Claude 的行为，也避免「两张卡叠放」。
5. **点击 = 用户消息，走宿主输入框。** `setDraft(text)` → 轮询等编辑器草稿落定 → `submit()`（内部 `mode: "queue"`，与手动回车同一条提交链）。不伪造会话事件。发送前的决策记录让界面立即进入只读态；草稿非空时禁用胶囊（`setDraft` 是整篇替换，会覆盖用户正在打的字）。
6. **严格门控。** 只在 `turn/end` 且 `reason.kind === "completed"` 时生成；Stop/报错/`max-tokens`/待审批一律不出卡；子代理会话不出卡；流式期间宿主本来就不渲染 turnTail 节点。官方 action-cards 只判「有没有最终文本」，会在 `max-tokens` 后误出卡——这里做对，是产品可信度上的差异点。
7. **开关 = 不再发请求，而不是隐藏 UI。** 设置在 `$DSH_HOME/next-step.settings.json`，host 每次生成前重读（1s 缓存），所以改文件即生效、不需要重启；`enabled=false` 时在发请求之前就返回。另有 `pauseUntil`、`maxCardsPerSession` 预算闸与超时（默认 20s）、失败静默。
8. **幽灵提示默认关。** 它必须 portal 进编辑器位置盒、复用宿主 placeholder 的 class 才能保证同基线同字号——这是私有 DOM 依赖，宿主升级会静默失效。把它做成默认关闭的 flag，失败时只是没有提示。

## 备选方案

- **两个包**：见决策 1。除非 B 要单独面向市场（它已饱和），否则不值得。
- **纯客户端状态**：实现最简单，但刷新即失忆，且「点击后卡片还在」只能维持到下一次重渲染，直接违背用户要的持久效果。
- **让主模型调工具出卡（官方 `propose_action` 路线）**：零额外请求是优点，但依赖主模型配合，模型不调就没有卡；且卡片动词语义与「点一条=发一句话」不同。保留为后续可选项（可复用官方卡基建），不在 v1。
- **主模型直接沿用官方投影**：`dsh-action-cards` 只在 opt-in bundle 里，不能假定启用；插件自带一套投影更可控。

## 后果

- 好：状态可审计（谁在什么上下文下被建议了什么、选了哪条），可随会话 fork；客户端不需要轮询或内存态；两个面对外的成本与开关只有一个入口。
- 代价：
  - 依赖三条私有 seam：`conversation.chat.turnTail`、`ctx.sessionProjections.register`、composer facade 的 `setDraft`/`submit`（外加幽灵提示的 `conversation.input.overlay` + placeholder DOM）。升级 DSH 可能静默失效；`pnpm probe:runtime` 需要跟进体检项。
  - 每次触发多一次真实模型调用，占用用户额度；`max-tokens`、限流、超时都必须静默降级。
  - 插件记录会随会话增长（每轮最多一条），`maxCardsPerSession` 只限制生成数量。

## 验证

见 [docs/testing/next-step.md](../../docs/testing/next-step.md)：单测（提示词/解析/设置）+ web 冒烟（临时 `DSH_HOME`、真实宿主）+ 桌面 CDP 只读冒烟（硬性要求）。
