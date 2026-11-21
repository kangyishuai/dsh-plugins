---
"@kangyishuai/dsh-projects": minor
---

补「一键建项目模板」（规格 §7.7.6 / 计划 B6）：`createProject(name, { dirs, template: true })`
会建目录、写一份 `instructions.md` 骨架。

- **绝不覆盖**：写盘用 `writeFileSync(..., { flag: "wx" })`，已有 `instructions.md` 直接跳过并记审计
- **已有 `AGENTS.md` 时不动它**，只在新骨架里加一行「两者都会注入，请避免写重复内容」，
  与 spec §3.3 的去重口径一致
- 重复调用幂等；模板创建失败**不阻断**建项目（只写审计 `project/template-failed`）

真机验证：新目录被建且骨架写入；已有 AGENTS.md 内容逐字节未变；同目录再建一次不覆盖。
新增 6 项单测。
