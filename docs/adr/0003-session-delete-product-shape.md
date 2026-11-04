# 0003. session-delete 的产品形态

- 状态：已接受（2026-11-04 拍板；实现方案见 [ADR 0004](0004-session-delete-architecture.md)）
- 日期：2026-11-04
- 涉及：session-delete

## 背景

DSH 官方只支持**归档**会话（往 `workspace.json` 的 `archivedSessionIds` 加 id），日志文件原样留在磁盘上。session-delete 要提供真正的删除。

调研结论见 [notes/session-delete-research.md](../notes/session-delete-research.md)、[notes/research/](../notes/research/)、[runtime/0.2.1-rc.5.md](../runtime/0.2.1-rc.5.md) `6。三条关键事实：

1. **同类插件 ≈45 个**，回收站/恢复/批量/级联/撤销/自动过期都已有实现——功能列表不再是差异点。
2. 官方 API 没有删除接口，但提供了 `stat` / `open(id,'write')`（写租约探测）/ `locate(header)`（真实路径）/ 归档集合闸门 / `workspace/session-stop`，足够拼出安全删除。
3. 唯一结构干净的参考实现 `dsh-tool-session-delete`（MIT）是**硬删**，与 ADR 0002 冲突，只能借时序不能借产品决策。

## 待决策与建议

| 问题         | 选项                                   | 建议                                                                                            | 理由                                                                                     |
| ------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 删除是否可逆 | 硬删 / 移入回收站 / N 秒撤销           | **回收站**：`~/.dsh/session-trash/`，「彻底删除」是独立的第二个动作                             | ADR 0002 硬性要求；社区主流；可恢复是对用户最实际的保护                                  |
| 入口位置     | 会话行 "…" 菜单 / 设置页 / 两者        | **菜单（order 420）+ 侧栏底部「回收站」页**；阶段二再考虑设置页                                 | 菜单是主路径；回收站需要常驻入口；菜单项会随菜单卸载，确认框与面板必须挂 `shell.overlay` |
| 批量删除     | 支持 / 不支持                          | **第一阶段不支持**                                                                              | 45 个竞品里批量已饱和；先把单条路径做到零 bug                                            |
| 级联范围     | 静默连带 / 列出让用户勾选 / 完全不联动 | **列出子代理会话，由用户勾选**；默认只删目标会话                                                | 静默级联是数据事故高发点；工作区记账里的子会话必须处理，但「删不删」应由用户决定         |
| 运行中的会话 | 拒绝 / 先停再删                        | **先 stop 再删**，并在确认框标出 live                                                           | 官方 `session-stop` 正是为此设计；「拒绝」会让卡死的会话永远删不掉                       |
| dry-run      | 做 / 不做                              | **做**：`plan` 返回条目、体积、是否 live、有无子会话；UI 先展示再确认                           | ADR 0002 要求；社区仅 3 个实现有，且都不完整                                             |
| 审计日志     | 做 / 不做                              | **做**：`~/.dsh/session-trash/audit.log`（JSONL，一次操作一行）                                 | ADR 0002 要求；社区基本没有                                                              |
| 差异化卖点   | ——                                     | **删除回执**：删除后对账 `projcache` / 归档与置顶集合 / 工作区记账 / 搜索索引 / spill，报告残留 | 唯一没有竞品做完整，且与本仓库「不写死内部实现、能力探测降级」的取向一致                 |

## 技术形态（建议）

- host 半：`TypertRemoteService`，方法 `plan` / `trash` / `list` / `restore` / `purge`；能力探测失败时返回明确错误码而不是半删。
- client 半：`ctx.reflect.get("remote.sessionDelete")`；菜单项 `sidebar.workspaces.session.menu.item`（order 420）+ `shell.overlay` 里的确认框与回收站面板。
- 删除时序：`archiveSession({stopActivity:true})` → `workspace/session-stop` → `flush` → `open(id,'write')` 探租约 → `locate` 取路径 → **move 进回收站** → 清 projcache → `unarchive`/`unpin`/`detachSession` → 广播移除。
- 未核实的内部契约（`detachEntered`、`storageDomain`、`entry.detach()`、projcache 文件形态）一律走能力探测 + 降级，并在实现时实测后回填 `docs/runtime/0.2.1-rc.5.md`。

## 决定

采纳下表全部建议，并补充两条拍板结论：

1. **四根支柱 + 十项子功能都做**，但分两批交付（范围见 [ADR 0004](0004-session-delete-architecture.md) §范围）：v0.1 先把四支柱与单条路径做扎实，v0.2 再加批量、级联勾选、agent 工具、撤销 toast。
2. **「撤销」用「恢复」实现**，不做 5 秒计时器——省掉一处客户端状态与竞态，且与回收站语义一致。
