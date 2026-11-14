# @kangyishuai/dsh-advisor

> 给主模型配一个单独配置的顾问模型，由**主模型自己决定**什么时候值得问：动手之前、反复失败时、宣告完成之前。顾问只给建议：它读整段对话、返回结构化答复，不批准、不拦截、不执行任何动作。

[![npm](https://img.shields.io/npm/v/@kangyishuai/dsh-advisor?color=cb3837&logo=npm)](https://www.npmjs.com/package/@kangyishuai/dsh-advisor) [![DSH](https://img.shields.io/badge/verified%20on%20DSH-0.2.2--rc.3-4b6bfb)](#兼容性) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

非官方 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，与 DeepSeek 无关。

> **状态：早期。** 已针对当前目标 DSH 版本验证——见[兼容性](#兼容性)表格。工具、选择器和模型元数据查询都依赖半公开的宿主 seam，DSH 升级可能让它们静默失效（请先读[副作用、限制与风险](#副作用限制与风险)）。插件还年轻——建议先用 `shadow` 模式跑几天，盯着账本再决定是否开启。

## 它做什么

这是一个**按需**顾问，不是被动复查器。要不要花这一次调用，由主模型判断；插件不会按轮次自动重读整段对话，所以成本和延迟随**决策次数**增长，而不是随对话长度增长。

- **一个由模型调用的工具。** 插件只注册一个工具 `advisor`（没有必填参数，可选一个 `focus` 字符串说明这次想解决的疑点）。工具描述会告诉主模型：在实质动手前、同一个错误反复出现时、失败后准备换方案前、以及宣告任务完成前徵询；短平快的反应式任务则不要反复调用。
- **第二个模型读整段对话。** 一次徵询时，插件把会话渲染成一段有长度上限的文本——用户消息、助手消息、**工具调用及其结果**——发给配置的顾问路由。顾问与主模型可以是同一个模型、同一路由下的另一个模型，也可以是另一家 provider。
- **结构化建议，仍在同一个回合里。** 顾问返回一个 JSON 对象：结论（`reviewed` / `declined`）、严重度（`nit` / `concern` / `blocker`）、不超过 900 字符的建议、最多 5 条风险、最多 5 条验收项，以及证据锚点（工具调用 id、消息 id、路径）。「没什么可说的」是合法回答。结果作为普通工具结果回到主模型，不新起一个回合。
- **只建议，不裁决。** 顾问不能批准、不能拒绝、不能运行工具，它的输出也从不授权任何动作。做决定的仍然是主模型。
- **`off` / `shadow` / `advisory` 三种模式。** 默认 `off`。`shadow` 在每个正常完成的回合后徵询一次并记账，但不把建议回灌；`advisory` 是正式模式。
- **天生可跨厂商。** 顾问路由独立于主模型。不同模型族的盲区不一样，这正是「第二意见」的意义——但指向另一家之前，请先读[成本与隐私](#成本与隐私)。
- **有预算，有账本。** 每回合、每会话、每小时三个次数上限，外加每日金额上限；token 记在 `<DSH_HOME>/advisor/usage.jsonl`。DSH 不会为这种额外模型调用记 usage，所以插件自己记。
- **有决策日志，可以事后复盘「该不该问」。** `<DSH_HOME>/advisor/decisions.jsonl` **一个回合一行**（没徵询的回合也记），
  记下是否徵询、没徵询的原因码、回答长度/工具调用数/是否报错，以及徵询后用户的下一条消息是否照着建议做。
  `pnpm advisor:review` 会按桶统计徵询率与采纳率，并列出两类可疑样本：疑似漏徵询、疑似无效徵询。
  这样「什么时候该徵询」是用数据定的，而不是拍脑袋。只写本地文件，不联网、不改变徵询时机。

### 它不是什么

| 不是这个                      | 为什么                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| 每答一轮就复查一遍的 reviewer | 成本和延迟会随对话叠加，重复的「看起来没问题」只会增加噪音，不是信号。 |
| 权限 / 审批闸门               | 它只是建议：这里没有任何东西能放行或阻止一次工具调用。                 |
| 多模型投票面板                | 一个顾问、一个答案，没有聚合规则可吵。                                 |
| 模型路由器                    | 它从不切换主模型，只负责回答。                                         |

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-advisor
```

想在本地跑工作区里的源码，先打包再装——`link:` 装法不可用（宿主解析 `@deepseek-ai/*` 时只覆盖真实路径位于 profile 内的包）：

```bash
cd packages/advisor
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-advisor-*.tgz
```

改完代码要重新 `pnpm pack` 再 `add`。插件有 host 半和一层很薄的 client 半：**host 改动重启 DSH 桌面版**，**client 改动刷新页面**。在你配置好顾问路由并正式开启之前，它不会把任何内容发出去。

## 配置

**顾问模型的 baseURL、API key 和线路协议都不归本插件管。** 去 DSH 的*设置 → 模型*里配——也就是 `dsh-llm-pi-ai` 的 `providers` 字典，每个键是一条路由。本插件只保存**路由名**和模型 id，从不读写凭据。

插件设置只有一个 JSON 文件：`<DSH_HOME>/advisor.settings.json`（`DSH_HOME` 默认 `~/.dsh`，插件配置里的 `dataRoot` 可覆盖）。宿主在每次徵询前重读（1 秒缓存），所以改文件对下一次调用立即生效，不用重启。未知键会被丢弃，越界的数字会被夹紧到区间，文件损坏则回落到默认值。**默认是 `off`**——一个会花钱、会把会话内容发出去的插件必须显式开启。

**设置页。** 设置 → **顾问**（独立分节，不再挤在通用设置里）。首屏只有三行摘要：模式、路由、预算；
其余项收进「更多设置」折叠，默认收起。默认 `off` 时只显示模式、一句状态和「配置顾问」；启用后才显示：

- **基础**：模式、币种、服务商、模型、思考档、每日预算、发送范围、发送前脱敏。
- **高级**（默认折叠）：调用限额、工作区限额、人民币汇率、单价（含缓存读取/写入）、输出/输入上限、建议条数、白名单、答后复查、读文件核实、影子去重、记录发送内容；折叠标题会标出「默认值」或「N 项已修改」。
- **状态与诊断**（默认折叠）：累计调用/token/金额、最近结果/跳过原因、发送预览、诊断、设置文件与账本路径。

高级字段旁的「?」点开或用键盘激活会显示说明、默认值与范围、技术名；悬停只是补充。改完点「保存」才对下一次徵询生效。

金额字段支持小数：预算最多 2 位，单价最多 4 位。

| 键                        | 设置页名称                    | 默认        | 范围 / 取值                          | 说明                                                                                                                                                                                                               |
| ------------------------- | ----------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`                    | 模式                          | `"off"`     | off / shadow / advisory              | 是否允许徵询。默认关闭，显式开启才生效。                                                                                                                                                                           |
| `provider`                | 服务商                        | `""`        | 设置 → 模型里的路由名，≤300 字符     | 顾问路由。留空 = 永不调用。                                                                                                                                                                                        |
| `model`                   | 模型                          | `""`        | 该路由下的模型 id，≤300 字符         | 顾问模型。留空 = 永不调用。                                                                                                                                                                                        |
| `reasoningEffort`         | 思考档                        | `""`        | 模型支持的思考档 id，`""` = 模型默认 | 填了不支持的值会去掉思考档重试一次。                                                                                                                                                                               |
| `maxTokens`               | 输出上限                      | `4096`      | 256–32000                            | 单次徵询最多生成多少 token。                                                                                                                                                                                       |
| `temperature`             | 随机性                        | `null`      | 0–2，`null` = 不传                   | 留空由模型决定。                                                                                                                                                                                                   |
| `maxCallsPerTurn`         | 每回合调用上限                | `1`         | 0–8，0 = 不限                        | 每回合最多徵询几次。                                                                                                                                                                                               |
| `maxCallsPerSession`      | 每会话调用上限                | `32`        | 0–1000，0 = 不限                     | 每个会话最多徵询几次。                                                                                                                                                                                             |
| `maxCallsPerHour`         | 每小时调用上限                | `12`        | 0–500，0 = 不限                      | 滚动一小时内。                                                                                                                                                                                                     |
| `currency`                | 币种                          | `"USD"`     | USD / CNY                            | 金额和单价按此币种填写；账本/预算池内部仍记 USD。                                                                                                                                                                  |
| `usdToCny`                | 人民币汇率                    | `7.2`       | 0.1–100                              | 1 USD = ? CNY；只在人民币时用于换算；手动维护，不联网。                                                                                                                                                            |
| `maxCostPerDay`           | 每日预算（按币种）            | `0`         | 0–10000，0 = 不限；最多 2 位小数     | 每天最多花多少（按 `currency`）；只有填了单价才计算金额。                                                                                                                                                          |
| `priceInputPerMTok`       | 输入单价                      | `0`         | 0–1000；最多 4 位小数                | 顾问模型输入价，按 `currency` / 百万 token；0 = 不算钱。                                                                                                                                                           |
| `priceOutputPerMTok`      | 输出单价                      | `0`         | 0–1000；最多 4 位小数                | 输出价，按 `currency` / 百万 token。                                                                                                                                                                               |
| `priceCacheReadPerMTok`   | 缓存读取单价                  | `0`         | 0–1000；最多 4 位小数                | 缓存读取/命中的输入 token 单价，按 `currency`；0 = 不计缓存部分。                                                                                                                                                  |
| `priceCacheWritePerMTok`  | 缓存写入单价                  | `0`         | 0–1000；最多 4 位小数                | 缓存写入/创建的输入 token 单价，按 `currency`；0 = 不计缓存部分。                                                                                                                                                  |
| `privacyScope`            | 发送范围                      | `"summary"` | off / summary / full                 | 发多少会话内容，见「成本与隐私」。                                                                                                                                                                                 |
| `redact`                  | 发送前脱敏                    | `true`      | 布尔                                 | 尽量遮掉常见密钥格式；不能保证全部遮住。                                                                                                                                                                           |
| `immuneTurns`             | 仅 JSON：免疫回合             | `3`         | 0–20                                 | 投递后保持安静的回合数；只用于 shadow 投递。                                                                                                                                                                       |
| `dedupe`                  | 影子模式去重                  | `true`      | 布尔                                 | 影子模式下相同建议只记一次；工具路径不据此拦截。                                                                                                                                                                   |
| `sessionCap`              | 建议条数上限                  | `24`        | 0–200                                | 单会话最多展示几条建议；到顶后只有 blocker 继续。                                                                                                                                                                  |
| `tiers`                   | 仅 JSON：能力档位             | `{}`        | `"provider/model"` → 数字            | 配对校验用的档位；没有条目时结论是「未校验」。                                                                                                                                                                     |
| `allowedModels`           | 模型白名单                    | `[]`        | 字符串数组                           | 留空 = 不限制；可写 provider/model 或裸 model id。                                                                                                                                                                 |
| `confirmedHosts`          | 仅 JSON/按钮：已确认 provider | `[]`        | 字符串数组                           | 跨 provider 发送的确认名单；设置卡里的按钮会写入。                                                                                                                                                                 |
| `pairingEnforcement`      | 仅 JSON：配对校验             | `"warn"`    | warn / block                         | 顾问档位低于主模型时：warn 放行并告警，block 拒绝。                                                                                                                                                                |
| `workspaceMaxCallsPerDay` | 工作区每日调用上限            | `200`       | 0–100000，0 = 不限                   | 工作区级，跨会话累计，按本地日重置。                                                                                                                                                                               |
| `workspaceMaxCostPerDay`  | 工作区每日预算（按币种）      | `0`         | 0–10000，0 = 不限；最多 2 位小数     | 工作区级每日金额上限（按 `currency`）。                                                                                                                                                                            |
| `postAnswer`              | 回合结束后自动复查            | `"off"`     | off / card                           | advisory 模式下每轮回答后自动复查一次；只记录，不插回对话。                                                                                                                                                        |
| `advisorTools`            | 允许顾问读文件核实            | `false`     | 布尔                                 | 允许顾问读工作目录内的文件（≤5 个、只读）；多一次调用。                                                                                                                                                            |
| `tracePrompt`             | 记录发送内容                  | `"preview"` | `preview` / `off`                    | 在会话记录里保留实际发送文本的首尾各 2,000 字符（脱敏后）；`off` 只记元数据。                                                                                                                                      |
| `timeoutMs`               | 仅 JSON：超时                 | `90000`     | 5000–600000                          | 单次徵询超时；`/advisor cancel` 可以更早中止。撞上超时会返回 `code: "timeout"`（与 `aborted` 分开）。慢路由真的会撞到：本机 28 次真实徵询实测 p50 6.2s / p90 52.5s，其中两次打满 90 秒——先量你那条路由，慢就调大。 |
| `maxInputChars`           | 输入上限                      | `60000`     | 4000–400000                          | 会话文本总预算；超出保留首尾、省略中间。                                                                                                                                                                           |

**缓存单价。** 宿主 usage 里只有 `cacheReadTokens` / `cacheWriteTokens`（都是输入侧），没有缓存输出 token；缓存 token 是额外的输入 token，不从 `inputTokens` 扣。`priceCacheReadPerMTok` / `priceCacheWritePerMTok` 为 0 时不计缓存部分；如果账本里有缓存 token 而缓存单价为 0，状态区会提示「缓存 token 未计价」。内置参考价没有缓存价，不做猜测。

**币种与账本。** 设置里的金额和单价按 `currency` 填写（USD/CNY），`usdToCny` 是手动汇率。账本与工作区预算池内部始终记 USD：调用时把设置金额换算成 USD，展示时再换回当前币种。切换币种会按汇率折算当前表单金额，保存前不会落盘；旧版 `maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd` 键会按 USD 自动迁移到新键。汇率变化只影响之后的换算和展示，不会重写历史账本。

> **关于 `sessionCap`、`dedupe`、`immuneTurns`：** `sessionCap` 会生效——单会话投递到上限后，只有 `blocker` 级建议还会返回。`dedupe` 与 `immuneTurns` 会被保存并用于 shadow 路径，但工具路径不会因为它们跳过徵询（是模型显式要求的）。真正会拦住**调用本身**的是 `maxCallsPerTurn` / `maxCallsPerSession` / `maxCallsPerHour` / `maxCostPerDay`。

示例（路由名和模型名是占位，请用选择器里看到的真实值）：

```json
{
  "mode": "shadow",
  "provider": "my-router",
  "model": "large-model",
  "priceInputPerMTok": 3,
  "priceOutputPerMTok": 15
}
```

**选模型。** `/advisor` 会打开选择器，列出 DSH 里已经配好的路由与模型，外加*关闭*和*添加 / 配置 provider*。选中一个模型会把 `mode` 切成 `advisory`。还缺什么，`/advisor doctor` 会逐条告诉你。

## 命令

| 命令                                   | 行为                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/advisor`                             | 打开模型选择器（client 半）。每次打开都重新取路由和模型，不跨次缓存。                                                                               |
| `/advisor status`                      | 模式、顾问路由、本会话 / 本回合已用与上限、累计 token、最近一次结果，以及最近一次「为什么没徵询」。                                                 |
| `/advisor on`                          | 切到 `advisory`。还没配置顾问模型时拒绝执行，并指向选择器。                                                                                         |
| `/advisor off`                         | 切到 `off`：不徵询，不发请求。                                                                                                                      |
| `/advisor shadow`                      | 切到 `shadow`：每个完成的回合后徵询一次并记账，但不回灌。                                                                                           |
| `/advisor ask`                         | **立刻**徵询一次，并把建议作为命令输出返回。                                                                                                        |
| `/advisor cancel`                      | 中止在途徵询——请求会被真正 abort，不只是忽略结果。                                                                                                  |
| `/advisor doctor`                      | 逐项自检：宿主 `llm` 服务、已注册路由、路由解析与上下文窗口、支持的思考档、模式、会话预算、账本状态、最近一次失败。每行给出结论，必要时给出下一步。 |
| `/advisor <provider>/<model> [effort]` | 直接指定顾问路由，校验规则与选择器一致（未知路由、缺凭据、不支持的思考档都会给可读原因）。                                                          |

`advisor` **工具**和命令是两回事：工具由模型调用，不是你。它没有必填参数；可选的 `focus` 是一句话，用来说明你想让顾问解决的疑点——不是任务本身，任务永远是整段对话。

每次徵询还会在回合末尾留下一条紧凑的顾问线（不进入模型可见的 surface）；展开后显示本次徵询的触发方式、本地时间、顾问模型、发送字符数与用量/成本摘要。 记录了发送内容时，展开后可以点「查看发送内容」看当时实际发送文本的首尾片段。

## 成本与隐私

这一节请在开启前读完。

- **每次徵询都是一次额外的模型调用**，按顾问路由计费，走那家 provider 的额度。主模型自身的 usage 不受影响。
- **token 由插件自己记账。** DSH 只为主动环里的 assistant 消息记 usage，所以插件单写一份账本：`<DSH_HOME>/advisor/usage.jsonl`，一次徵询一行 JSON（时间、会话 id、触发方式 `tool` / `shadow` / `manual`、provider、model、思考档、结论、严重度、输入 / 输出 / 缓存读/写 token、估算金额、耗时、错误码）。文件只追加，超过 2 MiB 滚动到 `usage.jsonl.1`，启动时从文件尾部恢复累计数。
- **算钱需要你填单价。** DSH 的模型元数据没有价格字段。按 `currency` 填 `priceInputPerMTok`、`priceOutputPerMTok`、`priceCacheReadPerMTok`、`priceCacheWritePerMTok`；都留 0 时账本只记 token，界面不显示金额。账本内部记 USD 等价，内置参考价是 USD，人民币展示时折算；内置参考价没有缓存价。插件从不猜价格。
- **每日预算统计的是已经记下的花费**，所以跨过上限的那一次徵询仍会完成并计费。
- **顾问路由在外部时，会话内容会离开本机。** 渲染后的会话文本（含工具调用与结果，受 `privacyScope` 和 `maxInputChars` 限制）会发到该路由指向的 baseURL。如果那是另一家厂商，你的对话就离开了这台机器；只有指向本地网关的路由才留在本机。除此之外插件什么都不发：没有遥测，没有统计，除了徵询本身不访问网络。
- **`privacyScope` 决定发多少。** `summary`（默认）：每个文本块最多 2,000 字符，工具参数最多 300，工具结果最多 700。`off`：只发用户与助手的文本（最多 1,200 字符），完全不发工具往来。`full`：文本最多 4,000，工具参数最多 1,200，工具结果最多 3,500。渲染完再按 `maxInputChars`（默认 60,000）封顶：保留前 30% 和结尾，中间替换成省略标记。
- **脱敏是尽力而为。** `redact: true`（默认）会在**截断之前**清掉常见的密钥形态字符串、`Authorization` 头、`KEY=` / `TOKEN:` 形式的赋值、URL 里内嵌的凭据，以及 PEM 私钥块。它是启发式过滤，**不是密钥扫描器**：一定会漏，也无法保证密钥绝不外发；更不能替代「这个仓库是否允许发给那家 provider」这个判断。
- **发送预览会写入会话记录。** `tracePrompt: "preview"`（默认）会把本次实际发送文本的首尾各 2,000 字符（脱敏、按 `maxInputChars` 截断后）写进会话插件记录，展开顾问线后可查看；`off` 只记元数据。若同时关闭 `redact`，预览就是原文片段。
- **先开 `shadow`。** 它回答的是「它本来会说什么、本来要花多少」，但不把模型输出塞回你的会话。看几天账本，再切到 `advisory`。

## 兼容性

| 已验证的 DSH 版本 | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.2.2-rc.3        | **0.6.2**（2026-11-14）：把**超时**与**取消**分开。撞上 `timeoutMs`（默认 90 秒）的徵询现在返回 `code: "timeout"` 与「顾问调用超时（N 秒）」，不再混进 `aborted`——与本 README 早先承诺的失败码清单对齐；不足 1 秒的时长也不再显示「0 秒」。定位来自一次真实的 `aborted` 工具结果：call/result 时间戳相差 90,017ms，账本记 `ms:90002` 且 token 为 0，而本机没有 `settings.json`（即用的内置 90 秒默认）。28 次真实徵询实测 p50 6.2s / p90 52.5s、两次打满上限，所以默认值保持不变、改为把数据写进文档。已验证：142 项单测（新增 4）+ `pnpm probe:runtime` 72/72 + web `pnpm smoke:advisor` **14/14** + 桌面只读回归 **19 PASS + 1 SKIP**；超时/取消/报错/正常四条路径另用 stub 宿主验证过。 |
| 0.2.2-rc.2        | **0.6.0 → 0.6.1**（2026-11-14）：新增决策日志 `decisions.jsonl` + `pnpm advisor:review` 复盘；设置搬到「设置 → 顾问」分节（首屏三行摘要 + 更多设置折叠）。已验证：单测（含 `decisions` 20 项、linter 全绿）+ `pnpm probe:runtime` 72/72 + web `pnpm smoke:advisor` **14/14**（临时 DSH home，不发起模型调用）。设置分节另有真机只读 CDP 核验（DOM + 截图：三行摘要、更多设置默认收起）；桌面只读回归 **19 PASS + 1 SKIP**（SKIP 是该会话没有顾问记录，脚本不制造徵询）。0.6.1 只修决策日志的原因码归类（`aborted`/`blocked` 不再落到 `skipped-other`），单测 18 项覆盖，未复跑桌面回归。                                                                                                   |
| 0.2.2-rc.1        | 已在该版本验证：单测（81 条）与 `pnpm probe:runtime`；web 端到端冒烟 `pnpm smoke:advisor`、桌面端只读回归 `pnpm smoke:advisor-desktop`。其他 DSH 版本未验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

插件不声明 `engines.dsh`，也不声明 `@deepseek-ai/*` 的 peer 范围：DSH 还在预发布阶段，semver 对预发布版本不可靠（见 [ADR 0005](../../docs/adr/0005-dsh-version-compatibility.md)）。这张表就是兼容性声明。DSH 升级后请跑 `pnpm probe:runtime`、`pnpm smoke:advisor-desktop` 和单测，再看 `/advisor doctor`。

## 副作用、限制与风险

**它会写什么**

| 路径                                       | 内容                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `<DSH_HOME>/advisor.settings.json`         | 插件设置；由 `/advisor` 和选择器写入，每次徵询前重读。 |
| `<DSH_HOME>/advisor/usage.jsonl`（+ `.1`） | 一次徵询一行；只追加，超过 2 MiB 滚动。                |

没有别的：不写工作区文件，不往会话日志里塞自己的记录（一次徵询就是普通的工具调用与工具结果），没有遥测。

- **建议是模型输出。** 它可能错、可能空泛、可能一本正经地错。插件校验的是*形状*——是 JSON 对象、结论与严重度在闭集内、长度封顶、证据锚点格式合法——不是内容。请自己掂量、自己核实；做决定的仍然是主模型。
- **半公开的宿主 seam。** host 侧的 `llm.prepareCall`、`llm.resolveModelInfo`、`session.deriveMessages`、`tools.register`、`commands.register`、`session/event`，以及 client 侧的 `commandUi.decorate`（选择器），都不是稳定的公开 API。DSH 升级可能静默地让工具、选择器或命令失效。每次升级后跑 `pnpm probe:runtime`；安装失败只写日志不抛错，所以还要看 `/advisor doctor` 和宿主日志。
- **配对档位需要你自己声明。** DSH 没有跨厂商的能力目录，所以「顾问是不是至少和主模型一样强」只能来自你填的 `tiers`。没有条目时结论是**未校验**，徵询照常进行；它不会假装校验通过。把 `pairingEnforcement` 设成 `"block"` 时，档位更低的顾问会被拒绝。
- **被中止的调用 token 可能记少。** 徵询被取消或超时时，可能收不到 usage chunk；账本会把这次记成 0 token，金额预算可能落后于真实花费。把账本当可靠估算，别当账单。
- **顾问路由可能因为插件之外的原因坏掉**（baseURL 写错、缺密钥、限流）。所有失败都会变成结构化的工具结果（`MISSING_CREDENTIAL`、`rate_limited`、`overloaded`、`prompt_too_long`、`timeout`、`aborted`…），不会把回合弄断。
- **设置页在「设置 → 顾问」这个独立分节里**（首屏三行摘要 + 「更多设置」折叠）；标了「仅 JSON」的键仍要改设置文件，或继续用 `/advisor` 选择器。
- **部分生效的旋钮。** `sessionCap` 会限制单会话投递条数（blocker 豁免）；`dedupe` / `immuneTurns` 只在 shadow 路径上有意义——见[配置](#配置)。
- **只试一次，没有重试循环。** 顾问输出解析失败会报 unavailable，不重试；不支持的思考档只会去掉思考档重试一次。
- **`shadow` 模式照样花钱。** 它省掉的是回灌，不是调用。而且 `shadow` 期间，模型主动调用 `advisor` 工具仍会拿到建议：这个模式抑制的是回合结束后的自动复查，不是模型发起的徵询。要彻底停调用请用 `off`。
- **子代理会话**不会被自动 shadow 复查；只有顶层会话的回合会被复查。

## 测试与验证

```bash
pnpm verify                        # 仓库级门禁：lint、类型、插件规范、文档一致性、单测
cd packages/advisor && pnpm test   # 本插件的单测（node --test）
pnpm smoke:advisor                 # web 端到端冒烟（一次性 DSH_HOME，不花钱）
pnpm smoke:advisor-desktop         # 桌面版（Electron）只读回归，走 CDP
pnpm smoke:agent-tool              # 仓库级真实模型工具冒烟（需要凭据，没有就 SKIP）
```

- `pnpm verify` 是发版门禁，提 PR 之前必须通过。
- `pnpm smoke:advisor` 在一次性 `DSH_HOME` 里起真实宿主（只放一个临时工作区、不需要凭据），装包后验证：client 半加载、`/` 菜单出现 `advisor`、设置卡渲染、`/advisor doctor`/`preview`/`confirm`/`report all` 都有输出，并断言**没有生成账本文件**（即没有花钱）。命令输出读会话日志，因为宿主的命令卡片在 DOM 里是折叠的。
- `pnpm smoke:advisor-desktop` 是桌面版（Electron）只读回归；插件有 client 半，所以这是硬性要求。它通过 CDP 连上正在运行的应用、确认 client 半真的加载，**不会**触发需要付费的徵询。发版门禁里加 `--require`，这样连不上调试端口会失败而不是静默跳过。它要求应用用 `open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` 启动。
- `pnpm smoke:agent-tool` 在一次性 DSH 目录里用真实模型驱动一个已注册工具。需要模型凭据；没有凭据时以 SKIP 退出——SKIP 不等于通过。

真机端到端验证（确认「真的发生过一次顾问调用」只能靠这一步）：

1. `cd packages/advisor && pnpm pack --pack-destination /tmp`，然后 `dsh plugin --profile desktop add /tmp/kangyishuai-dsh-advisor-*.tgz`。
2. 重启 DSH 桌面版；如果还没配，先在*设置 → 模型*里配好顾问路由。
3. `/advisor doctor` 每一行都应有解释；`/advisor` 能列出你的模型，选一个。
4. `/advisor shadow`，然后正常做一轮任务。确认 `<DSH_HOME>/advisor/usage.jsonl` 多了一行，且建议没有被注入会话。
5. `/advisor on`（或 `/advisor ask` 单次徵询）。确认工具卡 / 命令输出里有建议，且 `/advisor status` 的计数在动。
6. 用完 `/advisor off`。`dsh plugin --profile desktop remove @kangyishuai/dsh-advisor` 卸载代码；设置文件和账本会保留。

测试分层、断言明细与完整的手工 GUI 清单见 [docs/testing/advisor.md](../../docs/testing/advisor.md)；设计取舍见 [ADR 0010](../../docs/adr/0010-advisor-architecture.md)。

## License

MIT。源码、issue 与发版记录：[kangyishuai/dsh-plugins → packages/advisor](https://github.com/kangyishuai/dsh-plugins/tree/main/packages/advisor)。
