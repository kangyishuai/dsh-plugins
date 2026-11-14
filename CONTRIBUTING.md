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

### 自动合并（automerge）分级

CI 绿是**必要条件，不是充分条件**。哪类 PR 可以在 CI 绿之后自动 squash 合并，按「改动面 + 是否机器生成 + 能否机检」分三档（决策见 [ADR 0014](docs/adr/0014-automerge-tiers.md)）：

| 档               | 适用改动（需**全部**满足）                                                                                                                                                                                                                        | 谁可以打 `automerge`            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **A 直接自动**   | 标题为 `chore(release): version packages`、来自 `changeset-release/main`，diff 只碰各包 `CHANGELOG.md` / `package.json`（版本号）/ `.changeset/**` / `pnpm-lock.yaml`                                                                             | 维护者、agent                   |
| **B 证据门自动** | 标题为 `docs:` / `docs(<plugin>):` / `test:` / `chore(repo):` 且 diff 全部落在 `docs/**`、`*.md`、`.changeset/**`；**或** diff 只碰一个 `packages/<name>/**` 与 `.changeset/**`、且 PR 描述附了证据（单测覆盖；有 client 半时附桌面只读回归结果） | 维护者、agent（描述里写清证据） |
| **C 只能人工**   | 其它全部。明确包含 `.github/**`、`scripts/**`、根 `package.json` 与依赖变更、`types/**`、`docs/adr/**`、`NOTICE`；任何 `feat(<plugin>)`、新增/删除插件、跨多个包；外部贡献者的 PR                                                                 | ——                              |

为什么这样分：

- **门禁不能由门禁自己批**。`scripts/`（gate / publish / check-*）与 `.github/`（CI、分支保护）改的是检查本身；自动合并它们等于让被检查者改考卷。
- **行为改动有 CI 覆盖不到的部分**（桌面真机上的真键盘、`setDraft → submit` 时序，见 [docs/testing](docs/testing/)）。这一档自动合并会把「发版前手工补真机回归」事实上废掉。
- **release 与纯文档 PR 没有信息量可评审**：diff 形态可机检，人工那一下只是延迟发布。

怎么武装（**只有一步**）：

```bash
gh pr edit <n> --add-label automerge
```

打上标签后由 `.github/workflows/automerge-guard.yml` 跑 `scripts/automerge-guard.mjs`：

| 判定   | guard 的动作                                                                         |
| ------ | ------------------------------------------------------------------------------------ |
| 合规   | 用 `RELEASE_TOKEN`（PAT）**替你武装** auto-merge（squash + 删分支），CI 绿后自动合并 |
| 不合规 | 摘掉 `automerge` 标签、关闭已武装的 auto-merge、留一条说明评论，该检查变红           |

机检对 A/B 档还会**再拦一次硬黑名单**：`.github/**`、`scripts/**`、`types/**`、`docs/adr/**` 里的文件即使标题是 `docs:` 也不放行。

> ⚠️ **不要手动 `gh pr merge --auto`。** guard 不是必需检查，手动提前武装会在它跑完之前就把 PR 合掉。
> 2026-11-14 用冒烟 PR 实测过：一个碰 `docs/adr/**` 的 `docs:` PR 加上标签并立刻武装，guard 正确判红、
> 摘了标签，但 PR 已经被合进 `main` 了（只能再开一个 PR 回滚）。武装权只给 guard。
>
> PAT 缺失时 guard 打印警告并跳过武装，此时才退回手动 `gh pr merge --auto`——但也必须等 guard 绿。

- 打标签前也可以自己机检：`git diff --name-only main...HEAD`，越出白名单就别打。
- 仓库设置里必须打开 **Allow auto-merge**；没打开时退回「CI 绿后手动 squash 合并」，分级表照旧生效。
- `automerge` 与「已评审」是两条独立条件：有 `REQUEST_CHANGES` 时即使 CI 全绿也不合。

**必须摘掉 `automerge` 的情况**（任何有写权限的人直接摘，不需要解释）：

- 任一必需检查红，或检查因分支落后而失效（先 `gh pr update-branch <n>` 再说）
- 有人 `REQUEST_CHANGES`
- 打标签之后追加的提交越出白名单
- 需要人工核对真机行为（`needs-dsh-verify` 标签）

来自 fork 的外部 PR 永不自动合并：标签与 auto-merge 只对维护者/agent 自己的分支生效。

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

### 叠式 PR（base 不是 `main`）

大改动可以拆成两个 PR 叠着提：第二个 PR 的 base 指向第一个分支。**第一个分支一旦有新提交，
第二个分支必须立刻 rebase 上去**，否则第二个分支与基分支分叉 → PR 变 `CONFLICTING` →
GitHub 造不出 `refs/pull/<n>/merge` 这个合并引用 → 它的 `pull_request` 工作流（CI、PR title、
gitleaks、runtime probe）会**静默地一次都不跑**，PR 页面上只剩 `pull_request_target` 的
PR labeler 有结果。

实际现象（2026-11-13 session-delete 的两个 PR 上确认过）：

```bash
gh run list --branch <分支> -L 3   # 只有 "PR labeler"，没有 CI
gh api "repos/<owner>/<repo>/actions/runs?head_sha=<sha>"   # 也查不到 pull_request 的 run
```

两个补救办法，任选其一：

1. `git rebase` 到基分支的最新提交后强推（`--force-with-lease`），PR 变回 `MERGEABLE` 之
   后再推一次，`pull_request` 工作流就会重新触发；
2. 或者按上面的兜底路径补跑一次：`gh workflow run ci.yml --ref <分支>`（`workflow_dispatch`
   的结果挂在同一个 head commit 上；`commitlint` / `PR title` 属于 `pull_request` 工作流，
   补跑不覆盖它们）。

合并顺序永远是「先基分支 PR，再叠在上面的 PR」；两个都合进 `main` 之后各自的检查都会在
`main` 的基线上重新跑一遍，所以别用 bypass 跳过。

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
