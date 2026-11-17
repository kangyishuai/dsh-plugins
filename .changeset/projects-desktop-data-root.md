---
"@kangyishuai/dsh-projects": patch
---

修桌面版 `projects: store is unavailable`：DSH 桌面进程不导出 `DSH_HOME`，旧的 `resolveDataRoot` 在没有配置 `dataRoot` 时直接抛错。现按「配置 `dataRoot` → `$DSH_HOME/projects` → `~/.dsh/projects`」解析，并把解析器抽到可单测的 `lib/paths.js`（新增回归测试）。
