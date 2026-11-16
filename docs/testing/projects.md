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

| 文件               | 证明什么                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `store.test.js`    | 仓储：原子写、损坏文件**改名隔离不删除**、未来格式拒绝、旧字段补齐、默认策略 L1               |
| `context.test.js`  | 渲染：16k 预算的裁剪顺序、记忆索引裁剪、**不与宿主已加载的 AGENTS.md 重复**                   |
| `attach.test.js`   | 挂载：只有归属且 active 的会话被注入；归档不注入；agent 无 `systemPrompt` 时降级              |
| `overview.test.js` | 状态机：五态迁移、`turn/start` 清失败、**失败从 `assistant/attempt` 判**、`replay` 重建、排序 |
| `worktree.test.js` | 命名与路径（**防目录穿越**）、命令计划（默认不加 `--force`）、porcelain 解析、回收三重判据    |
| `thread.test.js`   | **真 git 集成**：建隔离线程、非 git 降级、建失败降级、脏工作区拒绝回收、启动对账              |
| `index.test.js`    | 清单自检：`dsh.bundle.patch` 存在、`files` 白名单逐项存在、**不把宿主包声明成依赖**           |

## 2. web 端到端冒烟（34 项）

`pnpm smoke:projects` 在临时 home 里种子一个**真实 git 仓库**作为工作区，然后：

1. 打开「项目」面板 → 断言导航入口、面板、`data-projects-status` 锚点、本地化摘要
2. 通过 UI 新建项目 → 断言行出现、计数增加、无错误条
3. 会话行「…」菜单 → 「归属到项目…」→ 断言 `projects.json.threads` 非空且指向真实项目
4. 详情页 → 三个页签可切换 → 返回回到列表
5. **绑定项目目录** → **新建线程** → 断言线程行、`data-projects-thread-state`、
   `branch` 形如 `dsh/…`、**worktree 目录真实存在且在主工作树之外**
6. 宿主侧断言：`projects.json` 是合法 JSON、`format=1`、默认策略 L1、无 `.tmp` 残留、截图落盘

## 3. 桌面只读回归

```bash
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
pnpm smoke:projects-desktop --require
```

断言：插件 client 半已加载（按 `window.__DSH_BOOT__.entries`）、侧栏有「项目」入口、
面板渲染且无 `data-projects-crash`、状态锚点可解析、摘要不是裸 key、新建控件存在（**不提交**）、
设置分节出现、关闭后界面仍可用。

未装进当前 live profile 时默认 **SKIP**，加 `--require` 则 **FAIL**（发版门禁用它）。

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
| `main` 用 `key`、其他 slot 用 `id`         | 面板永远不出现                           | 见 `docs/runtime/0.2.2-rc.3.md` §10.4          |
| RPC 回执包在 `value` 里                    | `.map is not a function` / 白屏          | 解包 `"value" in result`                       |
| SRC 模式禁止默认参数                       | `must use unique identifier parameters…` | Remote 方法不带默认值/解构/rest                |
| 运行时字典只在 `locale/*.json`             | 界面显示 `panel.title`                   | 必须在 client 半 `locale.register`             |
| 首启「预览版说明」对话框                   | 输入框收不到键盘（其余内容 `inert`）     | 冒烟先点掉它                                   |
| **空白会话没有行内动作**                   | 会话行找不到「…」                        | 冒烟先发一条消息让它非空白                     |
| **composer 是 `contenteditable`**          | 设 `value` 无效、消息发不出              | 聚焦 + 真实键盘 + Enter                        |
| `ctx.inject` 回调是异步的                  | 服务刚构造就被调用 → "unavailable"       | 就绪 Promise + 超时（§10.5）                   |
| 失败在 `assistant/attempt` 而非 `turn/end` | 失败被当成功                             | 记住本轮 attempt 再在 `turn/end` 合并（§10.6） |
| 归档不是 session 事件                      | 监听不到                                 | 用 `workspace/session-archived`（§10.7）       |
