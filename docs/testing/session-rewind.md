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
- `resolveSession` / `rewindResponse`：`not-found` / `busy` / `inert` 的优先级、并发重入、
  append 抛错时的 in-flight 清理；
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

1. `pnpm verify`（lint + 类型 + 规范 + 公开边界 + 205 单测）
2. `pnpm probe:runtime`（宿主包/API/slot/私有 seam，50 项）
3. `pnpm smoke:session-rewind`（临时 DSH_HOME 的 web 端到端，49 项）
4. 桌面只读回归（23 项，**永远带 `--require`**：没开调试端口就是失败，不是跳过）
5. 桌面 `--deep` 文件模式 e2e（23 只读 + 16 深链 = 39 项，需 `--workspace`；2026-11-09 实测全绿）

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

临时 home 里启动真实宿主 + ego-browser，49 项断言：

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
| 20    | 回溯面板四页签 + 回溯记录回执                                                                         |
| 21    | 回溯记录以时间线渲染（节点数 === 圆点数）                                                             |
| 22–23 | 候选列表搜索、加载更早（无更多候选时记为通过）                                                        |
| 24–25 | `/rewind` 打开候选、选候选进入确认框                                                                  |
| 26–27 | 设置页偏好持久化与恢复                                                                                |
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

`cd packages/session-rewind && pnpm test` 里包含 47 个文件引擎/追踪单测（临时目录）：

- 捕获与记录：write create/update、edit、apply_patch add/update/delete/move；
- 路径安全：cwd 逃逸、符号链接、`.git`/`node_modules`、非普通文件；
- 限制：单文件 8 MiB 跳过、不可读文件跳过；
- 恢复计划：多 anchor 同一路径取最早 before、冲突（外部修改/缺失/意外出现）、trash 列表；
- 执行：救援点失败不写、写后哈希校验、失败回滚、回收站移动、保留/GC/软上限；
- 工具钩子：`parsePatchPaths`、`commitFromToolResult`、`latestHumanUserSeq`、install 后
  tools/execute + post-execute 的正常/异常路径。

## 2.6 文件模式端到端（桌面版，已自动化）

2026-11-07 已用 CDP（`--remote-debugging-port=9222`，仅绑定 127.0.0.1，验证后关闭）在桌面版
自动跑通：冲突时文件模式置灰并列出冲突、创建文件后回退进回收站、修改文件后回退还原内容、
救援点恢复、面板/审计/诊断。脚本思路：`/json/list` 取 renderer → `Runtime.evaluate` 点按钮/
填 composer → `Page.captureScreenshot` 留证；工作区用临时目录，prompt 只让 agent 写一个测试文件。

桌面版（Electron）一键回归，**只读**：只切会话、开关对话框与面板、点取消；不回溯、不写文件、
不发模型请求，可以直接跑在真实 profile 上。

```bash
# 1) 带调试端口重启桌面版（验证完正常重启一次即可关闭端口）
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 2) 跑
pnpm smoke:session-rewind-desktop
```

桌面只读回归实测 **23 项**（2026-11-09，DSH 0.2.2-rc.1 / Electron 44）。

加 `--recall` 会在同一个 Electron 渲染进程里额外验证**输入框 ↑/↓ 历史召回**（7 条断言，合计 30 项）：
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
pnpm smoke:session-rewind-desktop -- --require                       # 发版前必须 PASS（只读 23 项）
pnpm smoke:session-rewind-desktop -- --require --deep \
  --workspace ~/Workspace/dsh-rewind-ui-smoke                        # 加上文件模式 e2e（23 + 16 = 39 项）
pnpm smoke:session-rewind-desktop -- --require --recall --deep \
  --workspace ~/Workspace/dsh-rewind-ui-smoke                        # 全量组合（23 + 7 + 16 = 46 项）
