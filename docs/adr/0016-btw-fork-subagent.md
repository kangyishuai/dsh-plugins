# 0016. btw：建在 fork 子代理上，而不是直接调用 llm

- 状态：已接受
- 日期：2026-11-16
- 涉及：btw

## 背景

需要「不打断主任务的只读旁问」：用户在 agent 跑长任务时问一句，答案只基于已有上下文、不进对话历史、不消耗太多 token。

Claude Code 的做法是主进程内一次单轮只读调用 + `skipTranscript:true`。在 DSH 里，这条路的**前提不成立**：第三方插件拿不到带 provider adapter 的 `llm` 实例。

实测记录（DSH 0.2.2-rc.3，六种取法全部失败）：

| 取法                                       | 结果                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `inject:['llm']` + `ctx.llm.stream()`      | `cannot get required service "llm" in inactive context`              |
| `apply()` 里同步捕获 `ctx.llm`             | `NO_ADAPTER: no adapter registered for provider "deepseek-official"` |
| 监听器里的 `this`（发射事件的 LlmRuntime） | `NO_ADAPTER`                                                         |
| `agent.ctx.llm` / `agent.ctx.get('llm')`   | `NO_ADAPTER`                                                         |
| `ctx.get('llm')` + `prepareCall()`         | `NO_ADAPTER`                                                         |
| `ctx.agents.get(sessionId)`                | 返回 `undefined`（拿不到真实 Agent）                                 |

微诊断结论：`ctx.llm` 每次访问返回新的服务代理，`adapters` 恒为空；provider 目录共享，adapter 表是实例私有的。

## 可选方案

1. **直连 `ctx.llm.stream`**：最贴近 Claude 语义、能真正做到「完全不落盘」。但第三方插件拿不到 adapter，实测不可用。
2. **fork 子代理 + 执行期工具 guard**：`ctx.subagents.startActivation({ provider:'fork', parent })`，在子代理 ctx 上挂 `ctx.tools.guard` 保证只读。代价是产生真子会话。
3. **插件内直接发 provider HTTP**：绕过宿主抽象，自建凭据与重试，弃。

## 决定

选方案 2。理由：

- 这是唯一在第三方插件里**跑通**的路径（真机冒烟端到端验证：`status=done`）；
- **成本更低**：fork 复用主会话前缀缓存，实测首次命中 57%、重复 94%，端到端实测 8960/10597 ≈ **84.5%**，且 DeepSeek 的上下文缓存**不另收写缓存费**（`cacheWriteTokens` 恒为 0），比 Anthropic 的 1.25× 写缓存更便宜。

## 影响

- 旁问会产生**真子会话**（有自己的日志与会话列表条目）→ 实现里在结束后调用 `ctx.workspaceRegistry.archiveSession(childId, { stopActivity: true })` 归档；归档失败不影响答案，README 已说明可能留下子会话。
- 「不进对话历史」语义**降级**为「进独立子会话、主会话不引用」，与 Claude 终端浮层不同，README 必须写清。
- 真实 `Agent` 只能从**调用上下文**取（命令 `invocation.agent` / 工具 `exec.agent`），`ctx.agents.get()` 不可用；这条写进了插件注释，避免以后有人改回去。
- 若将来 DSH 开放「插件级 llm adapter」或「不落 transcript 的一次性调用」，可回到方案 1，届时本 ADR 需要更新。
