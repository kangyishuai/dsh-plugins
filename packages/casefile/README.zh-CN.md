# @kangyishuai/dsh-casefile

> DeepSeek Harness 里的 REA 循证工作台：把观察变成可引用的证据、可交接的规格包、可复算的验收，而不是随会话消失的结论。

[English](./README.md)

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的非官方插件，与 DeepSeek 无关。它是 [REA](https://github.com/morluto/rea)（MIT）之上的适配层：不包含 REA 的代码，也不带分析引擎。

> **状态：M3 完成（五类 checker + 一次调用闭环 + near-miss + 覆盖率硬门 + 报告）。** 落盘「项目 / 证据 / 结论 / 功能 / 未知项 / 义务 / 检查记录」，能导出去原始化的规格包，并提供工作台页（证据 / 义务 / 运行）、侧栏入口与设置分节。现在可以从项目里起一个 **builder 会话**：casefile 建子会话、只投喂规格包（不投原件），返回 sessionId；`awaitBuilder` 报它为什么停下。`case_build loop` 一次跑完一轮：构建 → 按义务自带的检查配方逐个检查 → 通过的关闭 → 命中停止条件就停。构建/检查循环真的跑命令：`case_build start` 落 `BuildRun` 并算实现 digest，`case_check run` 记录绑定该 digest 的检查结果；之后再构建若 digest 变了，**自动重开**已被它关闭的义务。验证以包内单测 + 临时 DSH_HOME 上的 web 端到端冒烟（含 stale 重开路径）+ 桌面只读回归为准，具体条数与命令见 [docs/testing/casefile.md](../../docs/testing/casefile.md)。请按早期软件对待。

## 它解决什么

REA 很擅长产出「有证据支撑的观察」。它不做的是**留住这些观察**：证据只活在一次会话的工具结果里，会话一结束就没了。

casefile 补的就是这一层：

- **项目是一等对象。** 一个目标 = 一个项目目录，记录授权档（`owned` / `authorized` / `research`）、范围（`all` / `selected`）、REA 版本与能力哈希。
- **证据账本。** 每条观察落成一条 `Evidence`，**原样保留** REA 自己的 `confidence`（observed / derived / inferred）与 `authority`（shipped-artifact / controlled-replay / live-observation / external），加 `limitations` 与可选的 integrity。casefile 不重新判定这些。
- **可引用、可选中的结论。** `Claim` 是交接时被引用的单位：引用证据 id、带自己的局限、可被勾选（`case_claim select`）进入规格包。
- **功能分组。** 把选中的结论归到 `Feature`，写清边界与非目标——后续「只复刻这些功能」的范围单位。
- **未知项必须随包交付。** 未解决的未知项会进规格包；悄悄丢掉的包等于说谎。
- **规格包导出。** `case_brief export` 写出 `spec/<时间戳>/spec.json` + `brief.md`：选中的结论、证据、功能、未知项、覆盖度摘要与内容哈希。默认脱敏，且规格包、机器可读 bundle 与验收报告**共用同一套脱敏**（见[副作用与风险](#副作用与风险)的「隐私」段）。

## 脱敏

三条导出（规格包、bundle、报告）都走同一个 `redactPack`，`case_project report` 默认也脱敏：

- **路径：** 常见系统根目录下的任意路径（`/Users`、`/home`、`/var`、`/tmp`、`/private`、`/Applications`、`/Volumes`、`/opt`、`/etc`、`/Library`、`/usr`、`/System`、`/bin`、`/sbin`、`/dev`、`/proc`、`/boot`、`/root`、`/mnt`、`/media`、`/snap`、`/nix`、`/data`、`/srv`、`/workspace`）、未展开的 `~/…`、以及任何**以 1–8 字符扩展名结尾的绝对路径** → `<path>`。
- **Token：** `sk-…`、`ghp_…`、`github_pat_…`、AWS `AKIA…`/`ASIA…`、Google `AIza…`、`npm_…`、`xox[abp]-…`、`Bearer …`、JWT（`eyJ…`）、PEM 私钥块，以及 `password=` / `api_key=` / `secret=` / `token=` 的值 → `[redacted]`。
- **刻意保留：** **不带扩展名**的 URL 与 API 路由（`https://example.test/api/todos`、`POST /api/todos`、`/auth/token`）保持可读——把每个路由都变成 `<path>` 的规格包对 builder 没有价值。带文件扩展名的绝对路径即使像路由也会被遮（`/static/app.js`、`/api/v1/openapi.json`）。

已知限制：含空格的路径只遮到第一个空格为止，后面的片段会保留。脱敏是安全网，不是保证：分享前请自己过一遍。

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
- **义务** —— 义务、状态与未解决未知项。关闭义务需要**新鲜的 PASS 检查，且与当前实现 digest 绑定**；否则按钮会点名具体阻塞项（`no-fresh-check`、`coverage-below`、`open-unknowns` 等），而不是假装能关。
- **运行** —— 构建轮次（状态、实现 digest、命令）与绑定到该 digest 的检查结论。

列表页顶部有一条**总览**：项目数、按目标类型与状态的分布、义务通过数/总数、跨项目的未解决未知项；`case_project overview` 以 JSON 返回同一份数据。**空工作台**用人话说清这是什么、适合谁、第一步做什么；工具名（`case_evidence`、`case_claim` 等）收在「给开发者 / AI 的说明」折叠里，不再作为新用户首先读到的东西。**新建项目**表单给每个字段加了标签（标题、目标、对象类型、授权范围），必填标题在失焦与提交时校验并给出可读错误，而不是一个按了没反应的按钮。

面板头部显示当前项目的**自主性级别**（L0–L3）；徽章提示用一句话解释这个等级是什么，L0–L3 作为副标题保留。

头部还有**回收站**入口：列出被 `case_project drop` 丢弃的项目（id、体积、文件数），可一键恢复；清空回收站前先用 dry-run 展示影响面（`N 个条目 / 体积；来历不明的条目会保留`）。丢弃只是移走，确认硬删之前都能恢复。

项目详情页给用户留了一个默认收起的**「危险操作 → 移入回收站」**入口：先 dry-run 展示影响面（文件数 / 体积、可恢复），再显式确认才移动，移完直接进回收站视图。agent 侧的 `case_project drop` 除了 `confirm: true`，工具描述还明确要求「必须用户明确同意后才可执行，不得自行 drop」——完全权限档下宿主不会额外弹审批，所以这条同意要求同时写进工具契约与本文档，属于文档约束而非宿主强制。

按 [ADR 0002](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0002-destructive-operations.md)，脚本化场景用 `case_project purge`（`dryRun` + `confirm`）；每次 drop/restore/purge 都会写数据根级 `audit.jsonl`（被丢弃的项目已经写不进自己的 audit 文件）。

设置分节显示数据根、项目数与 REA 接入状态。REA 未接入按**可选 / 不可用说明**呈现（不影响建项目和手工记录证据），不是红色错误；`mcp__rea__*` 的原始检测结果放在同一个高级折叠里。

## 工具

| 工具              | 动作                                            | 用途                                                                 |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `case_project`    | `open` / `list` / `get` / `update`              | 新建**或打开已有**项目、列表、详情、改授权档/范围/状态               |
| `case_evidence`   | `add` / `list` / `show`                         | 把 REA 观察写成证据；过滤；看单条                                    |
| `case_claim`      | `add` / `list` / `search` / `select`            | 写可引用结论；搜索；勾选进入规格包                                   |
| `case_feature`    | `add` / `list`                                  | 把结论归到功能，写边界与非目标                                       |
| `case_unknown`    | `add` / `list` / `resolve`                      | 记录未知项；带备注标记已解决                                         |
| `case_obligation` | `add` / `list` / `close` / `reopen`             | 可验收义务；`close` 必须有新鲜的通过检查                             |
| `case_build`      | `start` / `agent` / `status` / `loop` / `cycle` | 构建运行、builder 会话、构建→检查→关闭的循环                         |
| `case_check`      | `run` / `list` / `loop`                         | 跑一个 checker，并把结果绑定到当前实现 digest                        |
| `case_access`     | `await-login`                                   | 轮询 CDP 页面直到登录判据成立（就绪/超时/错误）                      |
| `case_app`        | `inspect`                                       | macOS `.app` 一屏摘要（bundle id、版本、沙盒、ATS、UTI 归属域）      |
| `case_brief`      | `export`                                        | 写出脱敏的规格包（`spec.json` + `brief.md`）                         |
| `case_ingest`     | `ingest` / `schema`                             | 按稳定契约摄入外部 agent 的报告（只记录、不背书）；`schema` 打印契约 |

`case_project` 另有 `close`、`report`（`format: md / html / both`，默认脱敏）、`bundle`（机器可读、确定性）、`overview`、`archive`、`drop`（`dryRun` / `confirm`）、`trash`、`restore`、`purge`（`dryRun` / `confirm`）、`autonomy`（L0–L3 分级）。

**会话记忆：** 任何显式传入 `projectId` 的调用都会把它设为本会话的当前项目，且该指针会落盘——`case_project open` 传已有项目 id 时直接打开而不是报 `project-exists`；重启后同一会话继续调用工具不必重复传 `projectId`。若仍漏传，错误提示会带上「上次打开的项目」而不是只说失败。

所有工具统一返回 `{ ok, data?, error?{code,message,hint}, summary }`；错误带稳定 code，模型能自行纠正而不是猜。

**工具面代价：** 这 12 个工具的定义（`description` + `parameters` JSON）合计约 13.6 KB ≈ 3.4K tokens（按 ~4 B/token 估算），常驻每个会话，而真正用到 casefile 的会话是少数。这是有意的取舍（每个工具的 schema 都能自解释）；如果之后要压缩，优先把低频的 `case_access` / `case_app` / `case_ingest` 并进一个 `case_misc`。

义务可以带 `featureIds`，这样**只复刻选定功能**时能报出每个功能的覆盖率：挂在某功能上的义务只计入该功能，未挂的只计入全局。

## Checker

| Checker | 判什么                                                                | 三态                             |
| ------- | --------------------------------------------------------------------- | -------------------------------- |
| `build` | shell 构建命令：退出码 + 产物                                         | pass / fail / unknown(超时)      |
| `cli`   | 命令对照 `{ exitCode, stdoutIncludes, stdoutEquals, stderrIncludes }` | pass / fail / unknown(超时)      |
| `web`   | 两张 PNG 截图：相似度 = 1 − 平均绝对差/255，外加尺寸检查              | pass / fail / unknown(缺图/坏图) |

截图采集由别处完成（REA 的 browser 工具或用户自己的工具），`web` checker 只负责判定。PNG 解码器在仓库内（`lib/core/png.js`，无第三方依赖），支持 8-bit RGB/RGBA、非隔行。

## 授权档

项目带 `authTier`：`owned` / `authorized` / `research`。**起复刻构建**（`case_build agent` / `cycle`）时，`research` 档默认被拒绝；要放行必须显式传 `allowResearchTier: true` 并给 `reason`，放行会以 `auth/research-override` 写进项目审计。这样授权档不是装饰：research 档的项目可以调查、可以出规格，但不能悄悄被复刻。

## 关闭项目

`case_project close` 在项目真的做完之前会一直拒绝。闸门按顺序检查：至少一条义务；没有 `open`/`fail`/`blocked` 义务；覆盖率 ≥ `minCoverage`（默认 100%）；没有未解决未知项；存在一条新鲜的、实现 digest 与当前构建一致的检查。每个卡点都按名字报出来，知道该修什么。

`case_project report` 写出 `reports/<时间戳>/report.md` + `report.json`：全局覆盖率、**按功能覆盖率**、义务表、带实现 digest 的检查表、未知项、循环状态，以及「`unknown` 不等于通过」的声明。

## 采集：只摄入，不采集

casefile 自己不去抓任何内容。每条证据带一份 **`producer`** 记录——工具、版本、获取方式（`headful` / `headless` / `api` / `archive` / `manual` / `stealth` / `unknown`）、产物类型，以及你是否**明示确认**过这种获取方式。报告会渲染一张生产者表，外加一句声明：采集方式由操作者选择与执行。

这就是它能吃下任何东西的原因：REA 的采集、你自己代理录的 HAR、Scrapling 抓的 HTML 快照，或者你手动截的图。Tier 1（人类等价浏览、官方 API、公开归档）直接支持；Tier 2（你自己的会话，或你标为 `stealth` 的方式）只记录不背书；Tier 3（打码、指纹伪造、代理轮换、高频批量抓取）不提供、也不会加——见 [DISCLAIMER.md](DISCLAIMER.md#acquisition-boundary-three-tiers--采集边界三段式)。

## 净室 attestation

每次 builder 会话都会写一条 **attestation**（`attestations.jsonl`）：prompt 摘要、规格包摘要、投喂了多少条结论/证据、授权档与是否 research 覆盖，以及「不要读取原始目标」这条指令**是否真的**在 prompt 里。报告里渲染成 `## 净室 attestation` 小节。

这条声明刻意写清边界：DSH 没有按 agent 的工具白名单（见 `docs/runtime/0.2.2-rc.3.md` §12.7），所以隔离是**信息流层面**的。声明里明说这一点，而不是声称「净室认证」。

## 防假绿灯

测试里有 **near-miss 注入**：同一个义务在正确实现上关闭后，只改一个字符，下一轮必须判定失败并把义务重开；构建失败时直接跳过检查，不产生误导性的 pass。见 `packages/casefile/test/near-miss.test.js`。

## 数据布局

全部在插件数据根下（默认 `<DSH_HOME>/casefile`，可用 `dataRoot` 覆盖）：

```
casefile/
├── projects/<project-id>/
│   ├── project.json          # version + 目标 + 授权档 + 范围 + REA 版本
│   ├── evidence.jsonl        # append-only；同 id 后者胜
│   ├── claims.jsonl
│   ├── features.jsonl
│   ├── unknowns.jsonl
│   ├── audit.jsonl           # 谁做了什么，append-only
│   ├── artifacts/            # 归档产物（有体积上限）
│   ├── checks/               # 验收运行记录
│   ├── spec/<时间戳>/        # 导出的 spec.json + brief.md
│   ├── reports/              # 导出的报告
│   └── bundles/              # 导出的 agent 环境包
├── trash/                    # 被 drop 的项目，可恢复
├── audit.jsonl               # 数据根审计（drop / restore / purge）
├── last-opened.json          # 最近打开的项目（UI 便利）
├── session-pointers.json     # 会话 → 项目指针
└── builder-sessions.jsonl    # builder 会话（只读 guard 用）
```

规则：JSON 文件带 `version`；被更新版 casefile 写过的文件会报「只读」而不是被静默改写。坏 JSON 改名 `.broken` 保留。记录 append-only，项目目录可以 review、可以 diff。

## 配置

| 键                 | 默认                  | 含义                                                     |
| ------------------ | --------------------- | -------------------------------------------------------- |
| `dataRoot`         | `<DSH_HOME>/casefile` | 项目数据位置；测试可注入                                 |
| `defaultAuthTier`  | `research`            | 新项目默认授权档                                         |
| `cleanRoomDefault` | `true`                | 预留给 builder 里程碑：builder 看不到原件                |
| `checkers`         | `["cli","web"]`       | 预留给验收里程碑                                         |
| `maxRounds`        | `5`                   | 预留给循环                                               |
| `maxArtifactBytes` | `67108864`（64 MiB）  | 归档产物体积上限；超限直接拒绝（先 stat 预检，不读正文） |

配置写在 `cordis.patch.yml` 里 `casefile` 那一行的 `config:`，不要手改 profile。

## 兼容性

| 插件            | 已在哪个 DSH 上验证               | 跑了什么                                                                                                                                                                                                                                                                                                                |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.x–0.2.x     | 0.2.2-rc.3（macOS，桌面版 + web） | 138 → 177 项单元测试；临时 DSH_HOME 上 52 项 web 端到端冒烟；**真实 Electron 渲染进程上 14 项桌面只读回归（CDP）**；`pnpm gate casefile` 4/4 步全绿。                                                                                                                                                                   |
| 0.3.x–0.5.x     | 同上                              | 172 → 177 项单元测试；新增 `case_access`（等登录）、`case_app`（应用包第一跳）、产物归档、项目 `archive`/`drop`；**在 8 个真实项目上跑通**（含本机 macOS 应用、登录态网页、外部采集器摄入）。                                                                                                                           |
| **0.6.x–0.8.x** | 同上                              | 216 项单元测试；**56 项 web 端到端**（新增外部报告摄入 dryRun/真摄入断言）；**15 项桌面只读回归**（新增自主性徽章断言）；`pnpm gate casefile` 4/4 全绿。新增：HTML 报告、机器可读 bundle、L3 无人值守、外部报告摄入契约（含 Craft 形状自动映射）、空白截图防护。                                                        |
| 0.8.1           | 0.2.2-rc.5（macOS，桌面版 + web） | 这一版 DSH 不需要改代码。216 项单元测试；**56 项 web 端到端冒烟**；**15 项桌面只读回归（连跑 2 次，幂等）**；`pnpm gate casefile` 4/4 全绿，并已跑过 **`pnpm gate:all --repeat 2`**（六插件 631s 全绿）。本版的 43 包宿主 diff（[runtime rc.5](../../docs/runtime/0.2.2-rc.5.md)）里，本插件用到的宿主 API 一个都没动。 |

本插件用到的宿主 API 都经过运行时勘察，结论记在 `docs/runtime/0.2.2-rc.3.md` §10（含两个坑：漏一条 `declareRemote` 只会让那一个端点静默 404；`agentPresets` 不能用 bundle 名组合）。

真实任务里验证过的**五类**目标（含本机 Electron 应用）：**本机 macOS 应用包**（Info.plist/签名面/二进制库存，二进制层需 REA + Ghidra，见 `docs/runtime/0.2.2-rc.3.md` §13–§14）、**登录态网页**（`case_access await-login` + 只取结构）、**外部采集器产物**（`producer` + `artifactPath` 归档）、**应用自身发布包**（mas 包勘察 → 规格 → 验收闭环）。

## 副作用与风险

- **写哪些文件：** 只写上面的数据根。不写被调查的项目、不改 REA 二进制、不编辑 profile。
- **破坏性操作：** 遵循仓库 [ADR 0002](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0002-destructive-operations.md)。`case_project drop` 把整个项目目录移进 `<dataRoot>/trash/<时间戳>-<id>`（可恢复），必须传 `confirm: true`，支持 `dryRun` 并给出条目数/体积/目标路径，同时写数据根审计。工具契约明确要求 agent **只能在用户明确同意后**调用；工作台给用户自己的同一动作放在「危险操作」里，先预览影响面再确认。注意：在 `danger-full-access` / `approval: never` 权限档下宿主不会为这个工具加审批弹窗——完全权限会话被视为可信执行者，因此这条同意要求是文档约束，而不是宿主强制。回收站可查看、可恢复、可清空（`case_project purge`，`dryRun` + `confirm`；回收站里来历不明的条目保留并计数，绝不 `rm -rf`）。没有显式确认就不会硬删任何东西。
- **隐私：** 项目数据只在本机。规格包、bundle 与报告默认脱敏（系统根目录路径、`~/…`、扩展路径，以及上面列出的 token 形态），但**分享前仍应自己过一遍**——脱敏是安全网，不是保证。
- **证据质量：** casefile 只存你告诉它的东西。它不验证观察，也从不提升结论的可信度或权威性。
- **法务：** 面向研究与「你拥有或已获授权分析」的软件。刻意**不提供** DRM/反调试绕过，也不提供复用第三方资产的途径。使用前读 [DISCLAIMER.md](./DISCLAIMER.md)。

## 卸载后残留

卸载插件**不会删任何数据**：宿主只移除包本身。案卷仍留在数据根下（默认 `<DSH_HOME>/casefile`，见[数据布局](#数据布局)）：

- `projects/<id>/` —— 项目记录，以及 `artifacts/`、`spec/`、`reports/`、`bundles/`、`checks/`；
- `trash/` —— 被 `case_project drop` 移进回收站的项目（重装后仍可恢复）；
- `audit.jsonl`、`last-opened.json`、`session-pointers.json`、`builder-sessions.jsonl` —— 数据根审计、最近打开指针、会话 → 项目指针，以及只读 guard 用的 builder 会话记录。

数据不上传，卸载时也不清理——这是有意的，重装后证据还在。要手工删除（先确认已经导出需要的东西）：

```bash
du -sh "$DSH_HOME/casefile"   # 先看体积
rm -rf "$DSH_HOME/casefile"   # 改过 dataRoot 的话换成你自己的路径
```

导出的规格包、报告和 bundle 都在项目目录**里面**（`spec/`、`reports/`、`bundles/`），会随目录一起删掉；需要的话先拷出来。

## 开发

```bash
pnpm verify        # lint + 类型检查 + 插件规范 + 测试
pnpm check         # 插件规范 + 索引元数据
pnpm test          # 单包单测
```

## 许可

MIT。见 [LICENSE](./LICENSE) 与 [DISCLAIMER.md](./DISCLAIMER.md)。
