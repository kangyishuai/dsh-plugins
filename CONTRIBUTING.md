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
├── .github/assets/      # 仓库 logo、横幅、社交预览图（SVG 为源文件，PNG 用 rsvg-convert 生成）
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

## 工作流：Issue → 分支 → PR

### 分支

- `main` 永远可以发布。工作分支是短命的，合并后自动删除。
- 命名：`<type>/<plugin>-<主题>`。`type` 与提交类型一致，主题用 kebab-case。
  - 插件改动：`feat/session-delete-batch`、`fix/session-delete-ghost-entry`
  - 仓库级改动：`chore/repo-worktree`、`docs/repo-workflow`、`ci/repo-gitleaks`
- 一个分支只做一件事，只改一个插件。

### 直推还是走 PR

| 改动                                                    | 方式                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| **插件代码**（`packages/<name>/lib`、`locale`、`test`） | **必须走 PR**：先看到 CI 结果和 changeset，再合并               |
| 仓库脚本、模板、CI 配置                                 | 建议走 PR                                                       |
| 纯文档、错别字、README 措辞                             | 可以直推 `main`                                                 |
| 发版（`chore(release): …`）                             | 本地 `pnpm version-packages` 后直推，或合并 Version Packages PR |

### PR

- 一个 PR 只改一个插件，共享文件（`docs/`、根配置）另开 PR。
- 合并方式：**squash**（已禁用 merge commit）。squash 后 PR 标题就是 `main` 上的提交信息，所以 **PR 标题也必须符合 Conventional Commits**，CI 的 `PR title` 检查会校验。
- 描述里写 `Closes #<issue>`，按 PR 模板勾选自查清单。
- 标签由 `actions/labeler` 按改动路径自动打（`plugin:<name>`、`area:repo`、`area:ci`、`documentation`），不用手动打。

### 分支保护（main）

`main` 的规则集 `protect-main` 除了禁止删除和非快进之外，还要求这 4 个检查通过才能合并：

| 必需检查                      | 来自 `ci.yml` 的 job |
| ----------------------------- | -------------------- |
| `verify (node 22.19)`         | `verify`（矩阵）     |
| `verify (node 24)`            | `verify`（矩阵）     |
| `runtime probe (DSH surface)` | `probe`              |
| `gitleaks (full history)`     | `secrets`            |

`commitlint` 不在必需列表里：`ci.yml` 的 job 和 `pr-title.yml` 的 job 同名，两个工作流都产出叫 `commitlint` 的检查，按名字要求会不稳定。PR 标题仍由 `PR title` 工作流校验。

仓库所有者（admin）可以 bypass，只用于「检查根本不可能产生」的场景，例如 GitHub 侧故障。正常情况**不要**用 bypass 合并。

**Version Packages PR 的 CI 靠 `RELEASE_TOKEN`。** 这类 PR 由 `changesets/action` 创建，如果用仓库自带的 `GITHUB_TOKEN`，GitHub 会抑制它产生的 `pull_request` 事件——那个 PR 上要么没有任何检查，要么只有一个 0 job 的失败 run。所以 `release.yml` 用仓库 secret `RELEASE_TOKEN`（fine-grained PAT，只需 `Contents: write` + `Pull requests: write`）来开 PR，这样它和普通 PR 一样自带 `CI` 与 `PR title` 检查。

- **没配这个 secret 也能发版**：`release.yml` 会退回 `GITHUB_TOKEN`，并用 `workflow_dispatch` 给 `changeset-release/main` 补跑一次 `ci.yml`，检查结果同样挂在 PR 的 head commit 上。补跑有一处差别：`commitlint`/`PR title` 属于 `pull_request` 触发的工作流，补跑不会覆盖它们（release PR 标题固定为 `chore(release): version packages`，本身合规）。
- **PAT 到期/被撤权时不要慌**：`release.yml` 的 `Check CI on the Version Packages PR` 步骤会用 PAT 查一次仓库权限，权限不对就打印 warning 并自动退回补跑模式。到期表现是 Release 日志里出现该 warning，不是发布失败。换 token 只需覆盖同名 secret，不用改代码。
- 手工补跑（兜底路径或怀疑 CI 没触发时）：

