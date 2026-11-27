---
"@kangyishuai/dsh-casefile": patch
---

复审 follow-up（2026-11-28 `batch-ui-1` A1–A4/A6）：

- **审计来源可区分**：危险操作（drop / restore / purge / restore-failed）不再把所有审计行硬编码成 `actor:"user"`。`case_project` 工具路径显式记 `actor:"agent"` 并带上会话 `sessionId`，回收站 UI（Remote）显式记 `actor:"user"`，直接调用的脚本没传来源则如实记 `unknown`——`audit.jsonl` 现在能回答「这次 drop 是用户点的还是模型自己决定的」。
- **危险操作可访问性**：展开「危险操作」时焦点进主按钮；dry-run 影响面出现时焦点移到「取消」（以前焦点掉到 `document.body`），预览卡带 `role="alert"` + `aria-live="polite"`；取消后焦点还回入口。vm 测试驱动真实 `client.js` 断言三条焦点路径。
- **文档**：双语 README 的卸载残留清单补 `builder-sessions.jsonl`，数据布局树与卸载清单对齐。
- **冒烟诚实性**：桌面只读脚本新增「危险操作默认收起（`details.open === false`）」断言；空 profile 上 4 条危险操作断言由「记 PASS」改为 SKIP 并计数，不再假绿。
