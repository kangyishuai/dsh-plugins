# session-rewind 测试清单

> 目的：证明「回溯只追加、上下文确实被截断、界面确实隐藏、输入框确实回填」四件事，
> 而不是靠感觉点两下。三层：**纯函数单测 → 端到端 GUI 冒烟 → 界面手测/边界手测**。
> 前两层每次提交都跑；第三层发版、DSH 升级、以及改动客户端私有 seam 后必须跑。

## 0. 测试环境

**一律在临时 `DSH_HOME` 里跑**，不要拿真实会话试（回溯会往日志追加 marker）：

```bash
# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/session-rewind && pnpm pack --pack-destination /tmp

# 2) 隔离 home：复制 profile + 会话 + 存储
H=/tmp/dsh-test-rewind
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/srw
cp -R ~/.dsh/sessions $H/sessions
cp -R ~/.dsh/storages $H/storages
DSH_HOME=$H dsh plugin --profile srw install
DSH_HOME=$H dsh plugin --profile srw add /tmp/kangyishuai-dsh-session-rewind-0.1.0.tgz

# 3) 启动（端口 0 = 随机，--no-open 不弹浏览器）
DSH_HOME=$H dsh --profile srw --port 0 --no-open
```

以上步骤已经由 `pnpm smoke:session-rewind` 自动化（含浏览器驱动与日志断言）。

## 1. 自动化（每次提交）

```bash
cd packages/session-rewind && pnpm test   # 纯函数 + 客户端 vm 单测
pnpm verify                               # 仓库门禁
```

覆盖点：

- `listCandidates` / `planRewind` / `cutsOf`：候选过滤（只收 surface 上的真人 user 消息）、
  replace 区间（目标及其后全部 surface 节点）、`bad-target` / `not-on-surface`；
- `operations.js`：`not-found` / `busy` / `inert` 的优先级、marker 输入与 surface 元数据形状；
- `rewind-flow.js`（AUD-REW-10，本批新增）：preview → 救援点 → marker → apply → 部分失败兜底 →
  审计的编排状态机；覆盖 chat/both 成功、冲突拒绝、无文件动作、marker 已写/未写两种失败、
  运行中取消与拒绝、tracking/cwd 不可用、并发重入、审计失败不致命；
- `command.js`（AUD-REW-09）：`/rewind @<seq> [chat|both] [confirm]` 解析、`both` 执行前回执与
  冲突回执、成功回执；
- 客户端纯函数：`DoubleEscape` 双击窗口、`cutOfMarkerNode`/`collectCuts`、`errorTextKey`；
- 输入历史召回：`isRecallGesture`（组合键/输入法/已被消费一律放行）、`recallStep`（进入、到底不环绕、
  越过最新一条恢复 pending line）、`caretEdges`（首/末行为两个独立布尔，单行草稿两者都成立）、
  `historyFromCandidates`（宿主新→旧翻成旧→新、丢空文本、截 100）、`createRecallCache`（TTL 失真、
  `peek` 仍可读、按会话隔离、`forget`）。

## 1.5 一条命令跑完门禁（发版前）

```bash
pnpm gate session-rewind --deep --workspace ~/Workspace/dsh-rewind-ui-smoke
# 等价写法：pnpm gate:session-rewind -- --deep --workspace ...
```

按「便宜的先跑」排序，任何一步失败立刻停并给出下一步提示：

1. `pnpm verify`（lint + 类型 + 规范 + 公开边界 + 277 单测）
2. `pnpm probe:runtime`（宿主包/API/slot/私有 seam，99 项）
3. `pnpm smoke:session-rewind`（临时 DSH_HOME 的 web 端到端，约 62 项；本批新增 10 条：可恢复性 / 默认聚焦 / Tab 环绕 / 回收站入口 / 更多设置 / 命令 both 确认 / 跟踪范围 / 面板「选择消息回退」/ 命令候选键盘路径 / 诊断审计计数）
4. 桌面只读回归（35 项，**永远带 `--require`**：没开调试端口就是失败，不是跳过）
5. 桌面 `--deep` 文件模式 e2e（35 只读 + 27 深链 = 62 项，需 `--workspace` + 已注册的专用工作区；
   **2026-11-28 真机校准：59 PASS / 3 SKIP / 0 FAIL**，3 条 SKIP 是「宿主没有 `apply_patch`」的
   环境分支，见 §2.6）

只有显式 `--skip-desktop` 才跳过桌面端，且结束时会明确打印「门禁不完整」。

## 1.55 CI 里跑什么（每次 PR）

CI 无法跑 GUI（没有 ego-browser / 桌面版），所以只跑**确定性**的三件事：

| CI job                   | 内容                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `verify`                 | biome + typecheck + 插件规范 + 公开边界 + 全部单测（node 22.19 / 24）                       |
| `probe`                  | `pnpm probe:runtime`（没装 DSH 时脚本自己 SKIP）+ 每个插件的 `pnpm gate <plugin> --dry-run` |
| `secrets` / `commitlint` | gitleaks 全历史、Conventional Commits                                                       |

`--dry-run` 只检查「门禁结构完整」：每个插件必须有 verify / probe / web 冒烟三个必需步骤
（桌面端允许缺失）。web 冒烟与桌面端仍在本地跑（`pnpm gate <plugin>`），因为需要真实宿主与浏览器。

