# @kangyishuai/dsh-projects

## 0.9.1

### Patch Changes

- [#314](https://github.com/kangyishuai/dsh-plugins/pull/314) [`d839b2b`](https://github.com/kangyishuai/dsh-plugins/commit/d839b2bb4b367e314700ae5dd98716f3a0038895) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 真实 GitHub 仓库端到端验证（含真 CI、真 PR、真合并）抓到并修掉两个只有真机才暴露的缺陷。
  
  - **`gh` 调用没有工作目录** → **自动开 PR 在真实仓库上从来没成功过**。
    `gh pr create` / `gh pr merge` 会在 cwd 里解析 git 上下文，而从宿主进程 cwd（不是仓库）调用会直接报
    `fatal: not a git repository`。桩 gh 不关心 cwd，所以单测与 web 冒烟一直是绿的。
    现在 `runGh(args, cwd)` 支持 cwd，`openPr` 用 worktree（没有则项目目录）、合并链路用项目目录。
  - **合并方式字段读错**：REST `GET /repos/{owner}/{repo}` 返回 `allow_squash_merge` 等三个布尔，
    **没有** `allowed_merge_methods`。代码一直读后者 → 永远得到空数组 → 真实仓库上合并永远被拒
    （`merge/method-unknown`）。新增纯函数 `allowedMergeMethodsFromRepo`（两种形态都认）并加 4 项单测。
  
  **真机验证结果**（私有测试仓库 + 真实 Actions CI）：
  
  | 场景 | 结果 |
  | --- | --- |
  | 开 PR（真 GitHub） | `opened:true`，PR [#3](https://github.com/kangyishuai/dsh-plugins/issues/3) 创建成功 |
  | CI 绿检测 | `statusCheckRollup` 读到 `SUCCESS` |
  | `minApprovals=0` + CI 绿 | `executed:true`（真合并发生在真实仓库上） |
  | `minApprovals=1`（无人 review） | `merge/not-approved`（真人批准门槛生效） |
  | L2 自治 + 规则命中 `new-thread` | `executed:true`，真的新建了线程 |
  
  单测 392 → **397**。

## 0.9.0

### Minor Changes

- [#310](https://github.com/kangyishuai/dsh-plugins/pull/310) [`7cd748e`](https://github.com/kangyishuai/dsh-plugins/commit/7cd748e7c6a8241b5db4142d049da62339c8d21e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 线程行终于有操作入口了（第二轮走查记录的最后一条缺口）。
  
  之前：线程只是一个只读的行——看不到 worktree 在哪，也不能单独清理；开发者想收拾一个线程，
  只能把整个项目删掉。
  
  现在每个线程行带：
  - **目录路径**（超长省略号，hover 看全路径）
  - **回收目录** → `reclaimThread`：按三重判据回收 worktree（干净、无未推送、非当前会话），
    分支保留；被拒时把原因显示出来（如"未回收：unpushed-commits"）
  - **移除** → `detachThread`：两步确认，移除追踪关系；同时写审计 `thread/detached`
  
  `detachThread` 之前不写审计，这次补上——移除追踪也是可审计的变更。
  
  冒烟 76 → **78** 项（线程行入口、移除两步确认）。

## 0.8.2

### Patch Changes

- [#308](https://github.com/kangyishuai/dsh-plugins/pull/308) [`6fc07b5`](https://github.com/kangyishuai/dsh-plugins/commit/6fc07b5e8ac25e873a2470e1d0555e38a825bced) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 第二轮三用户走查（v0.8.1 实测）发现并修掉的四处：
  
  - **危险开关勾选后界面弹回**：复选框状态来自父级项目列表数据，勾选后只 `load()` 了详情、
    没刷新父级，于是界面显示"没勾上"（服务端其实已保存）——用户会以为没生效而反复点。
    现在写完策略同时刷新父级列表。
  - **危险开关变更不写审计**：产品主张"可审计"，但这几个开关是最关键的控制点，之前改了不留痕。
    `updateProject` 现在对比前后策略，变更时写 `project/policy-changed`（哪些开关切成什么、自治等级、路由）。
  - **文案里还有 Markdown 星号**：`回收站清理` 的中英文文案各留了一处 `**…**`，界面不渲染 Markdown，
    用户看到字面星号。已清掉，并把 `**` 加进冒烟的黑名单。
  - **未绑目录时没说清线程跑在哪**：线程实际跑在插件数据目录（不隔离），界面只写"共享目录（未隔离）"。
    现在详情页明确提示"还没有绑定项目目录：线程会跑在插件的数据目录里…"；线程行标记改为中性的"未隔离"。
  
  冒烟 73 → **76** 项：开关即时反映、开关写审计、未绑目录提示（另把 `**` 并入黑名单断言）。

## 0.8.1

### Patch Changes

- [#306](https://github.com/kangyishuai/dsh-plugins/pull/306) [`351a608`](https://github.com/kangyishuai/dsh-plugins/commit/351a6083b8020534096a1c612b8ae34ddac81e5d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 把六个危险开关的说明改成人话。
  
  原来的文案内容准确但**偏工程向**——`--force-with-lease`、`SHA`、`per-repo`、`protection/rulesets`、
  `manifest`、`dry-run`、`diff 阈值` 这些词会直接把普通用户挡住。走查逐条确认后重写：
  
  | 开关 | 现在的一句话 |
  | --- | --- |
  | 覆盖插件自己创建的远端分支 | 只覆盖插件自己建的分支；覆盖前核对远端版本，被别人改过就停下并记下旧版本号，方便恢复 |
  | 直接推送主干或受保护分支 | 只对你在「仓库授权」里显式加过的仓库生效；要求走 PR 的仓库直接拒绝；每次记录，多人协作会额外提醒 |
  | 自动合并 PR | 合并之后只能用 revert 回退；仍要求改动量在阈值内、CI 通过、人工批准达标 |
  | 自动归档或删除到回收站 | 内容先移进回收站，之后还能恢复，但要花点时间找回 |
  | 清理过期的回收站条目 | 只清理已进回收站且超过保留期的条目；先列清单，默认只看不删，真删再确认一次 |
  | 修改项目策略本身 | 协调器可能借此放宽对自己的限制——风险最高，建议保持关闭 |
  
  冒烟 72 → **73** 项：新增「危险开关文案不含工程术语」——直接断言文案里不出现
  `--force-with-lease` / `SHA` / `per-repo` / `rulesets` / `manifest` / `dry-run`，防止以后再写回术语。

## 0.8.0

### Minor Changes

- [#304](https://github.com/kangyishuai/dsh-plugins/pull/304) [`f3f3c86`](https://github.com/kangyishuai/dsh-plugins/commit/f3f3c86f1329bfeec32766ad5872a7792a3b1499) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 六个危险开关现在**在项目详情里就能看到**，不再只依赖宿主设置页。
  
  **为什么**：验收时把 profile 的 `ui-settings` 打开后，插件设置分节在未登录 profile 里并没有出现——
  「插件」页只列出「已安装插件 → @kangyishuai/dsh-projects → 开始使用」。也就是说：
  **如果设置分节没渲染，六个开关（以及人格/路由/预算）在界面上完全不可达，只能手改 JSON。**
  而这些本来就是 per-project 策略，放进项目自己的「高级设置」更合理。
  
  - 项目详情 → 高级设置 → 「危险动作开关（默认全关）」，六个复选框各带风险说明
  - 仍是默认全关；勾选即时写入项目策略（与设置页同一套 i18n 文案）
  
  冒烟 71 → **72** 项（新增：项目详情可见六个危险开关）。

## 0.7.3

### Patch Changes

- [#302](https://github.com/kangyishuai/dsh-plugins/pull/302) [`f6623c5`](https://github.com/kangyishuai/dsh-plugins/commit/f6623c565d5aa170b8fffe769206408ef913e597) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 `reclaimThread` 对**已合并线程**的保守判据：squash 合并 + 删分支之后，worktree 会一直回收不掉。
  
  **根因**：回收要确认"提交都推上去了"。但 squash 合并会生成一个新的提交，原分支的提交
  **不再是主干的祖先**，而分支一旦被删（B5 的常规操作），这些提交也不在任何 remote ref 上——
  两个判据同时失效，于是永远拒绝。
  
  **修法**：让"已合并"成为一个可记录的事实，而不是靠 git 事后推断。
  - 线程记录新增 `prNumber` / `mergedAt`：`openPr` 成功时记下 PR 号
  - 合并审批执行成功时，把对应 PR 的线程标记 `mergedAt`
  - 回收判据：`mergedAt` 存在即放行（内容已在主干）；否则维持原判据（未合并且有未推送就拒绝）
  
  新增 1 项真实 git 集成测试：squash 合并 + 删远端分支后，**未标记时拒绝、标记后允许回收**；
  另加 4 项 `shouldReclaim` 单测（merged 放行、未合并拒绝、当前会话/脏工作区仍拒绝）。

## 0.7.2

### Patch Changes

- [#300](https://github.com/kangyishuai/dsh-plugins/pull/300) [`d0df734`](https://github.com/kangyishuai/dsh-plugins/commit/d0df734207819eae8fe2045bc37b9cc6259e6c5f) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 多项目并行与审批队列走查后修的三处。
  
  - **返回列表不刷新**：在详情页建了线程、改了目录，返回面板看到的还是旧的「未设置线程数」——
    面板没有轮询，`onBack` 也不刷新。现在返回即刷新。
  - **头部统计看不出线程数**：`N 个项目 · N 个活跃 · 0 个会话已接入` 里的"已接入"其实是
    「已挂载项目上下文的会话数」，建了线程也不会变，用户看到"0"会以为没生效。
    现在改成 `N 个项目 · N 个活跃 · N 个线程 · N 个会话带上下文`，线程总数一眼可见。
  - **审批执行成功没有反馈**：执行完审批列表清空，提示也跟着消失（提示原本渲染在列表内部）。
    现在提示放在列表外，执行后显示「已执行（结果见审计）」。
  
  审批链路本身（待批准 → 批准 → 执行 → 审计三行）在临时宿主端到端验证通过。
  冒烟 70 → **71** 项（新增：返回后列表线程数已刷新、头部给出线程数）。

## 0.7.1

### Patch Changes

- [#298](https://github.com/kangyishuai/dsh-plugins/pull/298) [`90d2397`](https://github.com/kangyishuai/dsh-plugins/commit/90d2397dd72b97f76dcf101ff144cf38271be8ef) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 0.7.0 验收时踩到的两个问题。
  
  - **相对路径被静默接受**：项目目录填 `relative/plain` 也能"保存成功"，直到建线程时才在宿主里崩，
    报错是 `session header cwd must be an absolute path, got "undefined/plain"`——用户完全对不上号。
    现在绑定前当场校验：不是绝对路径直接拒绝，并提示「需要绝对路径（以 / 开头）；相对路径无法作为会话目录」。
  - **文案里的 Markdown 泄漏**：非 git 目录提示写成 `**共享这个目录**`，界面不渲染 Markdown，
    用户看到的是字面星号。已去掉。
  
  冒烟 69 → **70** 项（新增：相对路径当场拒绝并说明原因）。

## 0.7.0

### Minor Changes

- [#296](https://github.com/kangyishuai/dsh-plugins/pull/296) [`6a519e9`](https://github.com/kangyishuai/dsh-plugins/commit/6a519e9c02a2a11c7a45f9869a6688196a7584f9) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 边界/空态走查后修的三处（走查报告见私有 notes）。
  
  - **非 git 目录静默降级**：绑一个普通目录后，线程其实是**共享目录**（没有 worktree 隔离），
    但界面什么都不说，用户会以为有隔离。现在绑定后当场探测并明确提示：
    「不是 git 仓库：线程会共享这个目录（没有 worktree 隔离，别让两个线程同时改同一批文件）」；
    线程行也标「共享目录（未隔离）」。新增 RPC `inspectDir({ path })`（exists / isGit / writable）。
  - **超长项目名撑爆行高**：120 字符的项目名会把列表行拉得很高。现在名字单行省略号截断。
  - **绑定目录无任何反馈**：成功失败都静默。现在绑定后显示目录状态（git / 非 git）。
  
  冒烟 67 → **69** 项（新增：非 git 目录如实说明、超长名字截断）。

## 0.6.1

### Patch Changes

- [#294](https://github.com/kangyishuai/dsh-plugins/pull/294) [`2421abd`](https://github.com/kangyishuai/dsh-plugins/commit/2421abd95925ae994cbed09cb4e07ed016006dbc) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修 0.6.0 验收时发现的**自锁死路**：回收站只挂在项目详情页里，所以**删掉最后一个项目后就再也进不去回收站**——
  恢复入口自己把门锁上了（回收站里明明有项目可恢复，但界面上没有任何入口）。
  
  - 面板新增面板级回收站（`PanelTrash`）：**项目列表为空时**仍能查看、恢复、彻底删除（含两步确认）
  - 顺带修：`restoreProject` 恢复时**保留原状态**——之前一律写成 `active`，
    把用户显式设过的 paused/archived 状态抹掉了（冒烟里归档/暂停两条断言因此红过）
  
  冒烟 62 → **67** 项，新增「项目清零后面板仍能进入回收站（防自锁）」——
  这条是**真的删掉所有项目**再断言，不是跳过。

## 0.6.0

### Minor Changes

- [#292](https://github.com/kangyishuai/dsh-plugins/pull/292) [`5d319ba`](https://github.com/kangyishuai/dsh-plugins/commit/5d319ba18af09296959a323e563f6a3c75aab6aa) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 「记忆」页签从只读变成可写。
  
  走查发现：用户能看到「常设规则（instructions.md）」和「记忆索引（MEMORY.md）」，却没有任何编辑入口——
  规则只能靠协调器工具写，人想加一句"这个仓库测试用 pnpm test"都无处下手。
  
  - RPC `setProjectInstructions({ projectId, text })`：写 `instructions.md`（0o600）；
    空文本视为清空（删文件，而不是留个空文件让人分不清有没有规则）；上限 20k 字符（每次请求都会注入，太长持续吃上下文）
  - 界面：「编辑常设规则」→ 文本域 →「保存规则」；另有「追加一条记忆」输入框（回车即追加，重复条目会如实提示"已经记过了"）
  - 两个动作都写审计（`project/instructions-saved` / `project/instructions-cleared` / `memory/appended`）
  
  **踩坑记录**：给 `appendMemory` 加行内类型注释会让 SRC 网关拒绝注册该方法，
  表现为运行时 `typert gateway: ...`。`pnpm check` 里的 SRC 守卫当场拦住了——改用上方 JSDoc `@param`。
  
  冒烟 62 → **61**（本分支基于 main，新增 2 条记忆编辑断言）。

- [#291](https://github.com/kangyishuai/dsh-plugins/pull/291) [`59df29a`](https://github.com/kangyishuai/dsh-plugins/commit/59df29ae3b3e649a4e54846b6e72fb55750bcae8) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 回收站补「彻底删除 / 清空回收站」。
  
  走查发现：`purgeTrash` 只清**超过保留期（默认 30 天）**的条目，所以删错的项目即使恢复回来又删掉，
  也会在回收站里躺满 30 天——用户没有任何"现在就清掉"的手段。
  
  - RPC `deleteTrashEntry({ entryId, confirm })`：彻底删一个条目；不带 `confirm` 时只回报影响面（字节数），不动手
  - RPC `emptyTrash({ confirm })`：清空回收站，同样先回报条目数与总量
  - 界面：每行「彻底删除」（**两步确认**，第二次的按钮上直接写「确认彻底删除（1.6 KB，不可恢复）」），
    底部「清空回收站」（同样两步确认并写明条目数与总量）
  - 两个动作都写审计（`trash/entry-deleted` / `trash/emptied`），符合 ADR 0002
  
  冒烟 59 → **61** 项（新增：二次确认文案含"不可恢复"、确认后条目从回收站消失）。

### Patch Changes

- [#290](https://github.com/kangyishuai/dsh-plugins/pull/290) [`bd9aa97`](https://github.com/kangyishuai/dsh-plugins/commit/bd9aa979638430795bbeabc36ae6727e707b9433) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 走查 P2 的三处纯体验修补。
  
  - **空态指引过时**：原本只说"在会话行的「…」菜单里归属"，但现在面板本身就能建线程。
    改成「在上面输入一个任务就能新建线程；也可以回到会话行，用「…」菜单把已有会话归属到本项目」。
  - **页签被记忆**：上次停在「审计」，再进详情还停在「审计」，容易误判"这个项目没有线程"。
    现在换项目/重进详情一律回到「线程」。
  - **头部术语**：`N 个会话已挂上下文` → `N 个会话已接入`。
  
  冒烟 59 → **62** 项（新增：默认页签、空态指引、头部术语三条断言）。

## 0.5.0

### Minor Changes

- [#287](https://github.com/kangyishuai/dsh-plugins/pull/287) [`685dab8`](https://github.com/kangyishuai/dsh-plugins/commit/685dab8b80e374b5993fc0b72be5e2698a70c21b) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 真实用户走查后发现并修复的两处缺陷 + 一处补齐（走查报告见私有 notes）。
  
  **修：回收站预览直接报网关错**
  `purgeTrash(options)` 只有一个参数 `options`，客户端把 `dryRun`/`projectId` 平铺在最外层，
  网关按参数名校验拒绝，用户看到的是 `typert gateway: ... unexpected "dryRun", "projectId"`。
  改成 `{ options: {...} }`。已核对全仓 16 个客户端调用，仅此一处写错。
  
  **补：删除承诺"可恢复"，现在真的能恢复**
  - 新增 RPC `listTrash()`：列出回收站条目（名称 / 线程数 / 删除时间 / 体积）
  - 新增 RPC `restoreTrash(entryId)`：把项目与线程放回仓储、内容目录搬回、清掉回收站条目
  - 详情页新增「回收站（可恢复）」区块，每行一个「恢复」按钮；恢复后自动刷新项目列表
  
  **修：冒烟断言把报错当成通过**
  原断言只校验"有文字且不含 FAIL"，于是上面的网关错误一路绿灯发版。现在必须校验成功语义，
  并新增「回收站列表」与「删除→恢复往返」两条断言（web 冒烟 57 项）。
  
  新增 3 项 store 单测（恢复项目、同 id 拒绝、线程归属保持）。

- [#289](https://github.com/kangyishuai/dsh-plugins/pull/289) [`e1315bc`](https://github.com/kangyishuai/dsh-plugins/commit/e1315bca89ae3c45b03dfe65f62afc25c1cf2949) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 真实用户走查的 P1 四项（走查报告见私有 notes）。
  
  - **建线程写审计**：从面板「新建线程」成功后不再无声无息，现在写 `thread/created`
    （含 sessionId、是否隔离、任务摘要），「审计」页签能看到。之前只有被拒绝才留痕，
    与"可审计"的主张自相矛盾。
  - **路由结果说人话**：`按 blocked → new-thread · #long-task · 被拦: autonomy/L1` 这种内部码
    换成「规则「long-task」建议「新建线程」，但当前自治等级（L1）不允许自动执行，已拦下（可在设置里提高自治等级，或手动执行）」；
    原始码移到 `title` 属性，需要的人 hover 才看。
  - **高级设置默认折叠**：仓库授权 / 回收站清理 / 回收站（可恢复）三块收进一个
    「高级设置」折叠区，首屏留给线程——走查里这三块把主内容压到了折叠线以下。
  - **重名项目可区分**：项目行在名字后显示 `#<id 后缀>`，两条同名项目不再一模一样。
  
  冒烟从 57 增至 **59** 项（新增折叠态、项目行短 id 两条断言）。

## 0.4.3

### Patch Changes

- [#285](https://github.com/kangyishuai/dsh-plugins/pull/285) [`8fb2ffd`](https://github.com/kangyishuai/dsh-plugins/commit/8fb2ffdc0cc74a3d0c3f46880fee8688c32269c2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 0.4.2 装进 live profile、**重启桌面版后**复跑门禁，结果写进兼容表：
  
  - 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**
  - web 端到端冒烟 **54 PASS / 0 SKIP / 0 FAIL**
  - `pnpm gate:all --plugins projects` 全绿（64s）
  
  并在**真实界面**里用截图确认了本次修复：空项目的「线程 (0)」页签同时出现
  「新建线程」输入框与空态提示（修之前输入框被空态挡住，页面无处起线程）。
  
  另把 README 里的「317 项单测 / 52 项冒烟」更新为 **385 / 54**。

## 0.4.2

### Patch Changes

- [#283](https://github.com/kangyishuai/dsh-plugins/pull/283) [`4b409ab`](https://github.com/kangyishuai/dsh-plugins/commit/4b409ab290503a466c2b96bb740508315761c341) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个可用性缺陷：**新建的项目在面板里无法起线程**。
  
  详情页的「线程」页签在**没有线程时直接 return 空态**，而「新建线程」输入框和按钮就渲染在那个分支里——
  于是空项目的页面上根本没有入口，用户只能绕道会话行的「…」菜单去归属一个已有会话。
  现在把输入行提到判空之前，空态也带着它。
  
  顺带：web 冒烟的详情页截图改用 CDP `Page.captureScreenshot`
  （ego 的 `page.screenshot()` 在本版本返回空数据，存下来的 png 只有 56 字节），
  新增一张 `02-detail-thread-stats.png`，把线程行摘要与两块新 UI 一起留档。
  
  冒烟新增 1 项断言（空项目的详情页仍有建线程入口），共 **54** 项。

## 0.4.1

### Patch Changes

- [#281](https://github.com/kangyishuai/dsh-plugins/pull/281) [`e23ed5e`](https://github.com/kangyishuai/dsh-plugins/commit/e23ed5ee25bceadad2283aca147634c0136d7e4f) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修一个从 M2 起就存在的回收缺陷：**合并过的线程 worktree 永远回收不掉**。
  
  原来「有没有未推送提交」用的是 `git rev-list --count <base>..HEAD`，也就是「相对创建时的基线有没有
  新提交」。问题是**基线不会因为合并而前移**——线程只要提交过，这个数就永远是 1 以上，
  于是合并完成、PR 已合入主干的线程，worktree 仍然被判定为"有未推送提交"而拒绝回收。
  B5（分支生命周期）只能自己绕开这一步。
  
  现在改成按**是否已在某个远端**判断：`git rev-list --count HEAD --not --remotes` 为 0 才算"都推上去了"。
  没有配置远端的仓库（本地临时仓库、离线项目）无处可推，退回旧判据，避免永远拒绝回收。
  
  新增 2 项测试：有远端且已推送 → 允许回收（修复点）；有远端但提交只在本地 → 拒绝（内容不能丢）。
  负向验证：退回旧判据后第一条立即变红。

## 0.4.0

### Minor Changes

- [#280](https://github.com/kangyishuai/dsh-plugins/pull/280) [`4210c95`](https://github.com/kangyishuai/dsh-plugins/commit/4210c9517b28a7d5376452ab578b4543520b8109) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补上「分支生命周期」（规格 §7.7.5 / 计划 B5）：worktree 会回收，分支以前**永不删除**，会一路累积。
  
  **新判据（三条全满足才删）**，刻意**不用** `git branch --merged`——它在两个方向都会误判
  （未提交的新分支被当"已合并"、squash 合并的分支被当"未合并"，见 runtime §11.15）：
  
  1. 分支是插件建的（`dsh/` 前缀且与线程记录一致）
  2. 该线程**确有合并结果**：记录里有 `mergedAt`，或 `git merge-base --is-ancestor <branch> HEAD` 成立
  3. **没有未推送提交**：`git rev-list --count <branch> --not --remotes` 为 0
  
  **worktree 先处理**：分支若仍被 worktree 占用，`git branch -d` 会被拒。所以只在 worktree
  **干净**（`git status --porcelain` 为空）时用 `git worktree remove`（不加 `--force`）移除它，
  脏 worktree 一律保留并报告 `worktree-dirty`。
  
  **删除只用 `git branch -d`，永不用 `-D`**；失败保留并写审计。
  提供 RPC `cleanupBranches(projectId, { dryRun })`（默认 dry-run，真删需 `confirm: true`），
  并在**归档项目**时自动按同一判据清理一次（失败不影响归档）。
  
  真机验证（临时裸远端）：已合并+已推送的分支被删；未合并的分支保留（`not-merged`）；worktree 脏时保留。
  新增 6 项单测（三判据真值表 + 两种历史误判场景 + `-d` 断言）。

- [#273](https://github.com/kangyishuai/dsh-plugins/pull/273) [`4d8dcd1`](https://github.com/kangyishuai/dsh-plugins/commit/4d8dcd1642155b65743aa76c8bf3dd3f5359ca1e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补齐规格 §7.5 行 3 漏实现的合并硬前提，并落地项目级预授权（规格 §7.7.2）。
  
  **合并的三道硬前提**（此前只查「非 draft / 无冲突」）
  - **CI 绿**：`statusCheckRollup` 必须全部通过；空列表按「未配置检查」**拒绝**（`merge/ci-unknown`），不猜
  - **人工批准**：统计 `reviews` 里不同作者的 APPROVED 数 ≥ `policy.merge.minApprovals`（默认 1）
  - **合并方式**：仓库 `allowed_merge_methods` 必须含 `squash`，否则拒绝而不改用 merge/rebase
  - 阈值改从 `policy.merge` 读（`minApprovals` / `maxDiffFiles` / `maxDiffLines`），不再写死
  
  **项目级预授权**：`policy.preapprove` 列出可被 `policy-grant` 直接放行的动作；三条全满足才生效
  （在列表里、授权来源是 policy-grant、危险开关已开）。命中后自动 approved 并**立即执行**——
  闸门一条不跳过，只省掉「等人点一下」。`merge`（approval-event）与直推保护分支（per-incident）
  **永不**被预授权覆盖。执行结果会如实回报给协调器（`executed` / `auto-approved-not-executed` + 原因）。
  
  **顺带**：`delete-thread` 之前也是「可申请但执行只会 deferred」，现在真正走 `reclaimThread`（三重判据不变）。
  
  **一处旧结论纠正**：宿主没有 `ctx.approval.setPolicy`（`dsh-authorization` 是凭据流程，不是审批），
  所以预授权是本插件用政策授权自己实现的，不是宿主能力。
  
  341 项单测（新增 19 项：CI/批准数/合并方式/预授权/工具回报）、真机验过五种拒绝与两种放行路径。

- [#276](https://github.com/kangyishuai/dsh-plugins/pull/276) [`83910f7`](https://github.com/kangyishuai/dsh-plugins/commit/83910f76c1f22f6f0aca32f7246cf24ea54aa6f2) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补上「可观测」（规格 §7.7.3）：面板不再只有线程状态，还能看到这一步花了什么、改了什么。
  
  - 从**持久会话事件**累积每个线程的：步骤数（`assistant/attempt`）、工具调用与命令明细
    （`tool/call` + `tool/result` 回填成功与否，保留最近 12 条）、token 用量
  - 新增 RPC `threadStats(projectId, sessionId)`：在事件统计之外现算 worktree 的
    `git diff --numstat <base>..HEAD`（文件数 / +增 / -删）
  - 详情页线程行显示一行摘要：`N 步 · N 次工具 · diff N 文件 +a/-b · N tokens`
  - **缺失数据显式 n/a**：二进制文件的 numstat 是 `-/-`、宿主没上报 usage 时，都写 `n/a`，
    不用估算值冒充测量值
  
  新增 13 项单测（事件归约、命令上限、token 字段兼容、numstat 解析、n/a 语义）；
  web 冒烟 53 项（新增 1 项断言线程行摘要）。

- [#279](https://github.com/kangyishuai/dsh-plugins/pull/279) [`49ef2bb`](https://github.com/kangyishuai/dsh-plugins/commit/49ef2bb829987e6a198c0790e3e007254133a233) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补「一键建项目模板」（规格 §7.7.6 / 计划 B6）：`createProject(name, { dirs, template: true })`
  会建目录、写一份 `instructions.md` 骨架。
  
  - **绝不覆盖**：写盘用 `writeFileSync(..., { flag: "wx" })`，已有 `instructions.md` 直接跳过并记审计
  - **已有 `AGENTS.md` 时不动它**，只在新骨架里加一行「两者都会注入，请避免写重复内容」，
    与 spec §3.3 的去重口径一致
  - 重复调用幂等；模板创建失败**不阻断**建项目（只写审计 `project/template-failed`）
  
  真机验证：新目录被建且骨架写入；已有 AGENTS.md 内容逐字节未变；同目录再建一次不覆盖。
  新增 6 项单测。

- [#277](https://github.com/kangyishuai/dsh-plugins/pull/277) [`8fc72fd`](https://github.com/kangyishuai/dsh-plugins/commit/8fc72fd4cb1e5b016843c6b7bddf1ce3f0285d19) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 补「周预算」与「单线程步数上限」（规格 §7.7.4）。
  
  - **周预算**：`policy.budget.weeklyTokens`，按**自然周（周一 00:00，本地时区）**聚合 token 用量，
    到线即拒建新线程（`budget/weekly-tokens`）。为此把 token 用量从「单日桶」改成**按天分桶**
    （保留最近 21 天，旧形状自动迁移，不丢历史数）
  - **单线程步数**：`policy.budget.maxStepsPerThread`，按 `assistant/attempt` 计步；
    超限**只停协调器唤醒**（审计 `wake/skipped` + `budget/steps-per-thread`），
    **不杀会话、不阻止人继续**——这是刻意的：预算是防止无人值守的无限烧，不是惩罚使用者
  - `threadStats` 增加 `overBudget` / `budgetReason`，面板可据此提示
  
  新增 9 项单测（周界计算、周预算边界、步数边界、按天分桶、旧形状迁移、21 天修剪）。

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
