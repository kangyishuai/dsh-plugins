# casefile 测试手册

面向 `packages/casefile`。全部命令在仓库根目录执行。

## 分层

| 层                   | 命令                                           | 覆盖                                                                                                                                                                                                                                                  | 依赖                                                         |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 单元                 | `pnpm --filter @kangyishuai/dsh-casefile test` | **277 项**：core（model/store/digest/manifest/brief/bundle/ingest/autonomy/provenance/app-bundle/login-wait/png）、actions（含义务关闭硬门、外部摄入、L3 预算）、tools、Remote 声明一致性、**client 半 UX（vm 渲染真实 `lib/client.js`，14 项）**     | 无                                                           |
| 静态                 | `pnpm verify`                                  | lint + 类型 + 插件规范 + 文档一致性 + 公开边界 + 全部测试                                                                                                                                                                                             | 无                                                           |
| web 端到端（API 级） | `pnpm smoke:casefile`                          | **69 项**：临时 DSH_HOME 装包 + 真实 web 宿主，打 Remote 端点：项目/证据/结论/义务/检查/规格包/脱敏/审计/能力探测 + **外部报告摄入（dryRun 与真摄入）**                                                                                               | 本机 `dsh`                                                   |
| 桌面只读回归         | `pnpm smoke:casefile-desktop --require`        | **30 项**：真实 Electron 渲染进程：侧栏入口、工作台页、自主性徽章与**人话提示**、**空态引导/高级折叠**、新建表单开关/**标签/必填校验**、回收站入口/列表/返回（只读）、**危险操作 → drop 影响面 dry-run（只读）**、设置分节与 **REA 信息态**、Esc 不崩 | 桌面版**已装本插件**且带 `--remote-debugging-port=9222` 启动 |
| 发版门禁             | `pnpm gate casefile`                           | verify → web 冒烟 → 桌面回归                                                                                                                                                                                                                          | 同上；桌面未就绪时用 `--skip-desktop`（门禁不完整）          |

## web 冒烟（API 级）

```bash
pnpm smoke:casefile            # 失败时自动保留临时目录并打印路径
SMOKE_DEBUG=1 pnpm smoke:casefile   # 打印每次请求/响应
SMOKE_KEEP=1 pnpm smoke:casefile    # 成功也保留现场
```

它验证的断言包括：
- 插件安装进临时 profile、宿主持久化启动、没有未激活插件、数据根被创建；
- 鉴权（`GET /?token=` → 303 → `dsh-auth-*` cookie）后，`listProjects` 可用；
- 建项目 / 非法授权档被拒（`gateway/bad-request`）/ 记证据 / 写结论 / 勾选 / 建功能 / 记未知项；
- **义务硬门**：无新鲜 PASS 检查时 `closeObligation` 被拒（`obligationTooTall`）；补一条新鲜 PASS + digest 一致后可关闭；
- 规格包写出 `spec.json` + `brief.md`，只含选中结论，**本机路径被脱敏**，未知项随包；
- 审计日志含 `project/create`、`evidence/add`、`claim/add`、`spec/export`；
- **构建/验收闭环**：`startBuild` 落 `BuildRun` 并算出 64 位实现 digest；`runCheck` 绑定该 digest 判 pass；义务可关闭；**改实现后再构建 → 已关闭义务被 stale 重开**；`loopStatus` 给出停止条件；
- **净室 attestation**：builder 会话落一条含 prompt 摘要与净室指令标记的记录；报告写明「工具面未隔离」的边界；
- **授权档闸门**：`research` 档项目起 builder 被拒（`gateway/bad-request`）；显式 `allowResearchTier` 放行并写审计；
- **按功能覆盖率**：带 `featureIds` 的义务在报告里生成「按功能覆盖率」表；
- **跨项目总览**：`overview` 聚合项目数、按目标类型分布、义务与未知项合计；
- **一次调用闭环**：`runCycle` 在同一调用里完成构建→检查→关闭（带 builder 时先起会话并等停）；
- **覆盖率硬门与报告**：有未关闭义务/未知项时 `closeProject` 被拒；`exportReport` 写出 md+json，报告含覆盖率、义务表与「unknown 不等于通过」声明；
- **打开已有项目**：`createProject` 传已有项目 id 时直接打开（返回原项目，不报 `project-exists`）；
- **证据种类容错**：`kind: "docs"` 这类 schema 之外的种类落库为 `other` 并保留 `kindRaw`，不再整条被拒；
- **回收站**：`dropProject` dry-run 给出项目数/字节/路径且不移目录；`confirm` 后进回收站；`listTrash`/`restoreTrashEntry` 可列出与恢复；`purgeTrash` dry-run 给条数/字节、缺 `confirm` 被拒、`confirm` 后清空；drop/restore/purge 都写数据根 `audit.jsonl`；
- **报告默认脱敏**：`exportReport` 默认 `redacted: true`，md/html 里标注「已脱敏」，本机路径不落盘；
- **process / selfTest checker**：进程退出码与文件副作用（pass/fail）；自测 JSON 报告全绿 pass、非 JSON → unknown；
- **web checker**：相同截图判 pass（相似度 1）；不同颜色判 fail；缺图判 unknown（不吞成 pass）；
- **自动循环 + near-miss**：`advanceLoop` 在正确实现上关闭义务；把被测脚本改坏一个字符后，同一轮检查必须 fail 且义务回到 open；
- **builder 会话**：`startBuilder` 在真实宿主里创建 `session-*` 子会话并投喂规格包；`awaitBuilder` 返回合法停止原因；之后宿主仍可用；
- 无 REA 时 `diagnose` 报 `missing`（不假装正常）；
- 仓库工作目录没有被污染。

## 桌面只读回归

前置（二选一）：

```bash
# 1) 把当前源码打进 desktop profile
cd packages/casefile && pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-casefile-*.tgz
# 2) 带调试端口重启桌面版
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 3) 跑
cd <repo> && pnpm smoke:casefile-desktop --require
```

脚本只读：打开工作台、开关新建表单（不提交）、进设置分节、Esc 关闭；不写项目数据、不关闭义务、不删任何东西。失败时截图落在 `$TMPDIR/dsh-casefile-desktop-shots/`。

> 注意：插件必须真的装在**桌面 profile** 里，否则侧栏不会有「案卷」入口，脚本会以「找不到入口」失败——这是前置缺失，不是回归。

## 手动 GUI 检查（可选，用 ego-browser）

临时宿主 + 真实浏览器，用来确认 client 半渲染（不需要装桌面 profile）：

```bash
H=$(mktemp -d); W=$(mktemp -d)
(cd packages/casefile && pnpm pack --pack-destination "$W")
DSH_HOME="$H" dsh plugin --profile web add "$W"/*.tgz
DSH_HOME="$H" dsh web --port 0 --no-open    # 打印 http://127.0.0.1:<port>/?token=...
```

然后用 ego-browser 打开该 URL：关掉「预览版说明」→ 点侧栏「案卷」→ 断言 `[data-casefile-page]`、`[data-casefile-new]`、`[data-casefile-empty]`；新建一个项目后断言 `[data-casefile-project-row]` 与三个 `[data-casefile-tab]`。

## 手动 GUI 检查覆盖面（截至 2026-11-17）

| 视图          | 已实测                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| 侧栏入口      | 存在、可点、高亮                                                                   |
| 列表页        | 空状态、总览条（项目数/类型分布/义务通过/未知项）                                  |
| 新建项目      | 表单开合、提交后进入详情                                                           |
| 详情-证据页签 | 结论卡（可信度/已选中/证据数）、证据卡                                             |
| 详情-义务页签 | 义务卡（状态/种类/授权档）、关闭被拒的中文文案、有新鲜 PASS 后成功关闭、未知项分组 |
| 详情-运行页签 | 构建轮次（状态/实现 digest/命令）、检查结论（checker/绑定 digest）                 |
| 设置分节      | 项目数、数据根（长路径自动换行、无横向溢出）、REA 能力状态、隐私说明               |

**踩坑（已修）**：设置页数据根路径曾不换行，把面板撑出横向滚动条（`overflowX > 0`）。

## 已知坑

- **`declareRemote` 漏一条只影响那一个端点**（404 纯文本）。排障时先换一个确定已声明的方法探测；`test/remote-declarations.test.js` 会拦住这类回归。
- **Remote 参数是「命名位置参数」**：`createProject(input)` → `payload.args.input`；平铺字段会被网关拒（`gateway/arguments-invalid`）。
- **业务错误走 HTTP 200 + `result.ok=false`**，不是 4xx/5xx。
- **`dsh web` 启动的是内置 `web` profile**，插件必须装进 `--profile web`。

## 发版前体检记录（v0.1.0 草稿）

| 项                                | 结果                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm pack` 产物                  | 25 个文件 / 69 KB；只含 `cordis.patch.yml`、`lib/**`、`locale/**`、三份文档、LICENSE；**不含** test/、node_modules、notes/ |
| 依赖边界                          | `dependencies` / `peerDependencies` / `engines` 全为空；唯一宿主导入是 `@deepseek-ai/dsh-typert-protocol`                  |
| `publishConfig.access`            | `public`                                                                                                                   |
| `dsh.bundle.patch` / `dsh.client` | 均在，client 注入 `dsh-client-ui-workspace` + `dsh-client-ui-slots`                                                        |
| `pnpm probe:runtime`              | **72/72 PASS**（0 WARN / 0 FAIL）                                                                                          |
| `pnpm verify`                     | 通过（当时 138 项；现 277 项）                                                                                             |
| web 冒烟                          | 52/52                                                                                                                      |
| 桌面只读回归                      | **14 PASS / 0 FAIL**（真实 Electron 渲染进程，CDP 9222，2026-11-18）                                                       |

### 桌面回归结果（2026-11-18 实测）

- 日期：2026-11-18
- DSH 版本 / 系统：桌面版 0.2.2-rc.3 / macOS（Chrome 152.0.7977.130，CDP `127.0.0.1:9222`）
- 前置：`dsh plugin --profile desktop add /tmp/cf-desktop/kangyishuai-dsh-casefile-0.0.0.tgz` 后带调试端口重启
- `pnpm smoke:casefile-desktop --require` 结果：**14 PASS / 0 FAIL**
- `pnpm gate casefile`（不跳过桌面）：**4 步全绿**
- 截图目录：`$TMPDIR/dsh-casefile-desktop-shots`（`panel.png`、`settings.png`）
- 备注：首跑 4 PASS / 8 FAIL，全部是**脚本选择器**问题，产品本身正常；修法见下节「桌面脚本的两个坑」

### 桌面脚本的两个坑（2026-11-18 实修）

1. **固定 `sleep` 等不到真实渲染**：工作台首次挂载要打两个 RPC（`listProjects` + `overview`），`sleep(500)` 不够。
   改成轮询 `waitFor(selector)`（150ms 一次，最长 8s）。
2. **设置分节不能用全文匹配点「案卷」**：侧栏入口与设置导航项同名，`clickByText("案卷")` 总是先命中侧栏入口。
   改成「`clickAria("账号菜单")` → 在 `body` 里点「设置」→ 在 `[role="dialog"]` 里点「案卷」」。
3. 同理，`[data-casefile-settings]` 在 **loading 骨架**阶段就已存在，REA 行要等 `diagnose` 返回；
   断言 REA 前必须先 `waitFor("[data-casefile-rea]")`。

### 发版门禁记录（2026-11-19，0.8.1）

- `pnpm gate casefile`（不跳过桌面）：**4/4 步全绿**
  - `pnpm verify`：**216 项**单测通过
  - `pnpm probe:runtime`：宿主 0.2.2-rc.3 表面全绿
  - web 端到端：**56 PASS / 0 FAIL**
  - 桌面只读回归：**15 PASS / 0 FAIL**
- 桌面回归新增断言：**面板显示自主性级别徽章**（`data-casefile-autonomy`，默认 `L2`）。

#### 这条断言踩过的坑

`page.evaluate` 这个 CDP 辅助函数**只接受字符串表达式**；传箭头函数会得到：

```
{"code":-32602,"message":"Invalid parameters","data":"Failed to deserialize params.expression"}
```

看起来像页面报错，其实是调用方式错了。正确写法是把整个函数包进字符串：

```js
await page.evaluate(`(() => { ... })()`);
```

#### 断言写法的一个反面教材

写「摄入后证据数仍为 0」时我用了不存在的 Remote，而 `?? []` 把它掩盖成通过：

```js
(undefinedEvidence ?? []).length === 0; // PASS，但什么都没验证
```

改为真实存在的 `projectDetail`，并让断言失败时打印真实值。
**凡在断言里写 `x?.a ?? []`，先确认 `x` 本身可能不存在时会不会把问题掩盖掉。**

## 0.8.1 在 0.2.2-rc.5 上的复核记录（2026-11-19，DSH 0.2.2-rc.5）

插件代码没有改动；这一版只验证「升级后仍然成立」。宿主的 client 构建产物、REA 依赖的包与服务与 rc.3 逐字节相同（[runtime rc.5](../runtime/0.2.2-rc.5.md) §1.1）。

| 层                                      | 结果                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `node --test`（包内）                   | **216 pass / 0 fail**                                        |
| `pnpm verify`                           | 通过（lint / typecheck / check / check:docs / check:public） |
| `pnpm probe:runtime`                    | **72/72 PASS**                                               |
| `pnpm smoke:casefile`（web）            | **56 PASS / 0 FAIL**                                         |
| `pnpm smoke:casefile-desktop --require` | **15 PASS / 0 FAIL**，收尾打印 `15 PASS / 0 SKIP / 0 FAIL`   |

**串行注意**：这条桌面回归结束时页面停在「案卷」主面板（Esc 只关内层对话框）。接着跑别的插件的桌面回归会因为没有 composer 而误报（本轮 btw 首跑就因此 1 FAIL，切回会话后 18 PASS / 1 SKIP）——多条桌面回归之间先点回任一会话。

结论：**rc.5 上 casefile 无回归**。

## 2026-11-28 安全与契约修复批次（0.9.0，AUD-CASEFILE 簇）

这一批修的是审计报告 `AUD-CASEFILE-01…11` / `AUD-XCT-07` 的问题，全部「先红后绿」（先加失败测试再改实现）：

| 项          | 修复                                                                                                        | 对应用户可见变化                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 会话指针    | `open` 可打开已有项目；任何显式 `projectId` 调用都会记住；指针持久化到 `<dataRoot>/session-pointers.json`   | 重启后同会话可继续不带 `projectId`；漏传时报错带「上次打开的项目」 |
| 证据种类    | schema 写 enum（与 `CLAIM_KINDS` 同源）；未知值落 `other` + `kindRaw`                                       | `kind: "docs"` 不再整条被拒                                        |
| 回收站      | `drop` 加 `dryRun`/影响面/数据根审计；新增 `trash`/`restore`/`purge`（dry-run + confirm）；面板加入口       | 回收站可查看/恢复/清空；硬删必须显式确认                           |
| 报告脱敏    | `report` 接受 `redact`（默认 true），与 brief/bundle 共用 `redactPack`，报告页脚标注脱敏状态                | 「可外发归档」的 HTML 不再带本机路径                               |
| 脱敏范围    | 通用系统根路径、`~/`、带扩展名（1–8 字符）的绝对路径；补 AIza/ASIA/npm_/JWT/私钥块/password= 等             | 规格包/报告的负向断言覆盖这些形态                                  |
| 产物归档    | `maxArtifactBytes`（默认 64 MiB）+ stat 预检；先校验后归档                                                  | 大产物不再让主进程内存尖峰；校验失败不留孤儿文件                   |
| 并发写      | 唯一临时名 + `updateJson` 进程内串行化（覆盖回调含 `await` 的读改写；同步 IO 下并发 add 本就不会交错）      | 跨进程写同一文件不会出半截 JSON；跨进程仍不覆盖                    |
| schema 对账 | `case_project` 枚举补齐 `autonomy`/`bundle`/`trash`/`restore`/`purge`；测试加反向对账                       | 文档承诺的动作都能从 schema 触达                                   |
| 工具面      | README 承认 12 工具 **13.6 KB ≈ 3.4K tokens**（实测 description+parameters）的常驻代价；`tools.js` 注释更正 | 无行为变化                                                         |
| 设置分节    | `settings.section` order 94 → 96（消除与 btw 的并列）                                                       | 设置页顺序稳定                                                     |

验证：`node --test`（包内）**263 pass / 0 fail**；web 冒烟在临时 `DSH_HOME` 上实测 **69 PASS / 0 FAIL**（2026-11-28，含本批新增 13 条：open 已有项目、未知 kind、回收站 dry-run/confirm/恢复/清空、数据根审计、报告默认脱敏强断言）。桌面只读脚本由 15 项增至 **19 项**（新增 4 条回收站只读断言），需发版门禁在真实桌面版上重跑后回填 PASS 记录。

**独立复审补修（2026-11-28，第二轮）**：B1 冒烟变量名写错（实测 56 PASS / 1 FAIL → 修后 69 PASS / 0 FAIL）；B2「带扩展名路径」脱敏分支恒不命中（`${PATH_TAIL}?` → `(?:${PATH_TAIL})?`，补正/负例）；`restore` 先校验条目 manifest 再搬家（坏条目留在回收站并写 `project/restore-failed` 审计）；drop dry-run 改返回 `previewTrashPath`（预览路径非最终落点）；指针淘汰改 LRU；`updateJson` 串行化测试改用含 `await` 的 mutate（撤锁会红）；报告脱敏冒烟改为「target.ref 是本机路径」的探针强断言。F4/F6/F7/F12/F13/F14 记入复审报告延后。

**第三轮复审补修（2026-11-28）**：`listTrash` 对更高版本/不可读的 `project.json` 降级为「元数据未知」（不再整表 `read-only-newer` 报错）并补 version 99 的 list/restore 测试；恢复失败审计写入失败只告警、不顶掉原始错误；README 把「任意带扩展名路径」收窄为「绝对路径 + 1–8 字符扩展名」；删除 Config 表里不存在的 `redactOnExport`；报告脱敏强断言去掉永远为真的空断言；`purge` dry-run 字段改 `trashRoot`（与 drop 的 `previewTrashPath` 分开）。N7 的回滚分支与 N8 的 actor 口径仍按 F12/F14 记录延后。

**P3 收尾（2026-11-28）**：`markLastOpened` 与 `session-pointers.json` 落盘改为「尽力而为」——数据根只读/磁盘写满时只告警，`case_project get` 这类纯读动作不再跟着失败（F6）；指针文件版本高于本插件（降级场景）时按「无指针」处理，不再让所有省略 `projectId` 的工具调用整片失败（F7）。两条都有单测（`test/session-pointer.test.js`：只读数据根 / `version: 99` 指针）。

## 2026-11-28 用户模拟 UX 修复批次（非技术用户实测，0.9.1）

这一批只改 client 半文案/表单行为 + README，接口契约不变（`case_project` 的 drop 说明新增「必须用户明确同意」，属于描述收紧）。全部先红后绿：新增 `test/client-ux.test.js`，用 vm 把**真实的 `lib/client.js`** 渲染成树再断言（React shim + 假宿主 ctx），覆盖：

| 审计项     | 用户可见问题                                                  | 修法与断言                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USIM-U1-04 | 空态直接教用户调 `case_claim` / `case_evidence`，像报错       | 项目空态改成「是什么 / 适合谁 / 第一步」；三个页签空态人话在前；工具名收进「给开发者 / AI 的说明」`<details>`；设置里 REA 未接入改为 `.cf-info` 可选/不可用说明（`data-casefile-rea-notice`，不再是红色错误），`mcp__rea__*` 检测细节进同一高级折叠 |
| USIM-U1-05 | 新建表单两个下拉无标签、空标题点「创建」没反应                | 四个字段都包 `<label>` + `aria-label`/`aria-required`；必填标题失焦/提交时 `data-invalid=true` 高亮并给可读错误（`data-casefile-create-error`）；提交中禁用输入与按钮；失败留在表单上显示「创建失败：…」                                            |
| USIM-U1-16 | 「自主性 L2」悬浮说明是 `scope=selected` 代码术语             | 悬浮提示改人话，L0–L3 作为第二行副标题保留                                                                                                                                                                                                          |
| USIM-U2-16 | 「运行」tab 空态同一句出现两次                                | 空态只由居中块渲染一次；`data-casefile-empty="runs"`                                                                                                                                                                                                |
| USIM-U3-07 | drop 只能由 agent 工具 `confirm:true` 触发，用户端无入口/确认 | 详情页新增默认收起的「危险操作 → 移入回收站」：先 `dryRun` 展示文件数/体积/可恢复，再显式确认；工具描述写明「必须用户明确同意，不得自行 drop」；README 明示 `danger-full-access` / `approval: never` 下宿主不额外弹审批（文档约束而非强制）         |
| USIM-U3-11 | README 缺卸载残留说明                                         | 双语 README 新增「卸载后残留 / Uninstall」：数据根、`projects/`、`trash/`、审计与指针文件、手工 `rm -rf` 清理与先导出 spec/report 的提醒                                                                                                            |

**验证**：`node --test`（包内）**277 pass / 0 fail**（263 → 277，新增 14 条 client UX）。桌面只读脚本由 19 项增至 **30 项**（新增空态/表单校验/REA 信息态/危险操作 dry-run 断言；**本轮未跑桌面**，需发版门禁在真实桌面版上重跑后回填 PASS 记录）。web 冒烟未跑（接口契约未变；`case_project` 只在 description 上收紧）。

## 复审 follow-up（2026-11-28 `batch-ui-1` A1–A4/A6）

`notes/audit/2026-11-28/reviews/batch-ui-1.md` 的非阻塞项（本轮修完，不改接口契约）：

- **A1 卸载清单漏文件**：双语 README 的「卸载后残留 / Uninstall」补上 `builder-sessions.jsonl`，并把「数据布局」树补成与卸载清单一致（根级的 `audit.jsonl` / `last-opened.json` / `session-pointers.json` / `builder-sessions.jsonl` / `trash/`，以及项目目录下的 `artifacts/`、`checks/`、`spec/`、`reports/`、`bundles/`）。
- **A2 审计 actor 口径**（原 N8）：新增 `auditOriginOf()`，危险操作（drop / restore / purge / restore-failed）不再硬编码 `actor:"user"`——`case_project` 工具路径显式传 `actor:"agent"` + `sessionId`（来源证据），回收站 UI 走 Remote 时显式传 `actor:"user"`，直接调 action 的脚本没传就记 `unknown`（不猜）。审计行新增顶层 `sessionId` 字段。
- **A3 危险操作焦点/播报**：展开「危险操作」时焦点进主按钮（§7.4.2 默认焦点）；dry-run 影响面出现时焦点移到「取消」（安全项，以前入口按钮被替换后焦点掉到 `document.body`），预览卡加 `role="alert"` + `aria-live="polite"`；取消收起后焦点还回入口按钮。vm 测试用真实 `client.js` + ref 桩驱动，断言三条焦点路径与 live region。
- **A4 默认收起无断言**：桌面只读脚本新增 `details.open === false` 断言（以前只 `waitFor` 元素存在，折叠时子节点也在 DOM 里，等于没验）。
- **A6 无项目时假绿**：桌面脚本把空 profile 上 4 条危险操作断言从「记 PASS」改成 **SKIP 并计数**（收尾行变成 `N PASS / M SKIP / 0 FAIL`，并打印 SKIP 原因）；同一类问题的「有项目时空态不可见」也一并改 SKIP。

**验证（2026-11-28，本 worktree）**：`node --test`（包内）**279 pass / 0 fail**（277 → 279：A2 审计口径 1 条 + A3 焦点/播报 1 条；tools 回收站用例扩了 agent 来源断言）。桌面脚本改动**未在 live 桌面重跑**（需发版门禁），断言本身是只读的（dry-run 预览 + 取消），SKIP 计入计数。

## 设置保存状态（USIM-U1-10，2026-11-28）

设置分节统一加了「保存状态」行与稳定锚点（[plugin-conventions §7.2.6](../plugin-conventions.md#72-设置页)）。
本节记录**桌面只读断言**（按约定只写不跑；真机证据见下面的 2026-11-28 记录）与单测覆盖位置。

**单测（每次提交都跑）**：`test/settings-save-status.test.js` —— 用迷你 hooks 运行时驱动
`lib/client.js` 里的真实组件，不复制实现。

该分节**没有可保存的设置**（项目数 / 数据根 / REA 连接都是只读诊断），
因此不伪造「已保存」，只标 `readonly` 并写「无可保存设置」：

**桌面只读断言**：

1. 设置 → 案卷：`[data-casefile-settings]` 存在。
2. `[data-casefile-settings-status]` 的 `data-state` 为 `readonly`，文本是「诊断信息 · 无可保存设置」。
3. 不存在 `[data-casefile-settings-save]`，也不存在任何 `data-casefile-settings-status[data-state="saved"]`。

**真机记录（同上）**：

| 场景     | 结果                                               | 截图                                                 |
| -------- | -------------------------------------------------- | ---------------------------------------------------- |
| 打开分节 | `data-state=readonly`、「诊断信息 · 无可保存设置」 | `/tmp/dsh-sim-rel/shots/settings-casefile-clean.png` |

### A5 概览卡 kind / summary 本地化（2026-11-28）

缺陷：概览卡直接渲染服务端中文 `overview.summary`，且 `byKind` tag 用原始枚举（`binary × 1`）。
修法：客户端用结构化字段 + locale 组装摘要（`overview.projects/obligations/unknowns`），kind 走既有
`vocab(t,"kind",…)`；`test/i18n-parity.test.js` 锁中英键集，`test/client-ux.test.js` 渲染真实页面断言
中文/英文两套输出不混入原始枚举。

**切英文界面的方法（隔离实例，供下次复用）**：真实桌面版没有语言开关 UI；在 `$DSH_HOME/profiles/desktop/
cordis.patch.yml` 末尾加 `- id: locale / name: "@deepseek-ai/dsh-client-locale" / config: { preference: en }`
并重启桌面版即可（宿主 locale runtime 从 settings 命名空间读 preference）。

**真机记录（隔离实例 CDP 9410，英文界面）**：

| 场景                   | 结果                                                                                                                   | 截图                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 两个项目（binary/web） | 概览卡 `2 projects · obligations 0/0 closed · open unknowns: 0`，tag `Web / URL × 1`、`Binary × 1`；无中文、无原始枚举 | `/tmp/dsh-sim-rel/shots/nits-casefile-overview-en.png` |

### 复审 p/q：概览卡渲染条件与 0/0 文案（2026-11-28）

- **p（渲染条件）**：概览卡原来仍以 `overview?.summary`（服务端字段）为渲染条件，但 A5 之后 UI 已不再
  渲染 summary。改为 `hasOverviewFacts(overview)`：`projects / obligations.pass,total / openUnknowns`
  任一存在，或 `byKind` 非空才渲染，避免宿主不返回 summary 时整卡消失。`test/client-ux.test.js`
  新增渲染断言：无 summary 但有结构化字段 → 卡片出现且三行摘要齐全；空对象 `{}` → 卡片不渲染。
- **q（0/0 文案）**：`obligations 0/0 closed` / `义务 0/0 已关闭` 在无义务时读着怪。`total === 0` 时
  改用 `overview.obligationsZero`：中文「义务：已关闭 0 / 共 0」、英文 `obligations: 0 of 0 closed`；
  total>0 时保持原文案。中英两套渲染断言都在 `test/client-ux.test.js`。
- 上一节「真机记录」里截图是修复前（`obligations 0/0 closed` 旧形态）的历史记录；本轮改动由 vm 渲染单测锁定，
  未重拍真机截图（隔离实例里的真实数据仍可复用同一套断言路径）。

### 2026-11-28 发布后复测（0.9.2）

- 隔离实例（CDP 9419，有项目数据）：`node scripts/smoke-casefile-desktop.mjs --port 9419 --require` → **31 PASS / 1 SKIP / 0 FAIL**（SKIP=「有项目时空态引导不可见」的数据分支）。
- 脚本修复：`clickTextScoped` 只点可点击元素（危险区父级 `div` 的 textContent 与按钮相同，按文档序会先命中不可点的父级）；危险操作前先展开 `<details>`；账号菜单改为等待 `[role="menu"]` + 重试（Radix 菜单要求窗口在前台，连续冒烟时会偶发不展开）。
