# @kangyishuai/dsh-btw

## 0.6.4

### Patch Changes

- [#375](https://github.com/kangyishuai/dsh-plugins/pull/375) [`a8b7b2f`](https://github.com/kangyishuai/dsh-plugins/commit/a8b7b2fcb717b8f41ab7e237398e003f0267d49a) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 复审 follow-up（2026-11-28 `batch-ui-2` B1/B2/B4）：
  
  - **回退抽屉真正可达**：新增显式 `drawerFallback` 状态。右侧栏服务在、但 `openTab` 抛错或打开后 700 ms 仍没有 `[data-btw-panel]` 时，浮层抽屉现在真的会渲染（以前 `BtwDrawer` 在 `tabReady` 时直接返回 null，降级分支是死代码，用户只看到一条 toast）；再次成功 `openTab` 会清掉标记并收起抽屉，避免 tab 与抽屉同时在场。抽屉渲染判定抽成纯函数并用 `__test` 钩子驱动真实 `apply()` 的行为测试覆盖三条路径。
  - **IME 判据补齐**：`shouldSubmitOnKey` 增加 `nativeEvent.isComposing`、`which === 229`、`key === "Process"` 与 composition ref 四条判据（对齐 projects 的 `isImeConfirmKey`），两个输入框都接 `onCompositionStart/End`；React 合成事件不暴露 `isComposing` 时不再误发送。
  - 双语 README 写清面板降级形态；`docs/testing/btw.md` 的单测计数改真（notice 6、client 10、总数 118，冒烟默认段 +3 / `--deep` +2 / 改写 1 条）。

- [#357](https://github.com/kangyishuai/dsh-plugins/pull/357) [`e7fcfee`](https://github.com/kangyishuai/dsh-plugins/commit/e7fcfee15769972c01686baf8b8325191cca2e19) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修复审计（2026-11-28）里的 btw 问题：设置页的「每会话保留条数」（`historyLimit`，1–200）之前可改可存但服务端全部硬编码 50，现在每条历史读写路径都按它生效（降低上限后旧记录立即不再展示，并在下一次旁问落盘时裁掉）；只读 guard 改为**只**挂在旁问子代理自己的作用域上，删掉会落到宿主全局层、在旁问运行期间拒绝所有会话工具调用的插件 ctx 兜底（取不到子会话 ctx 时降级为「不挂 + warn」，只读只剩提示词约束）；同一会话并发的旁问历史写入改为按文件串行化，不再互相覆盖丢记录；bounded 模式只在真正命中阈值时才读父会话事件（不再每次旁问都无条件物化整段事件数组），digest 为空退回 full fork 时写 warn 不再静默；`observeUsage` 与追问队列按最近使用加界并在旁问结束时清理子会话条目；设置分节 `order` 改为 95，避免与 projects/casefile 同序抢占；README 补上卸载残留说明与 guard 作用域的真实表述。

- [#370](https://github.com/kangyishuai/dsh-plugins/pull/370) [`a27c3ff`](https://github.com/kangyishuai/dsh-plugins/commit/a27c3ff38af608893848321c3dbde273af7366b1) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 旁问 UX 修复（2026-11-28 用户模拟 USIM-U2-06 / U2-13 / U2-18）：空白/首启会话里 `/btw` 回车后不再「什么都没发生」——host 半记一条**内存回执**（`btw/notice`，不落盘、不触发模型调用），client 半轮询后画顶部 toast（已提交 → 完成带耗时与答案预览 / 失败带原因，点击可打开面板；面板已在显示答案时提示直接收起），空白会话里还会自动打开右侧栏「旁问」tab（右栏没渲染时回退浮层抽屉）。
  
  面板里两个输入框统一为 **Enter 发送、Shift+Enter 换行**（输入法组字中不发送）并给出提示，线程内发送按钮由「追问」改为「发送」，不再和线程头的「追问 / 取消追问」开关重名；live 卡片存在时状态条也不再吞掉失败提示。
  
  「转正」草稿去重：末答只作为「结论」出现一次，关键细节只保留追问的问题与和结论不同的较早答案；面板首次打开的空态改为解释「旁问是只读、不打断、不进历史」。顺带补齐 client 英文字典缺失的 `settings.bounded*` 两个键。

## 0.6.3

### Patch Changes

- [#245](https://github.com/kangyishuai/dsh-plugins/pull/245) [`60a97a9`](https://github.com/kangyishuai/dsh-plugins/commit/60a97a999c100231428d7bac34d58ef7bad70cfe) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 新增**可选**的 bounded-context 模式（ADR-0022，默认关）：会话上下文超过 400K tokens 时，`/btw`
  可以改用 `spawn` 子代理，只带最近 12 条 user/assistant 消息（单条 ≤700 字、总 ≤4000 字）+ 问题，
  把单次成本封顶；答案 meta 与面板标记 `bounded`，此时不再追加 fork 成本警告。
  
  - 设置分节「更多设置」新增复选框 `boundedContext`（默认 false）；开启后仅在 `contextPressure ≥ 400K`
    时生效，其余情况仍是 full fork。
  - digest 过滤 system-reminder、工具调用/结果、非 user 来源；digest 为空时安全回退 full fork；
    线程追问的历史 Q/A 也会带进 prompt。
  - spawn 不继承父会话、不复用父会话前缀缓存；因此默认关闭，属于用户显式取舍。
  - 新增 5 条 `lib/bounded.js` 纯逻辑单测 + settings 断言（单测 70 → 75）。
  - 临时宿主真实大会话 e2e：父 668K，bounded 单次 `cost.totalTokens=21,503`（同会话 fork 为 762,526），
    命令结果含 `· bounded`。

## 0.6.2

### Patch Changes

- [#240](https://github.com/kangyishuai/dsh-plugins/pull/240) [`b7d4544`](https://github.com/kangyishuai/dsh-plugins/commit/b7d45449da1dbb0f6004bb86edc5b9f9c80b0250) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 在超大上下文会话里给出**旁问成本量级提示**（Phase 1，只提示不阻断）：
  
  - 父会话 `contextPressure` ≥ **250K tokens** 时，面板顶部显示一行警告（预计为上下文的 0.75–1.2 倍），
    并在 `/btw` 结果末尾追加同一句提示；不发请求、不拦截。
  - 同时展示本会话**上一次旁问的真实 prompt 总量**（`inputTokens + cacheReadTokens`）方便对账。
  - 依据 2026-11-20 的临时 `DSH_HOME` 探针（真实会话 + 一次真实 fork 对账）：fork 子代理 prompt 约为
    父会话 contextPressure 的 **0.75–1.2 倍**，空会话固定开销 ~114K，所以只给区间、不假装精确账单。
  - 新增 5 条纯逻辑单测（`lib/cost-hint.js`），单测 65 → 70；默认 web 冒烟计数不变（提示只在大会话出现）。

## 0.6.1

### Patch Changes

- [#236](https://github.com/kangyishuai/dsh-plugins/pull/236) [`7e1f1f3`](https://github.com/kangyishuai/dsh-plugins/commit/7e1f1f3fe4454f1a9d573b8426c88f244e9dfd86) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修复转正把主 composer 撑高、以及 `/btw` 命令结果走英文 FALLBACK：
  
  - 转正草稿按当前输入框实际宽度收进 6 行：短线程保留四节 Markdown 源码，长线程改成「首问 + 结论开头」摘要并在末尾指回「旁问」面板（完整答案仍在面板里）。0.6.0 的长线程会插入 1262 字草稿，在窄输入框里渲染约 62 行、把可视对话区从 528px 压到 316px。
  - host 半把语义分层的 `locale/*.json` 摊平映射回平面键，并在注册 `/btw` 前同步加载 locale；命令描述与结果文案不再落到英文 FALLBACK（DSH 宿主没有 host 侧 locale 服务，命令文案逐字透传，见 `docs/runtime/0.2.2-rc.5.md` §8.1）。
  - 桌面回归 `--deep` 新增「转正后主 composer 不超过 6 行」断言；单测 59 → 65。

## 0.6.0

### Minor Changes

- [#179](https://github.com/kangyishuai/dsh-plugins/pull/179) [`5970b35`](https://github.com/kangyishuai/dsh-plugins/commit/5970b354edff528139b3d195c04321a6c4fe5853) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 第二轮可用性修复：转正草稿把每轮追问的 Q/A 写进「关键细节」（避免首问标题 + 末答结论语义错位）；长答案支持「收起」并保持阅读位置；面板底部新增「只在旁问面板显示答案」开关（等同 `echoAnswer`，零先验用户不用进设置）；`Esc` 在焦点位于主输入框时也关闭面板（设置对话框拥有焦点时不抢）；底部提示合并为一行，减少信息密度。

## 0.5.0

### Minor Changes

- [#177](https://github.com/kangyishuai/dsh-plugins/pull/177) [`9f2f22c`](https://github.com/kangyishuai/dsh-plugins/commit/9f2f22c9bd9e8ed11eab15f1318fe38c787e02cf) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 按三画像桌面可用性测试修复：徽章记录数在提交后立即刷新；展开全文保持滚动位置；追问输入打开时隐藏重复的「新旁问」输入并把按钮改为「追问 / 取消追问」；线程级转正用首问 + 最后一轮答案；新增「主对话是否回显完整答案」设置（`echoAnswer`，默认开）；`Esc` 关闭面板、面板可见时自动聚焦、header 显示「N 个线程」、流式推理阶段显示「思考中」。

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
