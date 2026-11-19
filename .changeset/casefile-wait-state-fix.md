---
"@kangyishuai/dsh-casefile": patch
---

修等待登录横幅不出现的根因：`installSessions()` 重建 actions 时**漏了 `onWaitChange`**，于是 `await-login` 期间 host 的等待状态从未被设置，`accessState` 恒为 `{active:false}`，client 覆盖层自然不渲染。

- 抽出 `actionOptions()`，构造函数与 `installSessions()` 共用同一份选项（含 `onWaitChange`）；
- 新增单测：`await-login` 必须上报一次等待态（`active:true`）并在结束时清空（`null`）。

实测证据：重启后跑真实 `await-login`（18s 超时路径），DSH 窗口里连采 18 次、`active` 全为 false、横幅 0 次出现 —— 定位到 host 侧状态根本没设。
