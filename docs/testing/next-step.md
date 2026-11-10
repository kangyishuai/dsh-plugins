# next-step 测试清单

> 目的：证明四件事——**卡片确实出现在完整回答之后**、**点胶囊确实按「用户消息」发出**、
> **状态只来自会话日志且刷新/切会话后一致**、**关掉开关后真的不再请求模型**。
> 三层：**单测 → web 端到端冒烟 → 桌面只读回归 + 手工 GUI 验证**。
> 前两层每次提交都跑；第三层发版、DSH 升级、以及改动客户端私有 seam 后必须跑。

## 0. 测试环境

next-step 会**真的调一次模型**：没有模型凭据时卡片不会出现，那属于「静默失败」而不是 bug。
冒烟与手工验证都会消耗 provider 额度，也会往会话日志里写插件记录，所以一律在临时 `DSH_HOME` 里跑：

```bash
# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/next-step && pnpm pack --pack-destination /tmp

# 2) 隔离 home：复制 profile + 会话 + 存储
H=/tmp/dsh-test-next-step
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/ns
cp -R ~/.dsh/sessions $H/sessions
cp -R ~/.dsh/storages $H/storages
DSH_HOME=$H dsh plugin --profile ns install
DSH_HOME=$H dsh plugin --profile ns add /tmp/kangyishuai-dsh-next-step-*.tgz

# 3) 启动（端口 0 = 随机，--no-open 不弹浏览器）
DSH_HOME=$H dsh --profile ns --port 0 --no-open
```

**观测点**（出不出卡、有没有真的发请求，都对照这里，而不是只看界面）：

| 位置                                             | 看什么                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `$H/sessions/<projectKey>/<sessionId>/` 会话日志 | 有没有新的 `plugin:next-step/card` / `plugin:next-step/decision` 记录 |
| 会话日志里的 `user/message` 事件                 | 点胶囊后是否**恰好**多一条正常用户消息，文本等于胶囊背后的完整指令    |
| 插件诊断（`diagnostics`）                        | 生成次数、失败/超时/限流计数；关开关后计数应停住                      |

## 0.5 验证记录（2026-11-10，DSH 0.2.2-rc.1）