## 1.6 README 效果图（改了界面才需要重跑）

```bash
pnpm shots:session-rewind
```

在临时 `DSH_HOME` 里只放**一个合成工作区 + 一个合成会话**（`/tmp/atlas-shots-workspace`、假想项目
atlas 的对话），装当前源码打的包，启动真实宿主后用 ego-browser 打开会话，截「确认框 / 面板」，
再按 DOM 矩形裁剪成 `packages/session-rewind/assets/*.png`。

隐私边界（因为图片没法像文本那样被 `check:public` 扫描）：

- 临时 home 里不放任何真实会话，侧栏只有合成工作区；
- 截图按矩形裁剪，账号区、其它工作区、真实路径都不在画面里；
- 脚本会把**裁剪矩形内的可见文本** dump 到 stdout，便于程序化核对（本次核对结果：只出现合成句子，
  唯一命中「token」的是插件自己的「约 50 token」文案）。

## 2. 端到端 GUI 冒烟（每次提交，改客户端后必跑）

```bash
pnpm smoke:session-rewind
```


> ego 的 TaskSpace 只有 8 个页面额度：冒烟每次新建页面，失败运行会留下没关的页面，
> 攒满后所有断言会以 `Page budget reached` 失败。脚本开跑前会先关掉遗留页面，
> 并在结束时关掉自己开的页面。
> 2026-11-28 起所有 web 冒烟的 `task.finish()` 都放进 `finally`（断言失败/超时也回收空间）；
> 万一还是卡在额度上（例如别的会话把环境搞脏了），用 `node scripts/ego-cleanup.mjs` 预览
> agent 遗留的 TaskSpace、`--apply` 清理（只清 `ownership=agent`，不碰用户 space）。
> 失败时临时 `DSH_HOME` 会自动保留并打印 `host.log` 尾部（不必再设 `SMOKE_KEEP=1`）。
> 临时 home 里启动真实宿主 + ego-browser，约 62 项断言（本批 +10）：

| #     | 断言                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 1     | 找到 ≥2 条用户消息的会话，且出现 ↶ 按钮                                                               |
| 2     | 点 ↶ 打开确认框，确认框写明「从对话中移除此消息及其后的所有内容」                                     |
| 3     | 确认后目标行及其后消失（只剩目标之前的消息）                                                          |
| 4     | 输入框回填目标消息文本，toast 提示成功                                                                |
| 5     | 占位 marker 行没有出现在对话里                                                                        |
| 6–7   | 空闲会话 `Esc` `Esc` 打开候选对话框并列出候选（宿主全量日志）                                         |
| 8–11  | 选候选 → 确认 → 再次截断 + 回填                                                                       |
| 12    | 页面重载后被撤回的行仍隐藏（cuts 兜底）                                                               |
| 13    | 切走会话再切回后仍隐藏                                                                                |
| 14    | 直接解压会话日志：原始用户消息一条没少（只追加）                                                      |
| 15    | 每次回溯多一条 `session-rewind` marker                                                                |
| 16    | marker 形状：`surfaceOp.op === "replace"`、`sourceEventSeqs` 覆盖被遮蔽节点、`targetSeq === startSeq` |
| 17    | marker 内容是非空占位文本                                                                             |
| 18–19 | 确认框有「仅对话 / 对话+文件」两个范围；无文件变更时文件模式置灰；提供「回退后立即重发」且默认不勾选  |
| 20    | 回溯面板三页签（设置已迁出）+ 回溯记录回执                                                            |
| 21    | 回溯记录以时间线渲染（节点数 === 圆点数）                                                             |
| 22–23 | 候选列表搜索、加载更早（无更多候选时记为通过）                                                        |
| 24–25 | `/rewind` 打开候选、选候选进入确认框                                                                  |
| 26–27 | 设置 → 会话回溯 分节的偏好持久化与恢复（含诊断可加载）                                                |
| 28    | 诊断页报告只读工具已注册                                                                              |
| 29–34 | 审计记录、marker 计数与形状、日志只追加等收尾断言                                                     |
| 35    | 召回：找到含 ≥2 条未被回溯遮蔽的用户消息的会话（期望值直接来自会话日志，不写死文案）                  |
| 36    | 召回前提：输入框已聚焦、草稿为空、能用 `[data-conversation-session]` 定位当前会话                     |
| 37    | 空草稿按 `↑` → 草稿等于最新一条用户输入（A1）                                                         |
| 38    | 再按 `↑` → 草稿等于上一条用户输入（A2）                                                               |
| 39    | 按 `↓` 回到最新一条，再按 `↓` → 恢复浏览前的空草稿（A3）                                              |
| 40    | 非空草稿 + 光标在第一行时按 `↑` 也能召回（A4）                                                        |
| 41    | 一路 `↓` 到底 → 原样还回用户自己的草稿（stash/restore，A4）                                           |
| 42    | 召回全程非破坏：无新 `user/message`、无回溯 marker、对话行数不变（A5）                                |
| 43    | 关掉「输入框 ↑/↓ 召回历史输入」后 `↑` 既不填草稿，也不在 window 阶段被 `preventDefault`（A6）         |
| 44    | 设置可以恢复为开启（后续设置类断言不受影响）                                                          |
| 45–49 | 草稿清理（不残留影响回溯回填）、截图与收尾断言                                                        |
| 50    | 确认框写明可恢复性（`data-rewind-recoverable`：撤回内容留在面板；文件有救援点/回收站）（AUD-REW-06）  |
| 51    | 确认框默认聚焦主按钮（`data-modal-autofocus` = 主按钮且 `activeElement` 在框内）（AUD-REW-07）        |
| 52    | 确认框 Tab 不穿透（合成 Tab 后焦点仍在框内环绕）（AUD-REW-07）                                        |
| 53    | 救援点页签里有回收站入口（`data-srw-trash`，可恢复/可清空）（AUD-REW-08）                             |
| 54    | 设置分节的低频项与诊断收进「更多设置」且默认收起（AUD-REW-17）                                        |
| 55    | `/rewind @<seq> both` 无 `confirm` 只回执影响面、不写文件（审计 marker 数不变）（AUD-REW-09）         |

