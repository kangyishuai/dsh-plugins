# 0003. session-delete 的产品形态

- 状态：提议中
- 日期：2026-11-04
- 涉及：session-delete

## 背景

DSH 官方只支持**归档**会话（往 `workspace.json` 的 `archivedSessionIds` 里加 id），日志文件原样留在磁盘上。session-delete 要提供真正的删除。调研记录见 [notes/session-delete-research.md](../notes/session-delete-research.md)。

## 待决策

| 问题         | 选项                                        | 倾向                      |
| ------------ | ------------------------------------------- | ------------------------- |
| 删除是否可逆 | 硬删 / 移到回收站 / 支持 N 秒撤销           | 回收站（ADR 0002 的要求） |
| 入口位置     | 会话行 "…" 菜单（order 420）/ 设置页 / 两者 |                           |
| 批量删除     | 支持 / 不支持                               |                           |
| 级联范围     | subagent 与 fork 子会话是否一起删           |                           |
| 运行中的会话 | 拒绝 / 先停再删                             |                           |

## 决定

（调研清单完成后填写，然后把状态改成「已接受」。）
