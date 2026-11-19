# casefile 测试手册

面向 `packages/casefile`。全部命令在仓库根目录执行。

## 分层

| 层                   | 命令                                           | 覆盖                                                                                                                                                                                      | 依赖                                                         |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 单元                 | `pnpm --filter @kangyishuai/dsh-casefile test` | **216 项**：core（model/store/digest/manifest/brief/bundle/ingest/autonomy/provenance/app-bundle/login-wait/png）、actions（含义务关闭硬门、外部摄入、L3 预算）、tools、Remote 声明一致性 | 无                                                           |
| 静态                 | `pnpm verify`                                  | lint + 类型 + 插件规范 + 文档一致性 + 公开边界 + 全部测试                                                                                                                                 | 无                                                           |
| web 端到端（API 级） | `pnpm smoke:casefile`                          | **56 项**：临时 DSH_HOME 装包 + 真实 web 宿主，打 Remote 端点：项目/证据/结论/义务/检查/规格包/脱敏/审计/能力探测 + **外部报告摄入（dryRun 与真摄入）**                                   | 本机 `dsh`                                                   |
| 桌面只读回归         | `pnpm smoke:casefile-desktop --require`        | **15 项**：真实 Electron 渲染进程：侧栏入口、工作台页、**自主性级别徽章**、新建表单开关、设置分节、Esc 不崩                                                                               | 桌面版**已装本插件**且带 `--remote-debugging-port=9222` 启动 |
| 发版门禁             | `pnpm gate casefile`                           | verify → web 冒烟 → 桌面回归                                                                                                                                                              | 同上；桌面未就绪时用 `--skip-desktop`（门禁不完整）          |

## web 冒烟（API 级）

```bash
pnpm smoke:casefile            # 失败时自动保留临时目录并打印路径
SMOKE_DEBUG=1 pnpm smoke:casefile   # 打印每次请求/响应
SMOKE_KEEP=1 pnpm smoke:casefile    # 成功也保留现场
```

它验证的 52 条断言包括：
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
| `pnpm verify`                     | 通过（当时 138 项；现 216 项）                                                                                             |
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