冒烟会先**定向清理** loopback（127.0.0.1 / localhost）的 cookie 后再打开页面：ego-browser 是用户真实的
浏览器 profile，绝不能整库清空（会踢掉真实登录态）。清理结果打印成 `SMOKE_COOKIES {"removed":…,"total":…}`。

失败时会打印断言明细并把截图留在 `/tmp/dsh-smoke-rewind-shots/`（截图含临时 home 里的真实
会话内容，不要提交）。`SMOKE_DEBUG=1` 可看浏览器脚本完整输出。

## 2.4 只读工具与状态提示（单测覆盖，不单独冒烟）

- `test/tool.test.js`：候选列表/搜索/limit 夹紧、过滤注入上下文、影响面、未完成工具调用、
  两份 JSON Schema 形状、render 文案、execute 接线、三种 install 路径。
- `test/state-changes.test.js`：区间聚合与计数、边界、未知事件类型忽略、摘要字段。
- 只读工具在真实宿主里是否真的注册，由冒烟第 28 条（诊断页显示 `只读工具 enabled`）保证。

## 2.5 文件引擎单测（每次提交）

`cd packages/session-rewind && pnpm test` 里包含 70 个文件引擎/追踪单测（临时目录）：

- 捕获与记录：write create/update、edit、apply_patch add/update/delete/move；
- 路径安全：cwd 逃逸、符号链接、`.git`/`node_modules`、非普通文件；
- 限制：单文件 8 MiB 跳过、不可读文件跳过；**恢复侧同上限**（当前文件被外部写大 → 计划里记
  `too-large` 而不是整块读；计划后才变大 → 救援点失败、一个字节不写；被污染的救援点内容也拒绝写出）（AUD-REW-12）；
- 恢复计划：多 anchor 同一路径取最早 before、trash 列表、按**目标状态**判定（已满足即 no-op；
  只有当前内容既不是 before 也不是该路径记录过的状态才算 `modified-externally` 冲突）；
- 删除文件还原：agent 删除的文件回退时按记录重建（父目录 `mkdir -p`）、重命名（delete+add）
  回退后源名字恢复、目标名字进回收站；外部删除的已改动文件按设计 §2.3 报 `missing` 冲突、
  不静默复活；「上次回溯自己移入回收站」的文件可由回收站记录命中后重建；
- 重复回溯：先回溯到后一轮（新建文件进回收站）再回溯到更早一轮不被拒绝；两次「只还原内容」
  的回溯都成功；上次回溯留下的中间态不被当成外部改动；
- 执行：救援点失败不写、写后哈希校验、失败回滚、回收站移动、保留/GC/软上限；
- 写入安全：还原 / 救援点恢复 / 回收站恢复三处共用 `assertWriteTarget`——父目录换成指向
  工作区外的 symlink、或目标本身是 symlink 时全部拒绝，工作区外文件不被改写；
- 跳过原因可见（AUD-REW-04）：符号链接 / 工作区外 / 排除目录 / 捕获失败都会落一条 `skipped`
  entry（相对路径），预览按原因分组报数，`file-tracking` 对 `recordChange` 的返回值逐原因告警一次；
- 执行安全网补充（AUD-REW-13/15）：marker（`beforeApply`）失败时丢弃救援点、不留幽灵救援点；
  新建文件进回收站后自底向上收回因此变空的目录（目录里还有其它文件时不收回）；
- 回收站（AUD-REW-08）：`restoreTrash` 先建 rescue-of-rescue 并返回 `safetyRescueId`；
  `clearTrash` 的 dry-run 只报影响面（文件数/字节/路径），确认后才永久删除；
- blob GC（AUD-REW-24）：`collectGarbage` 清掉无引用 blob、保留有引用内容（启动时自动跑一次）；
- 工具钩子：`parsePatchPaths`、`commitFromToolResult`、`latestHumanUserSeq`、install 后
  tools/execute + post-execute 的正常/异常路径。
