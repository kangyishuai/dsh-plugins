# projects 测试清单

> 目的：证明四件事，而不是靠感觉点两下——**上下文真的注入了**、**线程真的隔离**、**状态真的从事件推导**、
> **回收真的不会删用户东西**。三层：**纯函数单测 → web 端到端冒烟 → 桌面只读回归**。
> 前两层每次提交都跑；第三层发版、DSH 升级、以及改动客户端私有 seam 后必须跑。

## 0. 测试环境

**一律在临时 `DSH_HOME` 里跑**：真实 profile 里跑会往你的 `projects.json` 里写测试项目。

```bash
# 打包（link: 安装不可用，见 docs/runtime/0.2.1-rc.5 §6.9）
cd packages/projects && pnpm pack --pack-destination /tmp

H=/tmp/dsh-test-projects
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/proj
DSH_HOME=$H dsh plugin --profile proj install
DSH_HOME=$H dsh plugin --profile proj add /tmp/kangyishuai-dsh-projects-0.0.0.tgz
DSH_HOME=$H dsh --profile proj --port 0 --no-open   # 终端会打印带 token 的 URL
```

临时 home **不要**放 `.credentials.yaml`：冒烟刻意不发起模型调用。`pnpm smoke:projects`
还会主动清掉 `API_KEY|_TOKEN|SECRET|PASSWORD` 类环境变量，让"不花 token"成为可验证的主张。

## 1. 自动化（每次提交）

```bash
pnpm verify                     # lint / typecheck / 规范 / 文档 / 公开边界 / 全部单测
pnpm smoke:projects             # web 端到端（临时 DSH_HOME + 真实宿主 + ego-browser）
pnpm smoke:projects-desktop     # 桌面只读回归（需要 --remote-debugging-port=9222）
pnpm gate projects              # 发版门禁：上面三项 + 宿主能力体检
```

`packages/projects/test/` 覆盖：

| 文件                | 证明什么                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `store.test.js`     | 仓储：原子写、损坏文件**改名隔离不删除**、未来格式拒绝、旧字段补齐、默认策略 L1               |
| `context.test.js`   | 渲染：16k 预算的裁剪顺序、记忆索引裁剪、**不与宿主已加载的 AGENTS.md 重复**                   |
| `attach.test.js`    | 注册：全局注册一次、按 context 里的 agent/session 求值；未归属/归档返回空串；渲染异常不炸请求 |
| `overview.test.js`  | 状态机：五态迁移、`turn/start` 清失败、**失败从 `assistant/attempt` 判**、`replay` 重建、排序 |
| `worktree.test.js`  | 命名与路径（**防目录穿越**）、命令计划（默认不加 `--force`）、porcelain 解析、回收三重判据    |
| `thread.test.js`    | **真 git 集成**：建隔离线程、非 git 降级、建失败降级、脏工作区拒绝回收、启动对账              |
| `index.test.js`     | 清单自检：`dsh.bundle.patch` 存在、`files` 白名单逐项存在、**不把宿主包声明成依赖**           |
| `budget.test.js`    | 预算闸：暂停/归档优先、每日线程数、并发数、token 分桶（缺 `usage` 时不误判）                  |
| `trash.test.js`     | 删除安全：回收站路径（防穿越）、影响面四件事、`removeProject` 不动会话日志                    |
| `notify.test.js`    | 通知：只提醒**新出现**的失败/等待，不重复弹；线程消失不提醒                                   |
| `wake.test.js`      | 信封：必带线程结果、信任判定、注入去重、非 principal 的 report 被包成数据                     |
| `routing.test.js`   | 路由：规则优先、坏正则不炸、自治矩阵（L0/L1 不能建线程）                                      |
| `persona.test.js`   | 人格：默认三条准则、明确声明不改权限、不与项目指令重复                                        |
| `tools.test.js`     | 工具篮子：6 个 `project_*`（含记忆读写）、无 shell/写/删/推/合并、危险动作只能申请            |
| `executor.test.js`  | 执行器：批准≠可执行、**动作↔开关显式映射**、阈值、argv 无 shell、恢复证据                     |
| `autopr.test.js`    | auto PR 四档：默认关、只碰 `dsh/` 分支、幂等、CI 条件、重试上限                               |
| `autofix.test.js`   | auto-fix：轮数上限、无进展、同错两次、**碰测试文件即停**、错误签名稳定性                      |
| `untrusted.test.js` | 不可信输入：未知来源一律 `relay`、围栏不可被提前闭合、控制字符过滤                            |
| `memory.test.js`    | 记忆写入：幂等、单条与总量上限、时间戳注释、被拒时给出原因                                    |
| `exec.test.js`      | 子进程封装：参数原样传递、失败返回 code 不抛、cwd 生效、命令不存在也不抛                      |

## 2. web 端到端冒烟（54 项）

`pnpm smoke:projects` 在临时 home 里种子一个**真实 git 仓库**作为工作区，然后：

1. 打开「项目」面板 → 断言导航入口、面板、`data-projects-status` 锚点、本地化摘要
2. 通过 UI 新建项目 → 断言行出现、计数增加、无错误条
3. 会话行「…」菜单 → 「归属到项目…」→ 断言 `projects.json.threads` 非空且指向真实项目
4. 详情页 → 三个页签可切换 → 返回回到列表
5. **绑定项目目录** → **新建线程** → 断言线程行、`data-projects-thread-state`、
   `branch` 形如 `dsh/…`、**worktree 目录真实存在且在主工作树之外**
