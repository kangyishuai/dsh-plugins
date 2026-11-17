# @kangyishuai/dsh-btw

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