- 孤儿清理（`test/orphans.test.js`）：用真实宿主 slug 形态（`--Users-someone-Workspace-project--`）
  断言「存活会话的数据不被删」「真正孤儿被删」；枚举不到存活会话时视为枚举失败、一个字节都不删；
  未知宿主布局（扁平 `sessions/<id>/session.v4…`、多一层 `--project--` 嵌套）一律按枚举失败跳过；
  **逐 workspace 护栏**覆盖混合布局：一个正常 workspace + 一个多一层嵌套（`--project--` 或安全字符集
  project id）→ `unknownWorkspaces` + `incomplete`、不删；同一 workspace 内混有两层与更深层会话
  （条目不像会话目录）同样按未知布局跳过；两个都是正常两层布局时真实孤儿照删；
  任一 workspace 不可读（注入 `EACCES`）记为 `incomplete`，不删并留审计计划；某个 workspace 为空
  不会妨碍清理真实孤儿（不过度保守）；计划审计失败时不执行删除；不认识的插件数据条目进
  `unknownIds`、保留并告警。

## 2.6 文件模式端到端（桌面版）

**现状（2026-11-28 真机校准完成）**：web 冒烟的确定性断言只覆盖客户端侧（确认框/面板/设置/命令回执）；
需要真实模型写文件的路径放在桌面 `--deep`。2026-11-28 在隔离桌面实例（DSH 0.2.2-rc.5，
真实模型凭据，专用工作区）实测 **59 PASS / 3 SKIP / 0 FAIL**（62 条：默认只读 35 + 深链 27），
连跑两次结果一致（幂等）。

`--deep` 段落覆盖：

1. 新建会话前置：工作区已注册 → 新建**绑定该工作区的空白会话**（四项终态）→ 新建文件 →
   确认框 → 移入回收站 → toast/回填 → 救援点恢复 → 时间线出现 rescue-restore；
2. **修改还原**：agent 用 `write` 覆盖已有文件 → 回溯「对话+文件」→ 内容回到覆盖前；
3. **删除文件**：agent 用 `apply_patch` 删除文件 → 回溯 → 文件按记录重建；
4. **冲突拒绝**：外部把同一文件改成第三种内容 → 文件模式置灰并列出冲突 → 取消后外部内容原样。

**删除文件三条断言在本机按环境分支 SKIP**：DSH 0.2.2-rc.5 的四个 agent 预设
（standard / ptc / minimal / cordis）都在 preset 里把 `tool-fs.applyPatch` 设为 `false`
（宿主源码 + `dsh --dump-config` 双证据），桌面默认**没有** `apply_patch` 工具；而插件按设计只追踪
`write` / `edit` / `apply_patch`（bash、脚本、子代理不追踪），所以「删除 → 回溯重建」这条语义
在这个宿主组合里无法由受追踪工具驱动。断言本身没有放宽：脚本仍会发删除指令、仍按
「工具卡里出现 `apply_patch` + 文件真的消失」才进入三条断言；宿主以后打开 applyPatch，
这段会真的跑起来（那时 SKIP 会变成 PASS 或真 FAIL）。把宿主工具缺失记成 SKIP 而不是 FAIL，
是为了不给插件记假红；也**没有**为了凑 0 FAIL 改断言语义。

### 2.6.1 `--deep` 的运行前提（2026-11-28 校准）

1. **专用目录必须是已注册的桌面工作区**（唯一的人工前置）：
   桌面「工作区 → 添加工作区」选一次该目录。脚本只读侧栏、不写宿主注册表；缺了它侧栏里
   根本没有「在 X 中新建会话」按钮（旧版脚本在这里 `no-button` 静默失败，接着模型在**别的**
   会话里跑，文件永远不出现）。
2. **macOS 的 `/tmp` 是 `/private/tmp` 的软链，必须按真实路径注册**。宿主用真实路径绑定会话
   cwd；按 `/tmp/...` 注册时「新建会话」会先建出会话再 attach 失败（日志
   `session/workspace-attach-failed: its cwd resolves to '/private/tmp/...'`），界面**静默停在
   旧会话**上。脚本因此对 `--workspace` 做 `realpath` 再用它做文件断言。
3. **模型凭据可用**（要发 4~5 轮真实请求，花额度）；会话标题、回复文案都不参与断言。
4. 工作区标题默认取目录名；用户改过名时用 `--sidebar-workspace <标题>` 指定。
5. 每次跑会在侧栏留下一个新的测试会话（不自动删），测试文件会清理；截图写到
   `/tmp/dsh-session-rewind-desktop-shots/`（含真实会话内容，不要提交）。

删除文件还原、重复回溯、写入侧 symlink 拒绝、恢复侧大小上限、空目录收回、跳过原因可见等
安全护栏仍由上面的单测覆盖（含 `apply_patch` 的解析分支）；`--deep` 需要真模型额度 + 专用工作区，
日常/CI 不一定跑。

桌面版（Electron）一键回归，**只读**：只切会话、开关对话框与面板、点取消；不回溯、不写文件、
不发模型请求，可以直接跑在真实 profile 上。

```bash
# 1) 带调试端口重启桌面版（验证完正常重启一次即可关闭端口）
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 2) 跑
pnpm smoke:session-rewind-desktop
```

桌面只读回归实测 **35 项**（2026-11-28，DSH 0.2.2-rc.5；2026-11-12 时为 24 项）。