6. **暂停/恢复**项目 → 断言详情页有按钮、预算用量可见、宿主侧 `state=paused`
7. **删除**一个一次性项目 → 断言影响面文案、确认后项目从列表消失、回收站有 `manifest.json` 且写明可恢复
   7.5 **归档 / 取消归档**：用一次性项目归档 → 宿主侧断言 `state=archived`（归档不删数据，取消归档回到 active）
8. **通知器**挂载在 `shell.overlay`（全局轮询，不依赖浏览器 Notification 授权）
9. 宿主侧断言：`projects.json` 合法 JSON、`format=1`、默认策略 L1、无 `.tmp` 残留、
   `threads` 有归属、worktree 目录真实存在且在主工作树之外、回收站清单存在、截图落盘

## 3. 桌面只读回归

```bash
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
pnpm smoke:projects-desktop --require
```

断言：插件 client 半已加载（按 `window.__DSH_BOOT__.entries`）、侧栏有「项目」入口、
面板渲染且无 `data-projects-crash`、状态锚点可解析、摘要不是裸 key、新建控件存在（**不提交**）、
设置分节出现、关闭后界面仍可用。

未装进当前 live profile 时默认 **SKIP**，加 `--require` 则 **FAIL**（发版门禁用它）。

**2026-11-21 实测（DSH 0.2.2-rc.5）**：0.1.1 / 0.2.1 / 0.3.0 / 0.4.1 / 0.4.2 各跑过一次，都是 11 PASS / 0 SKIP / 0 FAIL
（0.3.0 那次 web 冒烟同时是 52 项，门禁 64s 全绿）。
0.2.1 那次是**装进 live profile 并重启桌面版之后**跑的（`pnpm gate:all --plugins projects --idle-session …`，
64s 全绿）。该 profile 里 `ui-settings` 是 `enabled: false`，所以「设置页出现项目分节」这条按允许跳过处理——
想验证设置页文案得先把设置页打开。

原始记录（0.1.1）：

```
11 PASS / 0 SKIP / 0 FAIL
```

这是本插件第一次跑通桌面回归。前置是**先把可见会话切到空闲会话**：桌面回归读的是
「当前可见会话」，而 agent 在自己的会话里跑时那一轮正在跑回合
（[runtime rc.5 §5.1](../runtime/0.2.2-rc.5.md)）。用一条命令把切换自动化掉：

```bash
pnpm gate:all --plugins projects --idle-session "<任一空闲会话标题的子串>"
```

`gate:all` 会在桌面步骤前切过去、结束后切回原会话，并用 `desktopGateVerdict()`
拦「缺计数行 / 全 SKIP」的假绿。

## 4. 手工验证（发版 / DSH 升级后）

| #   | 步骤                                            | 期望                                                                                  |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | 建项目 → 详情页绑定一个 git 仓库目录 → 新建线程 | 线程行出现，状态「进行中」→ 最终「已完成」或「失败」                                  |
| 2   | 看 `.dsh-worktrees/<repo>/<prj>-<n>`            | 目录存在；`git worktree list` 里能看到 `dsh/…` 分支                                   |
| 3   | 在项目目录里改点东西（不提交）→ 归档该线程会话  | worktree **保留**，日志里有 `worktree/reclaim` 审计且结果非 ok                        |
| 4   | 干净线程直接归档                                | worktree 被删除，`git worktree list` 里消失                                           |
| 5   | 重启 DSH                                        | 面板项目与线程仍在；记录里指向不存在目录的 worktree 被清掉（审计 `worktree/missing`） |
| 6   | 归档项目                                        | 项目从列表消失但数据保留；可 Unarchive                                                |

## 5. 已知坑（踩过并已绕过）

| 坑                                         | 现象                                     | 处理                                           |
| ------------------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `main` 用 `key`、其他 slot 用 `id`         | 面板永远不出现                           | 见 `docs/runtime/0.2.2-rc.3.md` §11.4          |
| RPC 回执包在 `value` 里                    | `.map is not a function` / 白屏          | 解包 `"value" in result`                       |
| SRC 模式禁止默认参数                       | `must use unique identifier parameters…` | Remote 方法不带默认值/解构/rest                |
| 运行时字典只在 `locale/*.json`             | 界面显示 `panel.title`                   | 必须在 client 半 `locale.register`             |
| 首启「预览版说明」对话框                   | 输入框收不到键盘（其余内容 `inert`）     | 冒烟先点掉它                                   |
| **空白会话没有行内动作**                   | 会话行找不到「…」                        | 冒烟先发一条消息让它非空白                     |
| **composer 是 `contenteditable`**          | 设 `value` 无效、消息发不出              | 聚焦 + 真实键盘 + Enter                        |
| `ctx.inject` 回调是异步的                  | 服务刚构造就被调用 → "unavailable"       | 就绪 Promise + 超时（§11.5）                   |
| 失败在 `assistant/attempt` 而非 `turn/end` | 失败被当成功                             | 记住本轮 attempt 再在 `turn/end` 合并（§11.6） |
| 归档不是 session 事件                      | 监听不到                                 | 用 `workspace/session-archived`（§11.7）       |

## 6. 设置分节的已知局限

`settings.section` 的断言依赖「设置页在本机 profile 里可用」。有些 profile 在
`cordis.patch.yml` 里把 `ui-settings` 关掉（`config.enabled: false`），此时冒烟里的
「设置里可编辑项目策略」「可切换自治级别」两条会**按跳过处理**，并在 detail 里写明原因。

