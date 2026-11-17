---
"@kangyishuai/dsh-btw": minor
---

浮层布局与阅读体验：

- **浮层改用 `shell.overlay` 居中弹窗**：原来挂在 `conversation.input.overlay`（在 composer 内部），被容器裁剪 —— 实测提示条跑到浮层外 302px、位置随对话流滚动漂移。换到 frame-wide 的 `shell.overlay` 后不受裁剪，标题栏与底部操作区固定、中间列表滚动。
- **答案按纯文本显示**：新增 `answerPlain`（`stripMarkdown` 带 `keepCode`），清掉 `**`、`##`、表格竖线等噪音，**代码块内容原样保留**（缩进有意义）。history 里的原文不变。
- **新建旁问输入框默认收起**：改为标题栏「＋ 新旁问」按钮展开，避免与线程内追问框并存造成混淆。
- **线程 id 缩短**：`t_mwkfmjk1_qrb3` → `t_mwkjq78hjo`，减少浮层发问时命令文本在输入框里的刺眼程度；并加一行说明「提交时会以 /btw 命令写入对话」。
