---
"@kangyishuai/dsh-projects": patch
---

修 0.7.0 验收时踩到的两个问题。

- **相对路径被静默接受**：项目目录填 `relative/plain` 也能"保存成功"，直到建线程时才在宿主里崩，
  报错是 `session header cwd must be an absolute path, got "undefined/plain"`——用户完全对不上号。
  现在绑定前当场校验：不是绝对路径直接拒绝，并提示「需要绝对路径（以 / 开头）；相对路径无法作为会话目录」。
- **文案里的 Markdown 泄漏**：非 git 目录提示写成 `**共享这个目录**`，界面不渲染 Markdown，
  用户看到的是字面星号。已去掉。

冒烟 69 → **70** 项（新增：相对路径当场拒绝并说明原因）。