尝试过的做法与其失败原因（别重复踩）：

- 在临时 home 的 profile 副本里把 `enabled` 改成 `true` → **无效**：
  `dsh plugin ... add` 会重写 `cordis.patch.yml`；即使放在 add 之后写，
  设置页的导航入口也不出现（导航入口由该插件自己的 slot 注册产生，插件被关就不注册）。
- 因此这两条的**权威覆盖**在「设置页可用的 profile」上做；默认 profile 上如实跳过。

## 7. 冒烟为什么会「导航失败」：cookie 按主机作用域

反复用临时 `DSH_HOME` 跑冒烟时，**同一个浏览器 profile 会在 `127.0.0.1` 上堆出一批
`dsh-auth-*` cookie**——它们指向早已退出的临时宿主。

关键点：**cookie 的作用域是主机，不含端口**。于是新宿主起来后，浏览器会把这些过期 token
一起发过去，服务端认错就 401，Chromium 表现为
`page.goto failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE`（看起来像页面坏了，其实是鉴权失败）。

处理（`scripts/smoke-projects.mjs` 里已实现）：

```js
const { cookies } = await page.cdp("Storage.getCookies");
for (const cookie of cookies ?? []) {
  if (!String(cookie.domain ?? "").includes("127.0.0.1")) continue;
  if (!String(cookie.name ?? "").startsWith("dsh-auth-")) continue;
  await page.cdp("Network.deleteCookies", {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path ?? "/",
  });
}
```

**只删 `127.0.0.1` 的 `dsh-auth-*`**：不要用 `Network.clearBrowserCookies`，
那会把用户所有站点的登录态一起清掉。

另外冒烟保留了容错导航（token 入口 303 失败时改导航到已设好 cookie 的根路径），
但**根因是 cookie 堆积**，容错只是兜底。

## 8. 零网络验证远端写入

开 PR / 合并需要 GitHub，但链路本身可以在本机验证：

- **远端**：`git init --bare /tmp/remote.git` + `git remote add origin /tmp/remote.git` 顶替；
  推完用 `git -C /tmp/remote.git branch --list` 断言分支真的到了远端。
- **gh**：在临时目录放一个同名可执行脚本（记录 argv、回显假 PR URL），把该目录放到 `PATH` 最前面。

两个反复踩到的坑：

1. **陈旧 tarball**：`pnpm pack` 只重打了探针却没重打插件时，跑的还是旧代码（症状是"改了没生效"）。
   每次验证前把**插件和探针两个包都重打**，或直接检查安装目录里的代码是否含最新改动。
2. **分支撞名**：线程分支名按项目名生成，同名项目重复创建会让 `git worktree add -b` 失败并降级共享目录，
   于是"没有 worktree → 没有可推分支"。验证时给项目名加唯一后缀。

## 9. 合并后清单（人工执行）

PR 合并只是开始。下列步骤需要真实环境，按顺序做一遍，把「已验证」补齐：

### 9.1 合并三个 PR

```bash
gh pr merge 143 --squash --delete-branch          # M1
gh pr edit 144 --base main && gh pr merge 144 --squash --delete-branch
gh pr edit 146 --base main && gh pr merge 146 --squash --delete-branch
```

`feat(<plugin>)` 属 C 档，**只能人工合并**（见 CONTRIBUTING §自动合并分级），不要打 `automerge`。

### 9.2 发版

合并后 Changesets 会开一个 `chore(release): version packages` PR，合并它即发布 `0.1.0`。
可用 `gh pr list --search "version packages" --state open` 找到。

### 9.3 桌面只读回归（2026-11-21 已绿，保留步骤备查）

```bash
# 1) 装进 live profile（打包，不要用 link:）
cd packages/projects && pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-projects-0.1.0.tgz

# 2) 带调试端口重启桌面版
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1

# 3) 跑（--require：跑不起来就算失败，而不是跳过）
pnpm smoke:projects-desktop --require
```

预期：`PASS 全部 11 项桌面回归断言通过`。在此之前它一直输出
`SKIP 插件未装进当前 live profile`。

### 9.4 真实 GitHub 上的远端写入（2026-11-21 已做）

在一个**临时私有测试仓库**上跑通了完整链路（用完即归档，不复用；下文 PR 号与合并提交 SHA 只作本次记录）。做法是：
临时 `DSH_HOME` + **复制真实 desktop profile** 起临时宿主（与 web 冒烟同一套 boot 方式，
否则只有 `dsh-base`、web 服务起不来）+ 一个临时驱动插件调用 `projects` 的 RPC。

实测结果：

| 档位    | PR  | GitHub 侧事实                                                                                                     |
| ------- | --- | ----------------------------------------------------------------------------------------------------------------- |
| `draft` | #5  | `state=OPEN`、`isDraft=true`、**未被合并**（合并请求被前置校验拒绝：`merge/pr-is-draft`）                         |
| `ready` | #6  | `state=MERGED`、`mergedAt=2026-11-21T05:12:06Z`、main 上出现 **squash 合并提交** `8332471 e2e: ready commit (#6)` |

四个检查点全部确认：draft PR ✓、分支名 `dsh/…` ✓、标题前缀 `dsh:` ✓、
合并只在「开关打开 + 审批通过」后发生且 argv 为 `pr merge <n> --squash --repo <owner/repo>` ✓。

**这一轮抓到了两个真缺陷**（已修，见 [runtime rc.5 §8.3](../runtime/0.2.2-rc.5.md)）：