加 `--recall` 会在同一个 Electron 渲染进程里额外验证**输入框 ↑/↓ 历史召回**（7 条断言，合计 42 项）：
空草稿按 ↑ 召回最新一条用户消息（并核对它确实出现在对话行里）、再按 ↑ 往前翻、↓↓ 走回并恢复空草稿、
全程对话行数不变且不弹回溯框。它**只写草稿**，结束时清空；不发送、不回溯、不写会话日志。
随机按键通过 CDP `Input.dispatchKeyEvent` 派发，走的是真实 DOM keydown 路径（也就是
`shortcuts.observeFixedInput` 的上游），但不经过桌面版的原生键盘桥——原生桥只拦截**已注册组合**，
而召回刻意不注册快捷键。

```bash
pnpm smoke:session-rewind-desktop --require --recall
```

**发版门禁要加 `--require`**：连不上端口时默认是 SKIP（exit 0，适合日常随手跑），加
`--require` 则判为 FAIL（exit 1）——避免「没跑也说通过」。

```bash
pnpm smoke:session-rewind-desktop -- --require                       # 发版前必须 PASS（只读 35 项）
pnpm smoke:session-rewind-desktop -- --require --deep \
  --workspace ~/Workspace/dsh-rewind-ui-smoke                        # 加上文件模式 e2e（35 + 27 = 62 项）
pnpm smoke:session-rewind-desktop -- --require --recall --deep \
  --workspace ~/Workspace/dsh-rewind-ui-smoke                        # 全量组合（35 + 7 + 27 = 69 项）
```

**`--deep`：文件模式端到端（真机、真模型）。** 前置与幂等做法见 §2.6.1：目录事先注册成桌面工作区
（按真实路径），脚本**自己**在该工作区点「新建会话」并断言四个终态（会话 id 变了 / 会话为空 /
输入框可编辑 / 工作区选择器显示该工作区）——不管桌面上现在有几个会话、停在哪个会话都成立。
之后：让 agent 用 `write` 创建 `rewind-desktop-smoke.txt`（prompt 给**绝对路径**，断言轮询文件系统
- 工具卡 `data-tool="write"`）→ 点该消息 ↶ → 确认「对话+文件」→ 断言文件进回收站、toast 与输入框
  回填 → 面板「救援点」恢复 → 断言文件内容回到工作区 → 修改还原 → 删除文件（宿主无 `apply_patch`
  时 3 条 SKIP，见 §2.6）→ 冲突拒绝 → 时间线出现 `rescue-restore` 节点。

安全闸：**必须**用 `--workspace` 显式给一个已存在、且不在本仓库内的目录，否则该项 FAIL 并跳过
后续步骤；目录没注册成工作区时给一条可执行的提示后停下（不猜、不用别的会话）。它只读写该目录里的
那一个测试文件名，但会消耗模型额度，并在侧栏留下一个测试会话（需要时手动删掉）。

**2026-11-28 校准修掉的三类坑**（都发生在隔离实例首跑 52 PASS / 8 FAIL 里）：

1. **前置**：旧版只断言「点到了新建会话按钮」，而按钮根本不存在（工作区未注册）时静默继续；
   现在先验「工作区已注册」，再按终态轮询新会话，并把工作区选择器显示当作 cwd 绑定证据。
2. **工具调用**：模型没写文件不是插件问题——旧版 prompt 说「当前工作区」且模型可能拿到拼接的
   多任务消息；现在 prompt 用绝对路径 + 「本轮唯一任务」，断言看文件系统与工具卡，不看回复文案。
3. **输入框回填污染**：回溯会把撤回的消息**回填**进输入框，旧版用 `document.execCommand("delete")`
   清不掉（改得动 DOM，改不动 Lexical 的编辑器状态），下一轮 prompt 于是叠成「旧任务 + 新任务」，
   模型反复执行旧任务（实测把 `write` 的内容写成上一轮的旧内容）。现在用真实 ⌘A/⌫ 清空并轮询确认。
   另外「回溯抽屉」也是 `role="dialog"[aria-modal]` 且铺满窗口，开着会吃掉输入框的点击——脚本
   在救援点恢复后**先关抽屉**再发下一轮，并把确认框选择器收紧到 `.dsh-srw-dialog`。


35 项只读断言（2026-11-28 真机实测输出，**顺序即脚本执行顺序**）：

