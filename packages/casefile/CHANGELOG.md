# @kangyishuai/dsh-casefile

## 0.1.1

### Patch Changes

- [#188](https://github.com/kangyishuai/dsh-plugins/pull/188) [`046df92`](https://github.com/kangyishuai/dsh-plugins/commit/046df92596e16fd394b1e8ea0c9a9a29dd257816) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修掉一处会让 CI 偶发变红的测试：`slugify` 对无法拉丁化的标题（如「中文标题」）会回落到 `project-<时间戳>`，而旧断言把两次调用的结果直接比较，跨毫秒必失败。改为断言前缀与 `ID_RE` 形状。

- [#186](https://github.com/kangyishuai/dsh-plugins/pull/186) [`d54e1ae`](https://github.com/kangyishuai/dsh-plugins/commit/d54e1ae5752bafb010a8b677f809d07e51afc295) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修正 npm/插件索引里显示的英文描述：`package.json#description` 之前写成了中文，导致 Discover 卡片的 `description.en` 显示中文。改成英文一行说明（中文描述仍由 `scripts/index-meta.json#descriptionZh` 提供）。

## 0.1.0

### Minor Changes

- [#151](https://github.com/kangyishuai/dsh-plugins/pull/151) [`a898e41`](https://github.com/kangyishuai/dsh-plugins/commit/a898e41480b55bc7a1f4a3d4f852a1f96b82e335) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 新增 casefile：REA 之上的循证逆向工作台（不做桥、不带引擎）。
  
  - **项目与证据**：项目态（目标 + 授权档 + 范围）、证据账本（保留 REA 的 confidence/authority/limitations）、结论（claim）与勾选、功能分组、未知项。
  - **交付物**：规格包 `spec.json` + `brief.md`（默认脱敏：本机路径、token 形态），未知项随包；验收报告 `report.md` + `report.json`（全局与按功能覆盖率、义务表、带实现 digest 的检查表）。
  - **验收**：五类 checker —— `build` / `cli` / `web`（自带 PNG 解码，无第三方依赖）/ `process`（退出码、输出、文件副作用与 SHA-256）/ `selfTest`（项目自测 JSON 契约）。崩溃、超时、缺图、报告不可解析一律 `unknown`，永不默认通过。
  - **闭环**：`case_build cycle` 一次调用完成（可选 builder 会话 → 构建 → 检查 → 关闭）；实现变化后旧 PASS 自动 stale 重开；接近但不对的改动必须判失败（near-miss 测试覆盖）。
  - **硬门**：关闭项目要求无未关闭义务、无未解决未知项、覆盖率达标、检查新鲜且实现 digest 一致，逐条报出卡点。
  - **授权档**：`research` 档默认禁止起复刻构建，需显式覆盖并留审计。
  - **净室 attestation**：记录投喂给 builder 的 prompt/规格摘要与「不要读取原件」指令是否在 prompt 里，并如实标注工具面未做白名单隔离。
  - **界面**：侧栏「案卷」入口、工作台（证据/义务/运行三页签）、跨项目总览条、设置分节（数据根、REA 能力状态）。
  - **工具**：9 个模型工具（`case_project` / `case_evidence` / `case_claim` / `case_feature` / `case_unknown` / `case_obligation` / `case_build` / `case_check` / `case_brief`）。
  
  数据只落本机；不做 MCP 桥、不做 token 网关、不带分析引擎、无 DRM/反调试绕过。
