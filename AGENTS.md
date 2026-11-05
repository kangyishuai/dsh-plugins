# AGENTS.md — 在本仓库开发 DSH 插件的工作约定

本文件由 DSH 自动加载（Claude Code 通过 `CLAUDE.md` 引用本文件）。**先读这里，再读 [docs/plugin-conventions.md](docs/plugin-conventions.md)，再读目标版本的 [docs/runtime/](docs/runtime/) 勘察记录。**

## 仓库性质

这是个人开发 DeepSeek Harness (DSH) 插件的**单仓多包**仓库，计划开源。每个 `packages/<name>/` 是一个独立的 npm 包，可以单独 `npm publish`、单独安装进任意 DSH profile。

- 目标运行时：**DSH 桌面版 0.2.1-rc.5**（Electron，profile 目录 `~/.dsh/profiles/desktop`）
- Node：开发用 24（`.node-version`），最低支持 22.19；pnpm >= 11
- 包名统一用 `@kangyishuai/dsh-<name>`

## 常用命令

| 命令                        | 作用                                                   |
| --------------------------- | ------------------------------------------------------ |
| `pnpm new <name> [描述]`    | 从 `templates/plugin` 生成新插件（**不要手抄文件**）   |
| `pnpm verify`               | lint + typecheck + 规范检查 + 测试，**交付前必须通过** |
| `pnpm check`                | 只跑插件规范检查（`scripts/check-plugins.mjs`）        |
| `pnpm check:public`         | 公开边界检查（见「公开边界」一节）                     |
| `pnpm format`               | Biome 格式化并自动修复                                 |
| `pnpm changeset`            | 为需要发版的改动写变更说明                             |
| `pnpm probe:runtime`        | 核对本机 DSH 安装里插件依赖的包/API/slot 是否还在      |
| `pnpm smoke:session-delete` | 端到端 GUI 冒烟（临时 DSH_HOME，24 项断言）            |
| `pnpm smoke:agent-tool`     | agent 工具真机冒烟（需要模型凭据，否则 SKIP）          |

## 开发流程

1. 新插件：`pnpm new <name>`，然后 `pnpm install`
2. 安装到本地验证：先打包再装——`cd packages/<name> && pnpm pack --pack-destination /tmp`，然后 `dsh plugin --profile desktop add /tmp/<tgz>`。**不要用 `link:`**：真实路径在 profile 外面，宿主注入的 `@deepseek-ai/*` 解析覆盖不到，插件会激活失败（见 [runtime](docs/runtime/0.2.1-rc.5.md) §6.9）
3. host 半（`lib/index.js`）改动 → **重启 DSH 桌面版**；client 半（`lib/client.js`）改动 → **刷新页面**
4. 验证完必须能在侧栏或设置里看到真实效果，不能只靠单元测试
5. 需要发版的改动跑 `pnpm changeset`
6. 新增插件时同步更新：根目录两份 README 的插件清单、`.github/ISSUE_TEMPLATE/bug_report.yml` 的插件下拉选项

## 公开边界

本仓库是**公开**的。写任何文件之前，先判断它属于哪一类：

| 类别           | 放哪里                   | 例子                                                                                                            |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **公开**       | 本仓库                   | 插件代码与测试；`docs/runtime/`（已验证的宿主事实）；ADR；`docs/testing/` 测试清单；`NOTICE`；CHANGELOG；README |
| **私有**       | `notes/`（独立私有仓库） | 竞品调研与点评；本机环境盘点（装了哪些插件、profile 内容）；未验证的猜测；产品路线与待办；投稿、推广计划        |
| **哪里都不放** | 不进任何 git             | token、密钥、`.env`；真实会话内容和日志；含真实数据的截图；带真实用户名的本机绝对路径                           |

拿不准就先放 `notes/`。确认能公开、并改写成「事实 + 结论」之后，再搬进公开仓库。

### 私有笔记：`notes/`

调研笔记放在独立的私有仓库 `kangyishuai/dsh-plugins-notes`，本地克隆到仓库根目录的 `notes/`（已被 `.gitignore` 忽略）：

```bash
git clone https://github.com/kangyishuai/dsh-plugins-notes.git notes
```

