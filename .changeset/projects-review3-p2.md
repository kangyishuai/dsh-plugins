---
"@kangyishuai/dsh-projects": patch
---

第 3 轮复审遗留 P2 收尾：

- 删除预览与真实 busy 同源：`previewDeleteProject` 变 async，用 `liveSessionFacts + threadBusy` 算「在跑」，影响面会写「N 个在跑/等你（删除会被拒绝）」
- 会话已被宿主删除（`state()` 查不到且 `list()` 也没有）时，不再因记录里的 `working/waiting-user` 永久阻塞删除
- PR 轮询按 `(仓库, PR 号)` 分组：多目录项目每个仓库各跑一次 `gh pr list`，不再拿 repoA 的 CI 状态写 repoB 线程
- 回收站恢复时跳过「同一 sessionId 已被别的项目占用」的线程记录，并在审计里写 `skippedThreads`
- `waiting-user` 在 turn 中途（已有 turn/start、尚无 turn/end）仍采信记录，避免 journal 缺 `interaction/pending` 时误判成 failed
- 修复 `liveCache` 拼写（实际字段是 `liveStateCache`），resolve/reopen 后缓存真正失效
- UI：设置分区 tablist 补 `aria-label`；右栏 Routines 入口中英混排改「打开定时任务 / 提醒」
