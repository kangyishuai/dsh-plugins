---
"@kangyishuai/dsh-btw": patch
---

修复转正把主 composer 撑高、以及 `/btw` 命令结果走英文 FALLBACK：

- 转正草稿按当前输入框实际宽度收进 6 行：短线程保留四节 Markdown 源码，长线程改成「首问 + 结论开头」摘要并在末尾指回「旁问」面板（完整答案仍在面板里）。0.6.0 的长线程会插入 1262 字草稿，在窄输入框里渲染约 62 行、把可视对话区从 528px 压到 316px。
- host 半把语义分层的 `locale/*.json` 摊平映射回平面键，并在注册 `/btw` 前同步加载 locale；命令描述与结果文案不再落到英文 FALLBACK（DSH 宿主没有 host 侧 locale 服务，命令文案逐字透传，见 `docs/runtime/0.2.2-rc.5.md` §8.1）。
- 桌面回归 `--deep` 新增「转正后主 composer 不超过 6 行」断言；单测 59 → 65。