1. `gh pr merge` 没带 `--repo` → 合并会打到**宿主进程当前目录所在的仓库**；
   且 `gh pr merge` 对「已合并的 PR」仍返回 0，于是插件误报成功。修复：合并前从项目目录的
   `git remote get-url origin` 解析 `owner/repo` 并要求必须带上，解析不到就拒绝。
2. 没有「非 draft / 可合并」前置校验 → draft PR 也被当作可合并。修复：`gh pr view --json
   isDraft,mergeable,state` + `checkMergePreflight()`；`mergeable=UNKNOWN`（GitHub 刚建 PR
   时会这样）做有界重试而不是硬拒。

原计划（保留作步骤参考）：


本地验证用的是 bare 远端 + 桩 `gh`（§8）。真机确认只需一次：

1. 在一个**测试仓库**上建项目与线程；
2. 打开「自动开 PR」到 `draft` 档，跑一轮让线程产出提交；
3. 检查 GitHub 上出现的是 **draft PR**、分支名形如 `dsh/<project>-<n>`、标题以 `dsh:` 开头；
4. 打开 `autoMerge` 开关、走一次审批队列 → 确认合并命令是 `pr merge <n> --squash`，
   且合并**只**在开关打开 + 审批通过后发生。

### 9.5 发版后回到这里补一行

在 §4「手工验证」的表格里记下本次 DSH 版本与结果，
并把 README 状态行里的「真实 GitHub 上的效果还需发版后确认一次」改掉。

## 10. 危险动作的真机验证（临时宿主 + 本地 bare 远端）

三个推送/清理类动作在本地就能端到端验证，不需要真 GitHub：

- **远端**：`git init --bare` 当 origin；主仓库用
  `git remote set-url origin https://github.com/<slug>/<name>.git`（让插件能解析出 owner/repo）
  \+ `git remote set-url --push origin file:///path/to/remote.git`（真正推送到本地 bare）。
  `get-url` 读到的是 https 形态、推送落到本地目录，两件事都不牺牲。
- **`gh`**：PATH 前置一个桩脚本，按参数返回 protection 404 / rulesets `[]` / commits 两人。
- **宿主**：复制真实 desktop profile 起临时 `DSH_HOME`（与 web 冒烟同一套 boot 方式）。
- **驱动**：临时插件调 `projects` 的 RPC（`requestAction` → `resolveApproval` → `executeApproval`）。

2026-11-21 实测结果：

| 动作                    | 场景                     | 结果                                                                                    |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `push-branch`（普通）   | 开关开                   | `executed:true`，远端分支 = 本地 HEAD                                                   |
| `push-branch`（强推）   | 期望 SHA 与远端一致      | `executed:true`，远端 SHA 更新                                                          |
| `push-branch`（强推）   | 另一个 clone 先推了提交  | **`executed:false`（`force-push-failed`）** —— `--force-with-lease` 拒绝了 `stale info` |
| `push-protected-branch` | 未做 per-repo 授予       | **`executed:false`（`protected-push/repo-not-granted`）**                               |
| `push-protected-branch` | 已授予 + 服务端未要求 PR | `executed:true`                                                                         |
| `purgeTrash`            | dry-run                  | `eligible:1 kept:2`，未删任何东西                                                       |
| `purgeTrash`            | 真删但没给确认串         | **`ok:false`（`confirm-required`）**                                                    |
| `purgeTrash`            | 开关开 + 确认            | `purged:1`，并写出 `trash/purge-<ts>.md` 清单                                           |

注意：强推的「远端被别人动过」有两种挡法——前置的 `remote-moved`（用记录过的 `lastPushedSha` 对比
本地 tracking ref）与 `--force-with-lease` 本身。前者依赖 tracking ref 新鲜，后者不依赖，
所以**即使前置检查放过，lease 也会 fail-closed 拒绝**（上表第三行就是这种情形）。

## 11. 审批 → 执行闭环（2026-11-21）

规格要求「批准 ≠ 可执行」：批准只是改状态，**执行是独立一步**。此前这一步没有任何入口
（`executeApproval` 已导出但零调用方），等于安全层空转。现在补上：

- 详情页审批区把「待处理」与「已批准未执行」分开渲染；后者带 `data-projects-approval-execute` 按钮，
  点击调 `executeApproval`，把 `executed:true` 或拒绝原因（`detail.refused`）回显在
  `data-projects-approval-exec-result`
- 服务端补 `purge-trash` 与 `change-settings` 两条执行路径（此前走到 `execution-deferred`）
- `change-settings` 只接受白名单键（`persona` / `routing` / `goal`）；`danger` / `autonomy` /
  `preapprove` / `budget` / `repoGrants` 等安全面一律拒绝（`settings/forbidden:<key>`）

真机验证（临时宿主）：`settingsAllowed` → `executed:true, keys:["persona"]`；
`settingsForbidden` → `settings/forbidden:danger`；`purgeApprovalSwitchOff` → `switch-off`；
`purgeApprovalSwitchOn` → `executed:true, purged:1`（清单已写盘）。

**占用与执行分离（claim / release）**：早期实现把 `executedAt` 写在闸门之前，导致「被拒绝的申请也被占用」，
用户修好条件后无法重试。现在拆成两步：

- `claimApproval()` 在闸门前占位（`claimedAt`），并发第二次会得到 `already-claimed`；
- 执行**成功**才 `markApprovalExecuted()`（落 `executedAt` + evidence，并清占位）；
- 被拒绝或失败一律 `releaseApproval()`，**同一张申请可以重试**；
- 已执行的申请既不能占位也不会被释放（`already-executed`）。

