---
"@kangyishuai/dsh-projects": patch
---

设置与线程行的 P2 收尾：

- 项目设置抽屉页签 **5 → 3**（通用 / 记忆 / 环境），用量与调试并入「环境」分区（plugin-conventions §7 页签 ≤3）
- 线程行「展开」改成图标（`⌄`/`⌃`，aria-label 保留「展开/收起」）并提到 0.6 不透明度，400px 右栏不再挤成两行
- 行尾 meta `flex: 0 0 auto`，不再被挤到第三行
- 触达尺寸：设置图标 26×26、麦克风 24×24 盒子、composer 模型药丸 min-height 24

验证：`pnpm verify` 706、web 冒烟 270 PASS/0/0、`pnpm gate projects` EXIT=0。
