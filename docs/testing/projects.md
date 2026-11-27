# projects 测试清单

> 目的：证明四件事，而不是靠感觉点两下——**上下文真的注入了**、**线程真的隔离**、**状态真的从事件推导**、
> **回收真的不会删用户东西**。三层：**纯函数单测 → web 端到端冒烟 → 桌面只读回归**。
> 前两层每次提交都跑；第三层发版、DSH 升级、以及改动客户端私有 seam 后必须跑。

## 0. 测试环境

**一律在临时 `DSH_HOME` 里跑**：真实 profile 里跑会往你的 `projects.json` 里写测试项目。

```bash
# 打包（link: 安装不可用，见 docs/runtime/0.2.1-rc.5 §6.9）
cd packages/projects && pnpm pack --pack-destination /tmp

H=/tmp/dsh-test-projects
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/proj
DSH_HOME=$H dsh plugin --profile proj install
DSH_HOME=$H dsh plugin --profile proj add /tmp/kangyishuai-dsh-projects-0.0.0.tgz
DSH_HOME=$H dsh --profile proj --port 0 --no-open   # 终端会打印带 token 的 URL
```

临时 home **不要**放 `.credentials.yaml`：冒烟刻意不发起模型调用。`pnpm smoke:projects`
还会主动清掉 `API_KEY|_TOKEN|SECRET|PASSWORD` 类环境变量，让"不花 token"成为可验证的主张。

## 1. 自动化（每次提交）

```bash
pnpm verify                     # lint / typecheck / 规范 / 文档 / 公开边界 / 全部单测
pnpm smoke:projects             # web 端到端（临时 DSH_HOME + 真实宿主 + ego-browser）
pnpm smoke:projects-desktop     # 桌面只读回归（需要 --remote-debugging-port=9222）
pnpm gate projects              # 发版门禁：上面三项 + 宿主能力体检
```

门禁结果会落盘到 `build/gates/latest-<plugin>.json`（`build/` 已 gitignore）：含当前 commit、
每步 `status`/断言 `counts`/耗时与失败时的输出尾部。以前结果只活在终端和 commit message 里，
事后无法机器核对「哪次 gate 真的绿了」；发版前可直接读这个文件核对。`pnpm gate --dry-run`
也会写一份 `verdict: structure-pass` 的结构自检报告。

`packages/projects/test/` 覆盖：

| 文件                | 证明什么                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `store.test.js`     | 仓储：原子写、损坏文件**改名隔离不删除**、未来格式拒绝、旧字段补齐、默认策略 L1               |
| `context.test.js`   | 渲染：16k 预算的裁剪顺序、记忆索引裁剪、**不与宿主已加载的 AGENTS.md 重复**                   |
| `attach.test.js`    | 注册：全局注册一次、按 context 里的 agent/session 求值；未归属/归档返回空串；渲染异常不炸请求 |
| `overview.test.js`  | 状态机：五态迁移、`turn/start` 清失败、**失败从 `assistant/attempt` 判**、`replay` 重建、排序 |
| `worktree.test.js`  | 命名与路径（**防目录穿越**）、命令计划（默认不加 `--force`）、porcelain 解析、回收三重判据    |
| `thread.test.js`    | **真 git 集成**：建隔离线程、非 git 降级、建失败降级、脏工作区拒绝回收、启动对账              |
| `index.test.js`     | 清单自检：`dsh.bundle.patch` 存在、`files` 白名单逐项存在、**不把宿主包声明成依赖**           |
| `budget.test.js`    | 预算闸：暂停/归档优先、每日线程数、并发数、token 分桶（缺 `usage` 时不误判）                  |
| `trash.test.js`     | 删除安全：回收站路径（防穿越）、影响面四件事、`removeProject` 不动会话日志                    |
| `notify.test.js`    | 通知：只提醒**新出现**的失败/等待，不重复弹；线程消失不提醒                                   |
| `wake.test.js`      | 信封：必带线程结果、信任判定、注入去重、非 principal 的 report 被包成数据                     |
| `routing.test.js`   | 路由：规则优先、坏正则不炸、自治矩阵（L0/L1 不能建线程）                                      |
| `persona.test.js`   | 人格：默认三条准则、明确声明不改权限、不与项目指令重复                                        |
| `tools.test.js`     | 工具篮子：6 个 `project_*`（含记忆读写）、无 shell/写/删/推/合并、危险动作只能申请            |
| `executor.test.js`  | 执行器：批准≠可执行、**动作↔开关显式映射**、阈值、argv 无 shell、恢复证据                     |
| `autopr.test.js`    | auto PR 四档：默认关、只碰 `dsh/` 分支、幂等、CI 条件、重试上限                               |
| `autofix.test.js`   | auto-fix：轮数上限、无进展、同错两次、**碰测试文件即停**、错误签名稳定性                      |
| `untrusted.test.js` | 不可信输入：未知来源一律 `relay`、围栏不可被提前闭合、控制字符过滤                            |
| `memory.test.js`    | 记忆写入：幂等、单条与总量上限、时间戳注释、被拒时给出原因                                    |
| `exec.test.js`      | 子进程封装：参数原样传递、失败返回 code 不抛、cwd 生效、命令不存在也不抛                      |

## 2. web 端到端冒烟（250 项）

> 0.10.0 面板改版后：新建走「入口 → 模态（两入口）→ 表单」，列表页新增搜索/排序/收藏，详情页改为
> 主列 + 右栏（右栏为值行 + 编辑动作），并补了 toast、两列 DOM 顺序、值行无 input 等断言，故 78 → 102。
> 旧版断言清单仍适用于 0.9.x，新增部分见 `scripts/smoke-projects.mjs` 中 `data-projects-new*` /
> `data-projects-search` / `data-projects-sort` / `data-projects-pin` / `data-projects-rail-*` 相关断言。

> B1（Overview 与项目主页）再 +31，故 102 → 133。新增的 `data-*` 锚点：
> `data-projects-firstrun*`（首启引导只出现一次，`firstRunDone` 落 `storages/projects_ui.json`）、
> `data-projects-pill*`（5 类计数 + 点击过滤 + 过滤为空的空态）、
> `data-projects-group*`（分组计数/折叠/折叠状态跨进详情保留）、
> `data-projects-welcome*` + `data-projects-spark`（Welcome 头/状态句/7 日迷你图）、
> `data-projects-thread-steps`（无 todo 时必须是 `—`）、`data-projects-thread-subtitle`（缺数据必须留空）、
> `data-projects-thread-resolve` / `-unread-toggle`（手动 resolve/重开、未读圆点）、
> `data-projects-switcher*`（真切换项目）、`data-projects-dir-item/-remove/-limit`（多目录 ≤10）。
> 宿主侧另外断言：线程六态与 `resolvedAt` 已回写 `projects.json`、项目 `icon/repos/dirs` 落盘、
> `firstRunDone=true` 在宿主 storageDomain 里可回读。


> B2（把桩接通）再 +24，故 133 → 157。新增的 `data-*` 锚点与断言：
> `data-projects-coordinator*`（项目页的协调者区：不是宿主 composer；空态 → 点「建协调者」→
> 回读 `data-projects-coordinator-session` 非空；`compaction` 有无都要给出明确结论，这是 F10 的判空兜底）、
> `data-projects-poll-state` + `data-projects-detail-realtime-ci`（F21：轮询状态可见；实验开关 **disabled** 且
> `data-projects-detail-realtime-ci-implemented="no"`——实时监听未实现，盘上不允许出现 `realtimeCi=true` 的假状态）、
> `data-projects-thread-expand` → `data-projects-thread-detail`（展开面板：`-start-card` 起始卡、
> `-chips`/`-params` 行内 chip、`-tasks` + `-tasks-source`（无 todo 必须是 `none`，不编 0/0）、
> `-steer-input`/`-steer`、`-model-row`（`available=yes|no` 显式降级）、
> `-create-pr` + `-branch-bar`（无分支时按钮禁用并写明原因））。
> 宿主侧另外断言：`coordinatorSessionId` 落盘、`coordinator/created` 写审计、
> 每条线程记录都带 `ciState`/`headRefOid` 字段（`null` 也显式存在，不是缺字段）、
> 线程 `state` 回写为具体值 `resolved` 且与 UI 最后显示一致、
> `resolvedAt` 非空且与 UI 回读逐字符相同、无 todo 的线程 `todos` 恒为 `null`、
> 归档项目 `archivedAt` 是可解析 ISO 时间、未归档项目 `archivedAt` 恒为 `null`、
> **冷启动读路径**（`ProjectStore.load()` + `deriveThreadState()`）与 UI 最后显示一致、
> 线程 `dir` 是项目目录之一、`resolve`/`reopen` 写审计。

> **B4（结构性三项：Routines / 权限收窄 / 双模式提醒）再 +24，故 196 → 220。** 新增锚点与断言：
> `data-projects-rail-routines*`（详情右栏「定时任务」段：计数 + 新建入口 + 提醒入口）、
> `data-projects-routines*`（可用性 `available=yes|no` 如实反映宿主 `schedule` 是否装载、成本提示里必须有
> 「一次模型调用」与「60 秒」、六档频率枚举逐项等于 `manual,hourly,daily,weekdays,weekly,monthly`）、
> `data-projects-routine*`（创建 daily 09:30 → 行出现且描述「每天 09:30」+ 宿主 status；History 面板
> `-count=0` 且写明「还没有投递」——不编造投递；停用后按钮回读成「启用」；手动档描述必须有
> 「只有点 Run now」且**不建宿主任务**；删除后行消失且盘上不留记录）、
> `data-projects-reminder*`（默认模式 `timer` + 项目设置两档；对话框两模式按钮齐全，timer 档文案必须含
> 「不花模型调用 / 关着不响」，切 schedule 后必须含「跑一次模型 / 关着也会跑」；`minutes=0.02` 创建后
> **真到点**：行状态回读 `fired`、`shell.overlay` toast 出现「冒烟提醒」；再建一条 60 分钟的并取消，
> 状态回读 `cancelled`）、
> `data-projects-preset*`（默认 `current=""` 即「继承宿主」、选项来自宿主 `catalog()` 且带「更窄」标记、
> 卡片必须写明「推 / 合并 / 删除永远需要你批准」且不绕过；选一个比宿主默认更窄的档 → `-current` 回读等于所选，
> `-readback` 里至少有一个会话 `ok=true` 且 `currentPreset` 等于所选）。
> 宿主侧另外断言：`routines[]` 落盘带宿主 `scheduleId`、频率 daily、时间被补成 `09:30:00`；
> 停用后本地 `enabled=false`；手动档删干净；`reminders[]` 里 timer 那条 `state=fired` + `firedAt` + `unread=true`；
> 取消那条 `state=cancelled`；`project.preset` 等于 UI 所选（写→回读）。
> 覆盖不到的宿主侧行为（`schedule` 到点投递、重启后 timer 恢复）用单测固定：`test/routines.test.js`、
> `test/reminders.test.js`（`planReminderRecovery` 覆盖「关机期间到点」）、`test/b4-store.test.js`。

