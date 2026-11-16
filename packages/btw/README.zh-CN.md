# @kangyishuai/dsh-btw

> **不打断主任务的只读旁问。**

[English](./README.md)

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的非官方插件，与 DeepSeek 官方无关。

## 做什么

`/btw <问题>` 就当前工作提一个旁问，**不打断主任务、也不进入对话历史**。

- **回合进行中可用**：命令立即派发，不排到当前回合之后（实测 215 ms，且不产生用户消息）。
- **只读**：旁问在 fork 出来的子代理里执行，**不给任何工具**；运行期 guard 会拒绝漏网的工具调用，`send_message` 永远拒绝。
- **便宜**：fork 复用主会话的提示前缀，服务端大部分走缓存（实测首次 fork 命中 57%，重复请求 94%），且不产生写缓存费用。
- **可留存**：答案写入按会话切分的 JSONL 历史，裸 `/btw` 可重新打开上一条。

## 怎么实现的

第三方 DSH 插件**拿不到带 provider adapter 的 `ctx.llm` 实例**（所有取法都返回无 adapter 的实例）。受支持的路径是 **fork 子代理**：

1. `ctx.subagents.startActivation({ provider: 'fork', parent: agent, … })` —— 父 `Agent` 来自命令调用上下文；
2. 在子代理上挂 `ctx.tools.guard(...)`，保证只读；
3. 从 activation 结果里取答案，归档子会话避免污染会话列表，并把问答追加进历史。

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-btw
```

装完重启 DSH 桌面版。

## 用法

```
/btw 刚才那个配置文件叫什么来着？
/btw                      # 重新打开上一条答案
```

## 配置

| 键             | 默认                   | 含义                                                           |
| -------------- | ---------------------- | -------------------------------------------------------------- |
| `allowedTools` | `[]`                   | 允许旁问使用的工具名。空 = 完全只读。`send_message` 永不放行。 |
| `language`     | `auto`                 | `en` / `zh`；`auto` 跟随系统语言。                             |
| `dataRoot`     | `$DSH_HOME` → `~/.dsh` | 历史文件位置（`<dataRoot>/btw/<会话>.jsonl`）。                |

## 副作用与风险

- 每次旁问**多花一次模型调用**（fork 当前对话）。
- **会创建一个子会话**并随后归档。若归档不可用，子会话会留在会话列表里 —— 答案本身不受影响。
- **会写** `<dataRoot>/btw/<父会话id>.jsonl`（每会话最多 50 条，原子替换）。**绝不**把主对话内容复制到磁盘。
- **只读是运行期强制的**，不靠提示词：旁问发起的工具调用会带着面向模型的原因被拒绝。

## 兼容性

| 插件  | 已在 DSH 上验证 |
| ----- | --------------- |
| 0.1.0 | 0.2.2-rc.3      |

底层宿主 seam（busy 时命令派发、fork 缓存复用、`tools.guard`、`workspaceRegistry.archiveSession`）已在 DSH 0.2.2-rc.3 上实测。**插件本身尚未安装进真实 profile 跑过** —— 这一步端到端验证仍待完成。

## 许可证

MIT
