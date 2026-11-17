# @kangyishuai/dsh-casefile

> DeepSeek Harness 里的 REA 循证工作台：把观察变成可引用的证据、可交接的规格包、可复算的验收，而不是随会话消失的结论。

[English](./README.md)

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的非官方插件，与 DeepSeek 无关。它是 [REA](https://github.com/morluto/rea)（MIT）之上的适配层：不包含 REA 的代码，也不带分析引擎。

> **状态：M3（自动循环 + near-miss + web checker）。** 落盘「项目 / 证据 / 结论 / 功能 / 未知项 / 义务 / 检查记录」，能导出去原始化的规格包，并提供工作台页（证据 / 义务 / 运行）、侧栏入口与设置分节。现在可以从项目里起一个 **builder 会话**：casefile 建子会话、只投喂规格包（不投原件），返回 sessionId；`awaitBuilder` 报它为什么停下。`case_build loop` 一次跑完一轮：构建 → 按义务自带的检查配方逐个检查 → 通过的关闭 → 命中停止条件就停。构建/检查循环真的跑命令：`case_build start` 落 `BuildRun` 并算实现 digest，`case_check run` 记录绑定该 digest 的检查结果；之后再构建若 digest 变了，**自动重开**已被它关闭的义务。已通过 70 项单元测试、临时 DSH_HOME 上的 30 项 web 端到端冒烟（含 stale 重开路径），以及真实浏览器里的一轮手工 GUI 检查；桌面只读回归脚本已写好，但仍需先把插件装进桌面 profile 才能跑。请按早期软件对待。

## 它解决什么

REA 很擅长产出「有证据支撑的观察」。它不做的是**留住这些观察**：证据只活在一次会话的工具结果里，会话一结束就没了。

casefile 补的就是这一层：

- **项目是一等对象。** 一个目标 = 一个项目目录，记录授权档（`owned` / `authorized` / `research`）、范围（`all` / `selected`）、REA 版本与能力哈希。
- **证据账本。** 每条观察落成一条 `Evidence`，**原样保留** REA 自己的 `confidence`（observed / derived / inferred）与 `authority`（shipped-artifact / controlled-replay / live-observation / external），加 `limitations` 与可选的 integrity。casefile 不重新判定这些。
- **可引用、可选中的结论。** `Claim` 是交接时被引用的单位：引用证据 id、带自己的局限、可被勾选（`case_claim select`）进入规格包。
- **功能分组。** 把选中的结论归到 `Feature`，写清边界与非目标——后续「只复刻这些功能」的范围单位。
- **未知项必须随包交付。** 未解决的未知项会进规格包；悄悄丢掉的包等于说谎。
- **规格包导出。** `case_brief export` 写出 `spec/<时间戳>/spec.json` + `brief.md`：选中的结论、证据、功能、未知项、覆盖度摘要与内容哈希。默认脱敏（home、绝对路径、常见 token 形态）。
- **能力探测。** `case_project` 与 `diagnose()` 报告 `mcp__rea__*` 是否可见、casefile 依赖的工具缺哪些，而不是静默降级。

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-casefile
```

想跑工作树而不是发布版，先打包——`link:` 安装激活不了（宿主的 `@deepseek-ai/*` 解析只覆盖 realpath 在 profile 内的包）：

```bash
cd packages/casefile
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-casefile-*.tgz
```

改代码后要重新 `pnpm pack` + `add`；装完**重启** DSH 桌面版（这是 host 半）。

## 前置条件

- DSH 里已注册一个 REA MCP server，工具名为 `mcp__rea__*`（REA 官方 `rea setup` 或任意社区桥）。casefile **不会**自己插那一行——会和 REA 官方的 `rea-mcp` 行撞名。
- 没有 REA 也能手动记证据，但能力探测会报 `missing`，后续里程碑的检查会降级。

## 工作台

插件在侧栏加一个「案卷」入口。页面左侧是项目列表，右侧是选中项目的三个页签：

- **证据** —— 结论（带可信度、局限、证据数）与它们引用的证据记录；
- **义务** —— 义务、状态与未解决未知项。关闭义务需要**新鲜的 PASS 检查**；在 M2 的 checker 落地前，按钮会说明缺什么，而不是假装能关；
- **运行** —— 构建轮次、检查结论与循环停止条件。

设置分节显示数据根、项目数与 REA 能力状态，「REA 到底接没接上」不用翻日志就能回答。

## 工具

| 工具            | 动作                                 | 用途                                          |
| --------------- | ------------------------------------ | --------------------------------------------- |
| `case_project`  | `open` / `list` / `get` / `update`   | 新建/打开项目、列表、详情、改授权档/范围/状态 |
| `case_evidence` | `add` / `list` / `show`              | 把 REA 观察写成证据；过滤；看单条             |
| `case_claim`    | `add` / `list` / `search` / `select` | 写可引用结论；搜索；勾选进入规格包            |
| `case_feature`  | `add` / `list`                       | 把结论归到功能，写边界与非目标                |
| `case_unknown`  | `add` / `list` / `resolve`           | 记录未知项；带备注标记已解决                  |
| `case_brief`    | `export`                             | 写出脱敏的规格包（`spec.json` + `brief.md`）  |

所有工具统一返回 `{ ok, data?, error?{code,message,hint}, summary }`；错误带稳定 code，模型能自行纠正而不是猜。

## Checker

| Checker | 判什么                                                                | 三态                             |
| ------- | --------------------------------------------------------------------- | -------------------------------- |
| `build` | shell 构建命令：退出码 + 产物                                         | pass / fail / unknown(超时)      |
| `cli`   | 命令对照 `{ exitCode, stdoutIncludes, stdoutEquals, stderrIncludes }` | pass / fail / unknown(超时)      |
| `web`   | 两张 PNG 截图：相似度 = 1 − 平均绝对差/255，外加尺寸检查              | pass / fail / unknown(缺图/坏图) |

截图采集由别处完成（REA 的 browser 工具或用户自己的工具），`web` checker 只负责判定。PNG 解码器在仓库内（`lib/core/png.js`，无第三方依赖），支持 8-bit RGB/RGBA、非隔行。

## 防假绿灯

测试里有 **near-miss 注入**：同一个义务在正确实现上关闭后，只改一个字符，下一轮必须判定失败并把义务重开；构建失败时直接跳过检查，不产生误导性的 pass。见 `packages/casefile/test/near-miss.test.js`。

## 数据布局

全部在插件数据根下（默认 `<DSH_HOME>/casefile`，可用 `dataRoot` 覆盖）：

```
casefile/
└── projects/<project-id>/
    ├── project.json          # version + 目标 + 授权档 + 范围 + REA 版本
    ├── evidence.jsonl        # append-only；同 id 后者胜
    ├── claims.jsonl
    ├── features.jsonl
    ├── unknowns.jsonl
    ├── audit.jsonl           # 谁做了什么，append-only
    └── spec/<时间戳>/        # 导出的 spec.json + brief.md
```

规则：JSON 文件带 `version`；被更新版 casefile 写过的文件会报「只读」而不是被静默改写。坏 JSON 改名 `.broken` 保留。记录 append-only，项目目录可以 review、可以 diff。

## 配置

| 键                 | 默认                  | 含义                                      |
| ------------------ | --------------------- | ----------------------------------------- |
| `dataRoot`         | `<DSH_HOME>/casefile` | 项目数据位置；测试可注入                  |
| `defaultAuthTier`  | `research`            | 新项目默认授权档                          |
| `cleanRoomDefault` | `true`                | 预留给 builder 里程碑：builder 看不到原件 |
| `checkers`         | `["cli","web"]`       | 预留给验收里程碑                          |
| `maxRounds`        | `5`                   | 预留给循环                                |
| `redactOnExport`   | `true`                | 导出强制脱敏                              |

配置写在 `cordis.patch.yml` 里 `casefile` 那一行的 `config:`，不要手改 profile。

## 兼容性

| 插件  | 已在哪个 DSH 上验证                                                            |
| ----- | ------------------------------------------------------------------------------ |
| 0.0.x | 0.2.2-rc.3（Host API 通过运行时勘察核实，见 `docs/runtime/0.2.2-rc.3.md` §10） |

## 副作用与风险

- **写哪些文件：** 只写上面的数据根。不写被调查的项目、不改 REA 二进制、不编辑 profile。
- **破坏性操作：** M0 没有。后续里程碑（删项目、清 artifacts）遵循仓库 [ADR 0002](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0002-destructive-operations.md)：默认移入回收站、确认框给一行影响面、支持 dry-run、写审计。
- **隐私：** 项目数据只在本机。规格包默认脱敏（`HOME`、绝对路径、常见 token 形态），但**分享前仍应自己过一遍**——脱敏是安全网，不是保证。
- **证据质量：** casefile 只存你告诉它的东西。它不验证观察，也从不提升结论的可信度或权威性。
- **法务：** 面向研究与「你拥有或已获授权分析」的软件。刻意**不提供** DRM/反调试绕过，也不提供复用第三方资产的途径。使用前读 [DISCLAIMER.md](./DISCLAIMER.md)。

## 开发

```bash
pnpm verify        # lint + 类型检查 + 插件规范 + 测试
pnpm check         # 插件规范 + 索引元数据
pnpm test          # 单包单测
```

## 许可

MIT。见 [LICENSE](./LICENSE) 与 [DISCLAIMER.md](./DISCLAIMER.md)。
