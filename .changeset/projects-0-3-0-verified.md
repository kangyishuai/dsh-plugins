---
"@kangyishuai/dsh-projects": patch
---

0.3.0 装进 live profile、**重启桌面版后**复跑门禁，结果写进兼容表：

- 桌面只读回归 **11 PASS / 0 SKIP / 0 FAIL**
- web 端到端冒烟 **52 PASS / 0 SKIP / 0 FAIL**（含 0.3.0 新增的执行按钮/仓库授权/回收站清理两块）
- `pnpm gate:all --plugins projects` 全绿（64s）

0.3.0 改了 client 半，所以这次特别确认了「重启后新 UI 真的加载」：项目面板正常渲染
（该 profile 里没有项目，详情页两块由临时宿主的 web 冒烟覆盖）。
另把 README 的「309 项单测 / 50 项冒烟」更新为 317 / 52。