```

**`--deep`：文件模式端到端（真机、真模型）。** 它**自己**会在给定测试工作区点「新建会话」
（2026-11-09 起 H 段显式做这件事并断言会话为空），不再依赖调用者先手工开好会话；它会：新建会话 → 发一次模型
请求让 agent 用 `write` 创建 `rewind-desktop-smoke.txt` → 点该消息 ↶ → 确认「对话+文件」→ 断言
文件进回收站、toast 与输入框回填 → 面板「救援点」恢复 → 断言文件内容回到工作区 → 断言时间线
出现 `rescue-restore` 节点。

安全闸：**必须**用 `--workspace` 显式给一个已存在、且不在本仓库内的目录，否则该项 FAIL 并跳过
后续步骤。它只读写该目录里的那一个测试文件名，但会消耗一次模型额度，并在侧栏留下一个测试会话
（需要时手动删掉）。

23 项只读断言（2026-11-09 实测输出，顺序即脚本顺序）：

| #   | 断言                                                            |
| --- | --------------------------------------------------------------- |
| 1   | 连上桌面 UI（CDP `/json/list` 有 page target）                  |
| 2   | 插件 client 半已加载（`style[data-plugin]` 注入）               |
| 3   | 会话头部有回溯面板入口                                          |
| 4   | 当前会话渲染正常（用户行与 ↶ 按钮数量自洽）                     |
| 5   | 侧栏工作区限定状态（未加 `--sidebar-workspace` 时给出提示）     |
| 6   | 找到一个候选可达（≥1 条）的空闲会话用于 Esc 流程（没有则 FAIL） |
| 7   | 每条用户消息旁都有 ↶ 按钮                                       |
| 8   | `Esc` `Esc` 打开候选列表                                        |
| 9   | 候选列表可搜索                                                  |
| 10  | 候选搜索过滤生效                                                |
| 11  | 选择候选后进入确认框                                            |
| 12  | 确认框写明影响面与预览                                          |
| 13  | 确认框有「仅对话 / 对话+文件」两个范围                          |
| 14  | 确认框有「回退后立即重发」且默认不勾选                          |
| 15  | 确认框取消后退回候选列表（不执行回退）                          |
| 16  | 再取消后对话框关闭且未回溯                                      |
| 17  | 回溯面板打开且四页签齐全                                        |
| 18  | 回溯记录渲染为时间线（节点数 === 圆点数）                       |
| 19  | 救援点页签可渲染                                                |
| 20  | 设置页诊断可加载                                                |
| 21  | 诊断报告只读工具已注册                                          |
| 22  | 诊断报告孤儿数据检查存在                                        |
| 23  | 面板可关闭                                                      |

门禁建议直接跑**全量组合** `--recall --deep`（46 项，2026-11-09 实测全绿）：召回段会切会话、`--deep`
段自己新建会话，互不干扰；召回段结束会把草稿清空，`--deep` 的输入才不会被旧草稿污染。

`--recall` 追加的 7 项（合计 30 项）：找到可召回的会话 → 输入框已聚焦且草稿为空 → 空草稿按 `↑`
召回最新一条 → 召回的文本确实来自会话里的某条用户消息 → 再按 `↑` 换一条（只有 1 条历史时
退化断言为「停在最旧一条、不环绕」）→ `↓` `↓` 回到 live line 且草稿为空 → 全程对话行数不变、
不弹回溯框。

截图写到 `/tmp/dsh-session-rewind-desktop-shots/`（含真实会话内容，不要提交）。

两条踩过的坑：

1. **不能在「正在运行本 agent 的会话」里按 `Esc` `Esc`**——那会触发内置停止、取消正在跑的
   这一轮（脚本自己的工具调用会被 abort）。脚本先切到有消息的空闲会话，最后切回原会话。
2. 侧栏里可能有没有消息的会话，切过去候选为空；脚本只挑**有用户消息**的会话。

**桌面端跑不了「写文件 e2e」**：文件模式需要真实 `write` 工具调用（要花模型额度并改真实工作区），
所以那条放在 web 组合的冒烟里（临时 `DSH_HOME` + 临时工作区），桌面端只做只读回归。

如需人工复核，仍可按下面的手工步骤走一遍：

1. 新开一个**测试工作区**（或已有工作区的临时子目录），新会话里让模型只做一件事：
   「用 write 工具创建 `rewind-smoke.txt`，内容 hello」；
2. 等回合结束，确认文件存在；点该用户消息的 ↶ → 预览应显示「将还原/移入回收站 1 个文件」；
3. 选「回退对话和文件」→ 确认：文件消失（进插件回收站），composer 回填；
4. 回溯面板 → 救援点 → 恢复：文件内容回来；
5. 制造冲突：再让模型改一次文件后，手工再改同一文件 → 回溯文件模式应拒绝并列出冲突；
6. 检查 `~/Library/.../DSH_HOME/session-rewind/audit.jsonl` 有本次记录、trash 里有被移走的文件。

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
2. Chat 快照 builder 的 `visibility` 语义与 `uiConversation.views`/`definition.create` 是否还在；
3. `conversation.chat.node` 的键控账本（`entries`/`subscribe`/`component` 可写）是否还在；
4. `ctx.get("conversation").input.shell(id).setDraft`、`shortcuts.observeFixedInput` 的过滤器语义
   （输入历史召回依赖它把**每个 keydown** 都送给观察者，并附带 `context.region` / `gesture.composing`）；
   `data-conversation-session` 这个会话根 DOM 标记也由 `dsh-client-ui-conversation` 提供；
5. Typert Remote 的 SRC 网关仍要求 `method(request)` 且形参不可解构。