| 层                     | 结果                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test`（包内）  | 67 pass / 0 fail（settings 29 + prompt 38）                                                                                                                                                                                                                                                                                                                            |
| `pnpm probe:runtime`   | 60/60 PASS（含 8 条 next-step seam + 2 条 slot）                                                                                                                                                                                                                                                                                                                       |
| `pnpm smoke:next-step` | **37/37 PASS**（连跑两次可复现；临时 `DSH_HOME`、真实宿主、真实模型调用〔3 轮对话 + 2 次卡片生成〕，耗时约 93s）：投影健康、答后出卡、两粒胶囊、stance 互斥、点胶囊发送用户消息（文本 = `option.text` ≠ `label`）、点后胶囊消失且卡片保留为只读、只读态保留摘要与提问、刷新后仍只读、关开关后不再出卡；日志侧独立复核 `plugin:next-step/card` 与 `phase=sent` 记录形状 |
| 桌面真机回归           | **待跑**：需要 `pnpm pack` → `dsh plugin --profile <profile> add <tgz>` → 重启桌面版，再跑 `pnpm smoke:next-step-desktop --require`；本机验证时插件未装进正在使用的 profile，未重启用户的桌面版                                                                                                                                                                        |

本轮踩到的两个**真 bug**（都属"静默失效"，值得记住）：

1. **投影缺 `stateSchema` / `wire.viewSchema` 会让整条会话历史加载失败**（页面「历史加载失败」、卡片永不渲染，但发消息与日志都正常）。注册表在读取路径上无条件 `parse`，注册时却不校验。修法：给恒等桩 `{ parse: (v) => v }`，详见 [runtime 0.2.2-rc.1 §9.14](../runtime/0.2.2-rc.1.md)。
2. **macOS `/var` 是 `/private/var` 的软链**：冒烟里把未 realpath 的工作区路径写进 `workspace.json`，宿主校验失败 → 新会话 `session/workspace-attach-failed`，表现为"模型没权限"。脚本必须 `realpath`。

## 1. 单测（每次提交）

```bash
cd packages/next-step && pnpm test   # node --test
pnpm verify                          # 仓库门禁（含单测、规范、文档一致性）
```

应覆盖的范围（与 `lib/`、`test/` 同步维护）：

| 主题             | 要证明的事                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输出校验         | 严格 JSON 解析；恰好 2 条 option、`stance` 必须不同、`label` ≤ 20 字、`text` 非空；不合法输出直接丢弃、不写 card 记录（最多重试 1 次）。                                   |
| 触发门           | 只认 `turn/end` 且 `reason.kind === "completed"`；`enabled` / `card` 关上、暂停、该会话卡片数到 `maxCardsPerSession` 都不生成；同一 turn 已有 card 或 decision 不重复。    |
| 子代理与会话状态 | `origin === "subagent"` 或 `delegationDepth > 0` 的会话跳过；会话不 live 时跳过。                                                                                          |
| 投影折叠         | card + decision 记录折叠成 `{ cards, decisions }`；`turn` 是 key；旧卡未决策时按「被新卡取代」推导只读（不另入库）。                                                       |
| RPC              | `act` 返回 `stale` / `missing` / `disabled` / `error` 的优先级；`act` 只写 decision 并回 `text`，**不发送**；`dismiss`、`settings`、`updateSettings`、`diagnostics` 形状。 |
| 设置默认值       | `card` 默认开、`ghost` 默认关、全局默认开；`updateSettings` 的 patch 合并语义。                                                                                            |
| 客户端纯函数     | 只对最后一轮渲染可交互卡；有 decision 即只读；ghost 显示条件（ghost 开、草稿空、无附件/`@`/`/`、`phase === "plain"`、空闲）；草稿非空时胶囊禁用。                          |

**没覆盖**：真实宿主槽位、真实 Electron 渲染进程、真实的 `setDraft` → `submit` 时序。所以下面两层不能省。

## 1.5 一条命令跑完门禁（发版前）

`scripts/gate.mjs` 是通用的：`pnpm gate next-step` 会按「便宜的先跑」依次跑
`pnpm verify` → `pnpm probe:runtime` → `pnpm smoke:next-step` → 桌面只读回归（**永远带 `--require`**），
加 `--deep` 再跑桌面发送链 e2e。任何一步失败立刻停并给出下一步提示；只有显式 `--skip-desktop`
才跳桌面端，且结束时会明确打印「门禁不完整」。

## 2. web 端到端冒烟（每次提交，改 client 后必跑）

```bash
pnpm smoke:next-step
```

在临时 `DSH_HOME` 里启动真实宿主 + ego-browser，用真实模型走完整链路。断言应覆盖：

| 分组        | 断言                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 出卡        | 发一条能正常结束的提问 → 等 `turn/end` → 最后一条回答下方出现卡片（摘要 + 提问 + 两粒胶囊）；胶囊标签非空且互不相同。                                                |
| 卡片结构    | 摘要超过两行时出现「展开 / 收起」，点击只影响摘要显示；卡片不抢焦点（`document.activeElement` 不因渲染改变）。                                                       |
| 点胶囊      | 点第一粒 → 草稿先被写入再提交（与手动回车同一条链）→ 会话日志**恰好**多一条 `user/message`，文本 === 该胶囊的完整 `text`。                                           |
| 变只读      | 点击后卡片保留、胶囊消失、摘要与提问仍在；更早的卡不可点；`sent` 态可能多一行「已发出」灰字。                                                                        |
| 日志形状    | 解压会话日志：card 记录字段齐全（`turn` / `summary` / `question` / `options[2]` / `nextPrompt` / `model`），点击后有对应 decision 记录；卡片记录不是伪造的用户消息。 |
| 持久化      | 刷新页面 → 卡片与只读态仍在；切走会话再切回 → 同上；重开（或重载）后仍一致。                                                                                         |
| 收起 / 关闭 | 点 ✕ → decision 写入、卡片转只读、不发送；全局开关关闭后完成一轮 → **不新增 card 记录、诊断生成计数不增**（证明不是只隐藏 UI）。                                     |
| 预算 / 暂停 | 暂停或达到每会话预算后再完成一轮 → 不新增卡片，已有卡片仍可读。                                                                                                      |
| 草稿保护    | 输入框有草稿时胶囊禁用，点击不发送、草稿不被覆盖。                                                                                                                   |
| 幽灵提示    | 开 ghost → 空且空闲的输入框出现最新卡的 `nextPrompt`；`Tab` / `→` 接受进草稿且 `Ctrl+Z` 可撤销；输入字符后消失；`Esc` 清除；草稿非空/有附件/有 `@`/有 `/` 时不显示。 |
| 不发误消息  | 幽灵提示可见时按 Enter 不会发出任何消息（提示不在草稿里）。                                                                                                          |
| 子代理      | 子代理会话完成一轮 → 不出卡。                                                                                                                                        |
| 失败静默    | 伪造/诱导不合法 JSON（或断开模型）→ 不出卡、不弹错误框、只增诊断计数（可 mock 时在单测覆盖，冒烟按可操作性取舍）。                                                   |

失败时的截图与断言明细写进 `/tmp/dsh-next-step-smoke-shots/`（临时 home 里可能有真实会话内容，**不要提交**）。

## 3. 桌面只读回归（有 client 半，硬性要求）

```bash
# 1) 带调试端口重启桌面版（验证完正常重启一次即可关闭端口）
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 2) 跑
pnpm smoke:next-step-desktop --require
```

默认**只读**：只切会话、开关卡片、展开/收起、点 ✕、开关设置，不点胶囊、不发模型请求，可以直接跑在真实 profile 上。
断言应覆盖：CDP 连上页面 → 插件 client 半已加载（`style[data-plugin]`）→ 找到最后一段完整回答 →
卡片渲染在回答下方 → 摘要/提问文案非空 → 展开/收起可切换 → ✕ 后转只读（另有 decision 记录）→
刷新后仍只读 → 设置里能开关 card / ghost、暂停、预算 → 全程不抢焦点、不写草稿。

**发版门禁要加 `--require`**：连不上端口时默认是 SKIP（exit 0，适合日常随手跑），加 `--require` 则判为 FAIL（exit 1）——避免「没跑也说通过」。

### `--deep`：真正发出一次（会消耗额度）

`--deep` 才做有副作用的链路：由脚本在一个专用测试会话里让模型完成一轮 → 点胶囊 → 断言草稿被写入后发出、
会话多一条用户消息、卡片转只读、刷新后仍只读。它会消耗一次模型额度并往该会话写记录，所以
默认不跑，且不应在正在跑本 agent 的会话里跑（会打断当前回合）。

```bash
pnpm smoke:next-step-desktop -- --require --deep
```

## 4. 手工 GUI 验证步骤（发版、DSH 升级、改私有 seam 后）

按顺序做一遍，每步都对照「期望」；步骤里的 `$H` 用上一节的临时 `DSH_HOME`：

1. **装包**：`cd packages/next-step && pnpm pack --pack-destination /tmp`，然后
   `DSH_HOME=$H dsh plugin --profile ns add /tmp/kangyishuai-dsh-next-step-*.tgz`。
2. **重启桌面版**（host 半）并**刷新页面**（client 半）：侧栏/会话区正常，插件已激活，无报错。
3. 打开一个空闲会话，**发一条会正常结束的提问**（例如让它解释一个小概念）。
4. **观察卡片**：回答下方出现卡片——摘要、提问、两粒胶囊；摘要过长时可展开/收起；卡片不抢焦点、不改变输入框。
5. **点胶囊**：点其中一粒 → 该胶囊背后的完整文本作为**用户消息**出现在对话里并正常触发下一轮；卡片保留、胶囊消失、变只读（`sent` 态可能多一行「已发出」）。
6. **再次刷新**：卡片仍在且仍只读；切换会话再切回也一样；更早的卡只读。
7. **关开关**：在插件设置里关闭 card 面，再完成一轮 → **不再出卡**；查看诊断，生成计数不再增加（证明请求真的停了）。重新打开开关，下一轮恢复出卡。
8. **暂停 / 预算**：暂停后再完成一轮 → 不出新卡；已有卡片仍可读。恢复暂停。
9. **草稿保护**：先在输入框里留一段草稿，再让本轮结束 → 卡片可显示，但胶囊禁用；hover 提示先清空输入框；清空草稿后胶囊恢复可点。
10. **幽灵提示（ghost）**：打开 ghost 面，清空输入框并让它空闲 → 灰色提示出现（与 placeholder 对齐、单行省略）；`Tab` 或 `→` 接受进草稿（可撤销）；输入第一个字符后消失且 2 秒内不闪回；`Esc` 清除本次建议；有草稿/附件/`@`/`/` 时不出现；提示可见时按 Enter 不会误发。
11. **子代理**：在子代理会话里完成一轮 → 不出卡。
12. **升级回归**：升级 DSH 后重跑第 4–10 步；卡片不出、胶囊点了没反应、或幽灵提示消失，多半是宿主私有 seam 变了——先看诊断，再对照[第 5 节](#5-dsh-升级时要重点看的宿主事实)核对。

## 5. DSH 升级时要重点看的宿主事实

1. `conversation.chat.turnTail` 槽位是否还在、props 是否仍是 `{ turn, seq, openFile, t }`，以及
   `turn/end` 不存在时宿主是否仍不渲染该槽（流式中不出卡依赖这一点）；
2. `ctx.sessionProjections.register` 与客户端 `useProjection("nextStep")` 的注册/读取形状是否还一致
   （这是刷新、切会话后状态还在的唯一来源）；
3. `conversation.input.shell(sessionId).actions` 的 `setDraft` / `submit` 是否还在，以及
   `submit` 仍固定 `queue` 模式、`setDraft` 之后需要等草稿落定（同一 tick 连调会发空消息）；
4. `conversation.input.overlay` 与宿主 placeholder 的 class/内联样式是否还在（幽灵提示的渲染与对齐依赖它）；
5. `ctx.on("session/event")` 的 `turn/end` 事件形状（`reason.kind === "completed"`）与
   `appendPluginRecord` 的记录格式；
6. `ctx.get("llm")` 的 `prepareCall` / `call.stream` 形状，以及
   `ctx.get("agents").get(sessionId)?.model?.current?.()` 的读取方式。
