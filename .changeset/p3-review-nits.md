---
"@kangyishuai/dsh-advisor": patch
"@kangyishuai/dsh-projects": patch
"@kangyishuai/dsh-casefile": patch
"@kangyishuai/dsh-session-rewind": patch
---

复审 P3 收口：四个插件的用户可见 / 低风险可验证 nits（不含纯重构）。

- **advisor（回执视觉间距）**：回执/轻提示仍贴 composer 上沿，但 `gap` 量的是 `[data-composer-input]`
  顶部，而 composer 卡片顶部还高约 8px（卡片内边距/边框），实际卡片视觉间距只有 4px。`TOAST_LAYOUT.gap`
  12 → 16（= 目标视觉 8px + 卡片 8px），回退 24px / resize / ResizeObserver 路径不变；补「输入框
  top=700 时回执底边到卡片顶 = 8px」断言与 7×8 视口/位置扫描的不变量测试（`bottom ≥ 24`、
  `bottom + maxHeight + edge == viewport`）。
- **projects（注释/实现一致性）**：`routineDraftAfterCreate` 注释承诺「失败 / 无结果保留输入」，
  实现只挡 `{ok:false}`；补 `!result` 分支并加 `null` / `undefined` 断言（生产路径不可达，属防御性对齐）。
  Debug 分区保存状态行注释补上「通知开关」（N1 修复后它也走同一行）。均为注释/防御性对齐，无用户可见行为变化。
- **casefile（概览卡 p/q）**：概览卡渲染条件从服务端 `overview.summary` 改为结构化事实
  （`projects / obligations / openUnknowns / byKind`），宿主不返回 summary 时不再整卡消失；无义务时
  `obligations 0/0 closed` / `义务 0/0 已关闭` 改为「义务：已关闭 0 / 共 0」/「obligations: 0 of 0 closed」
  （total>0 文案不变）。渲染断言中英两套，含「无 summary 仍有卡」「空对象不渲染」两个反向用例。
- **session-rewind（复审 N3/N4/N10/N11）**：
  - N3 回收站「清空」内联确认补默认聚焦：主按钮在执行前带 `data-modal-autofocus`（执行中回落「取消」），
    浮层焦点 effect 增加清空状态依赖，并用内联确认优先的选择器避免被抽屉页签抢走焦点。
    `test/overlay-focus.test.js` 真跑 `RewindOverlay` 的 effect 驱动五态焦点；改回旧选择器或去掉新
    deps 时该测试会红（复审 M4 不再存活）。
  - N4 缺失 trash id 改用新错误码 `session-rewind/trash-not-found`（中英文案「回收站记录不存在…」），
    不再误报「部分文件处理失败」；部分恢复失败时从 `error.details.files` 取 restored/failed 数量，
    显示「已恢复 N / M 失败」并刷新回收站与审计列表。
  - N4 线缆形状修复（复审 B1）：本插件 `rethrowRemote` 原先把 details 包成 `{ details: … }` 交给宿主
    `RemoteError`，而 rc.5 签名第三参就是 details（gateway 原样透传）→ 客户端拿到双层包装，
    `trashPartialOf` / `conflictPathsOf` / `failedPathsOf` 全部读不到。抽 host-free `remoteFailureOf(error)`
    平铺 details 后，部分恢复 toast 才真正可达；新增「service → gateway → client」契约测试
    （把包装改回去时 5 条测试红）。
  - N10 启动/维护 GC 对 entries 读失败 fail-closed：任一会话 `readEntries` 失败就本次不删任何 blob
    （返回 `skipped: "entries-unreadable"`），service 记 warn；超软上限流程遇到 skipped 停止再删 anchor。
  - N11 历史 audit 行（0.7.0 及以前，缺 `removedMessageCount`）在 History 页签改用中性「撤回 N 条上下文
    记录」文案，不再把节点数标成「用户/助手消息」；新行口径不变。

已知竞态（非本批引入、本批不修）：设置自动保存不做串行化/去抖，快速连续修改时最终落盘值不一定是最后
一次操作、过期响应依赖各插件自己的保存序号/状态行兜底。该限制已如实记录在
`docs/testing/projects.md`「已知（自动保存非串行）」与 `docs/testing/session-rewind.md`
「已知竞态（非本批引入，如实记录）」，后续单独立项处理。