> **B4 反向验证（每条新断言为什么坏实现会红）**：Routines 的成本提示若被删，`/一次模型调用/` 与
> `/60 秒/` 两条正则同时红；`describeRoutineFrequency` 若把 daily 写成「每天 09:30:00」而 UI 漏了截断，
> 「每天 09:30」断言红；`schedule.create` 没被调用时行拿不到宿主 status（`data-projects-routine-status`
> 会是 `manual` 而不是 `active/paused`）且 Node 侧 `scheduleId` 为空；timer 若没真起、或到点没写回，
> `reminder-state` 永远停 `pending`、盘上 `firedAt` 为空；toast 若没接 `shell.overlay`，
> `data-projects-reminder-toast` 不会出现；权限开关若只是「存了名字没应用」，`-readback` 里没有
> `ok=true && currentPreset===所选`（我们会同时校验 current 与 readback 两处）；若把默认档写成
> 「工作区可写」而不是继承，`-current` 初值断言直接红。

> **B1 审查修复（同一分支，2026-11-23）**：上一版有 4 条宿主侧断言是恒真式（只校验「∈ 六态枚举」/
> 「`null` 或字符串」），已在上面替换成具体值 + 深比较；另外补了「冷启动读得回来」与「UI/盘上一致」两组，
> 保证坏实现（永远不写回、写进去读不回）会 FAIL。批次记录见 `notes/projects/claude-borrow/progress.md`
> （私有笔记，不在公开仓库）。

> **B5（Library / Artifacts：F33 F34 U15）+ B3 复审修复再 +18，故 220 → 238。** 新增锚点与断言：
> `data-projects-library`（+`-loaded` / `-degraded` / `-artifacts-available` / `-meter` / `-file-count`）、
> `data-projects-library-search`（+`-search-note` / `-search-run` / `-matches` / `-match`）、
> `data-projects-library-files`（+`-file` / `-dir` / `-files-unavailable`）、`data-projects-library-degraded-note`、
> `data-projects-artifact-open`、`data-projects-artifact-card`（+`-kind` / `-version` / `-available` / `-time` / `-cover`）、
> `data-projects-thread-artifacts`（+`-available` / `-count`）、`data-projects-folder-cwd-hint`。
> 断言覆盖：Library 真渲染（不再是「待接入」占位）、文件面列出项目目录里的 `seed.txt`、搜索只按文件名且
> `seed` 命中、产物面降级明示「需要 dsh-artifacts 0.2」且打开按钮禁用、降级时不伪造产物卡、授权卡写明
> cwd 语义（push-branch 在 worktree 里跑并继承项目目录授权）。宿主侧（Node 直连 RPC，`token → cookie →
> POST /api/<ns>/<method>` 的 client-request 信封）：`recordArtifact`→`libraryView.artifacts.stored` 的
> 写→回读（含 `source.toolCallId`）、`storedSummary` 计量、`artifacts-not-installed` 降级 reason、
> `workspaceFiles` 文件面读回 `seed.txt`、只搜文件名（正文里的 `needle` 不命中）、未知 `projectId` 的
> `listMemoryFragments` 被拒、`authorizeFolder(once)` → `requestAction(merge)` → `resolveApproval` →
> `executeApproval` 被 `switch-off` 拒后 once 仍 `used=false`。

> **B3 复审修复（同分支，2026-11-23）**：P0 `store.js` 的 effort 白名单删掉（`max`/`xhigh`/`off` 经手填
> 写入→回读，审计里能看到三次 `thread/defaults`，`test/b4-store.test.js` 覆盖冷启动回读）；P1 locale 补齐
> 44 键（`test/locale-parity.test.js` 锁 runtime↔locale 键集与文案值，冒烟再跑一次同口径检查）；
> P1 冒烟开局加 INFRA 自检（端口不可连 / 插件未激活 / `projects.json` 未落盘 / 浏览器脚本无结果都
> fail-fast，不进断言计数），并把 toast 消失、会话行、归属菜单、详情打开、折叠回读五处固定等待改成轮询；
> P2 once 凭据改到「所有闸通过 + 占位成功」之后消费、执行没落地时回滚（`test/service-execute.test.js`
> 覆盖 switch-off / repo-unknown / no-worktree 三条拒绝路径）、文件夹闸按实际 cwd 所属目录求 mode；
> P2 `listMemoryFragments` 先校验项目存在（单测静态守卫 + 冒烟真实 RPC 各一条）。

> **B6（收尾：F29 自动 resolve + 三个接线 P0）+10，故 238 → 248。** 新增断言与「坏实现为什么红」：
> - **F29 自动 resolve**（浏览器）：`data-projects-auto-resolve` + `-select` 在详情右栏存在、默认 `off`、
>   选项 ≥2 → 改成 7 天后 `-select` 回读 `7`（断言「UI 回读一致」而不是只断言派发过 change）。
>   若只写字段不接 UI，第一条红；若控件是假开关（onChange 没接 RPC / RPC 拿不到实参），第二条红。
>   （宿主侧）`projects.json` 里该项目 `autoResolveDays === 7` 且与 UI 两次回读一致；审计出现
>   `project/auto-resolve`；自动 resolve **不误伤**：审计里没有 `thread/auto-resolved`，
>   `projects/checkAutoResolve` RPC 返回 `{ok:true, checked>=1, resolved:[]}`。
>   若启动/每日检查误判近期线程，第三条红；若 RPC 没接线，第四条 RPC 直接非 200/无回执红。
> - **P0-2 启动 replay**：线程记录里 `events` 非空且含 `turn/start` + `turn/end`；`hydrateThreadView()`
>   （replay + 人工 resolve 覆盖）重建出的六态与 UI 最终态一致（`resolved`）。只把 `replay()` 写好却不在
>   `hydrateViews()` 里调用 → `hydrateThreadView` 拿不到事件、视图归零为 `idle`，第二条红。
> - **P0-3 threadStats 接进行摘要**：先把隔离线程 worktree 的 `seed.txt` 追加 2 行；未改动时行摘要必须是
>   `diff N 文件`（不是恒 `diff n/a`），改动后 `data-projects-thread-diff` 精确回读 `1:2:0` 且文案含
>   `+2/-0`。`progress()` 若继续只传 `stats`（不传 `diff`），两条都会停在 `n/a`。
> 单测侧（`test/autoresolve.test.js` / `test/replay.test.js`）固定边界：刚好 N 天命中、差 1ms 不命中、
> 超过命中、关闭/非法值一律不命中、已 resolved/归档/无时间事实不动、真实 store 冷启动 + 幂等；
> 以及 `compactEvent` 只留可回放最小事实（正文/参数不进盘）、新 store → replay 非 idle、
> resolve 覆盖与「resolve 后又有新活动则旧 resolve 过期」、journal 上限 80、旧数据无 `events` 仍可读、
> service 启动路径源码守卫（`hydrateViews()` / `appendThreadEvent`）。
> **P0-4 routing 契约**没有 UI 面可断言（走审批执行路径），由 `test/settings.test.js` 锁：字符串 `when`
> 明确拒绝、对象 `when` 写入后能被 `matchRules()`/`decideRoute()` 真命中、`defaultRules()` 自己满足契约。

> **页签收敛（3 页签，UI 规范 §7.3）+2，故 248 → 250。**
> 项目主页的 5 个页签（`threads / memory / library / routines / audit`）收到 3 个
> （`threads / memory / routines`）：**Library** 变成右栏一行入口
> （`data-projects-rail-library` + `data-projects-library-open`），点开在**主列**
> `data-projects-library-main` 里渲染同一份 `LibraryView`，`data-projects-library-back`
> 或再点同一右栏行收起；**审计**移到设置 Debug 区
> （`data-projects-settings-audit`，列表仍用 `data-projects-audit` / `-audit-empty`）。
> 被改写的断言（逐条）：
> 1. 「项目详情可打开且有**五个**视图页签」→「恰好**三个**页签
>    （threads/memory/routines）且不含 library/audit」（数量不变）：
>    从「5 个页签都在」改为「3 个页签 + 旧页签不再存在」。
> 2. 「Library 页签渲染真实视图」→「Library 从**右栏入口**打开并在
>    **主列**渲染真实视图（不再是页签；B5 已落地）」（数量不变，
>    断言强度从「有视图」升到「右栏入口 + 主列渲染 + back 回线程列表」）。
> 3. B5 那组 Library 断言的打开方式从 `openTab("library")` 改为点
>    `data-projects-library-open`，收尾从点 threads 页签改为点 `data-projects-library-back`
>    （断言本身不变）。
> 4. 「审计页签可渲染（空态也算）」→「审计在设置 Debug 区渲染
>    （原项目详情页签，空态也算）」（数量不变，渲染位置改到设置）。
> 5. 「危险开关变更写审计（project/policy-changed）」→「同一条审计在
>    设置 **Debug** 区回读（先在设置里选到冒烟项目）」（数量不变）。
> 6. **新增**：「Library/审计已外迁：详情页无这两个页签，右栏有 Library
>    入口且无审计残留锚点」。
> 7. **新增**：「Library 右栏行可再次点击收起（aria-pressed 跟随，
>    不占页签）」。
> 对应的 `data-projects-library*` 旧锚点全部保留（只外包了
> `data-projects-library-main`），因此 Library 数据面的 9 条断言一字未改。


`pnpm smoke:projects` 在临时 home 里种子一个**真实 git 仓库**作为工作区，然后：

