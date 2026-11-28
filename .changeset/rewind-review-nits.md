---
"@kangyishuai/dsh-session-rewind": patch
---

复审 p3-nits 收口（N1/N2/N3 有用户可见行为变化；N4 只收紧测试）。

- **N1 回溯记录里的文件动作行**：`trash-restore` / `trash-clear` 这类 file-mode 审计行以前按 `mode`
  归一化成对话，时间线显示「对话 · 撤回 0 条上下文记录 · 约 0 token」。现在按动作显示徽章
  （「回收站恢复」/「清空回收站」）与文件口径 meta（「从回收站恢复 {restored} 个文件」/
  「永久删除 {cleared} 个文件 · {bytes}」）；清空行不再渲染恒 0 的「文件：还原 0、回收站 0…」四态行，
  改为可展开的顶层路径列表（新行已有 `files.cleared` / `bytes` / `paths` 字段）。普通对话行与
  救援点行不变。
- **N2 启动 GC 的诊断**：任一会话 entries 读不出来时本次 GC 仍 fail-closed（一个 blob 都不删），
  warn 现在列出出问题的会话 id（原来只报数量），并补单测；README 中英补「修复前 blob 保留」的运维含义。
- **N3 从救援点恢复的部分失败**：与回收站恢复同款——服务端部分失败时从 `error.details.files` 取
  restored/failed，显示「已恢复 N 个文件，M 个失败」并刷新救援点与审计列表，不再用通用错误盖掉
  已恢复数量；通用失败（如 `rescue-not-found`）仍按错误码提示并保留确认行。
- **N4（只改测试，无行为变化）**：`test/overlay-focus.test.js` 的 fake DOM 改为从真实
  `RewindOverlay` 渲染树推导焦点目标（不再手工设定谁带 autofocus）；「真实组件不再产出 autofocus」
  这类 mutation 现在会红。