真机验证（临时宿主）：同一张 `purge-trash` 申请先因开关关返回 `switch-off`，
打开开关后**再次执行同一张申请**返回 `executed:true`，第三次返回 `already-executed`；
最终记录 `{status:"approved", claimedAt:null, executed:true}`。

## 12. 合并硬前提与预授权（2026-11-21）

### 12.1 合并的三道硬前提（规格 §7.5 行 3）

之前只查「非 draft / 无冲突」，漏了 CI、人工批准数与合并方式。现在 `checkMergeReadiness` 一次判完：

| 前提     | 判定                                                                                   | 拒绝原因                                                       |
| -------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| CI 绿    | `statusCheckRollup` 全部 SUCCESS/NEUTRAL/SKIPPED；**空列表按未配置检查处理并拒绝**     | `merge/ci-unknown` / `merge/ci-not-green` / `merge/ci-pending` |
| 人工批准 | `reviews` 里不同作者的 APPROVED 数 ≥ `policy.merge.minApprovals`（默认 1，0 表示不看） | `merge/not-approved`                                           |
| 合并方式 | 仓库 `allowed_merge_methods` 含 `squash`，否则拒绝（**不改用** merge/rebase）          | `merge/method-unknown` / `merge/method-not-allowed`            |

阈值从 `policy.merge`（`minApprovals` / `maxDiffFiles` / `maxDiffLines`）读，不再是写死默认值。

真机（临时宿主 + 桩 `gh` 切场景）：

```
CI 为空          → merge/ci-unknown
CI 有 FAILURE    → merge/ci-not-green
无 APPROVED      → merge/not-approved
全绿 + 已批 1 人  → executed:true
```

### 12.2 预授权（规格 §7.7.2）

三条全满足才放行：动作在 `policy.preapprove` 里、该动作授权来源是 `policy-grant`、对应危险开关已打开。
命中则 `requestAction` 直接落 approved（`source: policy-grant`）+ 审计 `approval/auto-approved`，
并**立即走 `executeApproval`**——闸门一条不跳过，只是省掉「等人点一下」。

真机：`delete-thread` 列进预授权后 `autoApproved:true`，随后被真实闸门拒绝（`unknown-thread`）；
`merge` 即使列进预授权也 `autoApproved:false`（授权来源不是 policy-grant）。

**注意**：宿主没有审批策略 API（`ctx.approval.setPolicy` 不存在，见 [runtime §11.32](../runtime/0.2.2-rc.3.md)），
所以预授权是本插件用 `policy-grant` 自己实现的，不是宿主能力。

## 13. 可观测（2026-11-21，规格 §7.7.3）

线程行现在多一行摘要：`N 步 · N 次工具 · diff N 文件 +a/-b · N tokens`。

| 指标        | 来源                                                                      | 缺失时                        |
| ----------- | ------------------------------------------------------------------------- | ----------------------------- |
| 步骤数      | `assistant/attempt` 计数                                                  | —                             |
| 工具 / 命令 | `tool/call` 记名，`tool/result` 回填 ok                                   | 取不到命令行则记工具名        |
| tokens      | `assistant/attempt.data.usage`（兼容 `totalTokens`/`total`/input+output） | 显式 `n/a`（宿主常缺）        |
| diff        | `git diff --numstat <base>..HEAD`（`threadStats` RPC 现算）               | 二进制 `-/-` → `null` → `n/a` |

**口径**：统计从插件启动后开始累积（不是回放历史），diff 是现算的所以始终准确。
冒烟断言 `data-projects-thread-stats` 存在且含「步 / 工具 / diff / tokens」。

## 14. 周预算与步数上限（2026-11-21，规格 §7.7.4）

| 闸门           | 配置                       | 行为                                                                           |
| -------------- | -------------------------- | ------------------------------------------------------------------------------ |
| 日 token       | `budget.dailyTokens`       | 到线拒建线程（`budget/daily-tokens`）                                          |
| **周 token**   | `budget.weeklyTokens`      | 按**自然周周一 00:00（本地时区）**聚合，到线拒建（`budget/weekly-tokens`）     |
| **单线程步数** | `budget.maxStepsPerThread` | 超限**只停协调器唤醒**（`wake/skipped` + `budget/steps-per-thread`），不杀会话 |

**为什么步数只停唤醒**：预算是防止无人值守时无限烧 token，不是惩罚使用者——
人还可以继续在同一会话里干活，只是插件不再主动唤醒协调器。

**token 存储改按天分桶**（原先单日桶算不出周）：`usage[projectId].days = { "YYYY-MM-DD": tokens }`，
保留最近 21 天；旧形状 `{date, tokens}` 首次写入时自动迁移，历史数不丢。

`threadStats` 另外返回 `overBudget` / `budgetReason`，面板可据此提示。

## 15. 分支生命周期（2026-11-21，规格 §7.7.5）

**为什么不能用 `git branch --merged`**：它在两个方向都会误判（见 [runtime §11.15](../runtime/0.2.2-rc.3.md)）——
未提交的新分支被当"已合并"、squash 合并的分支被当"未合并"。所以改用三条独立判据：

| 判据         | 检查                                                         | 不满足                                    |
| ------------ | ------------------------------------------------------------ | ----------------------------------------- |
| 是我们的分支 | `dsh/` 前缀 + 与线程记录 `branch` 一致                       | `branch-not-ours` / `branch-not-recorded` |
| 确有合并结果 | 记录 `mergedAt`，或 `merge-base --is-ancestor <branch> HEAD` | `not-merged`                              |
| 无未推送提交 | `rev-list --count <branch> --not --remotes` 为 0             | `unpushed-commits`（读不出也算不满足）    |

