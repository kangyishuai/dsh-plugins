---
"@kangyishuai/dsh-projects": minor
---

项目主页对齐 Claude Projects 的 Overview（B1）：六态状态机（等你 / 失败 / 在跑 / 待审 / 空闲 / 归档，事件回写持久 `state`）、分组折叠 + 五类药丸条过滤（`~Nm` 只在能从已观测步进节奏估计时显示）、行解剖（副标题取最近 `tool/call` 的可读摘要，步进环取 `todo/write` 快照，没有 todo 显示「—」而不是 0/0）、`Welcome back` 头 + 7 日 token 迷你图、手动 resolve/重开与未读标记、项目切换器、一次性首启引导（`firstRunDone` 存宿主 `storageDomain`）、Context 多选（目录 ≤10 + 仓库 owner/repo）与多目录线程。web 端到端冒烟 102 → 133 条；桌面只读回归随新锚点更新（本阶段未重启桌面版复跑）。