1. 打开「项目」面板 → 断言导航入口、面板、`data-projects-status` 锚点、本地化摘要
2. 通过 UI 新建项目 → 断言行出现、计数增加、无错误条
3. 会话行「…」菜单 → 「归属到项目…」→ 断言 `projects.json.threads` 非空且指向真实项目
4. 详情页 → 四个页签（线程 / Library / Routines / 视图）可切换 → 返回回到列表；记忆在「项目设置 › 记忆」
5. **绑定项目目录** → **新建线程** → 断言线程行、`data-projects-thread-state`、
   `branch` 形如 `dsh/…`、**worktree 目录真实存在且在主工作树之外**
6. **暂停/恢复**项目 → 断言详情页有按钮、预算用量可见、宿主侧 `state=paused`
7. **删除**一个一次性项目 → 断言影响面文案、确认后项目从列表消失、回收站有 `manifest.json` 且写明可恢复
   7.5 **归档 / 取消归档**：用一次性项目归档 → 宿主侧断言 `state=archived`（归档不删数据，取消归档回到 active）
8. **通知器**挂载在 `shell.overlay`（全局轮询，不依赖浏览器 Notification 授权）
9. 宿主侧断言：`projects.json` 合法 JSON、`format=1`、默认策略 L1、无 `.tmp` 残留、
   `threads` 有归属、worktree 目录真实存在且在主工作树之外、回收站清单存在、截图落盘

## 3. 桌面只读回归

```bash
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
pnpm smoke:projects-desktop --require
```

默认**严格只读**（不建、不删、不写 live profile）。断言：
插件 client 半已加载（按 `window.__DSH_BOOT__.entries`）、侧栏有「项目」入口、
面板渲染且无 `data-projects-crash`、状态锚点可解析、摘要不是裸 key、新建控件存在（**不提交**）、
**详情页两列**（`data-projects-detail-grid` / `-main` / `-rail`，右栏在主列右侧）、
**6 个状态药丸 + 3 个页签**（`data-projects-pill` × 6、`data-projects-tab` 恰好为
`threads|memory|routines`）、**Library 只在右栏有入口、审计不在详情页**、
右栏三段（指令/记忆/上下文）、详情可返回列表、
**设置四个分区 + Debug 区里的审计**（`data-projects-settings-nav-item` 恰好
`general,memory,usage,debug`、`data-projects-settings-debug`、`data-projects-audit-title` /
`data-projects-audit`）、关闭后界面仍可用。

**没有数据分支 SKIP**（2026-11-24 起）：
- live profile 里**一个项目都没有** 时，不再记 SKIP——改为断言**真实的空态**：
  `data-projects-empty` 存在、标题与说明非空、新建 CTA 可用、`data-projects-summary` 是
  “0 个项目 … 0 个线程”、回收站提示可见且列表行数为 0。详情页本身由 `--create` 覆盖。
- 设置页打不开（`cordis.patch.yml` 里 `ui-settings enabled:false`）时才进 `SKIP`；
  能打开就真断言（四个分区 + Debug + 审计，不再是“渲染了就算 PASS”）。

**`--create`（显式授权写入，默认关）**：用 UI 从零建一个
`smoke-desktop-<ts>` 临时项目 → 跑上面的详情页断言 → 再用同一套 UI
「详情 ⋯ → 删除 → 确认 → 回收站 → 彻底删除」，最后断言盘上
`projects.json`（默认 `~/.dsh/projects`，可用 `DSH_PROJECTS_DATA_ROOT` / `DSH_HOME` 覆盖）
里已没有这个项目，且列表里也不再出现。四条新断言：建项目 /
删除进回收站 / 回收站两步彻底删除 / 盘上校验。

> **2026-11-24 实跑（DSH 0.2.2-rc.5，live profile，重启后）**：
> `pnpm smoke:projects-desktop --require` → **15 PASS / 1 SKIP / 0 FAIL**（唯一 SKIP 是详情页，目录里没有项目）；
> `pnpm smoke:projects-desktop --require --create` → **24 PASS / 0 SKIP / 0 FAIL**（建临时项目 → 断言 → 删除 → 彻底删除 → 盘上核验零残留）。
>
> 实跑踩到并修掉的两个脚本坑（都会伪装成“功能没做”）：
> 1. **设置入口在左下角账户菜单里**（「设置 ⌘ ,」是 `[role=menuitem]`），不是独立按钮；菜单项文本带快捷键后缀
>    （`设置⌘,`），所以正则不能加 `\b`（中文无词边界），否则永远匹配不到。
> 2. **关模态不能靠 `document.dispatchEvent(Escape)`**：新建项目模态的 `onKeyDownCapture` 只在焦点位于模态内部时
>    触发；模态没关掉时遮罩会吃掉后续点击（表现为“设置入口找不到”）。改为点 `[data-projects-new-close]` 并加一条
>    「模态可关闭」断言。同理，点项目行要 `row.click()`，点行内第一个按钮会落到 pin/⋯ 上，进不了详情。

未装进当前 live profile 时默认 **SKIP**，加 `--require` 则 **FAIL**（发版门禁用它）。

**2026-11-21 实测（DSH 0.2.2-rc.5）**：0.1.1 / 0.2.1 / 0.3.0 / 0.4.1 / 0.4.2 各跑过一次，都是 11 PASS / 0 SKIP / 0 FAIL
（0.3.0 那次 web 冒烟同时是 52 项，门禁 64s 全绿）。
0.2.1 那次是**装进 live profile 并重启桌面版之后**跑的（`pnpm gate:all --plugins projects --idle-session …`，
64s 全绿）。live profile 里若 `ui-settings` 是 `enabled: false`，桌面回归的「设置页出现项目分节」不再计 PASS：
渲染了就真断言，没渲染就进 `SKIP` 并计入末尾计数行（2026-11-23 起）。

原始记录（0.1.1）：

```
11 PASS / 0 SKIP / 0 FAIL
```

这是本插件第一次跑通桌面回归。前置是**先把可见会话切到空闲会话**：桌面回归读的是
「当前可见会话」，而 agent 在自己的会话里跑时那一轮正在跑回合
（[runtime rc.5 §5.1](../runtime/0.2.2-rc.5.md)）。用一条命令把切换自动化掉：

```bash
pnpm gate:all --plugins projects --idle-session "<任一空闲会话标题的子串>"
```

`gate:all` 会在桌面步骤前切过去、结束后切回原会话，并用 `desktopGateVerdict()`
拦「缺计数行 / 全 SKIP」的假绿。

## 4. 手工验证（发版 / DSH 升级后）

| #   | 步骤                                            | 期望                                                                                  |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | 建项目 → 详情页绑定一个 git 仓库目录 → 新建线程 | 线程行出现，状态「进行中」→ 最终「已完成」或「失败」                                  |
| 2   | 看 `.dsh-worktrees/<repo>/<prj>-<n>`            | 目录存在；`git worktree list` 里能看到 `dsh/…` 分支                                   |
| 3   | 在项目目录里改点东西（不提交）→ 归档该线程会话  | worktree **保留**，日志里有 `worktree/reclaim` 审计且结果非 ok                        |
| 4   | 干净线程直接归档                                | worktree 被删除，`git worktree list` 里消失                                           |
| 5   | 重启 DSH                                        | 面板项目与线程仍在；记录里指向不存在目录的 worktree 被清掉（审计 `worktree/missing`） |
| 6   | 归档项目                                        | 项目从列表消失但数据保留；可 Unarchive                                                |

## 5. 已知坑（踩过并已绕过）

| 坑                                         | 现象                                     | 处理                                           |
| ------------------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `main` 用 `key`、其他 slot 用 `id`         | 面板永远不出现                           | 见 `docs/runtime/0.2.2-rc.3.md` §11.4          |
| RPC 回执包在 `value` 里                    | `.map is not a function` / 白屏          | 解包 `"value" in result`                       |
| SRC 模式禁止默认参数                       | `must use unique identifier parameters…` | Remote 方法不带默认值/解构/rest                |
| 运行时字典只在 `locale/*.json`             | 界面显示 `panel.title`                   | 必须在 client 半 `locale.register`             |
| 首启「预览版说明」对话框                   | 输入框收不到键盘（其余内容 `inert`）     | 冒烟先点掉它                                   |
| **空白会话没有行内动作**                   | 会话行找不到「…」                        | 冒烟先发一条消息让它非空白                     |
| **composer 是 `contenteditable`**          | 设 `value` 无效、消息发不出              | 聚焦 + 真实键盘 + Enter                        |
| `ctx.inject` 回调是异步的                  | 服务刚构造就被调用 → "unavailable"       | 就绪 Promise + 超时（§11.5）                   |
| 失败在 `assistant/attempt` 而非 `turn/end` | 失败被当成功                             | 记住本轮 attempt 再在 `turn/end` 合并（§11.6） |
| 归档不是 session 事件                      | 监听不到                                 | 用 `workspace/session-archived`（§11.7）       |

## 6. 设置分节：临时 home 里真打开，不再「跳过计 PASS」

`settings.section` 的断言依赖「设置页在本机 profile 里可用」。本机 live profile 的
`cordis.patch.yml` 把 `ui-settings` 写成 `config.enabled: false`，整份拷进临时 home 会把这个状态带过去。

现在的做法（**只改临时 home，不动 live profile**）：

1. `dsh plugin add` 之后，把临时 home `cordis.patch.yml` 里 `ui-settings` 的 `enabled` 改成 `true`；
2. web 客户端的设置入口没有稳定可读的按钮 label，冒烟用宿主自己的快捷键打开设置弹窗
   （web 默认 `primary+alt+Comma`），再点「项目」分节，等待 `data-projects-settings` 渲染；
3. 设置页若仍未渲染，这 14 条断言会进入**如实计数**的 `SKIP` 行（不计 PASS、不伪装覆盖），
   计数行写成 `X PASS / Y SKIP / Z FAIL`。

之前的“改 enabled 无效”结论来自旧尝试：问题不是配置没生效，而是**没有可点的设置入口**；
用宿主快捷键打开设置弹窗后，`settings.section` 能正常渲染（本批次实测通过）。

## 7. 冒烟为什么会「导航失败」：cookie 按主机作用域

