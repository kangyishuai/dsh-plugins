# @kangyishuai/dsh-btw

## 0.4.0

### Minor Changes

- [#172](https://github.com/kangyishuai/dsh-plugins/pull/172) [`885eae6`](https://github.com/kangyishuai/dsh-plugins/commit/885eae6d709a602dabb639ecd9ddf14abe6d5f41) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 旁问面板改为 **DSH 原生右侧栏 tab**（主对话变窄但不被遮挡，可收起/展开；旧宿主回退到右侧浮层抽屉）；答案**流式输出**并按 **Markdown** 渲染；成本徽章的 token 数与耗时自适应 `K/M/B/T` 与 `ms/s/m/h`；消息顺序改为**旧→新、最新在底部**并展开线程全部轮次；转正草稿保留 Markdown 源码（输入框里是原文，发送后由 DSH 渲染）。

## 0.3.0

### Minor Changes

- [#167](https://github.com/kangyishuai/dsh-plugins/pull/167) [`352c23f`](https://github.com/kangyishuai/dsh-plugins/commit/352c23fbf048e8210affae8552b7a0216cdde977) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 答案渲染与追问体验：
  
  - **代码块与链接**：答案按段渲染（`answerSegments`）——``` 围栏渲染成等宽 `<pre>`（不再把 ``` 显示给用户），URL 变成可点链接（之前是死文本）。刻意**不做**完整 Markdown 渲染（表格/标题/粗体已由 `stripMarkdown` 变成可读标点），避免在无构建的前提下手写渲染器。
  - **追问不再把 `--thread` 暴露在输入框**：浮层点「追问」时先把 `{threadId, question, scope}` 通过 `queueFollowUp` 交给 host 暂存，再提交**裸 `/btw`**；host 处理裸命令时先查队列，取不到才走「重开上一条」。host 未升级时自动回退到旧命令文本（优雅降级）。
  - 新增 `packages/btw/lib/followup-queue.js`（按 session 分槽、一次性取出、TTL 60s）。
  
  **修复**：追问后按钮卡死到 120s 超时 —— 判断「刷新成功」原来只看**线程数增加**，
  而追问是**同线程**（线程数不变），条件永不成立。改为：新问题看线程数、追问看目标线程的 `turns`。
  这也解释了 0.1.x 时期「追问后界面 50 秒无变化」的真实根因（当时误判为轮询窗口不够）。

## 0.2.0

### Minor Changes

- [#163](https://github.com/kangyishuai/dsh-plugins/pull/163) [`539fafa`](https://github.com/kangyishuai/dsh-plugins/commit/539fafa9d7234ca1018eac5e2959b8e066e96201) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 浮层布局与阅读体验：
  
  - **浮层改用 `shell.overlay` 居中弹窗**：原来挂在 `conversation.input.overlay`（在 composer 内部），被容器裁剪 —— 实测提示条跑到浮层外 302px、位置随对话流滚动漂移。换到 frame-wide 的 `shell.overlay` 后不受裁剪，标题栏与底部操作区固定、中间列表滚动。
  - **答案按纯文本显示**：新增 `answerPlain`（`stripMarkdown` 带 `keepCode`），清掉 `**`、`##`、表格竖线等噪音，**代码块内容原样保留**（缩进有意义）。history 里的原文不变。
  - **新建旁问输入框默认收起**：改为标题栏「＋ 新旁问」按钮展开，避免与线程内追问框并存造成混淆。
  - **线程 id 缩短**：`t_mwkfmjk1_qrb3` → `t_mwkjq78hjo`，减少浮层发问时命令文本在输入框里的刺眼程度；并加一行说明「提交时会以 /btw 命令写入对话」。

## 0.1.1

### Patch Changes

- [#160](https://github.com/kangyishuai/dsh-plugins/pull/160) [`de438f5`](https://github.com/kangyishuai/dsh-plugins/commit/de438f52dc9d7a4adf006ca9d1845d3a1057dca1) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修三画像零先验用户实测发现的体验问题：
  
  - **提交后界面不刷新、按钮永久卡死**：轮询窗口（30s）短于实际耗时（32–40s），且轮询链无 `catch` 保护。改为 deadline + `try/finally`，窗口 120s，任何路径都恢复按钮。
  - **提交反馈看不见**：提示原是浮层最后一个子元素，列表一长就被推到滚动区外。改为头部下方的 sticky 状态条，带进度指示「正在等待答案…（通常 20–40 秒）」。
  - **转正草稿是 Markdown 源码**：新增 `stripMarkdown()`（去井号/星号/反引号/代码围栏，表格行转 `a — b`），模板改 `【标题】`，长度上限 4000 → 1200。
  - **长答案撑满浮层**：超 400 字折叠 6 行 + 「展开全文」。
  
  注意：`stripMarkdown` 与长度上限在 host 半，**需重启 DSH** 生效；client 侧改动刷新页面即可。

## 0.1.0

### Minor Changes

- [#145](https://github.com/kangyishuai/dsh-plugins/pull/145) [`11002dc`](https://github.com/kangyishuai/dsh-plugins/commit/11002dca2b83fcb0a65f53cde3693280651ce0cf) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 旁问插件接入 client 半：
  
  - **浮层**（输入框左侧「旁问」按钮）：列出本会话最近的旁问，带成本徽章（新增/命中缓存/耗时）。
  - **浮层内发问**：经 composer façade（`setDraft` → 等落定 → `submit`）提交 `/btw <问题>`；发问必须在命令上下文里执行，因为真实 `Agent` 只能从调用上下文获取。
  - **host 半改为 `TypertRemoteService`**：新增 Remote `history` / `last` / `settings` / `updateSettings`。Remote 方法参数必须是单一标识符，**不能有默认值/解构/剩余参数**（网关 SRC 签名校验）。
  - **设置分节**：只读工具白名单、每会话历史条数；空白名单 = 完全只读，`send_message` 永不放行。
  - 新增 `pnpm smoke:btw-desktop`（CDP 只读回归，支持 `--require`）与冒烟的 cookie 卫生（约定 §6.3）。

- [#152](https://github.com/kangyishuai/dsh-plugins/pull/152) [`06a5856`](https://github.com/kangyishuai/dsh-plugins/commit/06a58563ff5b37b0af16c68fb5ae6cd3529ffb54) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 旁问支持线程与一键转正：
  
  - **多轮追问**：同一旁问可继续追问，线程历史回放给模型（每轮重新 fork，靠上下文重建多轮语义）。浮层里点「追问」提交 `/btw --thread <id> <问题>`。
  - **一键转正**：把旁问整理成四节草稿（我问了什么 / 结论 / 关键细节 / 仍未解决），**只插入输入框、不自动发送**；输入框已有内容时拒绝，避免覆盖用户正在写的东西。
  - **上下文徽章**：浮层底部显示「基于 N 条旁问记录 · 模型可见完整会话，范围只约束回答」——如实说明 fork 继承全部已完成轮次，范围只影响提示词，不裁剪上下文。
  - **范围档位选择器**：不限 / 整个会话 / 最近几轮 / 仅选中片段（封闭枚举），随 `/btw --scope <档位>` 提交；范围只写进提示词当建议，不裁剪上下文。
  - 单线程满 10 轮时提示开新线程（`threadFull`）。
  - 新增 Remote `stats` / `threads` / `promote`；历史记录新增 `threadId` 字段（老记录自动按单条线程归类）。
  - 单测 17 → 27（线程分组、标记解析、草稿模板、截断、空值兜底）。
