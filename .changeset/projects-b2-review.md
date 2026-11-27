---
"@kangyishuai/dsh-projects": patch
---

B2 复审修复：把「批准 / 派活」的入口真正接上，并清掉三处不可证伪的宣称。

- **P0 协调器工具从未注册**：`attachCoordinatorTools` 全仓零调用者，`project_thread_start` / `project_request_action` / `project_memory_*` 运行时不存在（F18「审批产生入口」与 F9「它派活」都是死代码）。现在注册逻辑抽到 `coordinator-tools.js`，在 `onAgentCreated` 与 `warmUpCoordinator` 两条路径幂等挂载，`agent/disposed` 时摘掉；单测断言 6 个工具注册 + 失败写审计不抛，冒烟断言审计里有 `coordinator/tools` 且 `count=6`。
- **F21 口径**：`autoFixStep` 补上手动入口「修一轮 CI」（只在 CI 失败时可点，结果回显，服务端写审计）；实验性实时监听开关改为 **disabled + 明确「未实现」**（需要 gh-webhook 扩展与仓库管理员），README / changeset 里「会建临时 webhook」的宣称删掉。
- **F24 effort**：模型下拉旁新增 effort 下拉（数据来自 `modelCatalog().groups[].models[].reasoning.efforts`），`selectThreadModel` 传 `reasoningEffort` 并回读 `modelSelection`（以前只传 provider/model）。
- **F20 断言可证伪**：冒烟真的点 Create PR，断言行内动作条出现且原因是决策层真实原因（`no-commits` 等）；删掉 `openPr` 调用只会得到 `unknown`，这条会红。
- **F17 订阅单测**：`todo/write` → `reduce` 后 `todoItems` 非空（行 `tasks` 的来源），并用源码守卫钉住 `session/event` 订阅与事件回写。
- **写路径单测**：`sendToCoordinator` / `steerThread` / `selectThreadModel` / `createPr` 抽到 `write-paths.js`，用假 `sessionController` 断言 `mode:'queue'|'steer'`、`content:[{type:'text'}]`、`reasoningEffort`、signal 必传与错误信封。
- **P2**：删掉零调用者的 `threadTasks` RPC；跨项目移动冲突错误本地化；协调者 user 气泡按「同角色同文本 + 5s 窗口」去重；`defaultPolicy`/`normalizePolicy` 补 `pr.tier`（按项目 opt-out）；`setThreadState('resolved')` 维护 `resolvedAt`；`mergeRecord` 映射 `waiting-user`（盘上读回不再变 idle）；`createProject` 超限目录改为显式拒绝（不再静默截断）；`runCommand` 加 30s 超时（gh 卡住不再把轮询 inFlight 永久占住）；README 两条矛盾的 0.10.x 行合并。