反复用临时 `DSH_HOME` 跑冒烟时，**同一个浏览器 profile 会在 `127.0.0.1` 上堆出一批
`dsh-auth-*` cookie**——它们指向早已退出的临时宿主。

关键点：**cookie 的作用域是主机，不含端口**。于是新宿主起来后，浏览器会把这些过期 token
一起发过去，服务端认错就 401，Chromium 表现为
`page.goto failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE`（看起来像页面坏了，其实是鉴权失败）。

处理（`scripts/smoke-projects.mjs` 里已实现）：

```js
const { cookies } = await page.cdp("Storage.getCookies");
for (const cookie of cookies ?? []) {
  if (!String(cookie.domain ?? "").includes("127.0.0.1")) continue;
  if (!String(cookie.name ?? "").startsWith("dsh-auth-")) continue;
  await page.cdp("Network.deleteCookies", {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path ?? "/",
  });
}
```

**只删 `127.0.0.1` 的 `dsh-auth-*`**：不要用 `Network.clearBrowserCookies`，
那会把用户所有站点的登录态一起清掉。

另外冒烟保留了容错导航（token 入口 303 失败时改导航到已设好 cookie 的根路径），
但**根因是 cookie 堆积**，容错只是兜底。

## 8. 零网络验证远端写入

开 PR / 合并需要 GitHub，但链路本身可以在本机验证：

- **远端**：`git init --bare /tmp/remote.git` + `git remote add origin /tmp/remote.git` 顶替；
  推完用 `git -C /tmp/remote.git branch --list` 断言分支真的到了远端。
- **gh**：在临时目录放一个同名可执行脚本（记录 argv、回显假 PR URL），把该目录放到 `PATH` 最前面。

两个反复踩到的坑：

1. **陈旧 tarball**：`pnpm pack` 只重打了探针却没重打插件时，跑的还是旧代码（症状是"改了没生效"）。
   每次验证前把**插件和探针两个包都重打**，或直接检查安装目录里的代码是否含最新改动。
2. **分支撞名**：线程分支名按项目名生成，同名项目重复创建会让 `git worktree add -b` 失败并降级共享目录，
   于是"没有 worktree → 没有可推分支"。验证时给项目名加唯一后缀。

## 9. 合并后清单（人工执行）

PR 合并只是开始。下列步骤需要真实环境，按顺序做一遍，把「已验证」补齐：

### 9.1 合并三个 PR

```bash
gh pr merge 143 --squash --delete-branch          # M1
gh pr edit 144 --base main && gh pr merge 144 --squash --delete-branch
gh pr edit 146 --base main && gh pr merge 146 --squash --delete-branch
```

`feat(<plugin>)` 属 C 档，**只能人工合并**（见 CONTRIBUTING §自动合并分级），不要打 `automerge`。

### 9.2 发版

合并后 Changesets 会开一个 `chore(release): version packages` PR，合并它即发布 `0.1.0`。
可用 `gh pr list --search "version packages" --state open` 找到。

### 9.3 桌面只读回归（2026-11-21 已绿，保留步骤备查）

```bash
# 1) 装进 live profile（打包，不要用 link:）
cd packages/projects && pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-projects-0.1.0.tgz

# 2) 带调试端口重启桌面版
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1

# 3) 跑（--require：跑不起来就算失败，而不是跳过）
pnpm smoke:projects-desktop --require
```

预期：`PASS` 数等于当次执行的断言数（脚本最多 **17 项**；live profile 里一个项目都没有时
「详情页主列+右栏」那条不跑，记 SKIP，不计 PASS）。在此之前它一直输出
`SKIP 插件未装进当前 live profile`。

> **B1 审查 P1-5 修后的口径（未复跑）**：首启引导那条以前会**点掉 CTA**，等于往 live profile 的
> `firstRunDone`（storageDomain）里写东西——和「默认只读」自相矛盾。现在改为**只断言存在 + CTA 有文案、
> 不点击**，只把节点从 DOM 里摘掉（不写任何存储，刷新后引导仍在）。这一改动**没有在 live 桌面版复跑**
> （本批不重启桌面版），下次 `pnpm gate projects` 时以实跑结果为准；在那之前不要写死 PASS 数。

### 9.4 真实 GitHub 上的远端写入（2026-11-21 已做）

在一个**临时私有测试仓库**上跑通了完整链路（用完即归档，不复用；下文 PR 号与合并提交 SHA 只作本次记录）。做法是：
临时 `DSH_HOME` + **复制真实 desktop profile** 起临时宿主（与 web 冒烟同一套 boot 方式，
否则只有 `dsh-base`、web 服务起不来）+ 一个临时驱动插件调用 `projects` 的 RPC。

实测结果：

| 档位    | PR  | GitHub 侧事实                                                                                                     |
| ------- | --- | ----------------------------------------------------------------------------------------------------------------- |
| `draft` | #5  | `state=OPEN`、`isDraft=true`、**未被合并**（合并请求被前置校验拒绝：`merge/pr-is-draft`）                         |
| `ready` | #6  | `state=MERGED`、`mergedAt=2026-11-21T05:12:06Z`、main 上出现 **squash 合并提交** `8332471 e2e: ready commit (#6)` |

四个检查点全部确认：draft PR ✓、分支名 `dsh/…` ✓、标题前缀 `dsh:` ✓、
合并只在「开关打开 + 审批通过」后发生且 argv 为 `pr merge <n> --squash --repo <owner/repo>` ✓。

**这一轮抓到了两个真缺陷**（已修，见 [runtime rc.5 §8.3](../runtime/0.2.2-rc.5.md)）：

1. `gh pr merge` 没带 `--repo` → 合并会打到**宿主进程当前目录所在的仓库**；
   且 `gh pr merge` 对「已合并的 PR」仍返回 0，于是插件误报成功。修复：合并前从项目目录的
   `git remote get-url origin` 解析 `owner/repo` 并要求必须带上，解析不到就拒绝。
2. 没有「非 draft / 可合并」前置校验 → draft PR 也被当作可合并。修复：`gh pr view --json
   isDraft,mergeable,state` + `checkMergePreflight()`；`mergeable=UNKNOWN`（GitHub 刚建 PR
   时会这样）做有界重试而不是硬拒。

原计划（保留作步骤参考）：


本地验证用的是 bare 远端 + 桩 `gh`（§8）。真机确认只需一次：

1. 在一个**测试仓库**上建项目与线程；
2. 打开「自动开 PR」到 `draft` 档，跑一轮让线程产出提交；
3. 检查 GitHub 上出现的是 **draft PR**、分支名形如 `dsh/<project>-<n>`、标题以 `dsh:` 开头；
4. 打开 `autoMerge` 开关、走一次审批队列 → 确认合并命令是 `pr merge <n> --squash`，
   且合并**只**在开关打开 + 审批通过后发生。

### 9.5 发版后回到这里补一行

在 §4「手工验证」的表格里记下本次 DSH 版本与结果，
并把 README 状态行里的「真实 GitHub 上的效果还需发版后确认一次」改掉。

## 10. 危险动作的真机验证（临时宿主 + 本地 bare 远端）

三个推送/清理类动作在本地就能端到端验证，不需要真 GitHub：

- **远端**：`git init --bare` 当 origin；主仓库用
  `git remote set-url origin https://github.com/<slug>/<name>.git`（让插件能解析出 owner/repo）
  \+ `git remote set-url --push origin file:///path/to/remote.git`（真正推送到本地 bare）。
  `get-url` 读到的是 https 形态、推送落到本地目录，两件事都不牺牲。
- **`gh`**：PATH 前置一个桩脚本，按参数返回 protection 404 / rulesets `[]` / commits 两人。
- **宿主**：复制真实 desktop profile 起临时 `DSH_HOME`（与 web 冒烟同一套 boot 方式）。
- **驱动**：临时插件调 `projects` 的 RPC（`requestAction` → `resolveApproval` → `executeApproval`）。

2026-11-21 实测结果：

| 动作                    | 场景                     | 结果                                                                                    |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `push-branch`（普通）   | 开关开                   | `executed:true`，远端分支 = 本地 HEAD                                                   |
| `push-branch`（强推）   | 期望 SHA 与远端一致      | `executed:true`，远端 SHA 更新                                                          |
| `push-branch`（强推）   | 另一个 clone 先推了提交  | **`executed:false`（`force-push-failed`）** —— `--force-with-lease` 拒绝了 `stale info` |
| `push-protected-branch` | 未做 per-repo 授予       | **`executed:false`（`protected-push/repo-not-granted`）**                               |
| `push-protected-branch` | 已授予 + 服务端未要求 PR | `executed:true`                                                                         |
| `purgeTrash`            | dry-run                  | `eligible:1 kept:2`，未删任何东西                                                       |
| `purgeTrash`            | 真删但没给确认串         | **`ok:false`（`confirm-required`）**                                                    |
| `purgeTrash`            | 开关开 + 确认            | `purged:1`，并写出 `trash/purge-<ts>.md` 清单                                           |

注意：强推的「远端被别人动过」有两种挡法——前置的 `remote-moved`（用记录过的 `lastPushedSha` 对比
本地 tracking ref）与 `--force-with-lease` 本身。前者依赖 tracking ref 新鲜，后者不依赖，
所以**即使前置检查放过，lease 也会 fail-closed 拒绝**（上表第三行就是这种情形）。

## 11. 审批 → 执行闭环（2026-11-21）

规格要求「批准 ≠ 可执行」：批准只是改状态，**执行是独立一步**。此前这一步没有任何入口
（`executeApproval` 已导出但零调用方），等于安全层空转。现在补上：

- 详情页审批区把「待处理」与「已批准未执行」分开渲染；后者带 `data-projects-approval-execute` 按钮，
  点击调 `executeApproval`，把 `executed:true` 或拒绝原因（`detail.refused`）回显在
  `data-projects-approval-exec-result`
- 服务端补 `purge-trash` 与 `change-settings` 两条执行路径（此前走到 `execution-deferred`）
- `change-settings` 只接受白名单键（`persona` / `routing` / `goal`）；`danger` / `autonomy` /
  `preapprove` / `budget` / `repoGrants` 等安全面一律拒绝（`settings/forbidden:<key>`）

