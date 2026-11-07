# ADR 0006：session-rewind 的架构——只追加的「回溯标记」

- 状态：已接受
- 日期：2026-11-06

## 背景

用户想在一段多轮对话里撤回最近的几轮：既不想丢掉更早的上下文（所以不能开空会话），也不想让
不想要的几轮继续占上下文。理想交互是 Claude Code 的 `/rewind`——回到某条用户消息之前，那条消息
及其后的所有内容从模型上下文与界面里消失，消息文本回到输入框可以改完重发。

DSH 的会话是 append-only 事件日志，`ctx.sessionPersistence` 明确没有删除/截断接口；`Session`
的内存日志也没有 truncate API。能改的只有**模型可见的 surface**：每条消息类事件带
`surfaceOp`，`replace` 操作可以把一段已存在的 surface 节点整体替换成新节点——`/compact`
正是用它把一段历史换成摘要。

## 决策

1. **只追加一条 marker，不删改日志。** 回溯执行时向当前会话追加一条 `user/message`，
   `surfaceOp: { op: "replace", startSeq: 目标节点, endSeq: 最后一个 surface 节点 }`，
   `sourceEventSeqs` 列出全部被遮蔽节点。目标消息及其后的一切从模型上下文里消失；日志完整保留，
   可审计、可停用插件后恢复界面显示。
2. **marker 是常量内容 `"(empty message)"`，身份放在 `source` 里。** 内容固定且非空，避免严格
   OpenAI 兼容网关拒绝空 user content；`source: { kind: "session-rewind", targetSeq }` 是它自己的
   生产者身份（会话校验只要求 `source.kind` 是非空字符串，额外字段会保留到客户端）。
   注意：客户端 Chat 只把 `surfaceOp: "append"` 的 user/message 渲染成节点，`replace` 的 marker
   不会出现在 Chat 快照里，所以 `targetSeq` 不是界面隐藏的数据来源，只作审计与前向兼容。
3. **界面用 Chat builder 的 `visibility: "hidden"`，不改渲染组件。** 客户端先向宿主查询
   `sessionRewind/cuts`（读 live session 日志里的 marker，按会话缓存），再包装已注册的 `chat`
   view builder，把落在 `[targetSeq, markerSeq]` 区间里的节点在送入 builder 前标成 hidden：
   节点仍在 store（输入框回填、轨迹面板还能读到原内容），但离开 `order`、Turn 导航与分组。
   `uiConversation.views` 与 `definition.create` 是私有 seam，安装时做形状检查，失败即整体降级为
   「上下文已截断、界面不隐藏」，卸载时还原。每个会话挂载时重新 seed 一次 cuts，保证重载/切换
   会话后依然隐藏。
4. **执行通道用 Typert Remote，不用 slash 命令。** 宿主半导出 `SessionRewindService`
   （服务名 `sessionRewind`，方法 `candidates` / `rewind` / `cuts`），客户端走
   `ctx.connection.rpc.call("/api", "sessionRewind/<method>", { args: { request } })`。
   这样 `/` 菜单里不会多出内部命令，客户端也不需要伪造一次用户发送。宿主只当天执行、只接受空闲
   会话（v1 不主动打断运行中的回合），子代理会话直接拒绝。
5. **v1 只回溯对话，不还原工作区文件。** 文件检查点（写前备份、回退时还原）是另一条独立且更重的
   产品线，需要处理外部改动、路径安全、大文件与跨重启；本插件刻意只解决上下文问题。README
   「已知限制」明示这一点，后续若做，单开 ADR。
6. **入口两处：** 空闲会话连按两次 Esc 打开候选对话框（复用 DSH 的 fixed shortcut 通道，
   运行中仍由内置「Esc Esc 停止」优先）；每条用户消息操作行的 ↶ 按钮（通过接管
   `conversation.chat.node` 的 user 渲染器，把按钮塞进官方 actions 行的 `extraActions`）。
7. **不覆盖用户正在编辑的草稿。** 回填输入框前检查当前草稿，非空则只提示、不覆盖。

## 验证（2026-11-06）

`pnpm smoke:session-rewind` 在临时 `DSH_HOME` 里用真实宿主 + ego-browser 跑了 17 项端到端断言，
全部通过：两条入口、确认框、对话截断、输入框回填、重载/切换后仍隐藏；并直接解压会话日志验证
「只追加」与 marker 的 `replace` 形状（见 [runtime 0.2.2-rc.1 §9.7](../runtime/0.2.2-rc.1.md)）。
桌面版 Electron 的原生键盘路径没有单独回归。

## 后果

- 好：日志不可破坏；实现只依赖 surface 的官方语义；同一会话内可连续回溯（每次追加一个 marker）；
  不新建会话、不切窗口；文件系统与持久化后端零写入。
- 代价：
  - `uiConversation.views` / slot ledger 的接管是**私有 seam**，DSH 升级可能失效；失效时降级为
    「上下文正确、界面不隐藏 / 按钮消失」，不破坏会话。
  - 回溯不可在界面内原地撤销；日志中内容仍在（可停用插件恢复显示，或从轨迹面板查看）。
  - marker 会作为一条 `(empty message)` 留在模型上下文的末尾；provider 无关，但用户不可见。
  - 运行中的回合不能直接回溯（v1）；需要用户先按 Esc 停止。

## 备选方案

- **fork 分支会话**：官方 `ctx.sessions.fork()` 能从任意前缀建子会话，零风险；但会话 id 变化、
  侧栏留副本，不满足「就地移除」的产品语义。DSH 已经内置「在新对话中分支」，不重复造。
- **改写日志文件**：直接重写 `session.v4.jsonl.zstd` 截断到目标前缀。日志是 append-only 铁律，
  且 live 会话、投影缓存、写句柄都要一起换，风险远大于收益，否决。
- **插件自建 conversation Definition 隐藏节点**：需要接管整条渲染链，远比包装 builder 复杂，
  且官方 builder 已内建 hidden 语义，否决。
