---
"@kangyishuai/dsh-advisor": patch
"@kangyishuai/dsh-artifacts": patch
"@kangyishuai/dsh-btw": patch
"@kangyishuai/dsh-casefile": patch
"@kangyishuai/dsh-next-step": patch
"@kangyishuai/dsh-projects": patch
"@kangyishuai/dsh-session-delete": patch
"@kangyishuai/dsh-session-rewind": patch
---

插件身份（U1-01/U1-19）：8 个包在 `locale/en.json`、`locale/zh.json` 根对象新增 `meta.title` / `meta.description`（英文短描述 + `scripts/index-meta.json` 的中文描述），并把两个 locale 文件加进 `exports`，让「插件 → 已安装」不再只显示 npm 包名 + 英文长描述；每个包新增自绘 `icon.svg`（36×36、透明背景、无文字），在 `package.json` 顶层 `icon` 声明并加入 `files`，8 个插件的图标互不相同。已在 DSH 0.2.2-rc.5 隔离桌面实例实测（暗色主题、中文界面）。