真机验证（临时宿主）：`settingsAllowed` → `executed:true, keys:["persona"]`；
`settingsForbidden` → `settings/forbidden:danger`；`purgeApprovalSwitchOff` → `switch-off`；
`purgeApprovalSwitchOn` → `executed:true, purged:1`（清单已写盘）。

**占用与执行分离（claim / release）**：早期实现把 `executedAt` 写在闸门之前，导致「被拒绝的申请也被占用」，
用户修好条件后无法重试。现在拆成两步：

- `claimApproval()` 在闸门前占位（`claimedAt`），并发第二次会得到 `already-claimed`；
- 执行**成功**才 `markApprovalExecuted()`（落 `executedAt` + evidence，并清占位）；
- 被拒绝或失败一律 `releaseApproval()`，**同一张申请可以重试**；
- 已执行的申请既不能占位也不会被释放（`already-executed`）。

真机验证（临时宿主）：同一张 `purge-trash` 申请先因开关关返回 `switch-off`，
打开开关后**再次执行同一张申请**返回 `executed:true`，第三次返回 `already-executed`；
最终记录 `{status:"approved", claimedAt:null, executed:true}`。

## 12. 合并硬前提与预授权（2026-11-21）

### 12.1 合并的三道硬前提（规格 §7.5 行 3）

之前只查「非 draft / 无冲突」，漏了 CI、人工批准数与合并方式。现在 `checkMergeReadiness` 一次判完：

| 前提     | 判定                                                                                   | 拒绝原因                                                       |
| -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| CI 绿    | `statusCheckRollup` 全部 SUCCESS/NEUTRAL/SKIPPED；**空列表按未配置检查处理并拒绝**     | `merge/ci-unknown` / `merge/ci-not-green` / `merge/ci-pending` |
| 人工批准 | `reviews` 里不同作者的 APPROVED 数 ≥ `policy.merge.minApprovals`（默认 1，0 表示不看） | `merge/not-approved`                                           |
| 合并方式 | 仓库 `allowed_merge_methods` 含 `squash`，否则拒绝（**不改用** merge/rebase）          | `merge/method-unknown` / `merge/method-not-allowed`            |

阈值从 `policy.merge`（`minApprovals` / `maxDiffFiles` / `maxDiffLines`）读，不再是写死默认值。

真机（临时宿主 + 桩 `gh` 切场景）：

```
CI 为空          → merge/ci-unknown
CI 有 FAILURE    → merge/ci-not-green
无 APPROVED      → merge/not-approved
全绿 + 已批 1 人  → executed:true
```

### 12.2 预授权（规格 §7.7.2）

三条全满足才放行：动作在 `policy.preapprove` 里、该动作授权来源是 `policy-grant`、对应危险开关已打开。
命中则 `requestAction` 直接落 approved（`source: policy-grant`）+ 审计 `approval/auto-approved`，
并**立即走 `executeApproval`**——闸门一条不跳过，只是省掉「等人点一下」。

真机：`delete-thread` 列进预授权后 `autoApproved:true`，随后被真实闸门拒绝（`unknown-thread`）；
`merge` 即使列进预授权也 `autoApproved:false`（授权来源不是 policy-grant）。

**注意**：宿主没有审批策略 API（`ctx.approval.setPolicy` 不存在，见 [runtime §11.32](../runtime/0.2.2-rc.3.md)），
所以预授权是本插件用 `policy-grant` 自己实现的，不是宿主能力。

## 13. 可观测（2026-11-21，规格 §7.7.3）

线程行现在多一行摘要：`N 步 · N 次工具 · diff N 文件 +a/-b · N tokens`。

| 指标        | 来源                                                                      | 缺失时                        |
| ----------- | ------------------------------------------------------------------------- | ----------------------------- |
| 步骤数      | `assistant/attempt` 计数                                                  | —                             |
| 工具 / 命令 | `tool/call` 记名，`tool/result` 回填 ok                                   | 取不到命令行则记工具名        |
| tokens      | `assistant/attempt.data.usage`（兼容 `totalTokens`/`total`/input+output） | 显式 `n/a`（宿主常缺）        |
| diff        | `git diff --numstat <base>..HEAD`（`threadStats` RPC 现算）               | 二进制 `-/-` → `null` → `n/a` |

**口径**：统计从插件启动后开始累积（不是回放历史），diff 是现算的所以始终准确。
冒烟断言 `data-projects-thread-stats` 存在且含「步 / 工具 / diff / tokens」。

## 14. 周预算与步数上限（2026-11-21，规格 §7.7.4）

| 闸门           | 配置                       | 行为                                                                           |
| -------------- | -------------------------- | ------------------------------------------------------------------------------ |
| 日 token       | `budget.dailyTokens`       | 到线拒建线程（`budget/daily-tokens`）                                          |
| **周 token**   | `budget.weeklyTokens`      | 按**自然周周一 00:00（本地时区）**聚合，到线拒建（`budget/weekly-tokens`）     |
| **单线程步数** | `budget.maxStepsPerThread` | 超限**只停协调器唤醒**（`wake/skipped` + `budget/steps-per-thread`），不杀会话 |

**为什么步数只停唤醒**：预算是防止无人值守时无限烧 token，不是惩罚使用者——
人还可以继续在同一会话里干活，只是插件不再主动唤醒协调器。

**token 存储改按天分桶**（原先单日桶算不出周）：`usage[projectId].days = { "YYYY-MM-DD": tokens }`，
保留最近 21 天；旧形状 `{date, tokens}` 首次写入时自动迁移，历史数不丢。

`threadStats` 另外返回 `overBudget` / `budgetReason`，面板可据此提示。

## 15. 分支生命周期（2026-11-21，规格 §7.7.5）

**为什么不能用 `git branch --merged`**：它在两个方向都会误判（见 [runtime §11.15](../runtime/0.2.2-rc.3.md)）——
未提交的新分支被当"已合并"、squash 合并的分支被当"未合并"。所以改用三条独立判据：

| 判据         | 检查                                                         | 不满足                                    |
| ------------ | ------------------------------------------------------------ | ----------------------------------------- |
| 是我们的分支 | `dsh/` 前缀 + 与线程记录 `branch` 一致                       | `branch-not-ours` / `branch-not-recorded` |
| 确有合并结果 | 记录 `mergedAt`，或 `merge-base --is-ancestor <branch> HEAD` | `not-merged`                              |
| 无未推送提交 | `rev-list --count <branch> --not --remotes` 为 0             | `unpushed-commits`（读不出也算不满足）    |

**worktree 先处理**：分支被 worktree 占用时 `git branch -d` 会拒绝；所以只在 worktree
`git status --porcelain` **为空**时用 `git worktree remove`（不加 `--force`）移除，脏的一律保留。

删除**只用 `git branch -d`，永不用 `-D`**。RPC `cleanupBranches` 默认 dry-run，真删需 `confirm: true`；
归档项目时自动跑一次（失败不影响归档）。

真机（临时裸远端 + 桩 gh）：已合并且已推送的分支被删；未合并的保留（`not-merged`）。

## 16. 一键建项目模板（2026-11-21，规格 §7.7.6）

`createProject(name, { dirs: [dir], template: true })` 会：目录不存在则建 → 写 `instructions.md` 骨架。

| 情况                   | 行为                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| 目录不存在             | 建目录（recursive）                                              |
| 已有 `instructions.md` | **跳过**（`flag: "wx"`，绝不覆盖），记 `project/template` 审计   |
| 已有 `AGENTS.md`       | **不改动它**，只在骨架里加一行「两者都会注入，请避免写重复内容」 |
| 重复调用               | 幂等                                                             |
| 写盘失败               | 不阻断建项目，记 `project/template-failed`                       |

真机：新目录 → 建好 + 骨架；已有 AGENTS.md 目录 → AGENTS.md 逐字节未变、骨架里出现提示；
同目录再建 → 不覆盖。

## 17. 真实用户走查发现并修复的三项（2026-11-21，v0.4.3）

三个"无先验知识"的用户画像在桌面端走查（CDP 点击 + 截图目视），发现的问题里第一批已修：

### 17.1 回收站预览的网关参数错误

`purgeTrash(options)` 只有一个参数 `options`，客户端却把 `dryRun`/`projectId` 平铺在最外层，
网关按参数名校验直接拒绝，界面上原样显示出：

```
typert gateway: projects/purgeTrash: args fields do not match the descriptor: unexpected "dryRun", "projectId"
```

**结论（通用规则）**：Remote 调用的 `args` **必须**以参数名为键——单对象参数要包一层
（`{ options: {...} }`），不能平铺。核对全仓 16 个客户端调用，仅此一处写错。

### 17.2 删除承诺"可恢复"，却没有恢复入口

删除确认框写"可恢复：删除只移入回收站"，但界面上没有任何恢复入口，唯一能碰到回收站的
「预览可清理项」又因 17.1 不可用 → 删了就找不回来。现在补上：

| 能力 | 实现                                                                            |
| ---- | ------------------------------------------------------------------------------- |
| 看   | `listTrash()` 扫 `trash/<entryId>/manifest.json`，返回名称/线程数/删除时间/体积 |
| 恢复 | `restoreTrash(entryId)` 把项目与线程放回仓储、内容目录搬回、删掉回收站条目      |
| 界面 | 详情页新增「回收站（可恢复）」区块，每行一个「恢复」按钮                        |

**坑**：恢复的是"另一个"项目，恢复后必须触发列表刷新（`onChanged` → `refresh()`），
否则用户点了恢复却看不到项目回来——第一版就是这样，被冒烟抓出。

### 17.3 冒烟断言太弱，把报错当成了通过

原断言只校验"有文字且不含 `FAIL`"，于是 17.1 的网关报错一路绿灯发版。
现在断言必须校验**成功语义**（出现"没有超过保留期的条目"一类文案，且不含
`gateway`/`失败`/`错误`），并新增回收站列表与「恢复往返」两条断言。

### 17.4 走查后的 P1 四项（v0.5.0）