```bash
gh workflow run ci.yml --ref changeset-release/main
```

### Issue 与标签

| 标签                                      | 含义                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `bug` / `enhancement` / `question`        | 类型，由 issue 模板自动打                                         |
| `plugin:<name>`                           | 涉及哪个插件（PR 自动打；issue 手动补）                           |
| `area:repo` / `area:ci` / `documentation` | 仓库级改动                                                        |
| `needs-dsh-verify`                        | 需要在真实 DSH 上手动验证才能关                                   |
| `breaking`                                | 对用户的破坏性变更，发版要 bump minor 并在 changeset 里写迁移说明 |
| `dependencies` / `release`                | Dependabot、Version Packages PR                                   |

### 并行开发：一个分支一个 worktree

同时开发多个插件（或多个 AI agent 并行）时，**不要在同一个目录里来回切分支**，每个分支用独立的 worktree：

```bash
pnpm wt feat/session-delete-batch      # 建分支 + worktree，链接 notes/，pnpm install
pnpm wt list                           # 看所有 worktree
pnpm wt rm feat/session-delete-batch --delete-branch   # PR 合并后清理
```

- worktree 统一放在主仓库旁边：`../dsh-plugins.worktrees/<分支名，/ 换成 -->`
- git hooks 所有 worktree 共用；私有的 `notes/` 以符号链接接入，只有一份
- `pnpm wt rm` 不会强删：有未提交改动时 git 会拒绝。squash 合并的分支 git 识别不出「已合并」，确认 PR 合并后用 `git branch -D` 删
- **并行时的冲突点**：
  - DSH 的 `desktop` profile 是共用的，两个 worktree 都装开发版会互相覆盖。并行时的 GUI 验证一律用 `pnpm smoke:<plugin>`（临时 DSH 目录），只在最后合并前装进 `desktop` 手测
  - changeset 文件名随机，不会冲突；`pnpm-lock.yaml` 可能冲突，rebase 后重新 `pnpm install` 即可
  - 同一个插件同时只在一个分支上开发

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

走 PR 这条路时记得：Version Packages PR 由 `RELEASE_TOKEN` 创建，因此和普通 PR 一样自带 CI 与 `PR title` 检查，等必需检查绿了再合并（细节见[分支保护](#分支保护main)）。若那个 PR 上没出现检查，多半是 secret 缺失或 PAT 过期，用兜底入口手工补一次：

```bash
gh workflow run ci.yml --ref changeset-release/main
```

发布由 [`scripts/publish.mjs`](scripts/publish.mjs) 完成。它用 `npm publish --provenance` 发布，npm 页面会显示「Built and signed on GitHub Actions」，用户能确认包来自本仓库的 CI。之所以不用 `changeset publish`，是因为它在 pnpm 仓库里调用 `pnpm publish`，而 pnpm 不支持 provenance。发布成功后脚本会运行 `changeset git-tag`，由工作流推送 tag、创建 GitHub Release。

不要在本地 `npm publish`，脚本在 CI 之外也会拒绝执行。想看会发布什么，用 `node scripts/publish.mjs --dry-run`。

0.x 阶段：破坏性改动 bump minor，其余 bump patch。

本地跑 `pnpm version-packages` 需要 `GITHUB_TOKEN`，因为 changelog 由 `@changesets/changelog-github` 生成。

`.changeset/` 已在 `biome.json` 里排除格式化——否则 Biome 会把 frontmatter 改写成 Markdown 标题，导致 changesets 解析失败。

## 公开边界

这是公开仓库。不要提交 token 和密钥、真实会话内容，也不要提交带真实用户名的本机路径。调研草稿和竞品点评留在本地，只把核实过的结论写进 `docs/`。提交时 `pnpm check:public` 会自动拦截常见问题，详细规则见 [AGENTS.md](AGENTS.md#公开边界)。

## 引用第三方代码

参考或借用其他 DSH 插件的代码前，先确认对方的许可证允许。借用了就在仓库根目录的 `NOTICE` 里写明出处和许可证（文件不存在就新建）。

## 行为准则

见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。友善，就事论事。
