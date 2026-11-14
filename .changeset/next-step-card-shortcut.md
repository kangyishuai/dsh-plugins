---
"@kangyishuai/dsh-next-step": patch
---

卡片快捷键 `⌘↵` / `Ctrl+↵` 在真实会话里会静默失效：登记到宿主 fixed-input 通道的 effect 只依赖 `[sessionId, status]`，而卡片数据是投影**晚到**的（回合尾部先挂载、status 先变 interactive，卡片随后才进来），effect 不会为晚到的卡片重跑，于是卡片看着可点、点胶囊也正常，`⌘↵` 却没有登记上。把「卡片可见 / 有候选」纳入 effect 依赖修掉这个时序竞态，并补 `test/client-card-shortcut.test.js`（迷你 hooks 运行时驱动真实 client 源码，覆盖晚到卡、草稿非空、未揭示、已决策四种情形）。
