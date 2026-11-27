---
"@kangyishuai/dsh-projects": patch
---

第二轮复审的 P2/UI 收尾（无行为破坏）：

- 设置抽屉：`role=dialog` + `aria-modal`、Esc 关闭、关闭后焦点归还触发按钮；字段标签 `white-space: nowrap`（400px 下不再两行）
- 回收站只在「通用」分区出现（以前详情页 Context 段在通用/环境/调试三处各渲染一份）
- 项目行不再显示 `#id` 噪声，完整 id 挪到 `title`（重名仍可区分）
- 空态删除重复的同名「新建项目」CTA（头部保留一个）
- 迷你图：零值柱改用 accent 色 + 透明度（原 border 在深色下 ~1.5:1）、容器 `role=img` + 汇总 `aria-label`、空态不再重复 caption
- 删除确认框：`aria-labelledby`/`aria-describedby` 指向标题与影响面；影响面 summary 过滤空段落（修 `· ·`）
- 文案统一：状态词「进行中」→「在跑」、`自动 resolve`→`自动解决`、手填提示去掉英文 `effort`

验证：`pnpm verify` **706**；web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**；`pnpm gate projects` EXIT=0（桌面 17 PASS）。
