# advisor 测试清单

> 目的：证明三件事——**只有主模型真的征询时才产生模型调用**、**账本与四级预算真的记在账上、到顶会停**、
> **客户端只读面（`/advisor` 选择器、`status`、`doctor`）在真实 Electron 里不崩、不误发、不误记**。
> 四层：**单测 → web 端到端冒烟 → 桌面只读回归 → 手工 GUI 验证**。前三层每次提交都跑（web 冒烟不花 token）；
> 最后一层在发版、DSH 升级、以及改动客户端私有 seam（`commandUi.decorate`）后必须跑。
>
> web 端到端冒烟见 [§2](#2-web-端到端冒烟pnpm-smokeadvisor)。

## 0. 测试环境

advisor 会**真的调一次模型**（`shadow` 模式也一样会调），并且会把会话内容发送给顾问 provider。
所以除了单测，所有验证都必须在临时 `DSH_HOME` 里跑，并先确认顾问路由是本地网关或你愿意接收数据的 provider：

```bash
# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/advisor && pnpm pack --pack-destination /tmp

# 2) 隔离 home：复制 profile + 会话 + 存储
H=/tmp/dsh-test-advisor
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/ad
cp -R ~/.dsh/sessions $H/sessions
cp -R ~/.dsh/storages $H/storages
DSH_HOME=$H dsh plugin --profile ad install
DSH_HOME=$H dsh plugin --profile ad add /tmp/kangyishuai-dsh-advisor-*.tgz

# 3) 启动（端口 0 = 随机，--no-open 不弹浏览器）
DSH_HOME=$H dsh --profile ad --port 0 --no-open
```

**观测点**（"有没有花钱"、"为什么没问"都以这里为准，而不是只看界面）：

| 位置                                             | 看什么                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `$H/advisor.settings.json`                       | 插件设置：`mode` / `provider` / `model` / 预算 / 隐私档位（改文件即生效）                    |
| `$H/advisor/usage.jsonl`                         | 账本，一次征询一行：`trigger`（`tool`/`shadow`/`manual`）、`verdict`、token、`costUsd`、`ms` |
| 会话日志 `$H/sessions/<projectKey>/<sessionId>/` | `tool/call` + `tool/result`（工具路线的征询）；`session/event` 里没有额外 usage              |
| 工具卡 / `/advisor status`                       | 本次结论（`reviewed`/`declined`/`unavailable`/`skipped`）+ 累计 token + 最近一次跳过原因     |

数据根优先级：`config.dataRoot` > `$DSH_HOME` > `~/.dsh`（所以上面的 `H` 变量就是它）。

## 0.5 当前核查记录（2026-11-12，DSH 0.2.2-rc.2）

| 层                                         | 结果                                                                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test`（`packages/advisor`）        | **115 pass / 0 fail**（adoption / anchors / catalog / client / guard / locale-parity / money / prompt / redact / route / settings / tool-schema / trace / transcript / twopass / verifier）                           |
| `pnpm probe:runtime`                       | **67/67 PASS**（含 advisor 的 7 条 seam：`resolveModelInfo` / `prepareCall+configure` / `UNSUPPORTED_REASONING_EFFORT` / usage 分片 / `commands.register` / `commandUi.decorate` / `popupSelect`）                    |
| `pnpm smoke:advisor-desktop --require`     | **19 PASS + 1 SKIP（20 项；真机 DSH 桌面版 0.2.2-rc.2，冷启动实测）**：插件加载、选择器、设置卡（含「读到的是展开后快照」这条回归断言）、分页 `status`/`doctor`（读会话日志）、收尾清理。`--advice` 再加 4 项共 24 项 |
| 真机征询（`pnpm pack` → `add` → 手动征询） | **已完成**（2026-11-14 用 0.6.0 发布版补做，过程与证据见下面的 0.6.0 小节）                                                                                                                                           |

## 0.6.2 在 0.2.2-rc.5 上的复核记录（2026-11-19，DSH 0.2.2-rc.5）

插件代码没有改动；这一版只验证「升级后仍然成立」。rc.5 新增的宿主面（`CONTENT_REFUSED` 失败码、搜索提供方默认路由）与 advisor 无关：插件不解析失败码、不注册搜索提供方（[runtime rc.5](../runtime/0.2.2-rc.5.md) §1.2）。

| 层                                         | 结果                                                     |
| ------------------------------------------ | -------------------------------------------------------- |
| `node --test`（包内）                      | **143 pass / 0 fail**                                    |
| `pnpm verify`                              | 通过                                                     |
| `pnpm probe:runtime`                       | **72/72 PASS**                                           |
| `pnpm smoke:advisor`（web，临时 DSH home） | **15/15**，账本 0（不发起模型调用）                      |
| `pnpm smoke:advisor-desktop --require`     | **19 PASS + 1 SKIP**，0 FAIL（SKIP：本会话没有顾问记录） |

**前置踩坑**：第一次跑桌面回归时，可见会话还是 agent 自己那个「有运行中回合」的会话，脚本按设计拒绝敲键盘（`FAIL 当前会话空闲` + 13 条 SKIP）。切到一个**空闲会话**再跑即 19 PASS + 1 SKIP——切换只换视图，不会中断正在跑的回合。

**web 冒烟的弹窗竞态（2026-11-20 修）**：`npm smoke:advisor` 在 11:00 左右突然从 14/14 变成 5 项 FAIL（斜杠菜单空、设置 `no-settings`），复跑仍红。排查确认**不是插件/宿主变化**：首启「预览版说明」比脚本第一次点击晚一拍出现，盖住输入框后所有键盘/点击断言都打偏。脚本原来只点一次「继续」，现在改成 `dismissNotice()` 轮询到弹窗真正消失（并单独断言，14 → 15 项）；斜杠菜单断言也留了一次不降低断言的重试。这与同一天修的索引冒烟是**同一类**竞态（见 [runtime rc.5 §6.4](../runtime/0.2.2-rc.5.md#64-索引源冒烟smokeindex的两个环境假设)）。

结论：**rc.5 上 advisor 无回归**。

## 0.6.3 审计修复批次（2026-11-28，DSH 0.2.2-rc.5）

这批只动 host 半（钱/预算/决策日志/脱敏）与纯函数，没有改 client 模板；对应审计 AUD-ADV-01～15 的
「建议方向」。逐条修法与证据：

| issue  | 修法                                                                                                                                                            | 守护它的单测                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ADV-01 | usage/advice/decisions 改为单行 `O_APPEND` 追加 + 按文件串行写队列；outcome 回填是「唯一 tmp + rename」原子重写                                                 | `fs-atomic.test.js`、`ledger.test.js`「并发 record 不丢行」、`decisions.test.js`「并发回填」     |
| ADV-02 | 工作区池 `add` 读-改-写进 per-path 队列，调用方 `await`；唯一 tmp + rename                                                                                      | `budget.test.js`「并发 add 不丢更新」                                                            |
| ADV-03 | 插件侧硬超时：`deadline.js` 到点 abort 并提前返回 `timeout`，不落账；残余风险写进 README                                                                        | `deadline.test.js`（9 项）                                                                       |
| ADV-04 | 账本行写本地日键 `day`（`lib/day.js` 唯一实现），读取优先 `day`、旧行按 `at` 的本地日期折算                                                                     | `ledger.test.js`「day 字段优先」（远古固定日期，任何时区必红）、`day.test.js`（纯函数/DST/跨日） |
| ADV-05 | 启动时从 usage 尾部恢复 `sessionCalls` 与最近一小时 `hourStamps`；turnCalls 明确为进程内                                                                        | `ledger.test.js`「恢复会话调用数与最近一小时时间戳」                                             |
| ADV-06 | 新增 `ledger/budget/fs-atomic/deadline/day` 五个测试文件（文件系统相关全部 `mkdtemp`）                                                                          | 见上                                                                                             |
| ADV-07 | outcome 三条路径可达（assistant/tool 信号 → accepted、下一条真人消息 → user-typed-other、下回合无真人 → no-action）；`summarize`/`/advisor report` 带覆盖率分母 | `decisions.test.js`、`decisions-wiring.test.js`、`adoption.test.js`                              |
| ADV-08 | 决策日志只记顶层会话的口径写进 README / 本文 §1.5                                                                                                               | —（文档）                                                                                        |
| ADV-09 | 回填前用 `isInjectedContext` 过滤注入的 `user/message`（goal / time-context 等）                                                                                | `decisions-wiring.test.js`「注入消息不误判」                                                     |
| ADV-10 | 删除从未被调用的 `ledger.recent()` 与内存副本                                                                                                                   | `ledger.test.js`「不再暴露 recent」                                                              |
| ADV-11 | 预估成本传进 `checkBudget` / `checkPool`，日预算可「这笔会顶到就拒绝」                                                                                          | `guard.test.js`「边界 + 预估」                                                                   |
| ADV-12 | 两个预算闸统一 `>=`（已达上限即拒绝）                                                                                                                           | `guard.test.js`、`budget.test.js`                                                                |
| ADV-13 | 脱敏键名不区分大小写，补 JWT 与裸 `Bearer` token 两条规则                                                                                                       | `redact.test.js`（新增 3 项）                                                                    |
| ADV-14 | 删掉 client 内嵌字典与 `LOCALE_EXTRA` 重复的 30 个键，并加「键集不相交」断言                                                                                    | `locale-parity.test.js`                                                                          |
| ADV-15 | 空白会话斜杠命令不可见属上游行为，写进 README 已知边界                                                                                                          | —（文档）                                                                                        |

复审（`notes/audit/2026-11-28/reviews/advisor.md`）的 F2/F4/F5/F6/F7 已在本分支跟进：ADV-04 测试改成
时区无关的远古日期 + 新增 `day.test.js`；预算预检拒绝文案区分「已用完」与「本次调用预计超出」
（`guard.js`/`budget.js` 返回值带上 `estimatedCostUsd`）；README 声明脱敏可能误伤普通键名并用
`keywords:` 用例钉住；决策 outcome 的启发式/无置信度、post-answer 归因按下一回合计、会话结束
不 flush 都写进注释与本文。F1（review 脚本人类输出缺覆盖率）属 root `scripts/`，由 lead 的批次处理；
F3（call.js 接线无单测）/F8（失败调用不计次）留给后续批次。

另修一个既有 flake：`decisions-wiring.test.js` 原来用 `setTimeout(50/80/120)` 猜异步写落盘时序，全仓
verify 并发时偶发红。现在 `createDecisionLog` 暴露 `flush()`（等所有在途 append/回填落盘），接线测试
的 `deliver()` 改为 await `finishTurn` / `flush`，**不再有 sleep**；该文件连跑 8 次、包内全量连跑 5 次全绿。

验证口径：`node --test`（包内）= **203 pass / 0 fail**，`pnpm verify` EXIT=0。按批次约定**没有**跑
web 冒烟与桌面回归（由 lead 统一跑）；本批没有改 client 行为（只删了不生效的重复文案），15 项 web 冒烟与
19 项桌面只读回归的断言均在本次改动范围之外。

## 0.6.x 用户模拟交互修复批次（2026-11-28，DSH 0.2.2-rc.5）

用户模拟审计（`notes/audit/2026-11-28/user-sim-u2.md` / `user-sim-u1.md`）里属于 advisor 的 5 条。
这批**只动本插件**（host 半 + client 半 + locale + 本文 + 该插件的两份冒烟断言），没有改根配置/CI。

| issue      | 修法                                                                                                                                                                                                                                                                                                | 守护它的测试                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USIM-U2-07 | 命令回执第一行写成**原始命令行**（`commandReply`）；注册 `conversation.chat.commandview` 的 `advisor` keyed 渲染器，卡片显示原始命令行 + 完整多行正文（`pre-wrap`，不省略）；监听宿主 client 事件 `command/executed`，把多行输出放进右下角**命令回执面板**（不自动消失，点 ✕ 关闭；空白会话也可见） | `command-text.test.js`、`client.test.js`「command line and card view」「receipt of a local command execution」、`client-wiring.test.js`、web 冒烟 1 项 + 桌面回归 5 项 |
| USIM-U2-08 | 设置页模式行加**生效状态徽标**（`effectiveState`，与 host 半 `effectiveStateOf` 同判据）；`/advisor status` 与 `/advisor doctor` 把「模式（保存值）」与「生效（真实状态 + 原因）」分开报；`/advisor on` 在未配置模型时**不再**把保存的 `mode` 改成 `advisory`                                       | `command-text.test.js`「effectiveStateOf / formatStatusText」、`client.test.js`「effective advisor state」、桌面回归 1 项                                              |
| USIM-U2-14 | 用户可见文案里的繁体「徵询」统一成简体「征询」（`lib/**`、`locale/zh.json`、README、本文）                                                                                                                                                                                                          | `messages.test.js`「中英命令描述不同、都不含繁体「徵」」                                                                                                               |
| USIM-U2-15 | 斜杠菜单命令描述改为中英双语：host 半自己读 `locale/<lang>.json` 的 `host` 段，按 `config.language` 或 `LANG`/`LC_ALL` 选语言，读不到回落英文（宿主没有 locale 服务，见 runtime §8.1）                                                                                                              | `messages.test.js`（加载/摊平/选语言/中英描述）、`locale-parity.test.js`（`host` 段不进 client 键集）                                                                  |
| USIM-U1-11 | advisor 工具的 skip 结果不再把「已关闭 / 未配置 / shadow」这类内部开关状态交给主模型：`exposeSkip` 在 tool 触发时换成中性 code + 「不要把顾问状态写进给用户的回复」；`lastSkip` 仍留真实原因供状态/诊断使用                                                                                         | `tool-result.test.js`（4 项）                                                                                                                                          |

验证口径：`node --test`（包内）= **232 pass / 0 fail**（203 → 232，新增 5 个测试文件里的 29 项；复审 follow-up 再 +1 条 `renderToolOutput` + `exposeSkip` 组合断言，现为 **233**），
`pnpm verify` EXIT=0。按批次约定**没有**跑 web 冒烟与桌面回归（由 lead 统一跑）：

- web 冒烟新增 1 项 Node 侧断言：「`/advisor` 命令回执第一行是原始命令行（日志）」；
- 桌面只读回归新增 6 项断言：`/advisor status|doctor` 回执第一行 / status「生效：」行 / status 卡片 DOM 原始命令行 + 完整输出 / 命令回执面板出现 / doctor 卡片多行；断言选择器用 `data-advisor-command-card`、`data-advisor-receipt`，不依赖文案。**计数以 lead 的统一运行为准**，本文不虚构实测数字。

宿主机制（本批的核心事实，均来自 `app.asar` 内随包源码）：

- 命令节点由宿主 `dsh-client-ui-chat` 的 `command` 定义构建，`feature` 分组把**没有 groupTree** 的节点放进可折叠 process 组（标题固定 `message.stepProcess.done.thinking` =「已完成分析」）——插件没有扩展点把节点移出分组；
- `GenericCommandCard` 只显示 `node.name`、单行 summary 走 CSS 省略号、`text.includes('
')` 时才在**卡片第二层**折叠里给 `<pre>`；
- `conversation.chat.commandview` 是 `command` 渲染器的 keyed 子 slot（`entryKey: command.name`），插件可整卡替换；
- `command/executed` 只在**本浏览器本地提交成功**时由 `dsh-client-ui-commands` 广播（`notifyExecuted`），别的客户端/历史命令不会触发；
- 工具结果的 `value` 是 **execution-local**、不进持久化事件；模型读到的是 `output.render(args, value)` 渲染出的 `content`（`dsh-tools` 用这份 content 构造并持久化 `tool/result`，界面工具卡与模型上下文共用同一份）——所以 U1-11 的泄漏源不是 value 本身，而是 skip 结果里的 `code`/`reason` 被 `renderToolOutput` 渲染成了模型可见文本。

## 0.6.1 在 0.2.2-rc.3 上的复核记录（2026-11-14，DSH 0.2.2-rc.3）

插件代码没有改动；这一版只验证「升级后仍然成立」。

| 层                                         | 结果                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `node --test`（包内）                      | **138 pass / 0 fail**                                                                                 |
| `pnpm verify`                              | 通过（lint / typecheck / check / check:docs / check:public / 单测）                                   |
| `pnpm probe:runtime`                       | **72/72 PASS**（探针侧改了 1 条硬编码哈希资源的误报，见 [runtime rc.3 §2](../runtime/0.2.2-rc.3.md)） |
| `pnpm smoke:advisor`（web，临时 DSH home） | **14/14**，账本 0（不发起模型调用）                                                                   |
| `pnpm smoke:advisor-desktop --require`     | **19 PASS + 1 SKIP**，0 FAIL（SKIP：本会话没有顾问记录）                                              |
| 设置页                                     | 桌面只读读到紧凑态 3 行摘要、45 个 provider 候选、19 个「?」帮助按钮；字段与文案断言全过              |

结论：**rc.3 上 advisor 无回归**。

## 超时 vs 取消：一次真机 90 秒超时的定位（2026-11-14）

排查「advisor 工具报 `顾问不可用（aborted）：顾问调用被中止`」时，先用三条独立证据把范围钉死：

| 证据                                 | 读数                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 会话日志 `tool/call` → `tool/result` | 时间戳差 **90,017 ms**（seq 617 → 622）                                                                    |
| `~/.dsh/advisor/usage.jsonl` 末条    | `trigger:"tool"` · `verdict:"unavailable"` · `code:"aborted"` · **`ms:90002`** · in/out 全 0 · `costUsd:0` |
| `~/.dsh/advisor.settings.json`       | **存在**，且**显式**配着 `timeoutMs: 90000`（注意：在 `$DSH_HOME` 根下，不是 `advisor/` 子目录里）         |

结论：不是插件崩、也不是 rc.3 引入的回归，而是**顾问路由太慢、撞上了插件自己的 90 秒单次超时**。

28 次真实征询的耗时分布（同一份 `usage.jsonl`）：p50 **6.2s**、p90 **52.5s**、max **90.0s**；`>60s` 3 次，`≥90s` **2 次**——其中一次在 **2026-11-12** 就已经发生过（`ms:90007`），早于 rc.3，所以是这条路由的既有特征。

顺带发现两个真问题（已修，见 changeset `advisor-timeout-code`）：

1. **超时被当成「被取消」。** `call.js` 的 abort 分支只看 `finish.kind === "aborted"`，把 `AbortSignal.timeout` 触发的超时也归成 `code:"aborted"`，与 README 里 `timeout` / `aborted` 分列的失败码清单不符。
2. **超时文案说「0 秒」。** 不足 1 秒的时长会拼出「顾问调用超时（0 秒）」。

修法：新增纯函数 `lib/abort-reason.js`（`classifyAbort` / `formatTimeout`），`call.js` 根据「超时 signal 是否真的触发」区分 `timeout` 与 `aborted`；不足 1 秒按 1 秒显示。单测 4 项覆盖，接线用 stub 宿主验证过：`timeoutMs:120` → `code:"timeout"`「顾问调用超时（1 秒）」；外部 signal 取消 → `code:"aborted"`「顾问调用被中止」。

### 修复后的真机端到端复验（2026-11-14 15:26，DSH 0.2.2-rc.3 + advisor 0.6.2）

rc.3 桌面版重启后，在 **live 宿主**上把 `<DSH_HOME>/advisor.settings.json` 的 `timeoutMs` 临时改成 `5000`（允许的最小值），同时把 `maxInputChars` 压到 4000、`maxTokens` 压到 512，这样**万一没有超时，花费也可忽略**。然后触发一次真实征询：

```
顾问不可用（timeout）：顾问调用超时（5 秒）
```

账本新增一条（29 条中的最后一条）：

```json
{
  "at": "2026-11-14T07:26:25.131Z",
  "trigger": "tool",
  "verdict": "unavailable",
  "code": "timeout",
  "ms": 5003,
  "in": 0,
  "out": 0,
  "costUsd": 0
}
```

修复前后的对照（同一个工具、同一个路由）：

|           | 修复前（13:39，advisor 0.6.1） | 修复后（15:26，advisor 0.6.2） |
| --------- | ------------------------------ | ------------------------------ |
| `code`    | `aborted`（错）                | **`timeout`**                  |
| `message` | 顾问调用被中止                 | 顾问调用超时（5 秒）           |
| `ms`      | 90002                          | 5003（= 配置的 5 秒）          |
| 花费      | 0                              | **0**（超时不计 token）        |

结论：**超时与取消的分码在真机上生效**，不再把超时误报成「被中止」。测完设置已恢复，与备份逐字节一致（`cmp` + md5 均相同）。

> 教训：`$DSH_HOME/advisor.settings.json` 在 **`$DSH_HOME` 根下**，不在 `advisor/` 子目录（那里只有 `usage.jsonl` / `decisions.jsonl` / `advice.jsonl` / `budget.json`）。第一次定位时我查错了路径，误以为「没有设置文件、用的是内置默认 90s」——实际是显式配了 90000。数字巧合导致结论没错，但依据是错的，已更正。

后续动作：默认 90s **没有**改（改默认会连带影响成本与最坏延迟），但把实测分布写进了 README 的 `timeoutMs` 行；这条路由慢就自己调大（5000–600000）。

**2026-11-28 补充（AUD-ADV-03）**：0.6.2 只修了「怎么**命名**超时」，没有保证「超时真的**中止**」——
真实账本里仍有 6 次调用超过 90s 却以 `reviewed` 计费。0.6.3 起 `lib/deadline.js` 在
`startedAt + timeoutMs` 主动 abort 请求并让 `callAdvisor` 提前返回 `timeout`，不再等宿主流收尾，
该次调用按 0 token / `costUsd: 0` 记账。残余风险（provider 侧可能已计费、宿主可能仍持有请求）
写在 README「副作用、限制与风险」里，不假装解决。

## 0.6.1 复核记录（2026-11-14，DSH 0.2.2-rc.2）

| 层                                   | 结果                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `node --test`（`decisions.test.js`） | **18 pass**（新增 3 项：aborted/blocked 原因码、「回合被中断」归类） |
| `pnpm verify`                        | 通过                                                                 |
| `pnpm smoke:advisor`（web）          | 14/14（未受本次改动影响）                                            |

0.6.1 只改决策日志的归类：`endKind` 为 `aborted`/`blocked` 时直接记 `skipped-aborted`/`skipped-blocked`，
不再从人话里猜。桌面只读回归没有复跑（改的是 host 半的日志写入，不在桌面脚本覆盖面内）。

## 0.6.0 复核记录（2026-11-14，DSH 0.2.2-rc.2）

| 层                                      | 结果                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `node --test`（`packages/advisor`）     | **135 pass / 0 fail**（新增 `decisions.test.js` 15 项 + `decisions-wiring.test.js` 5 项） |
| `pnpm probe:runtime`                    | **72/72 PASS**                                                                            |
| `pnpm smoke:advisor`（web，不花 token） | **14/14**（新增「决策日志格式合法」一项）                                                 |
| `pnpm smoke:advisor-desktop --require`  | **19 PASS + 1 SKIP**，0 FAIL（SKIP 是「该会话没有顾问记录」，脚本不制造征询）             |
| `pnpm advisor:review --home <temp>`     | 用 3 行样本跑通，输出征询率/采纳率/分桶表与两类可疑样本                                   |

本版新增的决策日志落在 `<数据根>/advisor/decisions.jsonl`，与 `usage.jsonl`（钱的账本）分开：
一个回合一行，没征询的回合也写。

**真机征询（手工 `/advisor ask`，2026-11-14）**：`trigger` 为 `manual` 的路径在真实桌面版上跑通。

```
命令输出：顾问认为无需建议。 2.1k in / 72 out / 4.6s / ≈¥0.0260
usage.jsonl ：trigger=manual · provider=zhinao · model=moonshotai/kimi-k3.1-pro
              verdict=declined · inputTokens=2124 · outputTokens=72 · costUsd=0.0039
advice.jsonl：trigger=manual · status=declined · severity=nit · sessionId 与所在会话一致
```

两个观察（不是缺陷，记下来免得下次误判）：

1. `/advisor ask` **不接受问句参数**——多带的文字会让命令报「无法识别的参数」；
   它是「就当前会话内容征询一次」，要指定重点请用 `/advisor ask` 后的其它子命令或直接让模型调用工具。
2. `declined` 在界面上被渲染成「失败 advisor 顾问认为无需建议」——前缀来自宿主对「非成功结果」的
   统一渲染，不是插件报错；账本里的 `verdict` 才是准的。

**第一次在真实日志上跑复盘（2026-11-14，16 个回合）**：

```
回合：16 · 征询：0（0.0%）
未征询的原因：skipped-not-requested 15 · skipped-other 1
疑似漏征询（有工具 + 长回答 + 无报错，但没征询）：5 条（回答 1098–2860 字）
```

结论：`postAnswer: off` 时征询完全依赖主模型主动调用工具，实测一个都没发生——
这正是「该征询的时候没征询」的证据，比拍脑袋定触发条件靠谱。顺带从真实数据里抓到一个归类 bug：
「回合被中断」被归到 `skipped-other`（`skipped-aborted` 从没被产出过），已改为优先用结束原因判定。

单测与 seam 数字都会随实现增长，上面只是本次核对时的快照。

### 过期快照陷阱（桌面脚本，2026-11-12 定位并修复）

「设置卡新增字段」「确认跨 provider 发送」这 2 条断言曾**长期失败**，但**不是插件的 bug**，而是脚本
读到的是一份**过期快照**。这段记下来，因为它的表现（稳定失败 / 偶尔自愈）非常容易让人误判为被测代码有问题。

**根因**：`cdp.evaluate(expr)` 返回的是 `expr` 的求值结果本身；只有 `waitFor(cdp, expr, ...)` 才返回
`{ ok, value, error }` 包装。脚本把两者混用了：

```js
const card = await waitFor(cdp, ADVISOR_CARD, ...);      // card.value = 展开**前**的紧凑卡
await cdp.evaluate(CONFIGURE_CARD);
await cdp.evaluate(EXPAND_DISCLOSURES);
const expandedCard = await cdp.evaluate(ADVISOR_CARD);   // 裸对象，没有 .value
const value = expandedCard?.value ?? card.value ?? null; // 前者恒为 undefined → 永远用旧快照
```

于是判断「设置卡里有没有这些字段」时，拿到的是**展开高级区之前**那张紧凑卡的文本：
`helpButtons: 0`、只有「币种」一条命中、其余 7 个字段全报缺失。

**为什么它看起来像 flaky**：折叠状态存在插件模块级缓存 `settingsUiState` 里。只要此前任何一次跑把
高级区展开过，之后同一次页面会话里的每次运行都是展开的，问题就被缓存盖住；只有**冷启动**（刷新页面）
才会稳定复现。

**修法**（脚本侧，两处）：

1. 展开后用 `waitFor` 重新读，并且等到真的展开：
   `waitFor(cdp, ADVISOR_CARD, (v) => v?.advancedExpanded === "true")`，取 `expandedCard.value`；
2. 取节点方式统一：`CONFIGURE_CARD` / `EXPAND_DISCLOSURES` / 截图前的 `scrollIntoView` 原来用
   `querySelector`（第一个），`ADVISOR_CARD` 用最后一个；`[data-advisor-settings]` 出现多个时统一取
   **最后一个**（`CARD_ROOT`），避免「点的」和「读的」不是同一个节点。

**回归断言**：脚本里新增一条
`设置卡高级区已展开（断言读到的是展开后的快照，不是紧凑卡）`，同时要求
`expandedCard.ok === true`、`advancedExpanded === "true"`、`helpButtons > 0`。
它守的就是上面那个坑——谁把读法改回 `expandedCard?.value` 的裸对象，这条会**直接红**，
而不是让后面两条字段断言莫名其妙地失败。

**排查这类问题的顺序**（这次走过的弯路，两个假说都被证伪）：

| 假说                                                           | 结论                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| 设置页里有多个 `[data-advisor-settings]`，点的和读的不是同一个 | 当前实测 `cardCount: 1`，不是主因（仍做了统一，属防御）   |
| 桌面装的是旧构建，字段还没发布                                 | 已装构建与分支文件 md5 一致、字段文案 grep 得到，排除     |
| **脚本读的是过期快照**                                         | ✅ 往脚本注入一次 DEBUG，把断言实际拿到的对象打出来即定位 |

**复验方式（关键）**：改这个脚本后必须**刷新页面再跑**，清掉 `settingsUiState` 缓存，否则缓存会掩盖问题：

```bash
# 1) 刷新渲染进程（清缓存）。用 CDP 的 Page.reload，或直接在桌面版里按 Cmd+R
# 2) 切到一个空闲会话（脚本不在正在跑回合的会话上敲键盘）
# 3) 再跑
pnpm smoke:advisor-desktop --require
```

改完实测：冷启动后 **19 PASS + 1 SKIP**（原 18 PASS + 1 SKIP，新增的正是这条回归断言）。


## 1. 单测（每次提交）

```bash
cd packages/advisor && pnpm test   # node --test
pnpm verify                        # 仓库门禁（含单测、规范、文档一致性）
```

只测**纯函数**——不启动宿主、不连模型、不写真实数据根。应覆盖的范围：

| 主题         | 要证明的事                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 设置规整     | 默认 `mode: "off"`、未配置顾问；丢弃未知键；数字按区间夹紧（`0` 在预算字段里表示"不限"）；非法 `mode`/`privacyScope` 回落到默认；坏 JSON 不抛错只回落。                                                                                                                                                                                                                  |
| 设置合并     | `mergeSettings` 只覆盖 patch 里出现的键；写入是原子写、读回一致。                                                                                                                                                                                                                                                                                                        |
| 选路与配对   | 显式配置 > 会话当前模型 > 空路由（空路由 = 调用方放弃本次征询）；档位比较 `ok` / `warn`（顾问更弱）/ `block` / `unknown`（**未校验**，不阻断也不假装通过）。                                                                                                                                                                                                             |
| 预算         | 四级预算按固定顺序返回**第一个**不满足的条件；到顶的 code 可区分是哪一级；`0` = 不限制；**边界 `>=`**（已达上限即拒绝）且把本次预估花费算进日预算。                                                                                                                                                                                                                      |
| 原子写       | `appendJsonLine` 逐行追加、并发不丢行、超阈值滚动；`writeTextAtomic` 唯一 tmp + rename、并发替换不互踩、不留临时文件；同一路径的任务串行、前一个失败不阻塞后一个。                                                                                                                                                                                                       |
| 账本         | usage 追加不重写历史、并发 record 不丢行、每行带本地日键；启动时按 `day`（旧行按 `at` 的本地日期）恢复今日花费，恢复会话调用数与最近一小时时间戳；advice 追加与按日汇总。                                                                                                                                                                                                |
| 工作区预算   | 池子跨日清零、并发 `add` 不丢更新、唯一 tmp 不留临时文件；两个闸按 `>=` 与「已花 + 预估」判定。                                                                                                                                                                                                                                                                          |
| 硬超时       | 到点 abort 且 `timedOut` 为真；外部取消不算超时；`raceWithDeadline` 超时先到提前返回、迟到的 rejection 不变成 unhandled；dispose 后定时器不再触发。                                                                                                                                                                                                                      |
| 决策 outcome | `summarize` 报 accepted / ignored / noAction / pending / 覆盖率；跟踪器里三条路径都可达，注入的 `user/message` 不算用户反应；并发回填不丢行。                                                                                                                                                                                                                            |
| 金额         | 单价为 0 时不算钱（只显示 token，不编金额）；单价存在时按输入/输出分别乘。                                                                                                                                                                                                                                                                                               |
| 去重指纹     | 指纹忽略大小写、空白与标点差异；窗口内重复被拒、窗口外放行；指纹表有上限不会无界增长；免疫窗口只在窗口内为真。                                                                                                                                                                                                                                                           |
| 空洞建议     | "Looks good" 这类空洞结论被识别为 `declined` 而不是 `reviewed`（精确匹配，不做包含匹配）。                                                                                                                                                                                                                                                                               |
| 严重度       | 严重度排序单调（`nit` < `concern` < `blocker`），预算/归因逻辑用它比较。                                                                                                                                                                                                                                                                                                 |
| 输出契约     | 严格 JSON 解析（容忍 ```json 围栏与前后散文）；非法 severity 回落；`reviewed` 但建议为空 → invalid；纯散文 → unparsed；超长建议被截断并**留痕**；证据条目被过滤。                                                                                                                                                                                                        |
| 脱敏         | 常见 token 形态（`sk-`、`ghp_`、`AKIA`、`Bearer`、`KEY=VALUE`）被替换；小写 / camelCase 键名赋值（`api_key=`、`token:`、`apiKey:`、`password=`）、JWT、裸 `Bearer` token 也被遮；普通文本不被改动；递归处理嵌套对象的字符串，且有节点预算不无限递归。**已知取舍**：键名按不区分大小写的子串匹配，`keywords: …` / `monkey: …` 这类普通文本也会被遮（用例钉住，复审 F5）。 |
| 本地日键     | `dayKey` 用本地日期分量（跨日边界、夏令时切换日）；`dayKeyOf` 对 ISO 时间按本地日折算、非法输入返回空串；`dayOfEntry` 合法 `day` 优先、畸形 `day` 回落到 `at`（`day.test.js`，时区无关，复审 F2）。                                                                                                                                                                      |
| transcript   | 含工具调用与工具结果；**排除我们自己的工具调用**（`purpose: "advisor"` 那条）；`scope=off` 时不发工具往来；`system`/`developer` 消息不进 transcript；超长工具结果被截断并留痕；**脱敏在截断之前**生效；总预算超限时保留首尾并插入省略标记。                                                                                                                              |
| 工具 schema  | 工具名与参数形状对齐参照实现（**零必填**，只有可选 `focus`）；只使用宿主支持的关键字子集（`minimum` 这类会被抓出来）；`renderToolOutput` 覆盖四种状态且不抛。                                                                                                                                                                                                            |
| 命令文案     | `commandEcho` / `commandReply` 的第一行永远是 `/advisor <原始参数>`；`formatStatusText` 多行、含「生效」行，四种生效状态（on / shadow / off-mode / off-unconfigured）措辞正确；畸形 settings 不抛。                                                                                                                                                                      |
| 生效状态     | client 的 `effectiveState` 与 host 半 `effectiveStateOf` 同判据：保存 `advisory` 但没配 provider/model → off/unconfigured；`shadow` 已配置 → shadow；`off` → off/mode。                                                                                                                                                                                                  |
| 命令卡片     | `commandCardView` 从 `node.args` 还原原始命令行、剥掉正文里的命令行回显行、保留多行不截断；running/ok/error 三态；`receiptOf` 只认 advisor 命令并忽略空/畸形结果。                                                                                                                                                                                                       |
| host 文案    | `locale/<lang>.json` 的 `host` 段中英都存在且非空；`flattenMessages`/`mapMessages` 兼容嵌套与平面键；`pickLanguage` 显式配置 > `LANG`/`LC_ALL` > 英文；中英描述不同且中文不含繁体「徵」。                                                                                                                                                                                |
| 工具结果收敛 | `exposeSkip` 在 tool 触发时把 `disabled`/`not_configured`/`shadow_mode` 换成中性 code + 「不要播报」；`needs_confirmation` 与被动投递保留原文。                                                                                                                                                                                                                          |

**没覆盖**：真实宿主槽位、真实 Electron 渲染进程、真实的 `llm.prepareCall/stream` 行为、`commandUi.decorate`
在宿主里的实际渲染。所以下面两层不能省。

## 1.5 一条命令跑完门禁（发版前）

`scripts/gate.mjs` 是通用的：`pnpm gate advisor` 依次跑 `pnpm verify` → `pnpm probe:runtime` →
web 冒烟（`pnpm smoke:advisor`）→ 桌面只读回归（**永远带 `--require`**）。
任何一步失败立刻停并给出下一步提示；只有显式 `--skip-desktop` 才跳桌面端，且结束时会打印"门禁不完整"。

## 1.5 决策日志（`decisions.jsonl`）与复盘（`pnpm advisor:review`）

宿主侧**每个回合**往 `<数据根>/advisor/decisions.jsonl` 写一行（没征询的回合也写），
用来回答「该征询的时候有没有征询」。字段与原因码定义在 `packages/advisor/lib/decisions.js`。

- 单测：`test/decisions.test.js`（归类/分桶/回填/统计/覆盖率）与 `test/decisions-wiring.test.js`
  （用真实事件序列驱动跟踪器，确认回合结束会落行、三种 outcome 都可达）。接线测试**不用 sleep**：
  `createDecisionLog.flush()` 等所有在途写落盘，`deliver()` 是 async 的（等 `finishTurn` / `flush`）。
  注意 `service.js` 依赖 `@deepseek-ai/*`，单测环境里导入不了；所以「事件 → 决策行」这条逻辑
  放在 `decisions.js` 的 `createDecisionTracker`，service 只做薄委托。
- **outcome 口径（0.6.3 起）**：`accepted` = 下一回合的助手消息或工具调用参数里出现建议的路径/反引号命令/
  证据 ref（与 `attributeAdoption` 的 `JSON.stringify(event.data)` 口径一致），或下一条真人用户消息复述了信号；
  `user-typed-other` = 下一条真人用户消息没命中；`no-action` = 下个回合结束时没有任何真人反应。
  宿主注入的 `user/message`（`time-context` / `goal` / `runtime-context` 等，见 `transcript.js`
  的 `isInjectedContext`）**不是**用户反应，直接忽略。`summarize()` 输出 `resolvedOutcomes` /
  `pendingOutcomes` / `outcomeCoverage`，覆盖率与采纳率一起看。
  **accepted 是启发式、不区分置信度**：路径 / 反引号命令 / 证据 ref 一视同仁，模型顺手复述同一条
  命令也可能算命中；若 `tools/execute` 事件的 `data` 含工具结果全文，读文件读到的内容也可能被
  当成命中（事件形状待真机核实，见复审 F6）。**post-answer / shadow 的归因按下一回合计**：
  这类建议在 `turn/end` 之后异步产生，`noteAdvice` 晚于该回合的 `finishTurn`，于是会记到下一回合
  的决策行、pending 也在下一回合才设置（复审 F7，属既有错位，本批只记录不改）。**会话结束不
  flush**：没有后续回合的 pending 会一直保持未回填（覆盖率里体现为 pending）。
- **只记顶层会话**：`handleSessionEvent` 对子代理会话直接 return（避免 shadow 在子代理里叠加），
  所以本文件的口径是「主会话的回合」。`pnpm advisor:review` 的征询率/采纳率都是这个口径，
  不能用来推断 fork/spawn 子代理里的征询行为。
- 复盘：`pnpm advisor:review [--home <数据根>] [--days N] [--json]`，只读本地文件。
- 冒烟里只守住格式约定（存在就必须每行一个合法 JSON）；本冒烟不发真实回合，所以文件通常不存在。

## 2. web 端到端冒烟（`pnpm smoke:advisor`）

临时 `DSH_HOME`（复制 desktop profile、剥掉第三方插件、只放一个临时工作区）里启动**真实宿主**，
装当前源码打出的包，再用 ego-browser 跑一遍「装得上、命令注册了、设置卡渲染了、且**什么都没花**」。

**16 项断言（2026-11-14 实测 15/15；2026-11-28 新增 1 项 Node 侧断言，本轮未重跑）**：

1. 页面可交互（`contenteditable` 输入框存在）；
2. 插件 client 半已加载（`style[data-plugin]` 含 `@kangyishuai/dsh-advisor`）；
3. `/` 菜单里出现 `advisor`（证明 `commands.register` 生效）；
4. 能新建会话并拿到空输入框；
5. 设置卡默认是 `off` 紧凑态：只有模式、一句状态和「配置顾问」，不渲染 provider / 预算 / 隐私；
6. 点「配置顾问」并展开高级与状态后：provider 下拉有候选（实测 45 条）、每日预算/发送范围/工作区限额/模型白名单/预览都在，且有 15 个「?」按需帮助按钮、无 `[data-advisor-error]`；
7. 点开第一个「?」能展开内联说明（不是只靠 `title` 悬停）；
8. 关闭设置卡（宿主随后弹出的「首次配置凭据」对话框不算失败）；
9. 会话日志里 `command/done` 依次有 `/advisor doctor`（含 ✅/⚠️ 结论）；
10. 会话日志里出现 `/advisor preview`（目标 / 将发送）；
11. 会话日志里出现 `/advisor confirm`（已允许或未配置）；
12. 会话日志里出现 `/advisor report all`（顾问报告或空态）；
13. **整段冒烟没有生成 `advisor/usage.jsonl` 或 `advice.jsonl`** —— 证明它没有发起任何模型调用、没有花钱；
14. **（2026-11-28 新增）** 会话日志里每条 `command/done` 的第一行都是原始命令行（`/advisor doctor|preview|confirm|report all`）——宿主的通用命令卡片只显示命令名，所以这条只能靠回执文本自己保证。

（浏览器脚本检查与 Node 侧日志检查合计 16 项；1–8 来自浏览器脚本，9–14 是 Node 侧对会话日志/账本的检查。编号只是清单顺序，不严格对应实现里的 `check()` 调用。）

设计边界：命令输出以**会话日志**为准（宿主的通用命令卡片在 DOM 里是折叠的；2026-11-28 起 advisor 自己注册了 keyed 命令卡片，DOM 里能读到原始命令行与完整正文，桌面回归新增了对应断言）；
不点保存、不发消息、不征询；`SMOKE_KEEP=1` 保留临时目录与 `host.log` 排障。

> 不做「假 provider + 真实征询」的原因：那需要把 provider 额度或回环网关写进冒烟，成本与可重复性都差；
> 真实征询链路由桌面冒烟（只读）与真机手工验证覆盖。

## 3. 桌面只读回归

```bash
# 1) 带调试端口启动/重启桌面版（验证完正常重启一次即可关掉端口）
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 2) 跑（--require：连不上端口时失败而不是跳过）
pnpm smoke:advisor-desktop --require
# 端口不同时：DSH_CDP_PORT=9333 pnpm smoke:advisor-desktop --require
# 被测实例用的是自定义 DSH_HOME（临时 home / 非默认 profile）时必须显式传：
# 脚本要扫 <DSH_HOME>/sessions/*/<sessionId>/session.v*.jsonl.zstd 读命令回执，
# 不传就默认 ~/.dsh，会读错 home 导致「命令类断言读不到日志」假红。
DSH_HOME=/path/to/that/dsh-home pnpm smoke:advisor-desktop --require
# 连真实征询记录一起看（opt-in；只读，脚本不发起征询）：
pnpm smoke:advisor-desktop --require --advice
```

默认**只读**：只开菜单/对话框、读 DOM/文本、再 Esc 关闭；**不选任何模型、不改任何设置值、不点保存、
不触发真实征询、不写账本**，因此可以直接跑在真实 profile 上。默认 20 项、加 `--advice` 后 24 项
（没有顾问记录 / 没有选中 provider 的项记 SKIP，不算失败）。**2026-11-28 这轮新增 13–18 共 6 项命令面断言，按批次约定没有重跑桌面回归**，所以上面「默认 20 项」是旧口径，实际脚本现在是 26 项；PASS/SKIP 以 lead 统一运行为准。断言清单（✅ = 脚本已覆盖；⬜ = 仍是待补项）：

1. ✅ 连上桌面 UI（CDP）；
2. ✅ 插件 client 半已加载：`style[data-plugin="@kangyishuai/dsh-advisor"]`；
3. ✅（**web 冒烟**）`/` 菜单里能搜到 `advisor`，且描述非空（证明 `commands.register` 生效、宿主目录已刷新）；
4. ✅ 设置页分节（只读）：账号菜单 →「设置」→「顾问」；有首屏三行摘要（模式/路由/预算）与「更多设置」折叠，卡片有 provider 下拉（≥1 个候选）与 model 下拉，
   没有 `[data-advisor-error]`（宿主 RPC 正常），并出现新增字段「工作区」预算、「预览会发什么」、模型白名单、
   「确认跨 provider 发送」（没选 provider 时这项记 SKIP）；**不点保存、不改任何值**；关掉后对话框消失。
   文案从 `packages/advisor/locale/{zh,en}.json` 读，英文界面同样能过；
5. ✅ 回合尾部顾问线（只读）：页面上有 `.dsh-advisor-turn` 时 headline 为「顾问 · 严重度」
   （`declined` 时是「顾问认为无需建议」）；**没有记录就记 SKIP**——脚本不制造征询；
6. ✅ 输入 `/advisor` 回车 → 打开**宿主选择器**（有搜索框、有行），按 Esc 关闭、焦点回到输入框；
7. ⬜（未断言）选择器行里至少有一条来自宿主已配置路由（`provider/model` 文本可读），且**没有任何一行**泄露
   `baseURL`/`apiKey`；
8. ⬜（未断言）没有可用路由时**不显示空列表**，而是显示引导项（"去 设置 → 模型 配置"）；
9. ✅ `/advisor status` 输出多行文本：模式、顾问、本会话用量、最近一次结果/跳过原因（主模型与配对结论在 P2 的设置卡里显示）；
10. ✅ `/advisor doctor` 每行都有结论（`✅`/`⚠️`/`❌`）+ 下一步动作，不允许只回一句 error；
11. ✅（**web 冒烟**）整段过程**账本行数不变**：断言临时 `DSH_HOME` 里没有生成 `advisor/usage.jsonl` 与 `advice.jsonl`（即没有任何模型调用）；
12. ⬜（未断言）仓库 cwd 没有多出文件（脚本自身 cwd 污染是最容易漏的一条）。
13. ✅（2026-11-28 新增）`/advisor status` 回执第一行是 `/advisor status`（会话日志）；
14. ✅（新增）`/advisor status` 回执含「生效：」行（会话日志）；
15. ✅（新增）插件命令卡片 `[data-advisor-command-card]` 的 `data-command-line` = `/advisor status`，`textContent` 含「生效：」（DOM，宿主的通用卡片做不到）；
16. ✅（新增）提交命令后 `[data-advisor-receipt]` 立即出现且文本含「模式：」（不展开宿主折叠分组也能看见）；
17. ✅（新增）`/advisor doctor` 回执第一行是 `/advisor doctor`（会话日志）；
18. ✅（新增）`/advisor doctor` 卡片的 DOM 文本至少 3 行（多行检查结果完整渲染）；

`--advice`（opt-in，只读已有记录，**脚本本身不发起征询**；会被打印一行 `COST:` 提醒）再加 4 项：

- ✅ `/advisor report` 输出含「顾问报告」或「还没有顾问记录」；
- ✅ 有 `.dsh-advisor-turn` 时点开 headline，展开体含 `model · usage`（`910 in / 354 out`，上万会缩成 `9.1k`），
  再点一次收起；没有记录时两项都记 SKIP。

**注意**：脚本要求插件已装进**正在运行的那个 profile**。没装时第 2 项会失败，并把页面上全部
`data-plugin` 打出来——这是最省事的"是不是装错 profile / 没重启"判断依据。第 4 项的新字段是 P3 才有的：
桌面装的是旧构建（如 0.1.0；当前 0.2.0 已齐）时会失败，先 `pnpm pack` + `dsh plugin add` 再重跑，失败 detail 里也写了这句提示。

`--deep`（可选，P1 不做）：真要跑征询链时再补，要求显式传专用工作区、并在临时 profile 里跑。

## 3.5 设置页卡片（写操作 5 步，CDP 脚本）

只读冒烟（§3 第 4 项）只**打开**设置读文本、不点保存。下面这段会**改 `maxTokens` 再改回**，
所以只跑在确认过基线的机器上：

1. 新 client bundle 已加载（`style[data-plugin]` 里含 `dsh-advisor-settings`）；
2. 设置 → 顾问：首屏三行摘要 + 「更多设置」折叠；展开后卡片加载出 provider/model（**不是**「宿主未响应」），有预算与隐私分组；
3. 切 provider：model 下拉重新拉取并变化（实测 `zhinao` 5 个模型 ↔ `deepseek-official` 2 个）；
4. 选当前模型：思考档下拉出现**真实档位** + 「自动（模型默认）」（实测 `zhinao/deepseek/deepseek-v4.1-flash` → `自动/off/low/high/max`）；
5. 改 `maxTokens` → 保存 → 读 `$DSH_HOME/advisor.settings.json` 确认 → 改回 → 再确认（路由与模式必须不变）；再点「运行诊断」，检查项逐行渲染 `✅/⚠️/❌`。

**2026-11-11 真机结果：8/8 PASS**（DSH 桌面版 0.2.2-rc.1）。诊断输出含「44 条 provider 路由」「上下文 1000000 · 思考档 off/low/high/max」「账本 3 次 · 14428 in / 690 out」。

同一次真机会话里还验证了顾问线与报告（花一次征询）：

- 回合尾部出现 `顾问 · 轻微 <摘要>`，点开可见完整建议与 `zhinao/deepseek/deepseek-v4.1-flash · 910 in / 354 out · 4.2s`；
- **只有带记录的回合渲染**（该会话恰好一条记录、页面恰好一个 `.dsh-advisor-turn`）；
- `/advisor report`：`投递 1 条 · 采纳 0 · 未判定 1`、`证据锚点：校验 1 条 / 对上 0 条`、最近一条给出「建议里没有可追踪的信号」；空会话时显示「还没有顾问记录」；
- 本次顾问确实引用了 1 个锚点且**没对上**，所以报告里的「对上 0 条」是真实结果，不是统计 bug。

两个踩过的坑：

- **同版本号重装会被 pnpm 跳过**：`dsh plugin add` 同一个 `0.0.0` tgz 时不会覆盖已装副本，表现为「装了但行为没变」。验证新构建一律 `remove` → `add`，或改版本号。
- **基线可能是脏的**：脚本若在上一轮失败后重跑，会把脏值当基线而"假通过"。脚本开头强制 `maxTokens === 4096`，否则 ABORT。

## 3.6 证据锚点、采纳归因与顾问线（P2）

**单测覆盖**（纯函数，`node --test` 直接跑）：

- `anchors.test.js`：索引只收真实 tool-call id / message id / 路径；编造的 id 与不存在的路径判未验证；未知 kind 退化为文本包含；**有锚点但全没对上 → 严重度降一档并追加提示**，一条对上或完全没给锚点则不降级。
- `adoption.test.js`：信号只认路径、反引号命令、证据 ref，过短的丢掉；后续事件出现信号才算采纳；没有信号就 `unknown`（不硬认领）。

**真机手工检查（有顾问记录之后）**：

1. `对话里发生过一次征询` 后，回合尾部应出现「顾问 · <severity> <摘要>」一行；点开能看到完整建议与 `model · usage`；没有顾问记录的回合**不出现空壳**。
2. 若建议里引用的 tool-call id / 路径在对话里找不到，展开内容应带「证据锚点未对上（N 条）」且严重度已降档。
3. `/advisor report` 输出投递/采纳/锚点三行统计 + 最近 5 条；采纳判定必须给出依据（命中的信号），否则显示「未判定」。

## 3.7 P3 补齐项（内置目录 / 预算池 / 白名单 / 预览 / 两阶段取证）

**单测覆盖**：

- `catalog.test.js`：内置档位「最长匹配优先」、认不出返回 `undefined`；用户声明覆盖内置；单价三档来源（settings/builtin/none）；白名单（空=不限、`provider/model` 或裸 id 命中）。
- `catalog.test.js`（预算池部分）：跨日清零、调用数与金额双闸、边界按「已达上限」处理。
- `verifier.test.js`：`../`、绝对路径、符号链接逃逸被拒；缺失文件报 ENOENT；单文件截断留痕；一次最多 5 个；第二轮提示必须包含证据与不可读清单。

**手工/真机检查**：

1. `/advisor preview` 不触发任何模型调用，但输出里的「将发送 N 字符」「省略 M 字符」「脱敏命中」「单价来源」「工作区今日」要与实际相符。
2. 主模型与顾问 provider 不同时，首次征询应返回 `needs_confirmation`；`/advisor confirm` 之后正常。
3. `advisorTools: true` 时，顾问若返回 `needs`，工具结果里应带 `verification.read`；读不到的文件出现在 `verification.refused`，且首轮结论保留。
4. `/advisor report all` 读跨会话账本，按严重度/模型/日期汇总。
5. `workspaceMaxCallsPerDay` 到顶后，任何会话的征询都返回 `workspace_calls`（跨会话共享）。
6. 有顾问记录的回合，展开回合尾部顾问线应看到 `本次征询：<触发方式> · <HH:mm> · <model> · <字符数> · <in/out/耗时/≈$>`；旧记录没有 `requestChars` 时缺字符数，但其余已有字段仍应显示。
7. `tracePrompt: preview` 时，展开顾问线点「查看发送内容」应看到本次实际发送文本的首尾片段（中间有省略标记）；`tracePrompt: off` 时同一位置显示「这条记录没有保存发送内容」。预览是脱敏后的文本，关闭 `redact` 时则是原文片段。
8. 币种：切到人民币、汇率 7.2，保存后每日预算填 7.2 元；`/advisor preview` 的单价/预算显示 `¥`，预算闸按 7.2 CNY = 1 USD 比较；切回 USD 时金额按汇率折回，真实价值不变。旧 `maxCostPerDayUsd` 文件应自动迁移成 `maxCostPerDay`（USD）。
9. 缓存单价：填缓存读取/写入单价并保存；`/advisor preview` 的单价行应显示缓存读取/写入价。账本里有缓存 token 且两个缓存单价为 0 时，状态区应提示「缓存 token 未计价」；填了缓存单价后，顾问线 usage 里的缓存 token 与成本应一起变化。

## 3.8 P3 真机结果（2026-11-12）

| 项                    | 结果                                                                                                                                                                                                                       | 证据                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 设置卡 P3 字段        | **PASS**：`工作区每日调用上限` / `工作区每日预算` / `预览会发什么` / `模型白名单` / `确认跨 provider 发送` 全部渲染（默认折叠，桌面冒烟会先展开），`data-advisor-error` 不存在                                             | DOM（`[data-advisor-settings]` 的 `innerText`） |
| `/advisor preview`    | **PASS**：输出「目标 / 发送范围 / 将发送 60022 字符（约 20008 tokens）/ 上下文省略 20947 字符 / 工具往来 376 调用 376 结果 / 脱敏命中 kv-assignment / 白名单 未设置 / 跨 provider 否 / 单价 内置参考价 / 工作区今日 0 次」 | 会话日志 `command/done`（seq 2736）             |
| `/advisor confirm`    | **PASS**：「已允许把会话内容发送到「zhinao」」                                                                                                                                                                             | 会话日志（seq 2720）                            |
| `/advisor report all` | **PASS（空态）**：「还没有任何建议记录。」——P3 之前的 3 次征询发生在建议账本上线前，所以文件为空                                                                                                                           | 会话日志（cmd-…-14 / -18）                      |

**一个 UI 观测**：命令结果卡片在聊天流里是**折叠**的，且展开后 `innerText` 仍为空（宿主命令卡片的渲染方式）；命令**执行结果本身**可从会话日志的 `command/done.data.text` 读到。因此自动化断言命令输出时，优先读会话日志而不是 DOM。

**补充（2026-11-12 02:00 真机，重启后）**：

| 项                   | 结果                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shadow`             | **PASS**：`/advisor shadow` + 一轮「回复两个字」→ 账本新增 `trigger=shadow`、`turn=16`（绝对回合号）；回合尾部渲染出「顾问认为无需建议」                                                                                                                                                |
| 顾问线渲染           | **PASS**，但修了两个真 bug：①`turn` 曾用插件自己累计的计数，与 `props.turn` 对不上；②client 把 `advice` 结果按 sessionId 永久缓存，而影子建议在 `turn/end` 之后才落盘 → 永不刷新。现在缓存带 3s TTL 且未命中本回合时 2.5s/4s 各强制重取                                                 |
| 锚点校验（advisory） | **PASS**：真机一次征询 `anchors: {checked:2, verified:0, downgraded:true}`，即顾问引用的 2 个锚点在会话里都对不上，严重度被降档                                                                                                                                                         |
| 两阶段取证           | **未端到端触发**：连续三次征询（含显式 focus）顾问都没有返回 `needs`。编排已抽成 `runEvidencePass` 纯函数并用 4 条单测固定语义（无 needs 不动 / 读到文件则第二轮生效 / 越界记为 refused / 第二轮失败保留首轮）；提示词已把 `needs` 写进契约。模型是否请求证据属于模型行为，不是代码路径 |
| `/advisor cancel`    | **无法自动化**：命令面串行执行，`/advisor ask` 在 handler 内同步等待，第二个命令进不来；真机没有可并发的在途请求可取消                                                                                                                                                                  |

## 4. 手工 GUI 验证步骤

按顺序做一遍，每步都对照"期望"。`$H` 用 [§0](#0-测试环境) 的临时 `DSH_HOME`：

1. **装包**：`cd packages/advisor && pnpm pack --pack-destination /tmp`，然后
   `DSH_HOME=$H dsh plugin --profile ad add /tmp/kangyishuai-dsh-advisor-*.tgz`。
2. **重启桌面版**（host 半）并**刷新页面**（client 半）：侧栏/会话区正常，插件已激活，无报错。
3. **确认默认关闭**：打开一个会话，直接问一句普通问题 → 模型**不应该**征询（账本文件不存在或行数不变）；
   工具卡里不该出现顾问结果。
4. **选顾问**：输入 `/advisor` 回车 → 宿主选择器弹出，列出宿主已配置的 provider × model；
   选中一条 → toast 提示"顾问已设为 `provider/model`"；`/advisor status` 里的顾问变了。
   刻意选一条缺凭据的路由 → 行上标 ⚠ 且选中后给"去配置"提示，而不是静默失败。
5. **征询一次**：问一个需要动手的任务（例如"先看这个仓库的测试命令再改一个地方"），让模型在动手前调用
   `advisor` → 工具卡出现结论（`reviewed` / `declined` / `unavailable`），展开能看到建议文本与 token；
   账本 `$H/advisor/usage.jsonl` **多一行**，`verdict`/`provider`/`model`/token 与工具卡一致。
6. **看账本**：`/advisor status` 的累计 token 与账本最后一行对得上；`/advisor doctor` 每行都有结论。
7. **shadow 模式**：`/advisor off` → 编辑 `$H/advisor.settings.json` 把 `mode` 改成 `shadow`（或按实现提供的
   命令）→ 再完成一轮 → **账本增长，但主模型上下文里没有建议**（工具结果不注入；表现是模型行为不变，
   而账本多一行 `trigger: "shadow"`）。
8. **off 真的不发请求**：`/advisor off` → 完成一轮 → 账本行数不变。**注意**：`off` 时工具仍然注册
   （缓存安全），`execute` 直接返回 `disabled`——所以你可能看到一条 `skipped`/`disabled` 的工具结果，
   但那不是一次模型调用。
9. **预算到顶**：把 `maxCallsPerTurn` 或 `maxCallsPerSession` 临时改成 0/1，再让模型征询 → 得到
   `budget_exhausted`（说清是哪一级），账本不再增长；改回后恢复。
10. **隐私**：把 `privacyScope` 改成 `off` → 征询应被跳过并说明原因；改回 `summary` 后恢复。
    检查脱敏：在会话里贴一段形如 `sk-xxxx` 的假 token，征询后看账本/工具卡里没有原文。
11. **子代理会话**：在子代理会话里让模型征询 → 要么按配置拒绝（`no_session` 一类原因），要么行为与主会话
    一致且账本记录 `sessionId`；不允许出现"子代理里征询把主会话带崩"。
12. **递归**：跑一个多步回合并让模型征询 2–3 次，观察**不出现自我循环**（账本行数应等于模型实际征询次数，
    不是指数增长）。这是本插件唯一能把自己跑死的缺陷，手工也要看一眼。
13. **升级回归**：升级 DSH 后重跑第 4–12 步；选择器打不开、`status` 空白、或账本突然停记，多半是宿主私有
    seam 变了——先看 `/advisor doctor`，再对照 [§5](#5-dsh-升级时要重点看的宿主事实) 核对。

## 5. DSH 升级时要重点看的宿主事实

逐条都有源码证据（见 [runtime 0.2.2-rc.1 §9.15](../runtime/0.2.2-rc.1.md)）。建议把下面这些
（§9.15 第 11 条给的 5 条是主干；`settings.general.item` 槽等 P2 用到时再加）补进
`scripts/probe-runtime.mjs` 的 `SEAM_CHECKS`，让宿主升级时能直接 FAIL 而不是功能静默消失：

1. `llm.prepareCall` / `llm.stream` 仍是 `dsh-llm` 的服务定义成员，且 dispatch 前仍只重核路由字段
   （`callConfigEquals` 的口径不变）；一次 prepared call 仍只能 dispatch 一次；
2. `commands.register` 仍在，`commands/list` 仍是 Typert Remote（`/advisor` 出现在 `/` 菜单的唯一来源）；
3. `commandUi.decorate` 仍接受 `{name, available, ui: {kind: "popupSelect", options, onSelect}}`，
   且 `available` 仍被宿主直接调用（缺了会"回车没反应"）；
4. `usage` 仍只由主循环写进 `assistant/message`（**如果哪天宿主给额外调用记 usage，账本要重新设计**）；
5. `user/message` 的 `source.kind !== "user"` 仍渲染成不可见的 `context` 节点（隐藏注入通道）；
   `purpose` 仍能自由传值（递归防护的判据）；
6. `resolveModelInfo` 返回的 `reasoning.efforts` / `context.contextWindow` 形状不变，
   且 `UNSUPPORTED_REASONING_EFFORT` 仍是**抛错**而不是 clamp（否则 effort 降级逻辑可以简化）；
7. `LlmModelInfo` 仍然**没有价格字段**（有的话金额就不用用户填单价了）。

## 设置保存状态（USIM-U1-10，2026-11-28）

设置分节统一加了「保存状态」行与稳定锚点（[plugin-conventions §7.2.6](../plugin-conventions.md#72-设置页)）。
本节记录**桌面只读断言**（按约定只写不跑；真机证据见下面的 2026-11-28 记录）与单测覆盖位置。

**单测（每次提交都跑）**：`test/settings-save-status.test.js` —— 用迷你 hooks 运行时驱动
`lib/client.js` 里的真实组件，不复制实现。

**桌面只读断言**（不修改任何值、不点保存）：

1. 打开 设置 → 顾问：`[data-advisor-settings]` 存在且 `[data-advisor-error]` 不存在。
2. `[data-advisor-settings-status]` 存在，`data-state="clean"`，文本含「已保存」；
   clean 时旧锚点 `[data-advisor-dirty]` 必须不存在。
3. （dirty 态才有的旧锚点）改动后 `[data-advisor-dirty]` 存在且带 `data-advisor-dirty=""`——
   这是 `main` 上既有锚点，按 §7.8「新锚点附加、不删旧锚点」保留，桌面回归仍可用它定位未保存态。
4. `[data-advisor-settings-save]`（与既有 `[data-advisor-save]` 同一按钮）`disabled === true`。
5. 关闭对话框后断言它消失（与既有回归一致）。

失败态：状态行文本必须是「保存失败：原因」（原因与该分节顶部 `[data-advisor-error]` 横幅同源）。

**真机记录（2026-11-28，隔离实例 CDP 9410，`dsh plugin add file:<tgz>` 替换安装后重启）**：

| 场景     | 结果                                                                | 截图                                                |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| 无改动   | `data-state=clean`、「· 已保存」，保存按钮 `disabled`（opacity .6） | `/tmp/dsh-sim-rel/shots/settings-advisor-clean.png` |
| 改模式后 | `data-state=dirty`、「有未保存的改动」，保存按钮可点                | `/tmp/dsh-sim-rel/shots/settings-advisor-dirty.png` |
| 点保存后 | `data-state=saved`、绿色「已保存」                                  | `/tmp/dsh-sim-rel/shots/settings-advisor-saved.png` |

### 回执/轻提示不再遮挡输入区（发版后真机 P2，2026-11-28）

缺陷：命令回执固定 `right:24px;bottom:24px`；1280×820 有会话时回执高 204px，composer 在
y=700–736、发送按钮 y=748–782，回执把两者盖住（overlap y=36，证据脚本 `/tmp/advisor-receipt-overlap2.mjs`）。

修法：渲染时量 `[data-composer-input]` 顶部，`bottom = innerHeight - composerTop + 16`（无 composer
回退 24px），窗口 resize / composer 变高时重算；回执 `max-height` 按可用空间收缩，避免顶出视口。
纯函数 `toastBottomOffset` / `toastMaxHeight` / `toastBodyMaxHeight` 由 `test/client.test.js` 锁定，
桌面冒烟新增「回执 rect 与 composer/发送按钮无重叠」的几何断言。

> 常量演进：最初的 `gap=12` 是从**输入框顶部**算的，而 composer 卡片自身在输入框上方还有约 8px
> 内边距/边框，视觉上回执离卡片只剩 4px（复审 P3，见下面「复审 N：视觉间距」）。现在 `gap=16`，
> 视觉间距 8px。下面两张表是 `gap=12` 时代的真机记录（数字保留作历史对照）。

**真机记录（隔离实例 CDP 9410，`pnpm pack` 后 `dsh plugin add file:<tgz>` 替换安装并重启）**：

| 场景     | 结果                                                                                                   | 截图                                              |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 空白会话 | 回执 bottom=399、composer top=411（间距 12px），与 composer/send 的重叠均为 0，回执完整在视口内        | `/tmp/dsh-sim-rel/shots/nits-advisor-empty.png`   |
| 有会话   | 回执 bottom=688、composer top=700（间距 12px），与 composer/send 的重叠均为 0；max-height 收缩到 680px | `/tmp/dsh-sim-rel/shots/nits-advisor-session.png` |

### 复审后补强：composer 暂缺时回退位会重测（2026-11-28）

复审指出：回执出现时若量不到 `[data-composer-input]`，`measureToastLayout` 回退 24px 且不会重试，
可能停在旧 bug 位（压 composer）。修法：位置 effect 改为「出现时同步一次 + 每 1s 复核（只在 bottom 变化时
重渲染）+ resize/ResizeObserver」，composer 换节点/稍后挂载都能重新量到；轻提示也复用同一套
`maxHeight` 收缩（矮窗口不向上顶出视口）。注意它依赖宿主 DOM 锚点 `[data-composer-input]`，
事实已记入 [runtime §23.9](../runtime/0.2.2-rc.5.md)。

**真机记录（隔离实例 CDP 9410，`pnpm pack` 替换安装后重启；`gap=12` 时代）**：

| 场景                                 | 结果                                                               | 截图/证据                                            |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| 会话里有回执                         | 回执 bottom=688、composer top=700（间距 12）                       | `/tmp/dsh-sim-rel/shots/nits2-advisor-bump.json`     |
| 切到项目主面板（composer 卸载）      | 回执重新测量回退到 `style.bottom=24px`（不再停在旧 132px）         | `/tmp/dsh-sim-rel/shots/nits2-advisor-fallback.png`  |
| 切回会话（composer 回来后 ≤1s 复核） | `style.bottom=132px`、回执 bottom=688、与 composer/send 重叠均为 0 | `/tmp/dsh-sim-rel/shots/nits2-advisor-recovered.png` |

轻提示 maxHeight 未在真机单独触发（无低成本触发入口）；与回执共用 `toastMaxHeight` 单测路径。

### 复审 N：回执与 composer 卡片的视觉间距 4px → 8px（2026-11-28，P3）

复审（`notes/audit/2026-11-28/reviews/user-visible-nits.md` §3.1(c)/§5.2）指出：路径量的是
`[data-composer-input]` 顶部，但宿主 composer 卡片（`[data-composer-card]`）的顶部比输入框还高约 8px
（卡片内边距/边框，0.2.2-rc.5 实测），所以 `gap=12` 时回执底边到**卡片上沿**实际只有 4px，看起来贴着
输入框；composer 变高时同样只剩 4px。

修法：`TOAST_LAYOUT.gap` 12 → 16（换算关系 = 目标视觉间距 8px + 卡片内边距 8px），不动测量锚点
（仍是 runtime §23.9 记录的 `[data-composer-input]`），不改回退 24px / resize / ResizeObserver 路径。
单测（`packages/advisor/test/client.test.js`）：

```bash
cd packages/advisor && node --test
# 244 pass / 0 fail（38 suites）
```

- `sits one gap above the composer input, leaving 8px to the composer card`：1280×820、输入框 top=700
  → `bottom=136`，回执底边 y=684，卡片顶 y=692，**视觉间距 8px**（旧实现是 4px）。
- `keeps the gap/clamp invariants across viewports`：7 个视口高 × 8 个 composer top 扫一遍，
  `bottom ≥ 24`、`bottom + maxHeight + edge(8) == viewportHeight`（复审 §5.14(f) 的不变量）。
- 原有「无 composer 回退 24px」「矮窗口上界 `H−128`」「maxHeight/正文收缩」断言全部保留并按新常量更新
  期望值（132→136、680→676；正文上限仍 344）。

**真机记录（隔离实例 CDP 9432，本批代码；一次性数据目录已清理，截图留在 `/tmp/p3-review-evidence/advisor-gap.png`）**：

| 场景                                | 结果                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 空白会话触发 `/advisor status` 回执 | 视口 820、输入框 top=411、卡片顶=403、回执底=395 → **输入框间距 16px、卡片视觉间距 8px**；`style.bottom=425`、`maxHeight=387`，与 composer/send 无重叠 |

> 该实例用 worktree 构建覆盖 profile 里的发布版后再启动；属于「本批代码」的真机几何，不是上一节 `gap=12`
> 的历史记录。上一节两张 `bottom=688 / 间距 12` 的表保留作历史对照。

### 2026-11-28 发布后复测（0.6.5）

- 在「项目」面板直接起跑（composer 不存在）时，脚本会先尝试切回聊天会话并在日志打印诊断：`node scripts/smoke-advisor-desktop.mjs --port 9419 --require` → **25 PASS / 2 SKIP / 0 FAIL**（SKIP=未选 provider、无顾问记录）。
- 修复点：视角自愈（点击侧栏会话行/新建会话并等 composer），避免紧随其它 GUI 冒烟时把「无 composer」误判成产品故障。

### 2026-11-28 gate 复跑：活跃会话下视角自愈

- 在活跃会话（回合进行中/有草稿）里跑桌面只读时，脚本会挑一个有用户消息的空闲历史会话（命令卡片 DOM 只在历史会话渲染）；没有则新建空白会话。实测 live 9222 有活跃回合时 `27 PASS / 0 SKIP / 0 FAIL`。