| 项               | 改动                                                                                       | 怎么验                     |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| 建线程写审计     | `createThread` 成功也写 `thread/created`                                                   | 建线程后「审计」页签有记录 |
| 路由结果说人话   | 内部码换成"规则「X」建议「新建线程」，但当前自治等级（L1）不允许…已拦下"，原始码进 `title` | 派活后看文案               |
| 高级设置默认折叠 | 仓库授权 / 回收站两块收进 `<details data-projects-config>`，首屏留给线程                   | 冒烟断言 `open === false`  |
| 重名项目可区分   | 项目行名字后加 `#<id 后缀>`                                                                | 冒烟断言每行都有短 id      |

**又一个模板字符串转义坑**：冒烟里的浏览器脚本是模板字符串，`\w` 会被吞成 `w`，
写成 `/^#[\w-]{4,}$/` 实际是 `/^#[w-]{4,}$/`。字符类一律用 `[A-Za-z0-9_-]` 这种显式写法。

### 17.5 回收站的彻底删除（v0.6.x）

`purgeTrash` 只清「超过保留期」的条目；刚删错又不想留的，需要主动清理的入口：

| 动作       | RPC                                      | 语义                                |
| ---------- | ---------------------------------------- | ----------------------------------- |
| 彻底删一个 | `deleteTrashEntry({ entryId, confirm })` | 不带 `confirm` 只回报字节数，不动手 |
| 清空回收站 | `emptyTrash({ confirm })`                | 不带 `confirm` 只回报条目数与总量   |

界面都用**两步确认**：第一次点进入确认态，第二次点的按钮上直接写
「确认彻底删除（1.6 KB，不可恢复）」——不可恢复的操作必须把代价写在按钮上。
两个动作都写审计（`trash/entry-deleted` / `trash/emptied`）。
### 17.6 记忆页签可写（v0.6.x）

| 动作         | RPC                                           | 语义                                                                |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------- |
| 保存常设规则 | `setProjectInstructions({ projectId, text })` | 写 `instructions.md`（0o600）；空文本=清空（删文件）；上限 20k 字符 |
| 追加记忆     | `appendMemory({ projectId, text })`           | 追加一条到 `MEMORY.md`，重复条目如实返回 `added:false`              |

**坑**：给 Remote 方法的参数加**行内** `/** @type */` 会让 SRC 网关拒绝注册该方法，
运行时表现为 `typert gateway: ...` 而看不出是注册阶段的问题。一律用上方 JSDoc `@param`；
`pnpm check` 的 SRC 守卫会拦住（`Remote 方法 X 的参数表里不能有行内类型注释`）。

### 17.7 回收站必须有一个不依赖项目的入口（v0.6.1）

0.6.0 验收时踩到自锁：回收站只渲染在**项目详情页**里，所以
「删掉最后一个项目 → 没有任何项目 → 进不去详情页 → 回收站打不开 → 恢复不了」。
功能明明有，路却断了。

修法：面板加 `PanelTrash` 组件，在**项目列表为空时**渲染回收站（查看 / 恢复 / 彻底删除 / 清空），
`data-projects-trash` 锚点相同。

**顺带修的**：`store.restoreProject` 之前强制把状态写成 `active`，会把 `paused`/`archived` 抹掉；
现在保留 manifest 里的原状态（冒烟里归档/暂停两条宿主侧断言曾因此变红）。

冒烟断言「项目清零后面板仍能进入回收站（防自锁）」是**真删掉所有项目**再检查的，
恢复时特意跳过留给 manifest 断言的那一条。

### 17.8 边界与空态走查（v0.6.x）

专门针对「清空态 / 异常输入」走了一遍（0 项目、0 线程、非 git 目录、只读目录、超长名字）：

| 场景                   | 旧行为                            | 现在                                                                               |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| 绑非 git 目录          | **静默降级为共享目录**，界面不说  | 绑定当场提示「不是 git 仓库：线程会共享这个目录…」；线程行标「共享目录（未隔离）」 |
| 超长项目名（120 字符） | 行高被撑开                        | 名字单行省略号截断                                                                 |
| 绑定目录               | 成功/失败都无反馈                 | 显示目录状态（git / 非 git），由 `inspectDir` 探测                                 |
| 0 项目                 | 回收站不可达（自锁）              | 面板级回收站（17.7 已修）                                                          |
| 只读目录（0o500）      | 可绑定；非 git 走共享目录，不报错 | 同左（非 git 本来就不建 worktree），状态行也会说明                                 |

**结论**：这类问题单测与常规冒烟都抓不到——只有"真的把数据清空/喂异常值"才暴露。
冒烟因此新增三条：非 git 提示、名字截断、防自锁。

### 17.9 目录绑定的输入校验（v0.7.x）

验收 0.7.0 时我误把 `undefined/plain` 填进目录框，结果**保存成功**，直到建线程才崩：

```
failed to create session: Error: session header cwd must be an absolute path, got "undefined/plain"
```

这对用户是死胡同：界面说"绑定成功"，几秒后在完全不相干的位置报一句宿主错误。
现在 `saveDir` 当场校验：非绝对路径（不以 `/` 开头）直接拒绝，`data-projects-dir-info="invalid"`
并用危险色提示「需要绝对路径（以 / 开头）；相对路径无法作为会话目录，已拒绝保存」。

**顺带**：非 git 提示里的 Markdown 星号（`**共享这个目录**`）会原样显示——界面不渲染 Markdown，已去掉。

### 17.10 多项目并行与审批队列（v0.7.x）

**多项目并行**（三个 git 仓库 + 一个空目录项目）：建项目、绑目录、建线程、切换详情都正常；
`今日 N 个线程`、列表短 id、目录状态（git/shared）都对。顺带发现并修了两处：

| 问题             | 现象                                                      | 修法                                                     |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| 返回列表不刷新   | 详情里建了线程，回面板仍显示旧线程数（等 7s 轮询也不变）  | `onBack` 里调 `refresh()`                                |
| 头部统计没线程数 | `0 个会话已接入` 指的是"已挂上下文的会话"，建线程不改变它 | 改成 `N 个项目 · N 个活跃 · N 个线程 · N 个会话带上下文` |

**审批队列**（临时宿主 + 探针造一条真实 `change-settings` 审批，再用 CDP 点）：

```
待你批准的动作 | change-settings · 验收：把人格改成验收专用 | 批准 | 拒绝
→ 点「批准」后：同一行变成「执行」（体现"批准 ≠ 可执行"）
→ 点「执行」后：提示「已执行（结果见审计）」，审批列表清空
→ 审计：approval/requested → approval/resolved → approval/executed
```

**修的一处**：执行成功的提示原本渲染在审批列表**内部**，列表清空后提示跟着消失——
用户点了「执行」只看到区块消失，分不清成功还是出错。已把提示移到列表外。

### 17.11 已合并线程的 worktree 回收（v0.7.x）

**问题**：回收判据问的是"提交是否都在远端"。但 squash 合并会生成**新提交**，原分支提交
不再是主干的祖先；分支再被删（B5 的常规操作）后，这些提交也不在任何 remote ref 上——
两个判据同时失效 → 已合并线程的 worktree 永远回收不掉。

**修法**：把"已合并"变成**记录下来的事实**，而不是事后用 git 推断：

| 环节                    | 动作                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `openPr` 成功           | 线程记 `prNumber`                                            |
| 合并审批执行成功        | 把同 `prNumber` 的线程标 `mergedAt`                          |
| `reclaimThreadWorktree` | `mergedAt` 存在即允许回收；否则维持"未合并且有未推送 → 拒绝" |

集成测试用真实 git 复现整条链路（commit → push → squash 合并 → 删远端分支），断言
**未标记时拒绝、标记后回收成功**。

### 17.12 危险开关的可达性（v0.8.x）

**验收发现（含更正）**：把临时 profile 的 `ui-settings` 打开后，插件设置分节在**未登录**的 profile 里没有出现——
「插件」页只有「已安装插件 → @kangyishuai/dsh-projects → 开始使用」，没有配置区。

**更正（2026-11-22，0.9.0 桌面回归实测）**：在**已登录**的真实桌面 profile 上，
桌面回归断言「设置页出现「项目」分节」是 **PASS** 的——分节确实渲染。
所以准确结论是：**设置分节依赖登录态**（未登录时页面停在"开始使用"，不渲染插件配置区），
而不是注册方式有问题。

即便如此，把危险开关放进项目详情仍然值得保留：它们本来就是 per-project 策略，
放在项目自己的页面里比"去设置页找某个插件的分节"更直接，也不受登录态影响。

**对策**：把危险开关放进**项目详情 → 高级设置**（它们本来就是 per-project 策略），
与设置页共用同一套 i18n 文案与写入路径：

```
▼ 高级设置（仓库授权 / 回收站）
  ▼ 危险动作开关（默认全关）
     □ 允许强推自己的 dsh/ 分支 — 用 --force-with-lease 绑定期望 SHA…
     □ 允许直推默认/保护分支 — 需要先在项目策略里对该仓库 per-repo 授予…
     □ 允许自动合并 PR — 合并不可逆（只能用 revert 回退）…
     □ 允许自动归档/删除到回收站 — 会把内容移入 trash/…
     □ 允许保留期后清理回收站 — …默认 dry-run，真删需显式确认
     □ 允许修改项目策略本身 — 协调器可能借此放宽自己的限制；风险最高
```

**文案评估（待改进）**：六条说明偏工程向，普通用户会被 `--force-with-lease`、`SHA`、`per-repo`、
`protection/rulesets`、`manifest`、`dry-run`、`diff 阈值` 这些词挡住。建议每条先给一句人话结论，
技术细节折进第二行或 tooltip。

### 17.13 危险开关文案改成人话（v0.8.1）

技术细节仍然准确，但**先给结论、再给细节**，不再让用户读 `--force-with-lease`、`SHA`、`per-repo`、
`protection/rulesets`、`manifest`、`dry-run`、`diff 阈值` 这些词：

| 开关                       | 现在的一句话                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| 覆盖插件自己创建的远端分支 | 只覆盖插件自己建的分支；覆盖前核对远端版本，被别人改过就停下并记下旧版本号   |
| 直接推送主干或受保护分支   | 只对授权过的仓库生效；要求走 PR 的仓库直接拒绝；每次记录，多人协作会额外提醒 |
| 自动合并 PR                | 合并只能用 revert 回退；仍要求改动量在阈值内、CI 通过、人工批准达标          |
| 自动归档或删除到回收站     | 内容先移进回收站，还能恢复，但要花时间找回                                   |
| 清理过期的回收站条目       | 只清已进回收站且超保留期的；先列清单，默认只看不删，真删再确认               |
| 修改项目策略本身           | 协调器可能借此放宽对自己的限制——风险最高，建议保持关闭                       |

