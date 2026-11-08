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
- 客户端纯函数：`DoubleEscape` 双击窗口、`cutOfMarkerNode`/`collectCuts`、`errorTextKey`。

## 1.5 一条命令跑完门禁（发版前）

```bash
pnpm gate session-rewind --deep --workspace ~/Workspace/dsh-rewind-ui-smoke
# 等价写法：pnpm gate:session-rewind -- --deep --workspace ...
```

按「便宜的先跑」排序，任何一步失败立刻停并给出下一步提示：

1. `pnpm verify`（lint + 类型 + 规范 + 公开边界 + 185 单测）
2. `pnpm probe:runtime`（宿主包/API/slot/私有 seam，43 项）
3. `pnpm smoke:session-rewind`（临时 DSH_HOME 的 web 端到端，34 项）
4. 桌面只读回归（21 项，**永远带 `--require`**：没开调试端口就是失败，不是跳过）
5. 桌面 `--deep` 文件模式 e2e（36 项，需 `--workspace`）

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

临时 home 里启动真实宿主 + ego-browser，38 项断言：

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

**发版门禁要加 `--require`**：连不上端口时默认是 SKIP（exit 0，适合日常随手跑），加
`--require` 则判为 FAIL（exit 1）——避免「没跑也说通过」。

```bash
pnpm smoke:session-rewind-desktop -- --require                       # 发版前必须 PASS（只读 21 项）
pnpm smoke:session-rewind-desktop -- --require --deep \
  --workspace ~/Workspace/dsh-rewind-ui-smoke                        # 加上文件模式 e2e（共 33 项）
```

**`--deep`：文件模式端到端（真机、真模型）。** 它会：在给定测试工作区**新建会话** → 发一次模型
请求让 agent 用 `write` 创建 `rewind-desktop-smoke.txt` → 点该消息 ↶ → 确认「对话+文件」→ 断言
文件进回收站、toast 与输入框回填 → 面板「救援点」恢复 → 断言文件内容回到工作区 → 断言时间线
出现 `rescue-restore` 节点。

安全闸：**必须**用 `--workspace` 显式给一个已存在、且不在本仓库内的目录，否则该项 FAIL 并跳过
后续步骤。它只读写该目录里的那一个测试文件名，但会消耗一次模型额度，并在侧栏留下一个测试会话
（需要时手动删掉）。

21 项只读断言：

| #     | 断言                                                               |
| ----- | ------------------------------------------------------------------ |
| 1–4   | 连上桌面 UI、插件样式注入、面板入口、当前会话 ↶ 按钮               |
| 5     | 找到一个「有消息的空闲会话」用于 Esc 流程（侧栏没别的会话则 FAIL） |
| 6–8   | Esc Esc 打开候选、搜索框存在、搜索过滤生效                         |
| 9–10  | 选候选进入确认框，写明影响面与预览                                 |
| 11    | 确认框有「仅对话 / 对话+文件」两个范围                             |
| 12    | 确认框有「回退后立即重发」且默认不勾选                             |
| 13    | 点取消关闭对话框，且没有执行回溯                                   |
| 14    | 回溯面板四页签齐全                                                 |
| 15    | 回溯记录渲染为时间线（节点数 === 圆点数）                          |
| 16    | 救援点页签可渲染                                                   |
| 17–19 | 设置页诊断可加载、只读工具已注册、孤儿数据检查存在                 |
| 20    | 面板可关闭；最后切回原会话                                         |

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

## 4. DSH 升级时要重点看的宿主事实

见 [docs/runtime/0.2.2-rc.1.md §9](../runtime/0.2.2-rc.1.md)：

1. `Session.append` 的 surface `replace` 约束有没有变（`sourceEventSeqs` 完整覆盖被遮蔽节点）；
2. Chat 快照 builder 的 `visibility` 语义与 `uiConversation.views`/`definition.create` 是否还在；
3. `conversation.chat.node` 的键控账本（`entries`/`subscribe`/`component` 可写）是否还在；
4. `ctx.get("conversation").input.shell(id).setDraft`、`shortcuts.observeFixedInput` 的过滤器语义；
5. Typert Remote 的 SRC 网关仍要求 `method(request)` 且形参不可解构。
