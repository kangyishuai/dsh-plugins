---
"@kangyishuai/dsh-projects": patch
---

修「被拒绝的申请也被占用」：把幂等占位与执行结果拆开（claim / release）。

**之前的行为**：`executedAt` 在闸门之前就写入，所以只要点过一次「执行」——哪怕因开关没开、
影响面超阈值而被拒——这张申请就再也不能执行，必须让协调器重新申请。

**现在**：
- `claimApproval()` 只占位（`claimedAt`），并发第二次得 `already-claimed`
- 执行**成功**才落 `executedAt`（+ evidence），并清掉占位
- 被拒绝或失败一律 `releaseApproval()`，**同一张申请可重试**
- 已执行的申请不能占位、也不会被释放（`already-executed`）

真机验证（临时宿主）：同一张 `purge-trash` 申请先返回 `switch-off`，打开开关后再次执行
**同一张申请**返回 `executed:true`，第三次返回 `already-executed`；最终
`{status:"approved", claimedAt:null, executed:true}`。

322 项单测（新增 5 项 claim/release 语义）全绿。
