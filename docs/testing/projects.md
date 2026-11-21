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

## 2. web 端到端冒烟（50 项）

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

**2026-11-21 实测（DSH 0.2.2-rc.5）**：0.1.1 与 0.2.1 各跑过一次，都是 11 PASS / 0 SKIP / 0 FAIL。
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

**已知取舍**：幂等占位（`executedAt`）在闸门之前就写入，因此**被拒绝的申请也会被占用**，
不会显示「执行」按钮，需要协调器重新申请。这样做是为了避免并发重复执行；换成
claim/release 模型可以既保幂等又可重试，但涉及 14 处拒绝点，留作后续。