**worktree 先处理**：分支被 worktree 占用时 `git branch -d` 会拒绝；所以只在 worktree
`git status --porcelain` **为空**时用 `git worktree remove`（不加 `--force`）移除，脏的一律保留。

删除**只用 `git branch -d`，永不用 `-D`**。RPC `cleanupBranches` 默认 dry-run，真删需 `confirm: true`；
归档项目时自动跑一次（失败不影响归档）。

真机（临时裸远端 + 桩 gh）：已合并且已推送的分支被删；未合并的保留（`not-merged`）。

## 16. 一键建项目模板（2026-11-21，规格 §7.7.6）

`createProject(name, { dirs: [dir], template: true })` 会：目录不存在则建 → 写 `instructions.md` 骨架。

| 情况                   | 行为                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| 目录不存在             | 建目录（recursive）                                              |
| 已有 `instructions.md` | **跳过**（`flag: "wx"`，绝不覆盖），记 `project/template` 审计   |
| 已有 `AGENTS.md`       | **不改动它**，只在骨架里加一行「两者都会注入，请避免写重复内容」 |
| 重复调用               | 幂等                                                             |
| 写盘失败               | 不阻断建项目，记 `project/template-failed`                       |

真机：新目录 → 建好 + 骨架；已有 AGENTS.md 目录 → AGENTS.md 逐字节未变、骨架里出现提示；
同目录再建 → 不覆盖。

## 17. 真实用户走查发现并修复的三项（2026-11-21，v0.4.3）

三个"无先验知识"的用户画像在桌面端走查（CDP 点击 + 截图目视），发现的问题里第一批已修：

### 17.1 回收站预览的网关参数错误

`purgeTrash(options)` 只有一个参数 `options`，客户端却把 `dryRun`/`projectId` 平铺在最外层，
网关按参数名校验直接拒绝，界面上原样显示出：

```
typert gateway: projects/purgeTrash: args fields do not match the descriptor: unexpected "dryRun", "projectId"
```

**结论（通用规则）**：Remote 调用的 `args` **必须**以参数名为键——单对象参数要包一层
（`{ options: {...} }`），不能平铺。核对全仓 16 个客户端调用，仅此一处写错。

### 17.2 删除承诺"可恢复"，却没有恢复入口

删除确认框写"可恢复：删除只移入回收站"，但界面上没有任何恢复入口，唯一能碰到回收站的
「预览可清理项」又因 17.1 不可用 → 删了就找不回来。现在补上：

| 能力 | 实现                                                                            |
| ---- | ------------------------------------------------------------------------------- |
| 看   | `listTrash()` 扫 `trash/<entryId>/manifest.json`，返回名称/线程数/删除时间/体积 |
| 恢复 | `restoreTrash(entryId)` 把项目与线程放回仓储、内容目录搬回、删掉回收站条目      |
| 界面 | 详情页新增「回收站（可恢复）」区块，每行一个「恢复」按钮                        |

**坑**：恢复的是"另一个"项目，恢复后必须触发列表刷新（`onChanged` → `refresh()`），
否则用户点了恢复却看不到项目回来——第一版就是这样，被冒烟抓出。

### 17.3 冒烟断言太弱，把报错当成了通过

原断言只校验"有文字且不含 `FAIL`"，于是 17.1 的网关报错一路绿灯发版。
现在断言必须校验**成功语义**（出现"没有超过保留期的条目"一类文案，且不含
`gateway`/`失败`/`错误`），并新增回收站列表与「恢复往返」两条断言。

### 17.4 走查后的 P1 四项（v0.5.0）

| 项               | 改动                                                                                       | 怎么验                     |
| ---------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| 建线程写审计     | `createThread` 成功也写 `thread/created`                                                   | 建线程后「审计」页签有记录 |
| 路由结果说人话   | 内部码换成"规则「X」建议「新建线程」，但当前自治等级（L1）不允许…已拦下"，原始码进 `title` | 派活后看文案               |
| 高级设置默认折叠 | 仓库授权 / 回收站两块收进 `<details data-projects-config>`，首屏留给线程                   | 冒烟断言 `open === false`  |
| 重名项目可区分   | 项目行名字后加 `#<id 后缀>`                                                                | 冒烟断言每行都有短 id      |

**又一个模板字符串转义坑**：冒烟里的浏览器脚本是模板字符串，`\w` 会被吞成 `w`，
写成 `/^#[\w-]{4,}$/` 实际是 `/^#[w-]{4,}$/`。字符类一律用 `[A-Za-z0-9_-]` 这种显式写法。

### 17.5 回收站的彻底删除（v0.6.x）

`purgeTrash` 只清「超过保留期」的条目；刚删错又不想留的，需要主动清理的入口：

| 动作       | RPC                                      | 语义                                |
| ---------- | ---------------------------------------- | ----------------------------------- |
| 彻底删一个 | `deleteTrashEntry({ entryId, confirm })` | 不带 `confirm` 只回报字节数，不动手 |
| 清空回收站 | `emptyTrash({ confirm })`                | 不带 `confirm` 只回报条目数与总量   |

界面都用**两步确认**：第一次点进入确认态，第二次点的按钮上直接写
「确认彻底删除（1.6 KB，不可恢复）」——不可恢复的操作必须把代价写在按钮上。
两个动作都写审计（`trash/entry-deleted` / `trash/emptied`）。
### 17.6 记忆页签可写（v0.6.x）