冒烟新增断言「危险开关文案不含工程术语」（黑名单词逐个检查），把"人话"变成可回归的门槛。

### 17.14 第二轮三用户走查（v0.8.1 → 修复）

同样三个人设、同样"无先验知识"，在 0.8.1 上重走一遍。上一轮的问题全部确认已修（空态指引、短 id、
默认页签、共享标记、记忆可写、审计留痕、回收站可恢复/彻底删除、危险开关可见且是人话）。
新发现四处，都已修：

| 问题                 | 现象                                                          | 修法                                                      |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| 开关勾选后弹回       | 勾上后界面 4 秒内仍显示未勾（服务端已保存），重新进详情才正常 | 写完策略同时刷新父级列表                                  |
| 开关变更不写审计     | 审计里只有 `thread/created`，改危险开关没有记录               | `updateProject` 对比前后策略，写 `project/policy-changed` |
| 文案残留 `**`        | 回收站清理中英文各一处 Markdown 星号                          | 清掉，并把 `**` 加进冒烟黑名单                            |
| 未绑目录的线程跑在哪 | 实际在插件数据目录，界面只说"共享目录（未隔离）"              | 详情页明确提示，并建议先绑 git 仓库；行标记改"未隔离"     |

**仍未修的（记录在案）**：线程行没有任何操作入口（看不到 worktree 路径、也不能单独删除/归档线程）——
开发者想清理单个线程只能删整个项目。

### 17.15 线程级操作（v0.9.0）

第二轮走查记录的最后一条缺口：线程行是只读的，看不到 worktree 在哪、也不能单独清理。

| 入口     | 调用                       | 语义                                                                       |
| -------- | -------------------------- | -------------------------------------------------------------------------- |
| 目录路径 | —                          | 显示 worktree 全路径（超长省略，hover 看全）                               |
| 回收目录 | `reclaimThread(sessionId)` | 三重判据（干净 / 无未推送 / 非当前会话）通过才回收；分支保留；被拒显示原因 |
| 移除     | `detachThread(sessionId)`  | 两步确认；移除追踪关系；写审计 `thread/detached`                           |

**顺带**：`detachThread` 之前不写审计，这次补上——移除追踪也是可审计的变更。

### 17.16 真实 GitHub 端到端验证（v0.9.x，两个真机缺陷）

用私有测试仓库 + 真实 Actions CI 跑完整链路（探针插件调 RPC，不经过 UI）。**抓到两个只有真机才会暴露的缺陷**：

| 缺陷                     | 表现                                                        | 根因                                                                                                                    | 修法                                                                         |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **自动开 PR 从来没成功** | `pr/failed: failed to run git: fatal: not a git repository` | `gh pr create` 在 cwd 里解析 git 上下文，而调用方用的是**宿主进程 cwd**（不是仓库）                                     | `runGh(args, cwd)` 支持 cwd；`openPr` 用 worktree、合并链路用项目目录        |
| **合并永远被拒**         | 真实仓库上 `merge/method-unknown`                           | REST `GET /repos/{o}/{r}` 返回 `allow_squash_merge` 三个布尔，**没有** `allowed_merge_methods`；代码一直读后者 → 空数组 | 新增纯函数 `allowedMergeMethodsFromRepo`（布尔与数组两种形态都认）+ 4 项单测 |

**为什么之前的测试全绿**：桩 `gh` 不关心 cwd，也不校验字段名——它把这两个错误都"吃"掉了。
这正是"必须有一个真实宿主/真实外部服务"的价值。

**真机验证结果**：

| 场景                            | 结果                                              |
| ------------------------------- | ------------------------------------------------- |
| 开 PR（真 GitHub）              | `opened:true`，PR 创建成功                        |
| CI 绿检测                       | `statusCheckRollup` 读到 `SUCCESS`                |
| `minApprovals=0` + CI 绿        | `executed:true`（真合并）                         |
| `minApprovals=1`（无人 review） | `merge/not-approved`                              |
| L2 自治 + `long-task` 规则      | `executed:true`，真的新建线程（两段文本各建一个） |

测试仓库用完即归档（`gh repo archive`）；本机 `dsh-projects-merge-e2e` 仍需要 `delete_repo` 权限才能真删。

### 17.17 从 UI 走真实仓库的「批准 → 执行 → 真合并」（v0.9.1）

上一节（17.16）用探针调 RPC 验证了链路；这一步换成**真实界面点击**：

| 步骤       | UI 上的表现                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 项目面板   | `1 个项目 · 1 个活跃 · 1 个线程`；详情里线程行显示 worktree 全路径                                                                |
| 审批队列   | `待你批准的动作 / merge · UI 验收：合并这个 PR / 批准 / 拒绝`                                                                     |
| 点「批准」 | 同一行变成 **执行**（体现"批准 ≠ 可执行"）                                                                                        |
| 点「执行」 | `已执行（结果见审计）`，审批列表清空                                                                                              |
| 审计页签   | `thread/created → wake/skipped → pr/opened → project/policy-changed → approval/requested → approval/resolved → approval/executed` |

**GitHub 侧核对**（真实合并）：

```
PR #5  state=MERGED  mergedAt=2026-11-22T14:45:26Z  head=dsh/ui-1
main   e5a07eab  "ui walkthrough commit (#5)"
```

前置条件写清楚，便于复现：仓库允许 squash、CI 已绿（`statusCheckRollup=SUCCESS`）、
`merge.minApprovals = 0`、`danger.autoMerge = true`、PR 非 draft。缺任一条都会在 UI 里看到对应拒绝原因
（`merge/not-approved`、`merge/ci-*`、`merge/method-*`）。

**本次没走 UI 的部分**：项目/线程/worktree/PR/审批**的创建**是用探针插件（host RPC）预置的——
UI 目前没有"发起 PR"或"请求危险动作"的入口，那是协调器工具的职责。UI 覆盖的是
"看到 → 批准 → 执行 → 审计 → GitHub 真的合并"这一段。

## B3 · 本地优势 + 设置 + 记忆（2026-11-23）

**自动化**：`packages/projects` 单测 **502** 条（B3 之后新增：记忆碎片索引/forget/预览、
`memory-store` 真读盘与路径守卫、16k 去重（注入时真读宿主 AGENTS.md）、`<project-context>` 包裹、
goal 8k 写入口拒绝、预算默认值与补丁规范化、**暂停仍注入上下文**、完成通知与按项目开关、
文件夹授权三键与**执行闸**（deny 拒绝 / once 消费 / default 长期）、`gh` 三种失败态的解析、
AGENTS.md 受管区块幂等合并、`@` 候选排序）。`pnpm smoke:projects` 设置页相关 14 条在临时 home
里**真跑**（见 §6）：四分区、预算写→回读、Usage 无金额、Debug access、GitHub 检查、
通知开关、模板补全（两次点击仍幂等，回执写明 AGENTS.md 路径），以及宿主侧
`projects.json` 的预算/通知/模板落盘回读。

**手工（桌面版，本机保留一份真实交互记录的格式）**：

| 步骤                              | 期望                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 设置 → 项目分节 → 点 Memory       | 显示「指令 N 字符 · 记忆索引 N 字符 · 碎片 N 个」；「补全项目模板」写入 AGENTS.md 受管区块（区块外内容不变） |
| 点 Usage                          | 只有 token 与上下文占用；**页面里搜不到 ¥ / $ / USD**                                                        |
| 点 Debug                          | 标题是 `Debug access`；诊断计数；「检查 GitHub 连接」给出已连接账号或可操作命令                              |
| 点 General，把日线程改成 7 并保存 | 结果行出现「预算已保存」；重启后仍是 7（`projects.json` 回读）                                               |
| 暂停项目，再和已归属线程对话      | 上下文**仍在**（暂停只停新建线程与定时任务）——这是 B3 修的回归                                               |

**已知边界**：本机 web 冒烟 profile 把设置页禁用（`data-projects-settings` 不渲染），
设置相关 8+3 条断言按仓库既有约定标为「设置页未启用，跳过」；它们在设置页可用的环境
（桌面回归 / 打开 ui-settings 的 profile）里是真断言。冻结与非冻结的分界线写在这里，避免误读为全覆盖。

## B3 第二批 UI（2026-11-23）

在详情页右栏「上下文」与记忆页签里补齐可达入口（因为本机 smoke profile 会禁用设置页）：

| 区域         | 数据锚点                                                                                                        | 断言                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地优势卡   | `data-projects-b3-card` / `data-projects-mention-source`                                                        | 卡片存在；`@` 源只有在 `ctx.inject(["inputTriggers"])` 的 `registerSource()` 成功后才显示 `registered`（冒烟断言该值）；候选 token 形如 `thread:<id>`/`project:<id>`，Node 侧回查 `projects.json` 证明指向真实记录    |
| 文件夹授权卡 | `data-projects-folder-card` / `-folder-decision` / `-folder-mode`                                               | 三键 Deny / Set as default / Allow once；Deny→`mode=deny`、once→`mode=once`、「设为默认」→`mode=default` 逐一回读；`projects.json` 的 `policy.folderAuth[dir].mode=default` 与项目 `dirs` 对得上                      |
| 线程默认模型 | `data-projects-thread-model` / `-thread-effort` / `-thread-defaults-save` / `-manual-toggle` / `-model-catalog` | 两个下拉可写，选项数量**逐项等于** `data-projects-model-catalog` 记录的目录模型数/effort 数（硬编码会不等）；目录为空（无凭据部署）时展开「手填」写具体值，保存后 UI 回读与 `projects.json.threadDefaults` 逐字段相等 |
| 从会话开线程 | `data-projects-recent-sessions` / `-recent-session` / `-attach-session`                                         | 候选行数 > 0 且 id 来自 `recentSessions`（宿主 `list` 回执 `{items}`）；attach 的 sessionId 出现在线程行与 `projects.json.threads`                                                                                    |
| 线程动作     | `data-projects-thread-action`（rename/unread/resolve/copy/reclaim/detach）+ `data-projects-thread-host-menu`    | 自绘「⋯」六项齐全；重命名/未读回读；行右键打开**宿主** `contextMenus`（重命名/复制可见，Esc 关闭），Shift+F10 等价                                                                                                    |
| 记忆碎片     | `data-projects-frag` / `-frag-add` / `-frag-preview` / `-frag-forget`                                           | UI 入口存在；落盘/列表/预览/忘掉与 `../`、`..%2F`、绝对路径拒绝由 `memory-store.test.js` 用临时目录真跑                                                                                                               |

