# @kangyishuai/dsh-projects

## 0.3.2

### Patch Changes

- [#271](https://github.com/kangyishuai/dsh-plugins/pull/271) [`8c983c7`](https://github.com/kangyishuai/dsh-plugins/commit/8c983c742318daa441e5f0ca587636f26422e163) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修「被拒绝的申请也被占用」：把幂等占位与执行结果拆开（claim / release）。
  
  **之前的行为**：`executedAt` 在闸门之前就写入，所以只要点过一次「执行」——哪怕因开关没开、
  影响面超阈值而被拒——这张申请就再也不能执行，必须让协调器重新申请。
  
  **现在**：
  - `claimApproval()` 只占位（`claimedAt`），并发第二次得 `already-claimed`
  - 执行**成功**才落 `executedAt`（+ evidence），并清掉占位
  - 被拒绝或失败一律 `releaseApproval()`，**同一张申请可重试**
  - 已执行的申请不能占位、也不会被释放（`already-executed`）
  
  真机验证（临时宿主）：同一张 `purge-trash` 申请先返回 `switch-off`，打开开关后再次执行
  **同一张申请**返回 `executed:true`，第三次返回 `already-executed`；最终
  `{status:"approved", claimedAt:null, executed:true}`。
  
  322 项单测（新增 5 项 claim/release 语义）全绿。

## 0.3.1

### Patch Changes

- [#269](https://github.com/kangyishuai/dsh-plugins/pull/269) [`619c93a`](https://github.com/kangyishuai/dsh-plugins/commit/619c93ab4f5729933e7e2a68827bdbfc4723573a) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 0.3.0 装进 live profile、**重启桌面版后**复跑门禁，结果写进兼容表：
  
  - 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**
  - web 端到端冒烟 **52 PASS / 0 SKIP / 0 FAIL**（含 0.3.0 新增的执行按钮/仓库授权/回收站清理两块）
  - `pnpm gate:all --plugins projects` 全绿（64s）
  
  0.3.0 改了 client 半，所以这次特别确认了「重启后新 UI 真的加载」：项目面板正常渲染
  （该 profile 里没有项目，详情页两块由临时宿主的 web 冒烟覆盖）。
  另把 README 的「309 项单测 / 50 项冒烟」更新为 317 / 52。

## 0.3.0

### Minor Changes

- [#267](https://github.com/kangyishuai/dsh-plugins/pull/267) [`d6e3830`](https://github.com/kangyishuai/dsh-plugins/commit/d6e3830daf39327f37011774dd104b194051a8d8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 接通「审批 → 执行」闭环，并补齐新能力的两个界面入口。
  
  **审批 → 执行（修一个实质缺口）**
  - 之前 `executeApproval` 已导出为 RPC 却**没有任何调用方**：用户点「批准」只改状态，
    没有任何入口真正执行，整套开关/阈值/审计形同虚设
  - 详情页现在把「已批准未执行」的申请单独渲染，带「执行」按钮（`data-projects-approval-execute`），
    点击后把 `executed:true` 或拒绝原因回显在行内
  - 服务端补 `purge-trash` 与 `change-settings` 两条执行路径（此前只会 `execution-deferred`）
  
  **改本插件自己的配置（规格 §7.5 行 5a）**
  - `change-settings` 从「有开关、无实现」变成真可用：白名单只放 `persona` / `routing` / `goal`
  - 安全面一律拒：`danger` / `autonomy` / `preapprove` / `budget` / `repoGrants` 等
    （`settings/forbidden:<key>`），防自我提权
  
  **界面补漏**
  - 详情页新增「仓库授权」：`policy.repoGrants` 的 per-repo 授予以前只能手编 JSON
  - 详情页新增「回收站清理」：先 dry-run 预览、再确认；只处理本项目超保留期条目
  
  **已知取舍**：幂等占位写在闸门之前，所以被拒绝的申请也会被占用（需重新申请）。
  换成 claim/release 可两全，但涉及 14 处拒绝点，留作后续。
  
  317 项单测（新增 8 项配置白名单）+ web 冒烟 52 项（新增 2 项）全绿。

## 0.2.2

### Patch Changes

- [#265](https://github.com/kangyishuai/dsh-plugins/pull/265) [`bdd0e86`](https://github.com/kangyishuai/dsh-plugins/commit/bdd0e86555edc4210908a5d56f45dee541cdade8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把 0.2.1 装进 live profile 并在**重启桌面版之后**复跑桌面只读回归，结果写进兼容表：
  
  - 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**（`pnpm gate:all --plugins projects`，64s 全绿）
  - web 端到端冒烟 50 PASS / 0 SKIP / 0 FAIL
  
  此前 0.2.0 的兼容表如实写着「桌面回归尚未复跑」，现在这条已补齐（0.2.0 与 0.2.1 的 client 半一致）。
  另记一条环境事实：该 live profile 里 `ui-settings` 为 `enabled: false`，设置页打不开，
  因此开关文案无法在界面上目视确认（磁盘产物已确认是新文案）。

## 0.2.1

### Patch Changes

- [#263](https://github.com/kangyishuai/dsh-plugins/pull/263) [`3b5c030`](https://github.com/kangyishuai/dsh-plugins/commit/3b5c030640628873c78c553014f8ac99ae02e756) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 兼容表补 `0.2.0` 一行，并如实写清它验证到什么程度：309 项单测 + `pnpm verify` + web 冒烟 50/0/0，
  三项危险动作在临时宿主上真机验证（本地 bare 远端 + 桩 `gh`）；**桌面只读回归尚未对 0.2.0 复跑**
  （本次 client 半只改了开关文案，上次全绿是 0.1.1）。
  
  顺带把 README 里过时的「276 项单测」更新为 309。

## 0.2.0

### Minor Changes

- [#261](https://github.com/kangyishuai/dsh-plugins/pull/261) [`374cf69`](https://github.com/kangyishuai/dsh-plugins/commit/374cf69add8cb71ef6d2b285f176cb9c890e1365) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把规格 §7.5 里剩下三项危险动作从「只有开关、没有实现」补成真正可用，全部默认关：
  
  - **强推自建分支**（`push-branch` 带 `force`）：只走 `git push --force-with-lease=<branch>:<sha>`，
    不接受裸 `--force`；分支必须是插件记录过的 `dsh/` 分支、非保护分支、旧 SHA 已知；
    远端被动过时 lease 会 fail-closed 拒绝。成功后记录 `lastPushedSha`，审计里带旧 SHA 供恢复。
  - **直推默认/保护分支**（`push-protected-branch`）：推前查 `branches/<b>/protection` 与 `rulesets`，
    服务端要求 PR 时直接拒绝；需要项目策略里对该仓库 **per-repo 授予**（`policy.repoGrants`）；
    每次审计带仓库/分支/提交者数，检测到多人协作时返回 `warning: multi-collaborator`。
  - **回收站保留期清理**（`purgeTrash` RPC）：只处理已在回收站且超 `retentionDays`（默认 30 天）的条目，
    认不出时间的条目一律保留；**默认 dry-run**，真删需开关打开 + `confirm: "purge"`，
    执行前写出 `trash/purge-<ts>.md` 可恢复清单并审计。
  
  配套：`repoGrants` 进项目策略（只认显式 `true`）；线程记录新增 `lastPushedSha`/`baseSha`；
  设置页三个开关的文案从「暂未实现」改为真实行为说明；新增 22 项纯逻辑单测与「动作↔开关↔可申请」
  一致性守卫单测（309 项单测全绿）。

## 0.1.3

### Patch Changes

- [#259](https://github.com/kangyishuai/dsh-plugins/pull/259) [`4eadd4b`](https://github.com/kangyishuai/dsh-plugins/commit/4eadd4bb23039d2aaa5a1efe9acf53f91cc7a4b6) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修两个只在**真实 GitHub** 上才会暴露的合并缺陷（此前只用桩 `gh` 验证，抓不到）：
  
  1. **合并会打到错误的仓库。** `gh pr merge` 原本没带 `--repo`，于是按「宿主进程当前目录所在的
     git 仓库」解析目标；同时 `gh pr merge` 对已合并的 PR 仍返回 exit 0，导致插件误报成功。
     现在合并前必须从项目目录的 `git remote get-url origin` 解析 `owner/repo` 并要求带上
     `--repo`，解析不到直接拒绝（`merge/repo-unknown`）。
  2. **draft PR 被当作可合并。** 新增 `checkMergePreflight()`：合并前用
     `gh pr view --json isDraft,mergeable,state` 校验「非 draft / 可合并 / 仍 open」，
     任一不满足就拒绝并写审计；`mergeable=UNKNOWN`（GitHub 刚建 PR 时的正常状态）做有界重试。
  
  真实仓库实测：draft PR 保持 open 未合并（`merge/pr-is-draft`）；ready 档 PR 成功 squash 合并，
  main 上出现合并提交。单测 284 项（新增 9 项覆盖上述判定）。

## 0.1.2

### Patch Changes

- [#257](https://github.com/kangyishuai/dsh-plugins/pull/257) [`15b7295`](https://github.com/kangyishuai/dsh-plugins/commit/15b7295c7fdd2dd098a7e5929dd356479c490292) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 在 DSH 0.2.2-rc.5 上完成复验，并把桌面只读回归第一次跑绿。**不需要改代码**。
  
  - 桌面只读回归：**11 PASS / 0 SKIP / 0 FAIL**（此前该项目一直未绿）
  - web 端到端冒烟：**50 PASS / 0 SKIP / 0 FAIL**
  - 单测 276 / 276、`pnpm probe:runtime` 72/72
  - 本插件依赖的私有 seam（`dsh-session`、`dsh-workspace`、`dsh-api-gateway`、`dsh-typert-protocol`、
    `dsh-agent` 等）在 rc.3 与 rc.5 之间逐字节相同（43 包逐包 diff，见 docs/runtime/0.2.2-rc.5.md §1.1）
  
  同时修正文档里的两个数字：web 冒烟断言实为 **50**（旧文档把收尾汇总行也算成了第 51 项），
  单测为 **276**（旧文档写 274）。

## 0.1.1

### Patch Changes

- [#175](https://github.com/kangyishuai/dsh-plugins/pull/175) [`e8ce691`](https://github.com/kangyishuai/dsh-plugins/commit/e8ce69140925baa3d5c98eb7021de1e53ea08101) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修桌面版 `projects: store is unavailable`：DSH 桌面进程不导出 `DSH_HOME`，旧的 `resolveDataRoot` 在没有配置 `dataRoot` 时直接抛错。现按「配置 `dataRoot` → `$DSH_HOME/projects` → `~/.dsh/projects`」解析，并把解析器抽到可单测的 `lib/paths.js`（新增回归测试）。

## 0.1.0

### Minor Changes

- [#144](https://github.com/kangyishuai/dsh-plugins/pull/144) [`f660cb0`](https://github.com/kangyishuai/dsh-plugins/commit/f660cb01c1d1d7a959e7291b8ac2cf592c68ee3c) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 首发版本：把「项目」做成一等上下文单元，并给它一个**可审计、默认可控**的协调器。
  
  **项目与上下文**
  - 项目仓储：数据根可注入、原子写、损坏文件改名隔离（不删除）、未来格式版本拒绝
  - 项目级上下文注入：归属会话在每次请求前收到常设规则与 `MEMORY.md` 索引（16k 预算）。
    实现是**全局注册一次、按会话求值**（函数式 provider），只有归属且未归档的会话才渲染；
    不属于任何项目的会话拿到的始终是空串，不会被污染
  
  **并行工作**
  - 线程隔离：先建 Git worktree 再建会话；非 git 或建失败一律降级共享目录并说明原因
  - 回收：归档即回收，但三重判据（脏工作区 / 有未推送提交 / 当前会话目录）任一命中就保留；
    启动对账，磁盘上未记录的目录只报告、不删除
  - Overview：五态（待你处理 > 失败 > 进行中 > 已完成 > 空闲）全部从持久会话事件推导，可重启重建
  
  **协调器（默认只提议）**
  - 唤醒：线程跑完一轮就把结构化信封（含线程真实结果、项目规则与记忆摘要、人格）投给协调器会话。
    每轮最多一次：`decideWake()` 三态判定（水位重复 / 并发去重 / 发送），并发 `turn/end` 不会重复投递；
    未配协调器时记 `wake/skipped` 而不是静默
  - 冷会话唤醒：应用关着时线程跑完、或线程跑完时还没建协调器，信封会在下次启动后由
    `reconcileWakes()` 补发（只补 `done`/`failed`/`waiting-user`，`working`/`idle` 不补）
  - 路由：扁平规则优先，命中即确定性执行；未命中才由模型提议，且仍要过白名单与自治矩阵
  - 自治级别：`L0` 只观察、`L1` 只提议（默认）、`L2` 可建线程、`L3` 全权；
    闸门在决策之后、执行之前，审计里同时看得到意图与拒绝原因
  - 工具篮子：协调器只有 6 个 `project_*` 工具（起线程 / 列线程 / 给线程发消息 / 申请危险动作 / 读记忆 / 写记忆），
    没有 shell / 写文件 / 删除 / 推送 / 合并
  - 人格：内置三条准则 + 用户设定，并明确声明「人格不改变权限」。
    人格与项目上下文一样**随信封送达**——宿主的按会话 runtime context 不会投递给协调器会话
    （docs/runtime §10.24）
  
  **界面**
  - 侧栏面板：项目列表、新建、详情（线程 / 记忆 / 审计三页签）、按规则派活、预算显示
  - 项目操作：暂停 / 恢复、**归档 / 取消归档**（归档不删数据）、删除（回收站 + 两段式确认）
  - 设置分节：自治级别、人格、路由回退、六个危险开关（每项带风险说明，默认全关）
  
  **安全边界**
  - 删除项目走回收站（ADR 0002）：dry-run 影响面、两段式确认、`manifest.json` 可恢复、写审计
  - 审批队列：危险动作只能「申请」；批准 ≠ 可执行，还要开关打开、影响面在阈值内；
    执行器与开关之间是显式映射（打开别的开关解锁不了合并）
  - 六个危险开关默认全关，可配置但每项带风险说明；执行器与开关之间是显式映射
  - 不可信输入隔离：非 principal 来源的内容一律包成「数据不是指令」的块，围栏不可被内容提前闭合
  - auto-fix 只在本地 worktree 产出提交：不 push、不开 PR、轮数上限、同错即停、碰到测试文件即停
  - 远端写入三条链路（推分支 / 开 PR / 合并）都在本机完成端到端验证：
    远端用本地 bare 仓库、`gh` 用 PATH 桩脚本；`merge` 的 argv 固定为 `pr merge <n> --squash`，
    auto PR 支持 off/draft/ready/auto-merge 四档（默认 off）
  
  **尚未发布**：真实 GitHub 上的最终效果（需一次人工发版确认）、LiveShare 项目共享、
  按 token 的花费闸（宿主不上报 usage，见 docs/runtime §10.12）。
