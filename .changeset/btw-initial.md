---
"@kangyishuai/dsh-btw": minor
---

旁问插件接入 client 半：

- **浮层**（输入框左侧「旁问」按钮）：列出本会话最近的旁问，带成本徽章（新增/命中缓存/耗时）。
- **浮层内发问**：经 composer façade（`setDraft` → 等落定 → `submit`）提交 `/btw <问题>`；发问必须在命令上下文里执行，因为真实 `Agent` 只能从调用上下文获取。
- **host 半改为 `TypertRemoteService`**：新增 Remote `history` / `last` / `settings` / `updateSettings`。Remote 方法参数必须是单一标识符，**不能有默认值/解构/剩余参数**（网关 SRC 签名校验）。
- **设置分节**：只读工具白名单、每会话历史条数；空白名单 = 完全只读，`send_message` 永不放行。
- 新增 `pnpm smoke:btw-desktop`（CDP 只读回归，支持 `--require`）与冒烟的 cookie 卫生（约定 §6.3）。
