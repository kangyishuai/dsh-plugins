# Contributing / 参与贡献

感谢关注！这是一个个人维护的 DSH 插件仓库，欢迎 issue 和 PR。下面是人类贡献者需要知道的部分；AI agent 的工作约定见 [AGENTS.md](AGENTS.md)。

## 环境

- Node：开发用 24（见 `.node-version`），最低支持 22.19
- pnpm >= 11（`corepack enable` 后会自动使用 `packageManager` 里固定的版本）
- 一个本地 DSH 桌面版，用来实际验证

```bash
pnpm install   # 同时会安装 git hooks（pre-commit 格式化，commit-msg 校验提交信息）
pnpm verify    # lint + typecheck + 插件规范检查 + 测试，CI 跑的是同一套
```

## 目录结构

```
dsh-plugins/
├── packages/<name>/     # 一个插件 = 一个 npm 包（docs/images 放 README 截图，不进 npm 包）
├── templates/plugin/    # pnpm new 用的脚手架模板
├── scripts/             # 脚手架、规范检查、公开边界检查、冒烟测试
├── types/               # 手写的 DSH 宿主/client 类型声明（供 JSDoc 检查）
├── docs/                # 约定、运行时勘察、ADR、测试清单（索引见 docs/README.md）
└── .changeset/          # 待发布的变更说明（Changesets）
```

## 本地试装插件

`link:` 安装不可用（原因见 [runtime](docs/runtime/0.2.1-rc.5.md)），要先打包再装：

```bash
cd packages/<name> && pnpm pack --pack-destination /tmp && cd ../..
dsh plugin --profile desktop add /tmp/<tgz>
```

改了 host 半（`lib/index.js`）要重启 DSH；改了 client 半（`lib/client.js`）刷新页面就行。

## 截图

README 里的截图必须用演示数据生成，不能直接截真实界面：

```bash
SMOKE_DEMO=1 pnpm smoke:session-delete   # 截图在系统临时目录的 dsh-smoke-shots/
```

演示模式会把工作区名、会话标题和 ID 都换成演示数据。挑图之后**逐张检查**，确认没有残留的真实信息，再放进 `packages/<name>/docs/images/`。README 里用 `raw.githubusercontent.com` 绝对地址引用，这样 npm 页面也能显示。

## 常用命令

| 命令                     | 作用                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `pnpm new <name> [描述]` | 从 `templates/plugin` 生成新插件                            |
| `pnpm check`             | 检查所有插件是否符合 [插件约定](docs/plugin-conventions.md) |
| `pnpm format`            | Biome 格式化并自动修复                                      |
| `pnpm changeset`         | 记录一次需要发版的改动                                      |
| `pnpm list-plugins`      | 列出所有插件与版本                                          |

## 代码风格

- 纯 JavaScript（ESM）+ JSDoc 类型注释，文件头写 `// @ts-check`，由 `tsc` 只做检查、不产出文件
- 不引入打包器；client 半是手写的 classic script
- 格式与 lint 都交给 Biome，不需要手动对齐

## 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，commit-msg hook 会自动校验：

```
<type>(<scope>): <subject>
```

- `type`：`feat` `fix` `docs` `refactor` `perf` `test` `chore` `ci` `build` `revert`
- `scope`：插件目录名（如 `session-delete`），或仓库级的 `repo` `docs` `deps` `ci` `release` `scripts` `template` `types`
- 一次提交只改一个插件；共享文件（`docs/`、根配置）单独提交

## 发版

使用 [Changesets](https://github.com/changesets/changesets)，各插件**独立**版本号：

1. 改完代码运行 `pnpm changeset`，选择插件和 bump 类型，写一句面向用户的说明，和代码一起提交
2. 发版时二选一：
   - **本地出版本（维护者日常做法）**：`GITHUB_TOKEN=$(gh auth token) pnpm version-packages`，检查 `CHANGELOG.md` 和版本号，提交为 `chore(release): <plugin> <version>` 后推到 `main`
   - **走 PR**：直接把带 changeset 的提交推到 `main`，CI 会开一个「Version Packages」PR，合并它即可
3. `main` 上出现尚未发布的版本号时，Release 工作流会发布到 npm 并打 tag `@kangyishuai/dsh-<name>@<version>`，同时创建 GitHub Release

不要在本地 `npm publish`。

0.x 阶段：破坏性改动 bump minor，其余 bump patch。

本地跑 `pnpm version-packages` 需要 `GITHUB_TOKEN`，因为 changelog 由 `@changesets/changelog-github` 生成。

`.changeset/` 已在 `biome.json` 里排除格式化——否则 Biome 会把 frontmatter 改写成 Markdown 标题，导致 changesets 解析失败。

## 公开边界

这是公开仓库。不要提交 token 和密钥、真实会话内容，也不要提交带真实用户名的本机路径。调研草稿和竞品点评留在本地，只把核实过的结论写进 `docs/`。提交时 `pnpm check:public` 会自动拦截常见问题，详细规则见 [AGENTS.md](AGENTS.md#公开边界)。

## 引用第三方代码

参考或借用其他 DSH 插件的代码前，先确认对方的许可证允许。借用了就在仓库根目录的 `NOTICE` 里写明出处和许可证（文件不存在就新建）。

## 行为准则

见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。友善，就事论事。
