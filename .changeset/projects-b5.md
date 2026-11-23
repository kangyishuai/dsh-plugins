---
"@kangyishuai/dsh-projects": minor
---

feat(projects): B5 · Library / Artifacts（F33 / F34 / U15）+ B3 复审修复

- **F33 Library 视图**：项目页「Library」页签合并两块数据。**文件面**走宿主 `workspaceFiles`（scope `{sessionId, workspaceRoot}`，多目录逐个 list；明写「搜索只匹配文件名/路径，不搜正文」——这是宿主的边界）；**产物面**走 `artifacts` 0.2 契约（`ctx.get("artifacts")` + `version().contract === "artifacts/2"` 再 `list({projectId})`），并**自存 `projectId↔artifactId` 映射**（项目记录里的 `artifactRefs[]`：id/标题/类型/版本/字节/时间/来源；发布时在项目线程里 `recordArtifact` 落盘，冷启动可回读）。计量给 count/bytes，provenance 给「来自会话哪次工具调用」。
- **降级是明示的**：artifacts 未安装、`version()` 不可用或契约不是 `artifacts/2` 时，Library 写「产物库需要 dsh-artifacts 0.2」并只列文件面；**不会**显示「这个项目没有产物」。
- **F34 产物卡 / U15 视觉**：线程展开面板内嵌产物缩略卡（标题 + 类型 + 版本 + 时间 + provenance），Library 列表同样是「小标题 + 计量 + 缩略卡」的 Claude `Artifacts ⌄` 形态；「打开产物库」按钮走宿主右栏 `sidebarRight.openTab("artifact", { params: { projectId } })`，服务缺失时按钮禁用并说明原因。
- **B3 复审 P0（`store.js` effort 白名单）**：`THREAD_EFFORTS = ["","low","medium","high"]` 会把本部署的 `max` / `xhigh` / `off` 静默清空、UI 还提示「已保存」。删掉白名单改为**非空即收**（只做 40 字符上限），`setThreadDefaults` 写→冷启动回读单测覆盖三档；冒烟用手填路径逐档写入并断言回读与审计。
- **B3 复审 P1（locale 落后 44 键）**：`locale/{zh,en}.json` 补齐 runtime 字典缺失的 44 个键，`settings.realtimeCiHint/On/Off` 改成与 B2 一致的「未实现、不会建 webhook」；新增 `test/locale-parity.test.js` 锁 runtime↔locale 的键集与文案值，冒烟再验一次线上口径。
- **B3 复审 P1（冒烟 flake）**：开局加**基础设施自检**——宿主端口不可连、插件未激活、`projects.json` 未落盘、浏览器脚本没有返回结果，一律打印 `INFRA` 并 fail-fast，不再把环境问题混进断言计数；把最有劣化风险的几处固定 `waitForTimeout`（toast 自动消失、会话行、归属菜单、详情打开、折叠状态回读）改成轮询等待。
- **B3 复审 P2**：`once` 凭据改为**所有闸通过且占位成功之后**才消费，执行没落地时由 `settle` 回滚（`folder/once-rolled-back` 审计），动作被拒不再烧掉授权；文件夹闸按**实际 cwd 所属目录**求 mode（`push-branch` 的 worktree 继承其项目目录授权，反查不到才退回 `dirs[0]` 并标 `inherited:false`），授权卡补 cwd 语义说明；`listMemoryFragments` 先校验项目存在再拼路径（`../` 不能再枚举 dataRoot 外目录名）。
- **验证**：`pnpm verify` EXIT=0（projects 单测 **572**，新增 17 条：locale parity 5 / Library 6 / once+cwd 4 / effort 1 / memory guard 1）；`pnpm smoke:projects` 见下一条报告计数（新增 ≥10 条断言，含 A 段每条修复与 B 段文件面/产物面写→回读、降级）。
