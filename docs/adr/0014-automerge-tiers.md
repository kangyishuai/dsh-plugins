# 0014. 自动合并分级：release / 文档 / 证据齐全的单插件改动

- 状态：已接受
- 日期：2026-11-14
- 涉及：repo

## 背景

`main` 的合并门禁是四个 CI 检查（`verify (node 22.19)`、`verify (node 24)`、`runtime probe`、`gitleaks`）。日常要合并的 PR 有三类：

1. changesets 生成的 Version Packages PR；
2. 纯文档 PR（兼容性表、发布记录、测试清单）；
3. 单插件的修复 / 测试 PR。

第 1、2 类人工点一次合并没有信息增量——diff 形态可以机检，人工那一下只是延迟发布；第 3 类相反：CI 覆盖不到桌面真机行为（真键盘 `⌘↵`、`setDraft → submit` 时序等，见 [docs/testing](../testing/)），无条件自动合并会把「发版前必须手工补真机回归」这条硬约定事实上废掉。

另有一类改动是**门禁自身**：`.github/`（CI 与分支保护）、`scripts/`（gate / publish / check-*）、根 `package.json`、`types/`。让 CI 绿就自动合并这些，等于让被检查者自己改考卷。

## 可选方案

1. **一律 CI 绿即自动合并**：延迟最低。缺点：行为改动与门禁改动无人复核，发布链全自动；一次错误直接进 npm，且没有中间人可以发现"检查本身被改松了"。
2. **一律人工合并**：最稳。缺点：release 与文档 PR 的等待是纯空转；agent 只能轮询等 CI，浪费上下文和时间。
3. **按风险分级 + 显式标签**（选定）：机器生成或可机检的改动自动，行为改动与门禁改动人工；"自动"由 `automerge` 标签**显式开启**，而不是默认行为。

## 决定

采用方案 3。分级、白名单路径、打/摘标签的规则写在 [CONTRIBUTING.md §自动合并分级](../../CONTRIBUTING.md#自动合并automerge分级)；AGENTS.md 只留一句指路，不复制表格（它已经在体积上限附近）。要点：

- **A 档（直接自动）**：Version Packages PR（`chore(release): version packages`，diff 只碰 CHANGELOG / 包内 version / lockfile）。
- **B 档（证据门自动）**：纯文档 PR；或 diff 全在单个 `packages/<name>/**` 内、且 PR 描述附了证据（单测覆盖 + 有 client 半时的桌面只读回归结果）的 `fix` / `test`。
- **C 档（人工）**：`.github/**`、`scripts/**`、根依赖、`types/**`、`docs/adr/**`、`NOTICE`；`feat(<plugin>)`、新增/删除插件、跨包改动；外部贡献者的 PR。
- 任一必需检查红、分支落后导致检查失效、或有人 `REQUEST_CHANGES`，自动合并即失效；任何人可摘掉标签。
- 机制用 GitHub **原生 auto-merge**（`gh pr merge --auto --squash --delete-branch`），不自建合并脚本——合并动作交给平台，仓库里只维护"谁可以打标签"的规则。

## 影响

- 发布链上人工点合并从两次（feature + Version Packages）降到最多一次。
- 需要两个可撤销的开关：仓库设置里的 **Allow auto-merge**，以及 `automerge` 标签的存在。两者缺一时退回"CI 绿后手动 squash"，分级表照旧生效。
- 桌面真机回归仍是发版前的硬要求：B 档说的"证据"是 PR 描述里附的结果，不是 CI 自动产出的。想让 B 档真正安全，前提是把桌面回归纳入 `pnpm gate` 并能被 CI 复现（目前 `--deep` 需要真机）。
- 重新考虑的时机：出现"自动合并后才发现门禁漏检"的事故、或开始接收外部维护者批量 PR 时，收紧回只有 A 档自动。

## 增补 1（2026-11-14）：白名单校验落地

- 机检实现：`scripts/automerge-guard.mjs`（判定是纯函数，单测在 `scripts/test/automerge-guard.test.js`）+ `.github/workflows/automerge-guard.yml`。PR 带 `automerge` 标签时校验改动面；越界会摘掉标签、关闭已武装的 auto-merge、留一条说明评论（幂等，同一 PR 只维护一条），并把该检查标红。PR 模板补了一行自查。
- **不由 workflow 代劳「武装 auto-merge」**：用 `GITHUB_TOKEN` 发起的合并不会触发 `push` 工作流，会吞掉 Release（发版链）。所以武装仍只由人或 agent 用用户/PAT 凭据执行，workflow 只做否决。
- 顺序建议：先打 `automerge` 标签 → 等必检与 guard 都过 → 再 `gh pr merge --auto`。顺序反了 guard 也会回头纠正，只是多一条评论。
- 若以后想把 guard 加进 `protect-main` 的必需检查：它必须对**所有** PR 都产生结果（本 workflow 就是这样——没标签时直接成功退出），否则没有该检查的历史 PR 会永远卡在"等待检查"。

## 增补 2（2026-11-14 深夜）：冒烟实测后的两处修正

用真实 PR 冒烟（标题 `docs:`、碰 `docs/adr/**`、打标签后**立刻**手动武装 auto-merge）暴露两个问题：

1. **手动武装会抢在 guard 前面**。guard 不是必需检查，`gh pr merge --auto` 一旦武装，四件必检一绿就合，
   而 guard 还在跑；实测中 PR 在 guard 判红并摘掉标签之后仍然合并进了 `main`（只能另开 PR 回滚）。
   结论：**武装权收归 guard**——合规时它用 PAT（`RELEASE_TOKEN`）武装，不合规时摘标签 + 关闭 auto-merge。
   人或 agent 只负责打标签。
2. **参数被空格切碎**。guard 用一个 `gh` 封装按空格拆参数，注释标记 `<!-- automerge-guard -->` 里有空格，
   整条 `gh api` 变成 usage 报错，说明评论没发出来（但标签已摘、检查已红）。改为一律传参数数组。

为什么武装必须用 PAT 而不是 `GITHUB_TOKEN`：`GITHUB_TOKEN` 发起的合并不会触发 `push` 工作流，会吞掉
Release（发版链）——那样 A 档的 Version Packages PR 永远发不出去。没配 PAT 时 guard 只打印提示、不武装，
退回手动，但要求先等 guard 绿。