| #   | 断言                                                                              |
| --- | --------------------------------------------------------------------------------- |
| 1   | 连上桌面 UI（CDP `/json/list` 有 page target）                                    |
| 2   | 插件 client 半已加载（`style[data-plugin]` 注入）                                 |
| 3   | 会话头部有回溯面板入口（当前没有打开会话时按「无会话」放行）                      |
| 4   | 当前会话渲染正常（用户行与 ↶ 按钮数量自洽）                                       |
| 5   | 侧栏工作区限定状态（未加 `--sidebar-workspace` 时给出提示）                       |
| 6   | 找到一个候选可达（≥1 条）的空闲会话用于 Esc 流程（没有则 FAIL）                   |
| 7   | 每条用户消息旁都有 ↶ 按钮                                                         |
| 8   | `Esc` `Esc` 打开候选列表                                                          |
| 9   | 候选列表可搜索                                                                    |
| 10  | 候选搜索过滤生效                                                                  |
| 11  | 选择候选后进入确认框                                                              |
| 12  | 确认框写明影响面与预览（截断记录 / 撤回消息）                                     |
| 13  | 确认框有「仅对话 / 对话+文件」两个范围                                            |
| 14  | 确认框有「回退后立即重发」且默认不勾选                                            |
| 15  | 确认框写明「撤回不可撤销、内容留在已撤回页签」（可恢复性基础行）                  |
| 16  | 可恢复性文案按模式分档（chat 不出现文件救援点 / both 必含）                       |
| 17  | 确认框默认聚焦主按钮（`data-modal-autofocus`）                                    |
| 18  | 确认框 Tab 不穿透（焦点在框内环绕）                                               |
| 19  | 确认框写明文件追踪范围（write/edit/apply_patch；bash/子代理不追踪）               |
| 20  | 确认按钮文字与底色对比度 ≥ 4.5:1（真实渲染进程按 WCAG 计算；深色主题曾为 1.05:1） |
| 21  | 确认框取消后退回候选列表（不执行回退）                                            |
| 22  | 再取消后对话框关闭且未回溯                                                        |
| 23  | 回溯面板打开且三页签齐全                                                          |
| 24  | 回溯记录渲染为时间线（节点数 === 圆点数）                                         |
| 25  | 救援点页签可渲染                                                                  |
| 26  | 救援点页签里有回收站入口（可恢复/可清空，AUD-REW-08）                             |
| 27  | 回溯面板提供「选择消息回退」入口（USIM-U2-10）                                    |
| 28  | 「选择消息回退」关闭面板并打开候选对话框                                          |
| 29  | 设置页出现「会话回溯」分节                                                        |
| 30  | 设置分节包含偏好与诊断                                                            |
| 31  | 低频设置与诊断收进「更多设置」且默认收起（AUD-REW-17）                            |
| 32  | 「更多设置」可以展开（里面是每页数量/列表确认/诊断）                              |
| 33  | 诊断报告只读工具已注册（诊断文案已本地化）                                        |
| 34  | 诊断报告孤儿数据检查                                                              |
| 35  | 面板可关闭                                                                        |

门禁建议直接跑**全量组合** `--recall --deep`（69 项 = 35 只读 + 7 召回 + 27 深链）：
2026-11-28 已分别实测只读段 35/35 与只读+深链段（59 PASS / 3 SKIP / 0 FAIL）；`--recall` 段最近一次
真机全绿是 2026-11-20，本批未改动它。召回段会切会话、`--deep` 段自己新建会话，互不干扰；两段都会
清空各自的草稿。


**是否值得纳入门禁**：值得，但要按「默认段必备、深链段可选」分级——默认段 35 项全绿且只读、成本
秒级，适合 `pnpm gate` 每次跑；`--deep` 要模型额度 + 已注册专用工作区，建议发版前或 nightly 跑，
并把「3 条删除断言 SKIP」视为已知环境结论（不是失败）。

`--recall` 追加的 7 项（合计 42 项）：找到可召回的会话 → 输入框已聚焦且草稿为空 → 空草稿按 `↑`
召回最新一条 → 召回的文本确实来自会话里的某条用户消息 → 再按 `↑` 换一条（只有 1 条历史时
退化断言为「停在最旧一条、不环绕」）→ `↓` `↓` 回到 live line 且草稿为空 → 全程对话行数不变、
不弹回溯框。

截图写到 `/tmp/dsh-session-rewind-desktop-shots/`（含真实会话内容，不要提交）。

两条踩过的坑：

1. **不能在「正在运行本 agent 的会话」里按 `Esc` `Esc`**——那会触发内置停止、取消正在跑的
   这一轮（脚本自己的工具调用会被 abort）。脚本先切到有消息的空闲会话，最后切回原会话。
2. 侧栏里可能有没有消息的会话，切过去候选为空；脚本只挑**有用户消息**的会话。

**桌面端能跑「写文件 e2e」，但要花模型额度**：文件模式需要真实 `write`/`apply_patch` 工具调用，
所以放在 `--deep`（专用 `--workspace`，脚本自建会话）而不是默认只读回归；web 冒烟只覆盖
客户端侧的确定性断言（它不调用模型）。

如需人工复核，仍可按下面的手工步骤走一遍：

1. 新开一个**测试工作区**（或已有工作区的临时子目录），新会话里让模型只做一件事：
   「用 write 工具创建 `rewind-smoke.txt`，内容 hello」；
2. 等回合结束，确认文件存在；点该用户消息的 ↶ → 预览应显示「将还原/移入回收站 1 个文件」；
3. 选「回退对话和文件」→ 确认：文件消失（进插件回收站），composer 回填；
4. 回溯面板 → 救援点 → 恢复：文件内容回来；
5. 修改还原：再让模型用 `write` 覆盖已有文件 → 回溯「对话+文件」→ 内容回到覆盖前；
6. 删除文件：让模型用 `apply_patch` 删除文件 → 回溯「对话+文件」→ 文件按记录重建
   （**默认桌面没有 `apply_patch`**：四个 agent 预设都把它关了，手工也只会在宿主打开 applyPatch 时才走通；
   当前这条由单测覆盖解析分支，真机断言在 `--deep` 里按 SKIP 记）；
7. 制造冲突：再让模型改一次文件后，手工再改同一文件 → 回溯文件模式应拒绝并列出冲突，
   取消后外部内容原样（没有被插件覆盖）；
8. 检查 `~/Library/.../DSH_HOME/session-rewind/audit.jsonl` 有本次记录、trash 里有被移走的文件；
9. **重启持久性（USIM-U3-01）**：见 §2.7。

