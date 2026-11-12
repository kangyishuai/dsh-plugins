# @kangyishuai/dsh-session-delete

## 0.4.9

### Patch Changes

- [#81](https://github.com/kangyishuai/dsh-plugins/pull/81) [`d8e4c5a`](https://github.com/kangyishuai/dsh-plugins/commit/d8e4c5a94d28d4b725018c4dacb3f24bea43ec55) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Fix the trash-count badge's text colour in the dark theme.
  
  The badge paired its theme-adaptive fill (`--dsw-alias-state-error-primary`) with a hardcoded `color: #fff`. In the dark theme that fill is a *light* red (`#f25a5a`, designed for a dark foreground), so white-on-red dropped to **3.29:1**; pairing it with the host's `--dsw-alias-label-primary-foreground` gives 5.75:1 there and keeps 4.5:1 in the light theme.
  
  The foreground is now a named token (`dangerText`) next to the fill, and a regression test asserts the pair, plus that every theme token in the design map really exists in the host theme (a misspelt `var()` silently falls back to a hardcoded colour and stops following the theme).

## 0.4.8

### Patch Changes

- [#68](https://github.com/kangyishuai/dsh-plugins/pull/68) [`0fd4faa`](https://github.com/kangyishuai/dsh-plugins/commit/0fd4faa2c8ed893961d9b4bffac29ba0efd5ba5d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - macOS：自绘确认框 fallback 的遮罩声明 `data-window-drag-exclude`，覆盖页头时拖动不会再拖走整个 DSH 窗口。

## 0.4.7

### Patch Changes

- [#36](https://github.com/kangyishuai/dsh-plugins/pull/36) [`9bb615e`](https://github.com/kangyishuai/dsh-plugins/commit/9bb615e7369a604200d50333835eb154ce9e5354) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Use a template literal for the health-cleanup audit detail (Biome `useTemplate`), so `biome ci --error-on-warnings` stays clean on CI.

## 0.4.6

### Patch Changes

- [#35](https://github.com/kangyishuai/dsh-plugins/pull/35) [`01070d1`](https://github.com/kangyishuai/dsh-plugins/commit/01070d1f53e78aed4bc162de2123b23488264b9c) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Repository description and topics now cover both plugins (rewind and delete), so the packages are discoverable from the GitHub side as well.

## 0.4.5

### Patch Changes

- [#31](https://github.com/kangyishuai/dsh-plugins/pull/31) [`52d86f0`](https://github.com/kangyishuai/dsh-plugins/commit/52d86f02372073d8fe7ee471881b125ed7e7d356) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Tag the injected stylesheet with `data-plugin` so it is identifiable in DevTools (and by tests) as belonging to this plugin, matching the sibling plugin.

## 0.4.4

### Patch Changes

- [#6](https://github.com/kangyishuai/dsh-plugins/pull/6) [`83b4bd3`](https://github.com/kangyishuai/dsh-plugins/commit/83b4bd38d989e1f27302296cbb2231698f374b67) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 兼容性记录：补充 DSH 0.2.2-rc.1 的验证结果（`pnpm smoke:session-delete` 24 项断言全绿、插件在桌面版正常激活），README 徽章与兼容表更新到新宿主版本。

## 0.4.3

### Patch Changes

- [`03fc41b`](https://github.com/kangyishuai/dsh-plugins/commit/03fc41bb526ee0bf08e284dc2f48196c73f4090e) Thanks [@kangyishuai](https://github.com/kangyishuai)! - README 增加截图（演示数据生成）与 npm / DSH 版本徽章。

## 0.4.2

### Patch Changes

- 文档同步：兼容性章节改为「三层防线 + 四档能力」（api/internal/minimal/unknown），
  补齐 0.4.x 的批量与刷新行为说明，并标注仅 macOS 实测、Windows 路径未验证。

## 0.4.1

### Patch Changes

- 批量操作移到回收站页签：勾选条目后可以全选、清空、批量恢复、批量彻底删除；
  移除原先那个列出活跃会话的「批量」页签。对话框内容区限制高度并支持内部滚动。

## 0.4.0

### Minor Changes

- 回收站面板新增「批量」页签：列出会话、多选后一次删除（逐条进回收站，
  单条失败不影响其它），结果写进回执（action=trash-many）。一次最多 50 条。

- 新增 minimal 能力档：宿主没有 workspaceRegistry（如 headless 组合）时仍允许删除，
  归档闸门与工作区记账步骤跳过并在回执中标记；只有持久化本体缺失才进入只读模式。

## 0.3.0

### Minor Changes

- 新增模型工具 session_delete：两段式 plan → 一次性 token → delete。
  拒绝删除调用者自己的会话；会话在预览后变化会让 token 失效；回执记录
  operator=agent，便于区分人工与模型操作。

- 删除确认框支持级联：通过 parentSession 血缘（任意深度）+ live 子代理活动
  发现子会话，默认不删，勾选后父会话与子会话分别进入回收站（可分别恢复），
  回执里记录每个子会话的结果。

### Patch Changes

- 模型工具对已删除的会话再 plan 时返回 code=not-found，而不是笼统的 error。

- 修复外部删除（agent 工具、另一个窗口、CLI）后列表不刷新的问题：
  客户端每 10 秒轮询一次会话列表、页面重新可见时立即拉取，已删除的行会自动消失；
  同一轮询也会刷新侧栏页脚回收站的计数（agent 工具/另一个窗口的删除同样反映）。

## 0.2.0

### Minor Changes

- 新增两个页签：**体检**对账会话存储与工作区记账，报告归档/置顶幽灵、工作区
  记账失效条目、孤儿会话目录、损坏的回收站条目与未完成操作（清理只动登记表，
  写入审计）；**回执**展示每次删除/恢复/彻底删除/清理的机器可读记录。

## 0.1.0

### Minor Changes

- 首个版本：真正的会话删除能力——默认移入回收站（可恢复）、删除前列出影响面的
  plan 预演、每次操作写审计日志，以及删除后的对账回执。
  
  版本从 0.0.0 起步，本 changeset 在发版时产出 0.1.0。
