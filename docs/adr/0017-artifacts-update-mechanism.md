# 0017. artifacts 的更新机制：时间线摘要行 + 右栏面板 + 元数据封面

- 状态：已接受
- 日期：2026-11-16
- 涉及：artifacts

## 背景

Claude Code 的 artifact 体验依赖三件宿主能力：改写已渲染的工具行、服务端套壳 + 独立沙箱 origin、服务端截图缩略图。DSH 0.2.2-rc.3 三件都不成立：

- `conversationEvents` 服务不存在；`conversation.chat.node` 的 keyDomain 是封闭的 `ChatNodeKind`；`card` 是封闭 union（generic/terminal/diff/search/read/web）；`presentationMeta` 每次调用复制全文 ⇒ **改写旧工具行不可行**。
- 宿主没有兜底 CSP，也没有独立沙箱 origin ⇒ 隔离只能靠 `sandbox="allow-scripts"`（不透明源）+ 文档内 CSP 自焊。
- 宿主不带 headless Chromium，`ctx.officeKit` 只吃 Office/ODF/PDF ⇒ **截图式缩略图没有本地等价物**。

spike 实测（`notes/artifacts/spike-report.md`）验证了替代路径可行。

## 可选方案

1. **社区 `dsh-html-artifact` 的路线**：自定义 chat node + `card:'artifact'` 铸型 + 行内 patch 预览。
   - 优点：预览就在工具行里。
   - 缺点：在 rc.3 会**激活失败**（服务不存在、keyDomain 封闭）；即便能跑，`presentationMeta` 复制全文也把大 HTML 灌进会话日志。
2. **时间线只放摘要 + 右栏面板承载预览**：`tool.call.toolview` keyed 行渲染 id/最新版本/按钮；面板轮询 Remote `latest`，只换同一 iframe 的 `srcDoc`。
   - 优点：实测 `mounts=1`、`frames=1`，不重建；日志里只有一行摘要；面板可独立于时间线演进。
   - 缺点：预览不在行内；需要一次 1s 轮询。
3. **摘要行 + 全页 viewer（`main` slot）**。
   - 优点：空间大。
   - 缺点：打断会话上下文；右栏更贴近"边聊边看"。

## 决定

选 **方案 2**；缩略图用**元数据合成 SVG 封面**（`lib/cover.js`，320×200、≤4 KiB、按 id 稳定取色板、`<h1>/<title>` 作副标题），而不是引入 headless。

版本语义：每次 `append` = 一个版本文件；面板永远读 latest，所以**旧行与最新行都指向最新版**；行只认领 artifact id。

## 影响

- 工具行必须自己注册 `tool.call.toolview`（keyed by wire name），不能用 `card` 铸型。
- 面板需要一条"版本未变只回版本号"的轻量 RPC（`latest({since})`），否则 1s 轮询会重复传正文。
- 封面不反映页面内容；真实截图作为 v0.2 的可选项（页面自渲染 canvas → postMessage），且必须能关。
- 恢复的页签没有 `navigation.params`：客户端用 `localStorage` 记住最近 id 回退，否则退化为库视图。
- 若宿主将来提供 push 通道（Typert forwardable event），把轮询换掉即可，数据模型不变。