## 2.7 重启/冷启动后的持久性（USIM-U3-01，本批修复）

宿主重启后「对话仍被截断」由两层共同保证，缺一不可：

1. **宿主 replay（模型上下文）**：marker 写入时带 `surfaceOp: {op:'replace', startSeq, endSeq}` 与
   完整 `sourceEventSeqs`；会话加载时 surface fold 会真正执行这次 replacement。v4 物理格式会把
   `sourceEventSeqs` 压缩成 `[start,end]` 区间（宿主 `decodeSeqRanges` 再展开），**看到嵌套数组不是
   插件写坏**。本批用 u3 模拟实例的两份日志做过实测：展开区间后 `foldSurface()` 得到 replacement
   列表，且 server 事件里被遮蔽的 user/assistant 节点不在 surface 里（模型上下文已截断）。
2. **客户端可见性（transcript）**：宿主对话流**有意**保留原始事件（历史记录不因替换而消失），
   撤回行的隐藏由本插件的 chat builder 包装层负责。它依赖**宿主 cuts**，不能依赖 marker 节点：
   宿主 `input-message` 定义只把 `surfaceOp === 'append'` 的 user/message 变成 chat node，
   replacement marker 不会出现在节点树里。
   本批修复两个冷启动缺口：① builder 可能在「当前会话未知」时创建，旧实现把 null 会话 id 永久
   捕获；现在 rebuild 时动态解析并记住会话 id。② 选会话与宿主 resume 会话并发，第一次 `cuts`
   RPC 可能失败；旧实现一次失败就静默放弃，现在有限次退避重试，并允许打开回溯面板时补种 cuts。

**真机复验步骤**（本分支未运行，由 lead 做）：

1. 在测试会话里做一次「仅对话」回溯，确认目标行消失；
2. **完全退出并重启** DSH 桌面版（不是刷新页面、不是只重载客户端）；
3. 打开同一会话：被撤回的 user message 与 assistant 回复应仍不可见，面板「已撤回」内容一致；
4. 重启后立刻发送一条新消息，确认上下文从截断处继续（没有把被撤回内容带回来）。

单测层面由 `test/client.test.js` 的 `cold-start visibility (USIM-U3-01)` 覆盖：假 builder 重放
「先以 null 会话创建 → 宿主 cuts 到达后 rebuild 隐藏 → 后续流式 apply 仍保持隐藏」，以及
`cuts` RPC 第一次失败后会重试。

## 3. 界面手测 / 边界（发版与 DSH 升级后）

| 场景                                   | 期望                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| 回合运行中（流式输出时）按 `Esc` `Esc` | 仍是内置「停止回合」，不弹回溯框                        |
| 回合运行中点某条消息的 ↶               | 确认后提示「请先停止当前回合（Esc）再回溯」，不修改日志 |
| 输入框已有草稿时回溯                   | 对话照常回溯，输入框内容不被覆盖，toast 说明草稿已保留  |
| 子代理会话                             | 没有 ↶ 按钮；`Esc` `Esc` 不弹框                         |
| 目标消息已被 `/compact` 摘要遮蔽       | 确认后提示「已被压缩摘要遮蔽，无法回溯」                |
| 连续回溯到同一会话更早的位置           | 每次都截断在目标之前；重载后所有区间仍然隐藏            |
| 回溯到会话第一条用户消息               | 对话只剩系统提示，输入框回填第一条消息                  |
| 禁用/卸载插件后打开会话                | 被撤回的行重新显示（日志从未删改）                      |
| 空草稿按 `↑`，随后开始打字             | 召回立刻退出浏览；再按 `↓` 不会覆盖刚打的字             |
| 多行草稿光标在中间行按 `↑`             | 仍是光标上移，不召回（第一行才接管）                    |
| 正在运行回合（草稿在排队）按 `↑`       | 仍可召回，但 `phase !== plain` 时不接管                 |
| `/`、`@` 候选菜单打开时按 `↑` `↓`      | 菜单自己移动选中项，召回不插手                          |
| 回溯之后再按 `↑`                       | 被这次回溯撤下的消息不会出现在召回里                    |

## 4. DSH 升级时要重点看的宿主事实

见 [docs/runtime/0.2.2-rc.1.md §9](../runtime/0.2.2-rc.1.md)：

1. `Session.append` 的 surface `replace` 约束有没有变（`sourceEventSeqs` 完整覆盖被遮蔽节点）；
   同时确认会话加载的 surface fold 仍会应用 `replace`（决定重启后模型上下文是否截断），以及 v4
   物理格式仍把 `sourceEventSeqs` 压缩成 `[start,end]` 区间；
2. Chat 快照 builder 的 `visibility` 语义与 `uiConversation.views`/`definition.create` 是否还在；
   同时确认宿主 chat node 定义仍只把 `surfaceOp === 'append'` 的 user/message 变成节点
   （决定「可见性只能靠宿主 cuts + builder 包装，不能靠 marker 节点」这条实现假设）；
3. `conversation.chat.node` 的键控账本（`entries`/`subscribe`/`component` 可写）是否还在；
   以及 `commandUi.decorate` 的 `ui.kind:"action"`（裸 `/rewind` 靠它打开插件自己的对话框；
   USIM-U2-26 实测宿主 `popupSelect` 在插件这条路径上键盘导航失效，故不再使用）；
