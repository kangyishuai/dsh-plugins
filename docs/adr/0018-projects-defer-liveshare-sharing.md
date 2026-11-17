# 0018. projects：项目共享（LiveShare）推迟到宿主提供稳定接口

- 状态：已接受
- 日期：2026-11-17
- 涉及：projects

## 背景

`projects` 规格的 M4 里列了一项「项目共享」：把项目面板与其中的会话授权分享给另一个人，
不做账号体系（多租户明确不做）。当时的设想是复用 DSH 官方的 LiveShare，而不是自建协作层。

实现前先做了勘察（DSH 0.2.2-rc.3，`/Applications/DeepSeek Harness.app/.../node_modules/@deepseek-ai`）：

- 存在两个包：`dsh-experimental-liveshare` 与 `dsh-experimental-liveshare-protocol`（版本与宿主一致，0.2.2-rc.3）；
- 但**桌面 profile 没有启用它**：`~/.dsh/profiles/desktop/package.json` 与 `cordis.patch.yml` 里都没有引用；
- 包内导出的是 host/typert/client 三份 bundle，读到的类方法集中在「共享注册、请求裁定、enforcement、
  owner HTTP 路由」等内部机制上，**没有**一个像 `workspaceRegistry` / `sessionController` 那样
  有文档、有稳定方法名、可直接 `ctx.inject` 的宿主服务。

## 可选方案

1. **按实验包内部形状硬接**：优点是可以"先跑起来"；缺点是依赖未公开的内部结构与未启用的插件，
   DSH 一旦改内部形状就会静默坏掉，而且我们无法验证真实协作语义（谁授权、权限边界、撤销）。
2. **自建协作层**（自己的传输 + 授权 + 租约）：优点是完全可控；缺点是等于做了多租户/远端存储，
   与已确认的范围（不做账号体系、不做多 Host 共享）直接冲突。
3. **推迟**，等 LiveShare 变成「已启用 + 有稳定宿主接口」再实现。

## 决定

选 **3：推迟**。理由：

- 本插件的定位是「本地、可审计、可撤回」，共享是**唯一需要跨进程身份**的功能，风险与不确定性最高；
- 在这台宿主的这个版本上，共享的输入（对端身份、授权范围、撤销时机）都无法被验证，
  而本插件的所有安全设计都建立在「授权来源可验证」之上（ADR 0002）；
- 硬接头两个未启用的实验包，会得到一个**看起来能用、但语义未验证**的功能——这比没有更危险。

## 影响

- `projects` 的 0.1.x 不含共享；README 与 changeset 的「尚未发布」清单里保持列出该项。
- 项目本身仍然是**单机多线程**的协作单元：隔离 worktree、审批队列、审计都不受影响。
- 重新考虑的条件（任一条满足即可重开）：
  1. DSH 把 LiveShare 从 experimental 提升，并在默认 profile 启用；
  2. 出现可 `inject` 的宿主服务（例如 `liveshare`），且文档写明「分享某对象给某人」的授权与撤销语义；
  3. 有第二个真实用户需要协作，并且愿意接受"共享范围以会话为单位"的最小形态。
