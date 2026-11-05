# 0004. session-delete 的架构：三内核 + 两阶段提交 + 能力降级

- 状态：已接受
- 日期：2026-11-04
- 涉及：session-delete
- 关联：[ADR 0002](0002-destructive-operations.md)、[ADR 0005](0005-dsh-version-compatibility.md)、[调研索引](../notes/session-delete-research.md)

## 背景

产品形态见 [ADR 0003](0003-session-delete-product-shape.md)（回收站 / plan / 审计 / 对账四支柱），同类插件矩阵见 [research/feature-matrix.md](../notes/research/feature-matrix.md)：55 个同类里四项全有的是 0 个，但单看回收站已有 16 个。所以要赢只能赢在**组合的严密性与工程质量**，而不是功能数量。

约束：plain JS + JSDoc 无构建（ADR 0001）、破坏性操作默认可恢复（ADR 0002）、不写死 DSH 内部实现（AGENTS.md 硬性约定 1）。

## 决定

### 1. 十项功能收敛成三个内核

| 内核                   | 形态                                                      | 覆盖                                                     |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `plan(sessionId)`      | **纯函数**：输入快照，输出 Plan（无 IO 副作用）           | plan/dry-run、确认框影响面、级联范围、agent 工具前置校验 |
| `refs`                 | 适配器表：7 处引用 × { probe, snapshot, remove, restore } | 对账、恢复、删除回执、健康检查                           |
| `move(sessionId, dir)` | 原子移动（同卷 `rename`；跨卷回退 copy+verify+del）       | 入回收站、恢复、彻底删除                                 |

**plan 是唯一真相源**：执行前用同一函数重算并与计划里的 `digest` 比对，不一致就中止并要求重新确认。这一条同时消灭「预演与执行漂移」和「确认框打开期间会话多了一个子代理」的 TOCTOU。

### 2. 文件结构（8 个 host 文件 + 1 个 client 文件）

    lib/capability.js  宿主能力探测（一次，缓存）→ { tier: "api" | "internal" | "unknown" }
    lib/paths.js       数据根解析 + 安全校验（realpath、白名单、ID 正则）
    lib/refs.js        7 处引用的适配器表
    lib/plan.js        纯函数
    lib/journal.js     两阶段提交：intent → 执行 → done
    lib/trash.js       原子移动 + meta.json
    lib/audit.js       append-only JSONL，进程内串行队列
    lib/reconcile.js   表驱动核对 → 回执 receipt
    lib/service.js     TypertRemote：plan/trash/restore/list/purge/reconcile/audit/health
    lib/index.js       apply(): 探测 + 注册
    lib/client.js      一个 store + 三处注册（菜单项 / 确认框 / 回收站面板）

### 3. 破坏性操作走两阶段提交

`~/.dsh/session-trash/journal/<op-id>.json`：先写 intent（动作、目标、plan digest、时间），执行，最后写 done。启动时扫未完成的 op：能补做就补做，不能就回滚到可解释状态，并写审计。**没有 journal 的「安全删除」在断电面前不成立。**

### 4. 能力三档，unknown 一律拒绝

`capability.js` 只在一处维护「我们依赖哪些宿主能力」：

| 档         | 含义                                                             | 行为                         |
| ---------- | ---------------------------------------------------------------- | ---------------------------- |
| `api`      | 官方文档/类型里有的公开成员                                      | 正常执行                     |
| `internal` | 只在社区实现里见到的内部契约（`detachEntered`、`storageDomain`） | 执行 + 警告 + 记审计         |
| `unknown`  | 探测不到                                                         | **拒绝执行并说明**，绝不半删 |

### 5. 删除时序固定为七步

`archive(stopActivity)` → `workspace/session-stop` → `flush` → settle(~200ms) → **move 到回收站** → 摘登记表 + 清引用 → 1.5s 后复查原路径（复活守卫）。

先归档再停，是因为归档集合本身就是 provider `agent/pre-step` 的闸门；先移文件再摘登记表，是为了任何一步失败都停在「行还在、文件也在」的可解释状态。

### 6. 不用 `open(id,'write')` 做「有无活写者」探针

官方 JSONL 后端文档明确：对历史格式会话，write-open 会**发布新一代文件、写盘、占住 flock**。放进 plan 等于「点开确认框就改了磁盘」。liveness 改为两个只读信号：`ctx.sessions.get(id)` + `workspace/session-activity` waterfall；真正的写者竞争交给 `rename` 的 `EBUSY/EPERM` 退避重试兜底。

### 7. 三条性能纪律

- 不解压、不读日志正文（标题/体积来自 `stat().header` 或 `meta.json`）；
- 面板不调 `sessionPersistence.list()`（历史格式的 stat/list 成本与全库会话数成正比）；
- 除「健康检查」外不做全库扫描。

### 8. 「撤销」= 恢复，不设计时器

5 秒撤销条要引入客户端计时状态与竞态，收益和回收站恢复完全重叠。做法：删除成功的 toast 里给「撤销」按钮，直接调 `restore`。

### 9. 级联默认关闭

默认只删目标会话；确认框展示子会话数量与标题，由用户勾选是否一起删。静默级联是数据事故高发点。

## 范围与顺序

| 里程碑 | 内容                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1   | 四支柱 + 单条路径：capability / paths / plan / trash / restore / reconcile(单 id) / audit / purge / 菜单 + 确认框 + 回收站面板（含审计页签）                                              |
| v0.2   | 健康检查全库扫描、删除回执、面板的审计/体检/回执页签（**已随 0.2.0 发布**）                                                                                                               |
| v0.3   | 级联勾选、agent 工具（两段式 plan→token→delete，拒绝删除调用者）、外部删除后列表与角标自动刷新（**已随 0.3.0 发布**）                                                                     |
| v0.4   | minimal 能力档（没有 workspaceRegistry 的宿主仍可删除）、回收站内批量恢复/批量彻底删除、对话框长内容内部滚动（**已随 0.4.1 发布**；0.4.0 的「活跃会话批量删除」页签方向错误，0.4.1 已撤） |

## 影响

- 代码量约 host 700–900 行 / client 500–700 行 / 测试 400 行，零依赖零构建。
- v0.1 不碰 `list()`、不碰日志正文，性能预算：plan < 5ms、trash/restore < 20ms、200 条面板 < 50ms。
- 代价：v0.1 的 UI 只有「一条会话 + 一个回收站面板」，没有批量与级联，功能上打不过 `dsh-recycle-bin`，但四支柱完整度是 55 个里唯一的。

## 落地验证结果（0.2.0–0.4.1，已回填 [runtime](../runtime/0.2.1-rc.5.md)）

1. `sessionPersistence.locate()` / `stat().header` —— 字段与文档一致，plan/trash 全程使用；
2. `sessions.get` / `detachEntered` / `store` —— 桌面版可用（能力档 `api`）；缺失时降级为 `minimal`，跳过宿主内存条目清理；
3. `storageDomain.get("session_projcache")` —— 表名与删除语义符合预期，回执里会逐项列出清理结果；
4. `workspaceRegistry.unarchiveSession/unpinSession` —— 恢复路径实测可用；`minimal` 档会跳过并标记；
5. projcache 形态 —— 分片 + 总表，删除时两者都清；冷读不会重建空壳行。

仍未实测：Windows 下的 `EBUSY/EPERM` 与命名信号量路径（见 README 兼容性说明）。