- 新插件开工前的调研写到 `notes/<plugin>/`，`README.md` 是索引；跨插件的生态调研放 `notes/ecosystem/`；待办写在 `notes/TODO.md`
- `notes/` 有自己的 git，在里面单独提交、推送
- 公开仓库里的文件**不能链接到 `notes/`**（公开后是死链）。调研结论要沉淀回公开仓库：已验证的宿主事实 → `docs/runtime/<版本>.md`；决策 → `docs/adr/`；借鉴来源 → `NOTICE`；测试步骤 → `docs/testing/<plugin>.md`
- 笔记里指向公开仓库的链接，用 GitHub 绝对地址

### 自动检查

- `pnpm check:public`（`scripts/check-public.mjs`）在 pre-commit 和 CI 中都会运行，拦截以下内容：
  - 被 git 跟踪的 `notes/` 文件
  - 指向 `notes/` 的链接
  - 带真实用户名的本机绝对路径
  - 常见的 token 和私钥格式
- 示例里需要写路径时，用占位用户名：`me`、`you`、`user`、`<name>` 等
- 确属误报时，在同一行加注释 `check-public: allow`，并说明原因
- CI 另外运行 gitleaks，扫描全部提交历史里的密钥

## 硬性约定

1. **不写死 DSH 内部实现**。会话文件格式带版本号（如 `session.v4.jsonl.zstd`），目录布局也会变。一律按「扫描 + 匹配已知模式」实现，遇到不认识的条目保留并告警，不要 `rm -rf` 整个上层目录。
2. **破坏性操作遵循 [ADR 0002](docs/adr/0002-destructive-operations.md)**：默认移入回收站，必须有确认框并明示影响面（数量、大小、是否 live、能否恢复），支持 dry-run，写审计日志。
3. **版本约束先留空**。DSH 处于 `0.2.1-rc.x`，预发布版本让 semver 范围匹配很不可靠（`^0.2.0-rc.2` 严格匹配不到 `0.2.1-rc.5`）。除非已经验证，不要声明 `engines.dsh` 或 `peerDependencies` 里的 `@deepseek-ai/dsh-*` 范围。用 README 的「兼容性」表格代替。
4. **优先复用宿主服务**（`ctx.workspaceRegistry`、`ctx.sessionPersistence`、`ctx.sessions` 等），只有在没有接口时才直接操作文件系统，并在代码注释里写明原因。
5. **不引入打包器和构建步骤**（[ADR 0001](docs/adr/0001-plain-js-with-jsdoc.md)）。源码是 ESM JS + JSDoc，文件头写 `// @ts-check`。client 半手写 classic script，确实需要 JSX 时用 `React.createElement`。
6. 每个插件必须有 `README.md`（英文）和 `README.zh-CN.md`（中文），写清楚做什么、怎么装、有什么副作用和风险、在哪个 DSH 版本上验证过。
7. **数据根目录必须可注入**，不能在模块顶层写死 `~/.dsh`；文件系统相关逻辑在 `mkdtemp` 临时目录里测试。
8. 宿主类型声明（`types/*.d.ts`）只写已验证的成员。新发现的 API、slot、坑记到 `docs/runtime/<版本>.md`，不要写进 `plugin-conventions.md`。
9. 重要的取舍写成 ADR（`docs/adr/`）。

## 提交约定

- Conventional Commits，由 commit-msg hook 校验：`feat(<plugin>): ...` / `fix(<plugin>): ...` / `docs: ...` / `chore(repo): ...`
- scope 只能是插件目录名，或 `repo` `docs` `deps` `ci` `release` `scripts` `template` `types`
- 一次提交只改一个插件的目录；改共享文件（根配置、`docs/`、`templates/`、`scripts/`）单独提交
- 不要用 `--no-verify` 跳过 hook

## 不要做的事

- 不要提交 `node_modules`、构建产物、`.DS_Store`
- 不要把 DSH 自带的包（`@deepseek-ai/*`）加成本仓库的依赖，运行时由宿主提供（`pnpm check` 会拦）
- 不要在插件里修改 `~/.dsh/profiles/*/cordis.patch.yml`（`dsh.bundle.patch` 会自动接线）
- 不要在没确认许可证的情况下复制其他社区插件的代码；借用了就写进根目录的 `NOTICE`
- 不要在本地手动 `npm publish`，发版走 Changesets + CI
