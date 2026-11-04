# Security Policy / 安全策略

本仓库的插件运行在 DSH 宿主进程内，部分插件会**读写甚至删除**用户本地数据（如 `~/.dsh/` 下的会话文件）。安全问题请认真对待。

Plugins in this repository run inside the DSH host process and some of them read, write or delete local user data (e.g. session files under `~/.dsh/`).

## 报告漏洞 / Reporting a vulnerability

**请不要公开提 issue。** 使用 GitHub 的私密漏洞报告：

**Please do not open a public issue.** Use GitHub private vulnerability reporting:

👉 <https://github.com/kangyishuai/dsh-plugins/security/advisories/new>

请附上：受影响的包名与版本、DSH 版本、复现步骤、影响范围（例如能否越权删除工作区外的文件）。

Please include: affected package and version, DSH version, reproduction steps and impact.

## 支持的版本 / Supported versions

只修复每个插件**最新发布的版本**。项目处于 0.x 阶段，不会给旧版本单独出补丁。

Only the latest published version of each plugin receives fixes.

## 本仓库的安全底线 / Baseline guarantees

- 破坏性操作默认移入回收站，并且必须经过确认框（见 [ADR 0002](docs/adr/0002-destructive-operations.md)）
- 插件不联网，不上报任何数据，除非 README 里明确写了
- 文件操作都限定在已识别的 DSH 数据目录内，遇到不认识的条目保留并告警
