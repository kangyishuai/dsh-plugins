---
"@kangyishuai/dsh-btw": patch
---

复审 follow-up（2026-11-28 `batch-ui-2` B1/B2/B4）：

- **回退抽屉真正可达**：新增显式 `drawerFallback` 状态。右侧栏服务在、但 `openTab` 抛错或打开后 700 ms 仍没有 `[data-btw-panel]` 时，浮层抽屉现在真的会渲染（以前 `BtwDrawer` 在 `tabReady` 时直接返回 null，降级分支是死代码，用户只看到一条 toast）；再次成功 `openTab` 会清掉标记并收起抽屉，避免 tab 与抽屉同时在场。抽屉渲染判定抽成纯函数并用 `__test` 钩子驱动真实 `apply()` 的行为测试覆盖三条路径。
- **IME 判据补齐**：`shouldSubmitOnKey` 增加 `nativeEvent.isComposing`、`which === 229`、`key === "Process"` 与 composition ref 四条判据（对齐 projects 的 `isImeConfirmKey`），两个输入框都接 `onCompositionStart/End`；React 合成事件不暴露 `isComposing` 时不再误发送。
- 双语 README 写清面板降级形态；`docs/testing/btw.md` 的单测计数改真（notice 6、client 10、总数 118，冒烟默认段 +3 / `--deep` +2 / 改写 1 条）。
