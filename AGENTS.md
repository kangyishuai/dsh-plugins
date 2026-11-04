# AGENTS.md — 在本仓库开发 DSH 插件的工作约定

本文件由 DSH 自动加载。**先读这里，再读 [docs/plugin-conventions.md](docs/plugin-conventions.md)。**

## 仓库性质

这是个人开发 DeepSeek Harness (DSH) 插件的**单仓多包**仓库。每个 `packages/<name>/` 是一个独立 npm 包，可独立 `npm publish`、独立安装进任意 DSH profile。

- 目标运行时：**DSH 桌面版 0.2.1-rc.5**（Electron，profile 目录 `~/.dsh/profiles/desktop`）
- Node >= 22.19，pnpm >= 11
- 包名统一 `@kangyishuai/dsh-<name>`

## 开发流程

1. 新插件：`packages/<name>/`，参照 `docs/plugin-conventions.md` 的清单逐项建文件
2. 安装到本地验证：`dsh plugin --profile desktop add "link:$PWD/packages/<name>"`
3. host 半（`lib/index.js`）改动 → **重启 DSH 桌面版**；client 半（`lib/client.js`）改动 → **刷新页面**
4. 验证完必须能在侧栏/设置里看到真实效果，不能只靠单元测试

## 硬性约定

1. **不写死 DSH 内部实现**。会话文件格式带版本号（如 `session.v4.jsonl.zstd`），目录布局也会变。一律按「扫描 + 匹配已知模式」实现，遇到不认识的条目保留并告警，不要 `rm -rf` 整个上层目录。
2. **破坏性操作必须有确认框**，并明示影响面（数量、大小、是否 live、是否可恢复）。
3. **版本约束先留空**。DSH 处于 `0.2.1-rc.x`，预发布版本让 semver 范围匹配很不可靠（`^0.2.0-rc.2` 严格匹配不到 `0.2.1-rc.5`）。除非已验证，不要声明 `engines.dsh` 或 `peerDependencies` 中的 `@deepseek-ai/dsh-*` 范围。
4. **优先复用宿主服务**（`ctx.workspaceRegistry`、`ctx.sessionPersistence`、`ctx.sessions` 等），只在没有接口时直接操作文件系统——并在代码注释里写明原因。
5. **不引入打包器**。client 半手写 classic script 即可；确实需要 JSX 时用 `React.createElement`，不要加 Vite/Rollup 依赖。
6. 每个插件必须有 `README.md`（做什么、怎么装、有什么副作用/风险）。

## 提交约定

- Conventional Commits：`feat(<plugin>): ...` / `fix(<plugin>): ...` / `docs: ...` / `chore: ...`
- 一个插件的一次改动只动自己的目录；改共享文件（根 `package.json`、`docs/`）单独提交

## 不要做的事

- 不要提交 `node_modules`、构建产物、`.DS_Store`
- 不要把 DSH 自带包（`@deepseek-ai/*`）加成本仓库依赖——运行时由宿主提供
- 不要在插件里修改 `~/.dsh/profiles/*/cordis.patch.yml`（`dsh.bundle.patch` 会自动接线）
