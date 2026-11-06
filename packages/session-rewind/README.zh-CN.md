# @kangyishuai/dsh-session-rewind

> DeepSeek Harness 的「就地回溯」：把会话退回到任意一条用户消息之前，目标消息及其后的内容同时从模型上下文和渲染对话中撤回，消息文本回填输入框。

[![npm](https://img.shields.io/npm/v/@kangyishuai/dsh-session-rewind?color=cb3837&logo=npm)](https://www.npmjs.com/package/@kangyishuai/dsh-session-rewind) [![DSH](https://img.shields.io/badge/verified%20on%20DSH-0.2.2--rc.1-4b6bfb)](#兼容性) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md)

非官方插件，与 DeepSeek 无关。面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)。

> **状态：早期。** 已在 DSH 0.2.2-rc.1 上用 `pnpm smoke:session-rewind` 验证（一次性 DSH 目录里 17 项端到端断言：两条入口、对话截断、输入框回填、重载后仍隐藏、日志只追加）。桌面版 Electron 的原生键盘路径没有单独回归。插件还年轻，重要数据请自行备份。

## 它做什么

长对话会跑偏。几轮之后你希望当初换个问法，但新开一个会话会丢掉之前的全部上下文，继续聊又会让不想要的几轮永远占着上下文窗口。这个插件做**就地回溯**：

- **两个入口**：连按两次 `Esc` 打开回溯对话框选一条用户消息；或点任意用户消息操作行里、复制按钮旁边的 ↶ 按钮。
- **撤回目标消息及其后的全部内容**：模型可见上下文和渲染出来的对话都回到那条消息之前的样子。
- **回填输入框**：目标消息的文本自动放回输入框，改完直接重发。
- **同一个会话，不建分支**：会话 id、标题、工作区以及目标之前的全部历史都不变。不新建会话、不切窗口、不残留副本。
- **追加式安全**：历史从不删除、从不改写，插件只往日志末尾追加一条标记。被撤回的内容仍完整留在会话里（可在「轨迹」查看）；停用插件后界面会重新显示它们。

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-session-rewind
```

如果要用工作区里的代码而不是发布版，先打包再装——`link:` 装法不行（宿主的 `@deepseek-ai/*` 解析只覆盖真实路径位于 profile 内的包）：

```bash
cd packages/session-rewind
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-session-rewind-*.tgz
```

改完代码要重新 `pnpm pack` + `add`。插件带宿主半，装完重启 DSH 桌面版并刷新页面。

## 用法

**键盘 — `Esc` `Esc`。** 在空闲会话里快速连按两次 Escape。回溯对话框按时间倒序列出这个会话的用户消息，用 ↑/↓ 选择、Enter 或点击确认，对话立刻回溯。回合运行中时，`Esc` `Esc` 保持原生含义（停止回合）；停下之后再按两次即可打开回溯对话框。

**消息操作 — ↶。** 每条用户消息的操作行（复制按钮旁）都有一个 ↶ 按钮。悬浮提示「回退到此处」；点击后弹出确认框，写明将撤回什么，确认即回溯。

**回溯之后**，目标消息的文本会被放进输入框并获得焦点。如果输入框里本来就有草稿，不会被覆盖——回溯照常执行，并提示草稿已保留。

**会被拒绝的情况**

| 情况                         | 表现                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| 会话有正在运行的回合         | 宿主返回 `session-rewind/busy`；先停止回合（运行中按 `Esc` `Esc`）再回溯。 |
| 子代理会话                   | 没有 ↶ 按钮，`Esc` `Esc` 也不弹框：宿主拒绝对这类会话的通用 RPC。          |
| 目标消息已被 compaction 遮蔽 | 拒绝；回溯边界必须仍在模型上下文里。                                       |
| 同一会话已有回溯在执行       | 拒绝；一次只允许一个。                                                     |

## 原理

DSH 把会话保存为只追加的事件日志，模型可见历史从一条有序的 _surface_ 推导出来。消息类事件会声明自己如何进入 surface；`replace` 操作可以把一段已存在的 surface 节点整体换掉——`/compact` 正是用它把历史换成摘要。

回溯向当前会话追加一条 `user/message` 标记，`surfaceOp` 用 `replace` 覆盖目标消息及其后的所有 surface 节点。模型于是只看得到目标之前的部分。标记内容是固定文本 `(empty message)`（避免严格 OpenAI 兼容网关拒绝空 user content），身份放在它自己的 `source: { kind: "session-rewind", targetSeq }` 里。

浏览器端包装已注册的 Chat view builder，在节点送入 builder 之前把 `[targetSeq, markerSeq]` 区间里的节点标成 `visibility: "hidden"`。隐藏的节点会离开对话流、Turn 导航和分组，但仍留在节点 store 里——输入框正是靠它读回被撤回的文本。↶ 按钮则是接管 `conversation.chat.node` 槽位的 user 渲染器，往官方 actions 行里多塞一个子节点。

这两处都是客户端的私有 seam，不是公开 API。安装时做形状检查；未来 DSH 改动它们时，插件会降级成「上下文已回溯、界面不隐藏」或「按钮消失」，而不是让会话出错。

## 副作用与风险

- **每次回溯追加一条事件。** 一条 `user/message` 标记（文本 `(empty message)`，source 为 `session-rewind`）进入当前会话日志。不删除、不改写任何内容，也不碰其他文件。
- **标记对模型可见**：在原本被撤回的回合位置，模型会看到一条很短的 user 消息。模型会忽略它；界面不显示它。
- **不还原工作区文件。** 这个插件只回溯对话。被撤回回合改过的文件保持现状；文件请交给 git 或快照类插件。
- **没有原地撤销。** 回溯是追加式的，所以没有「重做」：内容仍在日志里（轨迹可看），停用插件会让这些行重新显示。
- **超出模型上下文的目标会被拒绝**（例如已被 compaction 遮蔽），并给出原因。
- **输入框只回填文本。** 如果被撤回的消息带图片或附件，本版本不会把它们放回输入框，只回填文本。
- **不联网、不上报。** 宿主半只往当前会话追加事件；浏览器半通过本地 `/api` 通道访问它。

## 兼容性

| DSH 版本   | 状态                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| 0.2.2-rc.1 | 已验证：`pnpm smoke:session-rewind` 17/17（临时 DSH 目录）；桌面版 Electron 未单独回归 |

插件不声明 `engines.dsh`，也不声明 `@deepseek-ai/*` 的 peer 范围：DSH 还在预发布阶段，预发布版本的 semver 范围不可靠（见 [ADR 0005](../../docs/adr/0005-dsh-version-compatibility.md)）。以这张表为准。DSH 升级改动 Chat builder 或槽位账本时，插件会落到上面的降级形态；升级后请跑一遍冒烟。

## 开发

```bash
pnpm test           # 单元测试（宿主纯模块 + 客户端 helper）
pnpm verify         # 仓库统一门禁
pnpm smoke:session-rewind   # 临时 DSH 目录 + 真实 GUI 端到端（需要 dsh 与 ego-browser）
```

设计记录：[ADR 0006](../../docs/adr/0006-session-rewind-architecture.md)。

## License

MIT