| 动作         | RPC                                           | 语义                                                                |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------- |
| 保存常设规则 | `setProjectInstructions({ projectId, text })` | 写 `instructions.md`（0o600）；空文本=清空（删文件）；上限 20k 字符 |
| 追加记忆     | `appendMemory({ projectId, text })`           | 追加一条到 `MEMORY.md`，重复条目如实返回 `added:false`              |

**坑**：给 Remote 方法的参数加**行内** `/** @type */` 会让 SRC 网关拒绝注册该方法，
运行时表现为 `typert gateway: ...` 而看不出是注册阶段的问题。一律用上方 JSDoc `@param`；
`pnpm check` 的 SRC 守卫会拦住（`Remote 方法 X 的参数表里不能有行内类型注释`）。

### 17.7 回收站必须有一个不依赖项目的入口（v0.6.1）

0.6.0 验收时踩到自锁：回收站只渲染在**项目详情页**里，所以
「删掉最后一个项目 → 没有任何项目 → 进不去详情页 → 回收站打不开 → 恢复不了」。
功能明明有，路却断了。

修法：面板加 `PanelTrash` 组件，在**项目列表为空时**渲染回收站（查看 / 恢复 / 彻底删除 / 清空），
`data-projects-trash` 锚点相同。

**顺带修的**：`store.restoreProject` 之前强制把状态写成 `active`，会把 `paused`/`archived` 抹掉；
现在保留 manifest 里的原状态（冒烟里归档/暂停两条宿主侧断言曾因此变红）。

冒烟断言「项目清零后面板仍能进入回收站（防自锁）」是**真删掉所有项目**再检查的，
恢复时特意跳过留给 manifest 断言的那一条。

### 17.8 边界与空态走查（v0.6.x）

专门针对「清空态 / 异常输入」走了一遍（0 项目、0 线程、非 git 目录、只读目录、超长名字）：

| 场景                   | 旧行为                            | 现在                                                                               |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| 绑非 git 目录          | **静默降级为共享目录**，界面不说  | 绑定当场提示「不是 git 仓库：线程会共享这个目录…」；线程行标「共享目录（未隔离）」 |
| 超长项目名（120 字符） | 行高被撑开                        | 名字单行省略号截断                                                                 |
| 绑定目录               | 成功/失败都无反馈                 | 显示目录状态（git / 非 git），由 `inspectDir` 探测                                 |
| 0 项目                 | 回收站不可达（自锁）              | 面板级回收站（17.7 已修）                                                          |
| 只读目录（0o500）      | 可绑定；非 git 走共享目录，不报错 | 同左（非 git 本来就不建 worktree），状态行也会说明                                 |

**结论**：这类问题单测与常规冒烟都抓不到——只有"真的把数据清空/喂异常值"才暴露。
冒烟因此新增三条：非 git 提示、名字截断、防自锁。

### 17.9 目录绑定的输入校验（v0.7.x）

验收 0.7.0 时我误把 `undefined/plain` 填进目录框，结果**保存成功**，直到建线程才崩：

```
failed to create session: Error: session header cwd must be an absolute path, got "undefined/plain"
```

这对用户是死胡同：界面说"绑定成功"，几秒后在完全不相干的位置报一句宿主错误。
现在 `saveDir` 当场校验：非绝对路径（不以 `/` 开头）直接拒绝，`data-projects-dir-info="invalid"`
并用危险色提示「需要绝对路径（以 / 开头）；相对路径无法作为会话目录，已拒绝保存」。

**顺带**：非 git 提示里的 Markdown 星号（`**共享这个目录**`）会原样显示——界面不渲染 Markdown，已去掉。

### 17.10 多项目并行与审批队列（v0.7.x）

**多项目并行**（三个 git 仓库 + 一个空目录项目）：建项目、绑目录、建线程、切换详情都正常；
`今日 N 个线程`、列表短 id、目录状态（git/shared）都对。顺带发现并修了两处：

| 问题             | 现象                                                      | 修法                                                     |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| 返回列表不刷新   | 详情里建了线程，回面板仍显示旧线程数（等 7s 轮询也不变）  | `onBack` 里调 `refresh()`                                |
| 头部统计没线程数 | `0 个会话已接入` 指的是"已挂上下文的会话"，建线程不改变它 | 改成 `N 个项目 · N 个活跃 · N 个线程 · N 个会话带上下文` |

**审批队列**（临时宿主 + 探针造一条真实 `change-settings` 审批，再用 CDP 点）：

```
待你批准的动作 | change-settings · 验收：把人格改成验收专用 | 批准 | 拒绝
→ 点「批准」后：同一行变成「执行」（体现"批准 ≠ 可执行"）
→ 点「执行」后：提示「已执行（结果见审计）」，审批列表清空
→ 审计：approval/requested → approval/resolved → approval/executed
```

**修的一处**：执行成功的提示原本渲染在审批列表**内部**，列表清空后提示跟着消失——
用户点了「执行」只看到区块消失，分不清成功还是出错。已把提示移到列表外。

### 17.11 已合并线程的 worktree 回收（v0.7.x）

**问题**：回收判据问的是"提交是否都在远端"。但 squash 合并会生成**新提交**，原分支提交
不再是主干的祖先；分支再被删（B5 的常规操作）后，这些提交也不在任何 remote ref 上——
两个判据同时失效 → 已合并线程的 worktree 永远回收不掉。