4. `ctx.get("conversation").input.shell(id).setDraft`、`shortcuts.observeFixedInput` 的过滤器语义
   （输入历史召回依赖它把**每个 keydown** 都送给观察者，并附带 `context.region` / `gesture.composing`）；
   `data-conversation-session` 这个会话根 DOM 标记也由 `dsh-client-ui-conversation` 提供；
5. Typert Remote 的 SRC 网关仍要求 `method(request)` 且形参不可解构。

## 0.7.0 踩到的跨插件陷阱（2026-11-14）

**`useStore` 的返回形态不一样。** session-delete 的 `useStore(store)` 返回 `[state, setState]` 元组，
而本插件的 `useStore(store)` **直接返回快照值**。做设置分节时照抄 `useStore(store)[0]` 拿到 `undefined`，
渲染时 `prefs.defaultMode` 抛错，宿主的 slot 错误边界只留下一个空的 `data-slot-error` 锚点——
现象是「设置页空白/打不开」，而不是一个像样的异常。抄跨插件的渲染代码前，先确认这层 API 的返回形态。

## 0.7.0 在 0.2.2-rc.5 上的复核记录（2026-11-19，DSH 0.2.2-rc.5）

插件代码没有改动；这一版只验证「升级后仍然成立」。宿主的 client 构建产物（含 `index-*` 哈希名）与会话格式 v4 与 rc.3 逐字节相同（[runtime rc.5](../runtime/0.2.2-rc.5.md) §1.1）。

| 层                                            | 结果                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `node --test`（包内）                         | **208 pass / 0 fail**                                                              |
| `pnpm verify`                                 | 通过                                                                               |
| `pnpm probe:runtime`                          | **72/72 PASS**                                                                     |
| `pnpm smoke:session-rewind`（web）            | **52/52**（临时 DSH home）                                                         |
| `pnpm smoke:session-rewind-desktop --require` | **25/25 PASS**（live rc.5 桌面版，只读；收尾新增打印 `25 PASS / 0 SKIP / 0 FAIL`） |

结论：**rc.5 上 session-rewind 无回归**。


## 0.7.0 在 0.2.2-rc.3 上的复核记录（2026-11-14，DSH 0.2.2-rc.3）

插件代码没有改动；这一版只验证「升级后仍然成立」。

| 层                                            | 结果                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `node --test`（包内）                         | **208 pass / 0 fail**                                                               |
| `pnpm verify`                                 | 通过                                                                                |
| `pnpm probe:runtime`                          | **72/72 PASS**                                                                      |
| `pnpm smoke:session-rewind`（web）            | **52/52**（临时 DSH home：↶ 按钮、Esc Esc、`/rewind`、隐藏/回填/审计/日志只追加）   |
| `pnpm smoke:session-rewind-desktop --require` | **25/25 PASS**（live rc.3 桌面版，只读：候选/确认框、面板页签、设置分节、诊断工具） |

结论：**rc.3 上 session-rewind 无回归**。

## 0.7.0 复核记录（2026-11-14，DSH 0.2.2-rc.2）

| 层                                            | 结果                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `node --test`（包内）                         | **208 pass / 0 fail**（`client.test.js` 90 项，含新增的分节与 store 断言）      |
| `pnpm probe:runtime`                          | **72/72 PASS**                                                                  |
| `pnpm smoke:session-rewind`（web）            | **52/52**（49 → 52：抽屉三页签、设置分节的三条交互）                            |
| `pnpm smoke:session-rewind-desktop --require` | **25/25**，0 FAIL（真实 Electron + 本分支构建；设置分节的三行文案与诊断都读到） |

设置从抽屉第 4 个页签迁到独立分节「设置 → 会话回溯」；抽屉只剩会话级数据（已撤回 / 回溯记录 / 救援点）。
回溯记录与救援点依赖当前会话，**没有**搬进全局设置页。

## 设置保存状态（USIM-U1-10，2026-11-28）

设置分节统一加了「保存状态」行与稳定锚点（[plugin-conventions §7.2.6](../plugin-conventions.md#72-设置页)）。
本节记录**桌面只读断言**（按约定只写不跑；真机证据见下面的 2026-11-28 记录）与单测覆盖位置。

**单测（每次提交都跑）**：`test/settings-save-status.test.js` —— 用迷你 hooks 运行时驱动
`lib/client.js` 里的真实组件，不复制实现。

**桌面只读断言**（不点单选/开关）：

1. 设置 → 会话回溯：`[data-srw-settings]` 存在。
2. `[data-session-rewind-settings-status]` 的 `data-state` 为 `clean`，文本含「已保存」。
3. 该分节没有显式保存按钮（偏好写 localStorage，改即存）。

**真机记录（同上）**：

| 场景               | 结果                             | 截图                                                         |
| ------------------ | -------------------------------- | ------------------------------------------------------------ |
| 无改动             | `data-state=clean`、「· 已保存」 | `/tmp/dsh-sim-rel/shots/settings-session-rewind-clean.png`   |
| 切换默认回退范围后 | `data-state=saved`、「已保存」   | `/tmp/dsh-sim-rel/shots/settings-session-rewind-changed.png` |
