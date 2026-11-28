---
"@kangyishuai/dsh-advisor": patch
"@kangyishuai/dsh-projects": patch
"@kangyishuai/dsh-casefile": patch
"@kangyishuai/dsh-btw": patch
"@kangyishuai/dsh-session-delete": patch
---

发版后真机复审发现的一组用户可见缺陷：

- **advisor（P2，遮挡输入区）**：命令回执/轻提示原来固定在 `right:24px;bottom:24px`，1280×820 有会话时
  回执盖住 composer（y=700–736）与发送按钮（y=748–782）。改为渲染时测量 `[data-composer-input]` 顶部、
  `bottom = innerHeight - composerTop + 12`（无 composer 回退 24px），resize / composer 变高时重算；
  回执 `max-height` 按可用空间收缩，避免顶出视口。纯函数（`toastBottomOffset` 等）有单测，桌面冒烟新增
  「回执与 composer/发送按钮无重叠」几何断言。
- **projects（O1/O3/O4）**：① 列表页删除项目后回收站区块不即时刷新（仍显示「回收站是空的」直到整页刷新）——
  删除成功 bump `trashEpoch`，回收站按 `reloadToken` 复用既有 `listTrash` 路径重载；② Routine 删除没有确认框
  （会撤掉宿主定时任务并丢历史，违反 ADR 0002）——新增一行影响面（routines 名/频率/宿主 scheduleId/投递状态/
  不可恢复性）、默认聚焦主按钮、Esc/取消，确认后才执行；③ Routine 创建成功后表单不清空、容易重复建——
  成功清空名字/指令并把频率/时间回默认，失败保留输入。
- **casefile（A5）**：概览卡渲染服务端中文 summary 与原始 kind 枚举（`binary × 1`）。改为按结构化字段 +
  locale 组装摘要，kind 走本包既有 `vocab` 中英映射；补 i18n parity 与真实页面渲染测试（中英两套断言）。
- **btw（B7）**：`/btw` 执行回执是 `div + onClick`，键盘不可达。改为 `role="button"` + `tabIndex=0` +
  Enter/Space 触发、默认聚焦环样式；点击开面板的既有行为与 toast 样式不变。
- **session-delete（O2，真机复审归到 projects 条目但代码在本包）**：删除确认框写「正在运行，会先停止」，
  但侧栏同一会话显示「空闲」——`plan.live` 实为「会话已在本机宿主进程注册」而非「回合在跑」。影响面改述为
  「本机已打开，会先关闭」（英文 `open in this window; closed first`），不再声称正在运行；确认时 digest
  校验继续拦截预览后变化。

另修正两条与本次改动无关、但会让 `pnpm verify` 随本地时段/并行负载随机变红的既有计时用例
（advisor 账本恢复注入可测时钟、btw 设置保存态改状态轮询），生产行为不变。