截图：`notes/projects/claude-borrow/shots/b3/07-b3-context-card-and-thread-actions.png`、
`08-b3-memory-fragments.png`。

## B3 复审修复（2026-11-23）

独立审查给了 5 P0 / 10 P1，逐条修复后的口径（每条都有可证伪断言或明确降级文案）：

| #     | 问题                                          | 现在的证据                                                                                                                                                              |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1  | `@` 源没生效（`c.get("inputTriggers")` 恒空） | 改用 `ctx.inject(["inputTriggers"])`，`registered` 只在 `registerSource()` 成功返回后置位；冒烟断言 `data-projects-mention-source=registered` + 候选 token 指向真实记录 |
| P0-2  | 设置页 14 条「跳过计 PASS」                   | 临时 home 打开 `ui-settings` + 宿主快捷键开设置；14 条真跑，跑不了时计入 `SKIP`（`X PASS / Y SKIP / Z FAIL`）                                                           |
| P0-3  | 线程默认模型没有可写路径                      | 两个下拉由 `modelCatalog` 动态生成且可写；目录为空时提供手填；断言选项数与目录数逐项相等                                                                                |
| P0-4  | 默认模型写→回读恒真                           | UI 回读 = 刚写的手填/目录值；`projects.json.threadDefaults` 的 provider/model/effort 逐字段比对                                                                         |
| P0-5  | 两条恒真断言                                  | 删掉不调生产代码的 F3 单测（真实覆盖在 `memory-store.test.js`）；`recentUi` 改为「候选行数 > 0 + attach 的 sessionId 落进 threads」                                     |
| P1-6  | 注入去重死代码                                | `attach.js` 注入时用 `host-instructions.js` 真读宿主会加载的 AGENTS.md/CLAUDE.md（目录链到 git 根），单测用临时目录断言重复段被省略                                     |
| P1-7  | Allow once 没有消费者                         | `folderAuth` 接进审批执行闸：deny 拒绝、once 首次放行并消费、default 长期、未授权保持旧行为；`service-execute.test.js` 三条                                             |
| P1-8  | `applyProjectTemplate` 参数错                 | RPC 改传 `{ projectId }`；模板写入 AGENTS.md 可回读且两次调用只保留一份受管区块                                                                                         |
| P1-9  | 宿主 contextMenus 死注册                      | 线程行右键/Shift+F10 调 `contextMenus.open()`；冒烟断言菜单项与 Esc 关闭；自绘「⋯」保留为降级                                                                           |
| P1-10 | B3 文案缺 EN                                  | 106 个 key 补进 runtime EN 字典与 `locale/en.json`（与 zh 对齐）                                                                                                        |
| P1-11 | `forgetMemory` 路径穿越                       | `memory-store.js` 加 slug/kind/块 id 守卫；单测覆盖 `../`、`..%2F`、绝对路径、反斜杠                                                                                    |
| P1-12 | F37 服务层无测试                              | `memory-store.js` 根目录可注入，`memory-store.test.js` 真跑新增/列表/预览/忘掉/索引改写                                                                                 |
| P1-13 | 文档夸大                                      | 本节与上方表格按实际断言重写；计数行以冒烟输出为准                                                                                                                      |
| P1-14 | 冒烟不可重复                                  | 记忆/归档/删除/搜索四处固定等待改为轮询；同 commit 连跑两次计数一致                                                                                                     |
| P1-15 | 桌面回归设置断言空话                          | 渲染了就真断言，没渲染就 `SKIP` 并计入计数行                                                                                                                            |

## Claude UI 对齐（M2–M6）验证（2026-11-27）

对齐 Claude Projects 本地 space 的布局后，新增/更新的验证口径（数字以本 commit 输出为准）：

- `pnpm verify`：projects 单测 **710**（含 i18n 三处一致性、`attachThread` 幂等、`pickRepoRoot`/`pickPollRoot`、
  `assessMergePr` 合并门禁、写入口路径校验、saveSoon 失败可见、源码守卫等）。
- `pnpm smoke:projects`：**270 PASS / 0 SKIP / 0 FAIL**（临时 `DSH_HOME`，ego 浏览器）。
- `pnpm smoke:projects-desktop --require`：**20 PASS / 0 SKIP**（空 profile 时 17 条，其余按真实数据 SKIP）。
- 新增断言（锚点均在 `lib/client.js`）：
  - 可见性开关写项目记录并回读（`data-projects-views-pane` 与副标题不再出现 `n/a`）；
  - 路由开关默认收起（`data-projects-route-toggle`，≥8×8，位于 composer 内）；
  - 排障信息默认折成一行（`data-projects-diagnostics`），展开后才出现 `data-projects-no-dir-hint`；
  - 线程行 `tabindex=0` / `role=button` / `aria-expanded` 同步，Enter 可展开；
  - 行内菜单有危险操作分隔线，↑↓ 可在 `role=menuitem` 间移动焦点；
  - Create PR 条：分支名直接展示、`data-projects-pr-bar-dismiss` 可收起、已有 PR 时整条隐藏。
- **对比度**：用浏览器内脚本遍历面板可见文本（逐级取实际背景色合成，按 WCAG 计算），
  浅色修掉 `faint` 的 5 类低对比文本后，仅剩 composer `+` 附件按钮（`disabled` 占位，WCAG 豁免）；
  深色扫描 **0 项**。脚本为一次性探针，未入库。
- **双端布局一致**：WebUI（临时 `dsh web --port 0`）与桌面版在 1440×900 下读几何，
  右栏 `x=1017 w=407`、composer `x≈296`、页签行高 `36`，差异 ≤1px；
  web 端用 `Emulation.setDeviceMetricsOverride` 固定视口，桌面端用 CDP 同法。
- 未验证项（需要重启宿主才能复验，已记录）：分支名带项目短 id 的实际推送、PR 草稿自动 `pr ready`、
  Routine 编辑触发的宿主 `schedule` 建/删、后台自动重试的真实端到端（单测覆盖调度器与判据）。

## 重启宿主后的 4 项复验（手动清单）

以下 4 项是 **host 半改动**，刷新页面不够（DSH 会继续跑旧 bundle），必须重启桌面版后按下述步骤确认。
没有做成一键脚本：其中两项需要真实模型调用/远端仓库，自动化在"重启前"无法自证有效。

### 1. 分支名带项目短 id（防撞远端）

1. 新建一个项目，在「项目设置 → 环境 → 项目目录」绑定任意 git 仓库（本地即可）。
2. 在项目里新建一条线程（会花一次模型调用）。
3. 读 `~/.dsh/projects/projects.json`：

   ```bash
   node -e 'const j=require(process.env.HOME+"/.dsh/projects/projects.json");
   console.log(Object.values(j.threads).map(t=>t.branch))'
   ```

4. 期望：分支形如 `dsh/<项目名 slug>-<序号>-<项目 id 末 6 位>`（例如 `dsh/pr-1-v563b8`）。
   旧行为是 `dsh/<slug>-<序号>`，同名/重建项目会撞远端已有分支，`创建 PR` 报 `push-failed`。

### 2. 草稿 PR 能自动 ready 后合并

1. 项目绑定一个**有远端**的仓库；在线程里提交一次改动。
2. 展开线程 → `创建 PR`（会建 draft PR）。
3. 展开同一行 → PR 卡里点 `合并`（需要危险开关打开 + 二次确认）。
4. 期望：成功（内部先 `gh pr ready` 再 `gh pr merge --squash --delete-branch`），
   PR 卡状态变为已合并，`projects.json` 里该线程写回 `mergedAt`；
   旧行为直接 `gh pr merge` 会被 GitHub 以 `Pull Request is still a draft` 拒绝。

### 3. Routine 改成手动后真的删宿主定时

1. 右栏 `Routines` 页签 → 建一条「每天 09:00」的定时任务（会建宿主 schedule）。
2. 在同一行点编辑，把频率改成「手动（不自动跑）」并保存。
3. 期望：该条显示为手动档，且宿主「设置 → 自动化任务」里对应条目**消失**
   （实现是 `planRoutineHostAction` 走 delete；旧行为只改本地 `enabled`，宿主仍会到点投递花 token）。

### 4. 后台自动重试（可选，较难稳定制造）

失败线程在 60 秒后会自动补一句「继续」，累计最多 2 次；可在 `settings` 分节关闭。
验证它需要先弄出一个失败回合（例如让线程在模型不可用时结束），确认 60 秒后线程重新进入 working，
且 `projects.json` 里 `autoRetryCount` 递增。**语义是"重发继续"**，不是用量恢复续跑。

### 关于 host 半单测覆盖率的说明

`lib/service.js` / `lib/client.js` 目前没有"真实 service 实例"的单测，原因是**仓库策略**：
`@deepseek-ai/dsh-typert-protocol` 由宿主提供，仓库不允许把它加进 `dependencies`（硬性约定 2/3），
而 `service.js` 顶层 `import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol"`
在仓库内无法解析；Node 的 `mock.module` 也需要先能解析到该包。

因此宿主半的回归防线是两层：
1. 纯逻辑抽到 `lib/*.js`（`store`/`overview`/`executor`/`autopr`/`thread`/`trash` 等）并用真实数据单测；
2. 高风险接线用**源码守卫**（`test/service-wiring-guards.test.js`）：读 `lib/service.js` / `lib/client.js`
   截出方法区间，断言关键调用存在（`pickRepoRoot`、`threadBusy`、`saveSoon`、`hidden` 门控、
   manifest 顺序、`ok===false` 处理等）。

这是有意识的取舍，不是"忘了写测试"；真正的 service 实例测试需要宿主测试脚手架，留待仓库策略允许时再补。
