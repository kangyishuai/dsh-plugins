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

## 2. 端到端 GUI 冒烟（每次提交，改客户端后必跑）

```bash
pnpm smoke:session-rewind
```

临时 home 里启动真实宿主 + ego-browser，31 项断言：

| #    | 断言                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 1    | 找到 ≥2 条用户消息的会话，且出现 ↶ 按钮                                                               |
| 2    | 点 ↶ 打开确认框，确认框写明「从对话中移除此消息及其后的所有内容」                                     |
| 3    | 确认后目标行及其后消失（只剩目标之前的消息）                                                          |
| 4    | 输入框回填目标消息文本，toast 提示成功                                                                |
| 5    | 占位 marker 行没有出现在对话里                                                                        |
| 6–7  | 空闲会话 `Esc` `Esc` 打开候选对话框并列出候选（宿主全量日志）                                         |
| 8–11 | 选候选 → 确认 → 再次截断 + 回填                                                                       |
| 12   | 页面重载后被撤回的行仍隐藏（cuts 兜底）                                                               |
| 13   | 切走会话再切回后仍隐藏                                                                                |
| 14   | 直接解压会话日志：原始用户消息一条没少（只追加）                                                      |
| 15   | 每次回溯多一条 `session-rewind` marker                                                                |
| 16   | marker 形状：`surfaceOp.op === "replace"`、`sourceEventSeqs` 覆盖被遮蔽节点、`targetSeq === startSeq` |
| 17   | marker 内容是非空占位文本                                                                             |

失败时会打印断言明细并把截图留在 `/tmp/dsh-smoke-rewind-shots/`（截图含临时 home 里的真实
会话内容，不要提交）。`SMOKE_DEBUG=1` 可看浏览器脚本完整输出。

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

一键回归（只读、不写文件、不发模型请求）：

```bash
# 先带调试端口重启桌面版
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
pnpm smoke:session-rewind-desktop
```

脚本检查：插件 client 半加载、↶ 按钮与面板入口、Esc Esc 候选列表、搜索过滤、四页签、
设置页诊断；截图写到 `/tmp/dsh-session-rewind-desktop-shots/`。

注意：**不能在「正在运行本 agent 的会话」里按 Esc Esc**——那会触发内置停止、取消正在跑的
这一轮。脚本会先切到一个有消息的空闲会话再测 Esc，最后切回原会话。

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