**修法**：把"已合并"变成**记录下来的事实**，而不是事后用 git 推断：

| 环节                    | 动作                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `openPr` 成功           | 线程记 `prNumber`                                            |
| 合并审批执行成功        | 把同 `prNumber` 的线程标 `mergedAt`                          |
| `reclaimThreadWorktree` | `mergedAt` 存在即允许回收；否则维持"未合并且有未推送 → 拒绝" |

集成测试用真实 git 复现整条链路（commit → push → squash 合并 → 删远端分支），断言
**未标记时拒绝、标记后回收成功**。

### 17.12 危险开关的可达性（v0.8.x）

**验收发现**：把临时 profile 的 `ui-settings` 打开后，插件设置分节在**未登录**的 profile 里没有出现——
「插件」页只有「已安装插件 → @kangyishuai/dsh-projects → 开始使用」，没有配置区。
如果分节不渲染，六个危险开关（以及人格/路由/预算）在界面上就**完全不可达**，只能手改 JSON。

**对策**：把危险开关放进**项目详情 → 高级设置**（它们本来就是 per-project 策略），
与设置页共用同一套 i18n 文案与写入路径：

```
▼ 高级设置（仓库授权 / 回收站）
  ▼ 危险动作开关（默认全关）
     □ 允许强推自己的 dsh/ 分支 — 用 --force-with-lease 绑定期望 SHA…
     □ 允许直推默认/保护分支 — 需要先在项目策略里对该仓库 per-repo 授予…
     □ 允许自动合并 PR — 合并不可逆（只能用 revert 回退）…
     □ 允许自动归档/删除到回收站 — 会把内容移入 trash/…
     □ 允许保留期后清理回收站 — …默认 dry-run，真删需显式确认
     □ 允许修改项目策略本身 — 协调器可能借此放宽自己的限制；风险最高
```

**文案评估（待改进）**：六条说明偏工程向，普通用户会被 `--force-with-lease`、`SHA`、`per-repo`、
`protection/rulesets`、`manifest`、`dry-run`、`diff 阈值` 这些词挡住。建议每条先给一句人话结论，
技术细节折进第二行或 tooltip。

### 17.13 危险开关文案改成人话（v0.8.1）

技术细节仍然准确，但**先给结论、再给细节**，不再让用户读 `--force-with-lease`、`SHA`、`per-repo`、
`protection/rulesets`、`manifest`、`dry-run`、`diff 阈值` 这些词：

| 开关                       | 现在的一句话                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| 覆盖插件自己创建的远端分支 | 只覆盖插件自己建的分支；覆盖前核对远端版本，被别人改过就停下并记下旧版本号   |
| 直接推送主干或受保护分支   | 只对授权过的仓库生效；要求走 PR 的仓库直接拒绝；每次记录，多人协作会额外提醒 |
| 自动合并 PR                | 合并只能用 revert 回退；仍要求改动量在阈值内、CI 通过、人工批准达标          |
| 自动归档或删除到回收站     | 内容先移进回收站，还能恢复，但要花时间找回                                   |
| 清理过期的回收站条目       | 只清已进回收站且超保留期的；先列清单，默认只看不删，真删再确认               |
| 修改项目策略本身           | 协调器可能借此放宽对自己的限制——风险最高，建议保持关闭                       |

冒烟新增断言「危险开关文案不含工程术语」（黑名单词逐个检查），把"人话"变成可回归的门槛。

### 17.14 第二轮三用户走查（v0.8.1 → 修复）

同样三个人设、同样"无先验知识"，在 0.8.1 上重走一遍。上一轮的问题全部确认已修（空态指引、短 id、
默认页签、共享标记、记忆可写、审计留痕、回收站可恢复/彻底删除、危险开关可见且是人话）。
新发现四处，都已修：

| 问题                 | 现象                                                          | 修法                                                      |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| 开关勾选后弹回       | 勾上后界面 4 秒内仍显示未勾（服务端已保存），重新进详情才正常 | 写完策略同时刷新父级列表                                  |
| 开关变更不写审计     | 审计里只有 `thread/created`，改危险开关没有记录               | `updateProject` 对比前后策略，写 `project/policy-changed` |
| 文案残留 `**`        | 回收站清理中英文各一处 Markdown 星号                          | 清掉，并把 `**` 加进冒烟黑名单                            |
| 未绑目录的线程跑在哪 | 实际在插件数据目录，界面只说"共享目录（未隔离）"              | 详情页明确提示，并建议先绑 git 仓库；行标记改"未隔离"     |

**仍未修的（记录在案）**：线程行没有任何操作入口（看不到 worktree 路径、也不能单独删除/归档线程）——
开发者想清理单个线程只能删整个项目。

### 17.15 线程级操作（v0.9.0）

第二轮走查记录的最后一条缺口：线程行是只读的，看不到 worktree 在哪、也不能单独清理。

| 入口     | 调用                       | 语义                                                                       |
| -------- | -------------------------- | -------------------------------------------------------------------------- |
| 目录路径 | —                          | 显示 worktree 全路径（超长省略，hover 看全）                               |
| 回收目录 | `reclaimThread(sessionId)` | 三重判据（干净 / 无未推送 / 非当前会话）通过才回收；分支保留；被拒显示原因 |
| 移除     | `detachThread(sessionId)`  | 两步确认；移除追踪关系；写审计 `thread/detached`                           |

**顺带**：`detachThread` 之前不写审计，这次补上——移除追踪也是可审计的变更。
