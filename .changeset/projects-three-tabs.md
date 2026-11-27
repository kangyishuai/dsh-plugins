---
"@kangyishuai/dsh-projects": minor
---

feat(projects): 页签收敛到 3 个（Library 走右栏入口、审计进设置 Debug），桌面回归可用 `--create` 覆盖详情页

- **页签 5 → 3（`docs/plugin-conventions.md` §7.3「页签最多 3 个」）**：项目主页只剩 `线程 / 记忆 / Routines`。
  `data-projects-tab` 的取值集合同步收缩为 `threads|memory|routines`；`audit`、`library` 不再是页签。
- **Library 外迁为右栏一行入口**：右侧栏「记忆」下方新增 `data-projects-rail-library` 段，动作按钮
  `data-projects-library-open`（`aria-pressed` 跟随状态）点开后**在主列**渲染现有的 `LibraryView`
  （`data-projects-library-main` 包裹，原有 `data-projects-library*` 锚点全部保留），主列顶部
  `data-projects-library-back`（‹ 返回线程列表）或再次点同一右栏行动作都能收起；右栏段给一行摘要
  `data-projects-library-rail-summary`（文件数 · 产物数）。数据面没有变化：仍然是宿主 `workspaceFiles`
  文件面 + `artifacts/2` 产物面 + 自存的 `projectId ↔ artifactId` 映射。
- **审计外迁到设置分节 Debug 区**：项目详情不再请求/渲染审计（少一轮 5s 轮询），设置
  Debug 分区新增 `data-projects-settings-audit`（标题 `data-projects-audit-title`，列表保留
  `data-projects-audit` / 空态 `data-projects-audit-empty` 锚点，新的在前，最多 100 条 = `listAudit` 的截断）。
- **桌面只读回归新增 `--create`（默认关，默认仍严格只读）**：开启时用 UI 从零建一个
  `smoke-desktop-<ts>` 临时项目 → 断言详情页两列（`data-projects-detail-grid/main/rail`）、6 个药丸、
  3 个页签、Library 右栏入口、审计不在详情页 → 再用同一套 UI「详情 ⋯ → 删除 → 确认 → 回收站 → 彻底删除」，
  最后断言盘上 `projects.json` 里没有它。默认模式（不带 `--create`）在有项目的 profile 上真断言详情页，
  没有项目时如实 SKIP 并写明原因（不再只能吃「live profile 没有项目」这条跳过）。
- 设置分节那条从「渲染了就算 PASS」改成真断言：四个分区（general/memory/usage/debug）+ Debug 面板 +
  审计锚点；设置页打不开仍如实 SKIP 并进计数行。
- **中英 runtime 字典 + `locale/{zh,en}.json` 三处同步**（新增 `library.railOpen/railBack/railHint/
  railSummary/railLoading`、`settings.auditTitle`；删掉不再使用的 `detail.tab.audit`），
  `test/locale-parity.test.js` 保持绿（键集与文案值逐条相等）。