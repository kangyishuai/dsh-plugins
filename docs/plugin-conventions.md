# DSH 插件开发约定

面向在本仓库开发 DSH 插件的人和 AI agent。这里只写**稳定的工程约定**；跟具体 DSH 版本绑定的勘察结果（可用的 slot、`ctx` 服务、磁盘布局、已知的坑）放在 [`docs/runtime/`](runtime/)：

- 当前目标运行时：[DSH 0.2.2-rc.5](runtime/0.2.2-rc.5.md)（旧版本记录保留在同目录）

重要决策的来龙去脉记在 [`docs/adr/`](adr/)。

---

## 1. 一个插件包的构成

不要手抄，用 `pnpm new <name> [描述]` 从 [`templates/plugin`](../templates/plugin) 生成：

```
packages/<name>/
├── package.json          # 必须声明 dsh.bundle / dsh.client
├── cordis.patch.yml      # bundle patch：往 profile 里 insert 一行
├── icon.svg              # 插件图标：36×36、透明背景、无文字；模板自带占位图，发布前替换
├── lib/
│   ├── index.js          # host 半（Node，可用 ctx 服务）
│   └── client.js         # client 半（浏览器 classic script，可选）
├── locale/
│   ├── zh.json           # 根对象 meta.title / meta.description = 插件身份
│   └── en.json
├── test/                 # node --test；不进发布包
├── README.md             # 英文
├── README.zh-CN.md       # 中文
└── LICENSE               # 脚手架从根目录复制（npm pack 不会带上根目录的文件）
```

`locale/{zh,en}.json` 根对象的 `meta.title` / `meta.description`（宿主不激活插件时读的标题与短描述）、`package.json` 顶层 `icon`、以及能被 Node 解析到的 locale `exports`，合起来就是「插件身份三件套」。**模板已经自带这三样**——发布前替换 `icon.svg` 与中英文文案，别让新插件又回到「显示包名 + 英文长描述 + 通用图标」（U1-01/U1-19）。

`pnpm check` 会检查下面这些规则，CI 也会跑。

### package.json 关键字段

| 字段                   | 要求                                          | 原因                                                                                             |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `name`                 | `@kangyishuai/dsh-<目录名>`                   | 裸名已被社区大量占用                                                                             |
| `type`                 | `"module"`                                    |                                                                                                  |
| `files`                | 白名单，列出的文件必须存在                    | 控制发布内容                                                                                     |
| `icon`                 | 顶层 `"icon": "icon.svg"`，且必须进 `files`   | 「插件 → 已安装」的图标来源；宿主读顶层字段、不走 `exports`，没它就用通用图标                    |
| `exports`              | 必须含 `"./locale/*.json": "./locale/*.json"` | 宿主用 Node 解析器读 locale；漏了会静默回退成包名 + 英文长描述，漏一个语言文件会丢整套 meta/icon |
| `publishConfig.access` | `"public"`                                    | scoped 包默认按私有发布，会失败                                                                  |
| `repository`           | `url` + `directory: "packages/<name>"`        | npm provenance 需要和仓库对应                                                                    |
| `dsh.bundle.patch`     | 指向 `./cordis.patch.yml`                     | `dsh plugin add` 据此自动接线，**不要手改 profile 的 cordis.patch.yml**                          |
| `dsh.client.platform`  | `"web"`                                       | 桌面版和 Web 都是 web client                                                                     |
| `dsh.client.inject`    | 依赖的宿主 client 包                          | 决定加载顺序                                                                                     |
| 依赖                   | **不能**出现 `@deepseek-ai/*`                 | 运行时由宿主提供                                                                                 |
| `engines.dsh`          | 先不写                                        | 见第 4 节                                                                                        |

### cordis.patch.yml

```yaml
- insert:
    - id: <plugin-id>
      name: "@kangyishuai/dsh-<name>"
```

`id` 是 profile 里一行配置的标识，同一个 profile 内唯一，和包名无关。本仓库要求它在所有插件之间都唯一。

---

## 2. 代码约定

- **host 半**导出 `apply(ctx, config)`（Cordis 插件约定），优先用 `ctx` 上的宿主服务。确实没有接口、只能直接操作文件系统时，在注释里写明原因。
- 需要 host→client 的 Typert Remote 时，host 半改为**导出 Service 类本身**（不要包一层子类）：Remote 方法必须声明在这个被导出的类自己的原型上，否则网关不会 claim 端点，所有 `/api/<id>/*` 返回 404。细节见 [runtime](runtime/0.2.1-rc.5.md) §6.10。
- **client 半**是 classic script，**不能用 `import`**，宿主模块通过 factory 的 `require()` 获取。所有副作用都写在 factory 里面。
- 所有文件头加 `// @ts-check`，用 JSDoc 写类型。宿主的类型在 [`types/`](../types/) 里手写维护，只声明已经验证过的成员。
- **路径必须可注入**：不要在模块顶层写死 `~/.dsh`。从 `ctx`、配置或参数里拿到数据根目录，这样测试可以在临时目录里跑。
- **样式只用宿主真实存在的主题 token**，且前景色要与底色成对取自 token，不能写死颜色。写错 token 名 CSS 不会报错，只会静默落到 `var()` 的兜底参数、永远不跟随主题；把 `#fff` 写死当前景，遇上随主题翻转的底色就会糊。`pnpm check` 会用 [`scripts/lib/host-theme-tokens.json`](../scripts/lib/host-theme-tokens.json) 拦截这两种情况（token 清单与配对表见 [runtime §6.1](runtime/0.2.2-rc.2.md#61-主题-token-清单)，DSH 升级后用 `pnpm tokens:host` 更新）。
- 破坏性操作遵循 [ADR 0002](adr/0002-destructive-operations.md)：默认移入回收站、必须有确认框、支持 dry-run、写审计日志。

---

## 3. 命名

| 位置            | 规则                                     | 例                                      |
| --------------- | ---------------------------------------- | --------------------------------------- |
| npm 包          | `@kangyishuai/dsh-<name>`                | `@kangyishuai/dsh-session-delete`       |
| 目录            | `<name>`（kebab-case，不带 `dsh-` 前缀） | `packages/session-delete`               |
| cordis 行 id    | kebab-case，一般与目录名相同             | `session-delete`                        |
| locale 命名空间 | camelCase                                | `sessionDelete`                         |
| commit scope    | 目录名                                   | `feat(session-delete): ...`             |
| git tag         | Changesets 自动打                        | `@kangyishuai/dsh-session-delete@0.1.0` |

---

## 4. 版本与兼容性

- 各插件**独立**版本号，用 Changesets 管理（流程见 [CONTRIBUTING.md](../CONTRIBUTING.md#发版)）。
- 0.x 阶段：破坏性改动 bump minor，其余 bump patch。
- DSH 还处在预发布阶段，semver 范围匹配不可靠：`^0.2.0-rc.2` 严格来说**不包含** `0.2.1-rc.5`。所以**先不声明** `engines.dsh`，也不在 `peerDependencies` 里写 `@deepseek-ai/dsh-*` 的范围。
- 用文字代替版本约束：每个插件 README 的「兼容性」表格写明「已在哪个 DSH 版本上验证」。

---

## 5. 文档与验证

`pnpm check:docs`（CI 与 `pnpm verify` 都跑）拦「代码改了、文档没跟上」这类漂移：

- 文档里的「目标运行时 / 当前目标运行时」与根 README 徽章，必须等于 `docs/runtime/` 里**最新**的版本；
- 插件 README 的状态行**不要写死版本号**（换成不依赖版本的措辞，否则每次发版都会漂）；
- `docs/adr/` 里每个 ADR 必须在 `docs/adr/README.md` 索引里；
- `docs/runtime/<版本>.md` 必须被至少一处文档引用；
- 插件 README 里写到的任何 DSH 版本（兼容表、状态行、正文），必须在 `docs/runtime/` 有对应勘察记录（防止把没验证过的版本写进兼容表）；
- **相对链接指向的文件必须存在，`#锚点` 必须能对上目标文件的标题**（按 GitHub 的 slug 规则：小写、删掉非字母数字、空格换连字符且**不折叠**连续连字符，中文原样保留）。改标题会让指向它的锚点**静默失效**——`2026-11-14` 就有一次把「两条硬约定」改成「三条」，漏掉了 `docs/runtime/` 里引用旧锚点的那处。

> 已知限制：锚点检查只看 Markdown 的 `[文案](目标)`，不解析 HTML 的 `href` / `src`（README 徽章那类）。

升级 DSH 时：新建 `docs/runtime/<新版本>.md`，再把上面几处「当前版本」指向它——漏了任何一处，`pnpm check:docs` 会直接报出来。

## 6. 测试与验证

### 6.1 桌面端自动化测试是**硬性要求**

**凡是带 client 半（`dsh.client`）的插件，必须同时提供 DSH 桌面版（Electron）的自动化测试。**
`pnpm check`、`pnpm gate <plugin>` 和 CI 的 `--dry-run` 都会拦这条，缺了直接报错。

要求与原因：

| 要求                                                                                          | 原因                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 `package.json` 有 `smoke:<name>-desktop` 脚本，指向 `scripts/smoke-<name>-desktop.mjs`     | 一条命令可跑；`pnpm gate` 能自动串起来                                                                                                                     |
| 走 CDP（支持 `--port` / `DSH_CDP_PORT`，默认 9222）                                           | 真正驱动**用户的桌面版**，不是另起一个 web 组合                                                                                                            |
| 支持 `--require`：连不上端口时**失败**而不是跳过                                              | 否则「没跑」会被当成「通过」——这是最容易自欺的地方                                                                                                         |
| **PASS 必须基于 `pass > 0`**：全 SKIP（`0 PASS / N SKIP / 0 FAIL`）视为**未验证**，门禁判失败 | 退出码 0 不等于验证过任何东西。`--require` 只防「连不上」，防不住「连上了但全 SKIP」——那是更隐蔽的假绿（2026-11-17 实测踩中，见下）                        |
| 默认**只读**：只开菜单/对话框/面板再 Esc 关闭，不执行破坏性操作                               | 要能安全地跑在默认 profile 上；破坏性流程要么放到 web 冒烟（临时 `DSH_HOME`），要么用专门的 `--deep --workspace <专用目录>`                                |
| 会打印截图目录与断言明细                                                                      | 失败时可复现、可留证                                                                                                                                       |
| 需要真机副作用的段落（如 `--deep`）**自己建立前置状态**：新建会话、确认工作区绑定后再动手     | 依赖前面段落「切回某个会话」不可靠——行在折叠分组里时点击不生效，会静默跑在**上一个会话**上，模型没有该工作区权限，表现为「文件不存在」而不是「会话没切对」 |
| 任何会写文件的段落，都要断言「没写进仓库 cwd」                                                | 会话没绑对工作区时，模型的 `write` 会落到脚本自身 cwd（本仓库根），留下未跟踪文件；断言只会显示「文件不存在」，污染完全静默                                |

为什么必须做：client 半大量依赖宿主**私有 seam**（slot、`extraActions`、`views` 接管、`commandUi.decorate`…），
这些没有类型、没有契约，单测和 web 冒烟都覆盖不到**真实 Electron 渲染进程**里的行为。

参考实现：

- `scripts/smoke-session-rewind-desktop.mjs`（25 项只读，2026-11-19 在 rc.5 实测 25/25；`--recall` 再加 7 项输入框召回；`--deep` 再加文件模式 e2e，合计 40 项）
- `scripts/smoke-session-delete-desktop.mjs`（18 项只读，2026-11-19 在 rc.5 实测 **16 PASS + 2 SKIP**——本机回收站为空时，「保留全选与批量操作」「条目布局」是**数据相关分支**，空态下不渲染工具条/条目行，按 SKIP 记；非空时照旧断言。带 `--workspace` 时另有写文件段落。这条脚本 2026-11-19 修过一次假红，见 [runtime rc.5 §6.1](runtime/0.2.2-rc.5.md#61-session-delete-桌面回归空回收站会假红)）
- `scripts/smoke-advisor-desktop.mjs`（20 项，2026-11-19 在 rc.5 实测 19 PASS + 1 SKIP；SKIP 是「该会话没有顾问记录」——脚本不制造徵询）
- `scripts/smoke-next-step-desktop.mjs`（22 项只读，2026-11-20 在 rc.5 复跑 **20–21 PASS + 1–2 SKIP**——SKIP 都是数据相关分支：「该卡没有展开按钮」「只有一粒胶囊」；**默认只读不点 ✕**（decision 是写操作、不可撤销，会让连跑不幂等），点 ✕ 归 `--deep`；胶囊按 1–2 粒断言）。**2026-11-28 起为 25 项**：新增 3 条旧卡折叠断言（只读态卡折叠成一行、折叠行无提问/胶囊/✕、折叠行文本有界），「有没有更早的只读卡」是数据相关分支（不满足时这 3 条记 SKIP）
- `scripts/smoke-casefile-desktop.mjs`（15 项只读，2026-11-19 在 rc.5 实测 15/15；注意它结束时页面停在「案卷」主面板，串行跑别的桌面回归前先点回会话）
- `scripts/smoke-btw-desktop.mjs`（19 项只读，2026-11-19 在 rc.5 实测 18 PASS + 1 SKIP；会话里已有旁问记录时是 **25 PASS / 0 SKIP**（2026-11-20 实测）；`--deep` 另跑真实 `/btw`，2026-11-20 在 rc.5 实测 **22 PASS + 1 SKIP**，真实数据根落下 `status=done` 记录）

**收尾的计数行不是装饰，也不靠自觉（2026-11-19 发现，2026-11-20 上护栏）**：`parseCounts()` 只认 `N PASS / M SKIP / K FAIL`；
脚本不打这一行时它返回 `undefined`，`isVacuousPass()` 就**永远放行**——门禁的假绿检测对该脚本等于不存在。
2026-11-19 复核发现 advisor / next-step / session-rewind / casefile / session-delete 五条脚本都漏了这一行（只有 btw 打了）。

现在有三层护栏：

1. **门禁判失败**：`gate.mjs` 的 `countedStageVerdict()` 对 **web 冒烟与桌面回归**都判 `missing-counts` /
   `vacuous`，拿不到计数行或一条断言都没跑都直接失败——不再把「无法判断」当成「通过」。web 冒烟在缺
   `dsh` / `ego-browser` 时的**早退分支也必须打印 `0 PASS / 1 SKIP / 0 FAIL`**（否则门禁同样判假绿）。
2. **静态检查**：`pnpm check`（`check-plugins.mjs`）扫所有 `scripts/smoke-*.mjs`（web + 桌面）：没有计数行
   就是 error；「缺环境会早退」的脚本还要求早退分支带 `0 PASS / N SKIP / 0 FAIL`。
   `templates/plugin-desktop-smoke/smoke.js` 也带这一行，新插件不会再漏。
3. **单测锁住**：`scripts/test/gate.test.js` 覆盖 `missing-counts / vacuous / ok` 三种判定，
   `scripts/test/scaffold-and-check.test.js` 覆盖「模板生成 → 检查通过」与「漏计数行 → 报错」。

**「跑过但零断言」必须判失败（2026-11-17 血的教训）**：

`--require` 只保证「连不上端口就失败」，但脚本**连上了、又因为安全检查全 SKIP** 时退出码仍是 0。
门禁如果只看退出码，就会把「一条断言都没执行」报成「全绿」。

实测发生的输出（`pnpm gate btw`，agent 在自己的会话里跑）：

```
▶ [4/4] 桌面只读回归（需要调试端口）
SKIP 桌面交互 — 当前会话有运行中的回合（agent 自己跑回归时会这样）；切到空闲会话再跑

0 PASS / 1 SKIP / 0 FAIL
✓ 桌面只读回归（需要调试端口）

PASS btw 门禁全绿（4 步，24s）        ← 假的
```

**修法（`scripts/gate.mjs` 已实现）**：解析每阶段的 `N PASS / M SKIP / K FAIL` 收尾行，
桌面阶段 `pass === 0 && fail === 0` 直接判失败并打印可操作原因；**没有计数行**同样判失败
（2026-11-20 起，见上一条）。判定逻辑导出为 `parseCounts` / `isVacuousPass` / `desktopGateVerdict`
（`scripts/test/gate.test.js` 覆盖）。

写桌面脚本时的对应义务：

- 收尾**必须**打印 `N PASS / M SKIP / K FAIL`（门禁靠它判定，格式不能改；`pnpm check` 会静态拦 **所有** `smoke-*.mjs`，web 与桌面一视同仁。`smoke-agent-tool` 需要真实模型凭据、不在 gate/gate:all 里，作为诊断脚本豁免）
- SKIP 只能在「数据相关分支」用（例如「该会话没有可交互卡」），**不能**用来兜住前置失败
- 一个插件如果所有断言都能被 SKIP 掉，说明脚本设计有问题——至少留一条**无条件**断言
- **会话是空白（blank）时不要断言命令卡片**：斜杠命令的生命周期事件是 log-only，客户端在
  `blank` 会话里走 hero 空态、不构建任何会话节点；先发一条普通消息让会话 materialize 再断言
  （宿主的 `conversationPhase()` 判定与实测见 [runtime rc.5 §5.2](runtime/0.2.2-rc.5.md#52-命令卡片只在非空白会话里渲染2026-11-20-实测)，`smoke:btw --deep` 已按此热身）
- **只读模式不得写会话日志、不得产生不可撤销的决策。** 「只读」= 只开菜单/对话框/面板、切会话、
  再 `Esc` 关掉。点 `✕` 关闭倡议卡这类动作会往会话日志追加 `plugin:<name>/decision`，把那张卡
  **永久**变成只读态——连跑几次就把用户会话里仅有的可交互卡消耗光，下一次运行直接红
  （2026-11-20 next-step 实测）。**写路径一律放 `--deep`**，而且优先放在 web 冒烟的临时 `DSH_HOME` 里
  （数据可丢）；桌面 `--deep` 只留「真实数据根往返」这类临时 home 覆盖不到的事，并在文档里写明会写什么。
- **只读回归必须幂等**：同一个桌面会话**连跑两次**，结果与断言数应当一致（SKIP 的数据分支可以不同，
  但不应因为第一次运行改了状态而失败）。用 `pnpm gate:all --repeat 2` 自动做这件事：连跑两次、
  任何一次 FAIL 都判红，计数漂移只提示不判红。这是本轮唯一靠「跑第二遍」才暴露的缺陷类别。
- **首启弹窗要轮询到真正消失**，别只点一次：`预览版说明` 可能比第一次点击晚一拍出现，盖住输入框后
  斜杠菜单空、设置打不开（索引冒烟与 advisor 冒烟都栽过，见 [runtime rc.5 §6.4](runtime/0.2.2-rc.5.md#64-索引源冒烟smokeindex的两个环境假设)）。
  这段轮询逻辑**不要在每个冒烟里各抄一份**：用 `scripts/lib/browser-helpers.mjs` 的 `NOTICE_DISMISS_SOURCE`
  插值进浏览器脚本模板（2026-11-20 从 6 份复制收成 1 份，btw 的数组式脚本用 `NOTICE_DISMISS_SOURCE,` 单独一项）。
- **冒烟脚本要显式清掉从真实 profile 复制进来的用户配置**（索引源、市场源…），否则「用户自己点过某功能」
  会让冒烟变红，看起来像升级坏了（同 §6.4）。

**agent 自己跑桌面回归时会撞上的前置**：advisor / next-step 的脚本带「当前会话不能有运行中的回合」的安全检查
（检测到「停止」按钮就拒绝一切交互，只留 SKIP）。而 agent 的回合就跑在同一个桌面版里，所以它自己跑必然失败。
做法是把**可见会话**切到一个空闲会话再跑，跑完切回——切换只是换视图，不会中断正在跑的回合（2026-11-14 实测）。

发版前用 `pnpm gate <plugin>` 一次跑完（桌面步骤永远带 `--require`）：

```bash
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
pnpm gate session-rewind
```

细节与坑见 [docs/testing/session-rewind.md](testing/session-rewind.md)（Esc Esc 会打断当前会话、
挑选「候选可达」的会话、紧跟 web 冒烟后要等页面可交互等）。双击 `Esc` / `↑` `↓` 这类**手势**断言
建议加一次不降低断言的重试：切会话或关掉上一个对话框之后，焦点与回合状态可能还差一拍，
第一次按不出、第二次就出来（session-rewind 的桌面脚本已这样做）。

### 6.2 其余测试层次

1. 单元测试：`node --test`，放在 `packages/<name>/test/`。文件系统相关逻辑一律在 `mkdtemp` 临时目录里测。
2. `pnpm verify`：lint + 类型检查 + 规范检查 + 文档一致性 + 测试。
3. 真实验证（必须做）：`cd packages/<name> && pnpm pack --pack-destination /tmp`，再 `dsh plugin --profile desktop add /tmp/<tgz>`，然后重启桌面版（host 半改动）或刷新页面（client 半改动），在 GUI 里手动点一遍。改完代码要**重新 pack 并再次 add** 才会更新已装副本；`link:` 安装会因宿主包解析不到而激活失败（[runtime](runtime/0.2.1-rc.5.md) §6.9）。
4. 验证完可以 `dsh plugin --profile desktop remove <包名>`，再 `add` 正式版。

### 6.3 用 ego-browser 跑 GUI 冒烟时的三条硬约定

ego 的浏览器是**和用户共用**的实例：它的 cookie jar 里装着用户自己的登录态。写 GUI 冒烟脚本时必须遵守下面两条，否则会「跑几次就坏」或者损坏用户数据。

1. **只清理自己的 cookie，禁止 `Network.clearBrowserCookies`。**
   临时宿主的地址是 `127.0.0.1:<随机端口>`，而 cookie 按**主机名**共享（端口不隔离），每次冒烟又用新 token、cookie 名里带 token（`dsh-auth-<hash>`），于是每轮都新增一条而不会覆盖旧的。攒到请求头超过宿主上限（Node 默认 16 KB）时，页面直接 `431`，ego 只会报 `ERR_HTTP_RESPONSE_CODE_FAILURE`，很难联想。
   正确做法：只删 `domain ∈ {127.0.0.1, localhost, ::1}` **且** `name` 以 `dsh-auth-` 开头的 cookie，并在跑完后再清一次（别把垃圾留给下一轮）：

   ```js
   const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
   const found = await page.cdp("Storage.getCookies", {});
   const mine = (found.cookies ?? []).filter(
     (c) => LOOPBACK.includes(c.domain) && String(c.name).startsWith("dsh-auth-"),
   );
   for (const c of mine) {
     await page.cdp("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
   }
   ```

   全清会顺手删掉用户自己的站点登录态、以及本机其它 dev server 在 `127.0.0.1` 上的会话——这属于破坏用户数据。

2. **页面额度是硬上限（8 个），自己开的页面要自己关。**
   `TaskSpace` 对每个任务空间限制 8 个 Page。冒烟里 `task.newPage()` 建了第二个标签页却不关，
   就会随每轮运行累积，攒满后**所有**断言都以 `Page budget reached (8/8)` 失败——表现像被测代码坏了。
   做法：开跑前清理遗留页面，跑完关掉自己开的；`task.page()` 只能引用**已存在**的页面，新建要用 `await task.newPage()`。

3. **浮层的状态不能跨 `page.evaluate` 保持。**
   宿主在两次 evaluate 之间会重渲染，刚打开的面板/编辑器会被收掉，后续调用一律拿到空引用（表现为「断言说打不开，但其实打开过」）。因此：**打开面板 + 在面板里做的一连串操作要放进同一个 evaluate**；需要分步时，每步开头都先检查目标是否还在，不在才重开。另外截图（`page.screenshot`）要在面板还活着时立刻执行——如果截图前先做 DOM 脱敏（遍历改写文本节点），那次改写本身就可能把面板刷掉。

### 6.4 冒烟失败时必须留下现场

断言失败的价值等于它留下的证据量。2026-11-14 的一次真实教训：`smoke:next-step` 首跑 2 FAIL，报告只有一句「宿主生成失败/被门挡/客户端没渲染」；插件那边四种失败原因映射到同一句文案、中止路径又不落盘，而冒烟按默认策略把临时 `DSH_HOME` 删了——**原因从此不可恢复**，只能靠后来重跑猜。

三条要求：

1. **失败自动保留临时目录**，不要只在 `SMOKE_KEEP=1` 时保留。临时 `DSH_HOME` 里有宿主日志、profile 与插件设置文件，是唯一的现场。保留时把路径打出来，并说明「因为失败而保留」。
2. **把被测插件自报的原因打出来**，而不是替用户猜。插件侧留 `data-*` 锚点（如 `data-next-step-retry-error`、`data-advisor-error`）承载失败原因；冒烟在失败分支读它、作为一条断言/明细输出，并在汇总里再打一遍。
3. **先搬截图，再删目录**（顺序反了会把证据一起删掉）。截图目录与临时目录不要放在同一个会被递归删除的父目录里。

配套的插件侧要求：**同一类失败不要都映射到同一句文案**。至少让「超时 / 取消 / 业务失败」在诊断计数或文案上分得开——否则事后只能看到「操作失败」。`next-step` 的 `counters.aborted` 与 `error.aborted` 就是按这条补的。

---

## 7. 界面（UI）约定

这一节是四个插件（session-delete / session-rewind / advisor / next-step）在 2026-11 那轮界面重构里收敛出来的共性。
**判据是「用户会不会误操作、看不懂、找不到」**——不是「长得像不像」。视觉语言、信息密度、交互形态留给各插件自己定（见 §7.9）。

### 7.1 东西放哪里

| 内容                                   | 去处                                      | 理由                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件设置（偏好、开关、预算、诊断）     | **`settings.section` 的独立分节**         | 塞进 `settings.general.item` 会把它撑成一张大卡，还要滚动才能看到；每个插件一个分节，`order` 在 **90–96 内唯一**（8 个发布插件按目录顺序分配：session-delete 90 / session-rewind 91 / advisor 92 / next-step 93 / projects 94 / btw 95 / casefile 96；并列会让设置页顺序取决于注册时序），`label` 用 `ctx.locale.bind(NS)`（§2 没有现成的 `t`） |
| 跨会话的全局能力（回收站这类）         | `sidebar.footer.action` + `shell.overlay` | 它在会话之外还有意义，不该绑死在某个会话头部                                                                                                                                                                                                                                                                                                    |
| 会话级数据（撤回历史、救援点、决策卡） | 会话内面板 / 对话流                       | 这些数据离开当前会话就没有意义，搬进全局设置页语义是错的                                                                                                                                                                                                                                                                                        |
| 一次性动作（删除、批量清空）           | 会话/工作区菜单（`contextMenus`）、快捷键 | 用官方贡献点，菜单才会显示键位提示，也能进宿主的快捷键编辑面板                                                                                                                                                                                                                                                                                  |

### 7.2 设置页

1. **首屏只留 3 行摘要**（最常改或最想确认的：模式、路由、预算这种），其余收进「更多设置」折叠并**默认收起**。
2. 摘要里的控件要能直接改（紧凑下拉），而不是只读展示——否则改一个模式要点两次。
3. 诊断 / 用量单独成块、默认折叠；正常态只显示一行结论（`正常 · 版本 1`），细节展开再看。
4. 折叠标题**不要放「有改动项数」这类徽标**：`▸ 更多 13` 会被读成「还有 13 项没看」。
5. 保存类动作条固定在底部；没有改动时禁用（而不是点了没反应）。
6. **保存状态必须可见**：每个设置分节都要有一行固定位置的保存状态（`data-<plugin>-settings-status`，
   `data-state` 取 `clean` / `dirty` / `saving` / `saved` / `error` / `readonly`）。
   - 显式保存：有改动时显示「有未保存更改」并启用保存按钮；无改动时按钮禁用、状态显示「已保存」。
   - 自动保存：改动落盘后先显示「已保存」（2–3 秒）再回落「· 已保存」；失败显示「保存失败：原因」，
     并给可点的重试入口（`data-<plugin>-settings-retry`）。
   - 纯只读分节（如 casefile 的诊断）标 `readonly` 并写「无可保存设置」，**不要**伪造「已保存」。
   - 状态行是「已保存 / 未保存」的唯一出口：不要再额外弹 toast / 常驻 notice 重复同一句话（§7.6.3）。
     动作自身的业务回执（如「预算已保存：日线程 7 · …」）可以保留——它给的是保存了什么，不是重复状态。
   - 显式保存按钮的稳定锚点：`data-<plugin>-settings-save`（可与既有 `data-<plugin>-save` 并存）。

### 7.3 面板

1. **单页优先，页签最多 3 个。** 超过 3 个基本说明有功能该外迁——审计、设置、诊断这类都应该进设置页。
2. 面板顶部只留标题 + 次要动作（刷新 / 关闭）；不要在头上再叠工具条。
3. 空列表给一句话空状态，不要留空白区域让人以为加载失败。

### 7.4 破坏性操作的界面（[ADR 0002](adr/0002-destructive-operations.md) 之上）

1. **一行影响面**：数量 · 体积 · 是否在跑 · 能否恢复。技术细节（路径、标记、ID）进「详情」折叠。
2. 主按钮用宿主的 `data-modal-autofocus` 默认聚焦，**回车即执行**；不可执行时焦点回落「取消」。
3. 级联勾选（是否连带子会话）要**记住上次选择**；存数据根，不要用 `localStorage`——Web 端的 origin 带随机端口。
4. 批量执行**分批 + 进度 + 可停止 + 失败汇总**（当前实现 20 条/批），并在服务端留一个防御性硬上限（当前 200）。
5. 宿主有单次上限时（例如批量 RPC 只收 50 条），界面必须分批，不能把整单选齐后一次性提交——否则会被整单拒绝，看起来像「点了没反应」。

### 7.5 列表行

行 = 复选框 + **文本块** + 动作区，其中文本块是「标题行 + 元信息行」，动作区 `flex: none`。
文本块必须 `min-width: 0`，否则在窄容器里标题会被压成一个 `…`（真机出现过 `❗…`）。
行内动作默认隐藏，hover / focus 才出现，减少视觉噪声。

### 7.6 提示与卡片

1. **输入框内的 ghost 提示**：只在草稿为空且会话空闲时出现，`Tab` / `→` 接受，开始打字即消失，`Esc` 清除。它是「少打字」的入口，不是通知。
2. **卡片只在有真决策时出现**。内容不合格（没有具体对象、说不清下一步）时**整张不渲染**，不要用占位或兜底话术凑一张。（唯一例外：next-step 的「积极」档会连模型判 `no` 的卡一起显示，属 opt-in 校准实验档，见 [ADR 0013](adr/0013-next-step-gating-telemetry.md)；默认档位不偏离本条。）
3. 同一个信息不要用两种形态重复说：同时开卡片和 ghost 时，要么明确分工（一个给方向、一个给可直接发送的句子），要么只留一个。
4. 按钮 / 胶囊上的文案**就是点击后原样发出的内容**（WYSIWYG）；不要显示短标签、实际发送另一段话。
5. 建议类文案要能过「用户会这么说吗」的检验：写**具体对象**（文件名、命令、参数、版本号），不写「检查一下是否准确」这种放到哪一轮都成立的空话。

### 7.7 文案与本地化

1. 中英双语，键集必须一一对应（`test/locale-parity.test.js` 会拦）。
2. **同一个键不要在 `LOCALE_EXTRA` 和内嵌字典各定义一次**：后合并的会赢，渲染出来可能是半截词（`更多设置` → `更多`）。
3. 界面上的状态词要能落到日志/账本里的同一字段。宿主把「非成功结果」统一渲染成「失败」前缀（例如顾问的 `declined`），遇到这种要在文档里说明，别让用户以为是报错。
4. 说明性文案直接回答用户最可能问的那个问题，例如两个开关共用一个模型调用时，就写「两者共用同一次生成，同时打开不会额外计费」。

### 7.8 可测性

1. 关键节点给**稳定的 `data-*` 锚点**（`data-<plugin>-settings`、`data-row-key`、`data-modal-autofocus`…），冒烟和桌面回归靠它定位；只靠文案会随改文案而碎。
2. 面板 / 卡片的根节点带自己的属性（如 `data-advisor-summary`），断言才能区分「渲染了」和「渲染成什么样」。
3. 界面改动要重拍 README 截图，并做 DOM 层脱敏（工作区名、会话标题、UUID、本机路径），不要把真实会话内容带进仓库。

### 7.9 明确留给各插件的空间

以下是**不强制统一**的，按插件自己的形态选：

- 视觉语言、图标、信息密度、圆角/间距；
- 面板是抽屉、浮层、整页还是对话流内嵌；
- 卡片 / 胶囊的数量与文案风格（只要满足 §7.6 的具体性要求）；
- 快捷键默认键位（注意 Linux 不接受「修饰键 + Backspace/Delete」，这类插件就别设默认键，只留可改键）；
- 设置页里具体有哪些字段、诊断项列什么。

### 7.10 参考实现

按本文改造过的四个插件，各自代表了不同的形态，可以对照着看：

| 形态                      | 参考                                                                                           | 看什么                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 全局面板 + 设置分节       | [session-delete](https://github.com/kangyishuai/dsh-plugins/tree/main/packages/session-delete) | 侧栏入口、单页面板、批量分批、确认框默认焦点、级联勾选记忆        |
| 抽屉 + 设置分节           | [session-rewind](https://github.com/kangyishuai/dsh-plugins/tree/main/packages/session-rewind) | 4 页签 → 3 页签的瘦身、会话级数据与用户级设置的切分               |
| 设置分节为主              | [advisor](https://github.com/kangyishuai/dsh-plugins/tree/main/packages/advisor)               | 首屏三行摘要 + 折叠「更多设置」、长表单的信息分层                 |
| 对话流内卡片 + 输入框提示 | [next-step](https://github.com/kangyishuai/dsh-plugins/tree/main/packages/next-step)           | 卡片与 ghost 两种入口、内容门控（不合格就不渲染）、按钮即发送内容 |

### 7.11 改界面前的自检清单

- [ ] 设置进的是 `settings.section`，不是 `settings.general.item`；首屏 ≤3 行。

> **别把关键开关只放在设置分节里**（2026-11-22 实测）：`settings.section` 只在**已登录**的 profile 里渲染——
> 未登录时页面停在「开始使用」，插件配置区根本不出现。dsh-projects 因此把六个危险开关同时放进了
> 项目详情的「高级设置」；设置分节仍保留，但不再是唯一入口。
- [ ] 面板页签 ≤3，次要功能已外迁；**对齐宿主产品的固定 IA 时允许 4 个**（须在 README 说明理由，如 `dsh-projects` 的「线程/Library/Routines/视图」对齐 Claude Projects）。
- [ ] 破坏性操作：一行影响面 + 默认聚焦主按钮 + 分批 + 可停止 + 写审计。
- [ ] 列表行文本块有 `min-width: 0`，窄容器下标题不会被压成省略号。
- [ ] 只用宿主已定义的主题 token，前景/底色成对（§2）。
- [ ] 中英文案同步，没有重复定义的键。
- [ ] 关键节点有 `data-*` 锚点，web 冒烟与桌面回归都能定位。
- [ ] README 截图已重拍并脱敏。

## 8. 跨插件调用契约（Remote API）

> 本节只写**跨插件可见的稳定契约**：别的插件能调什么、怎么调、出错怎么判、装不上怎么降级。
> 存储布局、客户端组件这些实现细节**不是**契约，随时会变。
> 契约实例：`@kangyishuai/dsh-artifacts`（0.2，契约版本 `artifacts/2`）；新增跨插件契约按本节格式补一节。

### 8.1 三条原则

1. **只走 Remote（或宿主 cordis 服务），不读别人插件的存储目录。** 目录布局是私有的：读它等于把两个插件的发版绑死，而且插件升级后可能静默读到一半数据。
2. **两端两个入口**：client 半用 `ctx.connection.rpc.call("/api", "<service>/<method>", …)`；host 半用 `ctx.get("<service>")`。两条入口背后是**同一个** service 实例和方法集。
3. **先探契约再调**：每次使用先问 `version()` 的 `contract`（或至少判 `ctx.get()` 是否 `undefined`）。**缺依赖时降级并且明示**，不要伪装成"没有数据"。

### 8.2 调用形状

**client 半**（另一个插件的 `lib/client.js`）：

```js
/** 统一解 { ok, value } 信封；失败返回 undefined，由调用方降级。 */
async function call(method, request) {
  const rpc = ctx.connection?.rpc;
  if (typeof rpc?.call !== "function") return undefined;
  const payload = request === undefined ? { args: {} } : { args: { request } };
  const result = await rpc.call("/api", `artifacts/${method}`, payload);
  if (result && typeof result === "object" && Object.hasOwn(result, "value")) return result.value;
  return result;
}
```

- **参数必须包两层**：`{ args: { request } }`；无参数方法用 `{ args: {} }`（见 [runtime 0.2.2-rc.3 §12.4](runtime/0.2.2-rc.3.md#124-client-半ui)）。
- 网关信封是 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`；插件自己的信封在 `value` 里，另有 `value.ok`。
- 没有 typert 生成的客户端产物，**不要**用 `ctx.reflect.get("remote.artifacts")`。

**host 半**（另一个插件的 `lib/index.js`）：

```js
const artifacts = ctx.get?.("artifacts");                       // 未安装 → undefined
if (artifacts === undefined || typeof artifacts.list !== "function") return degraded();
const version = await artifacts.version().catch(() => undefined); // 契约探针（可选）
const page = await artifacts.list({ projectId });
```

- `ctx.get()` 是"可选依赖"的取法：拿不到就返回 `undefined`，不会挂起。**不要**为了可选依赖写 `ctx.inject(["artifacts"], …)`。
- service 实例被宿主包成 **Proxy**：只调方法，不要访问 `#private` 字段或私有属性（[runtime 0.2.2-rc.3 §11.1](runtime/0.2.2-rc.3.md#111-service-实例被-cordis-包成-proxy--不能用--私有成员)）。
- 跨插件**不要**用 host 半去 `fetch("/api/...")` 兜底：那要多一次鉴权上下文，且拿不到同一份内存状态。

### 8.3 `artifacts` · 契约版本 `artifacts/2`

方法集（`version().methods` 与本节必须一致，`test/remote-declarations.test.js` 会静态对账）：

| Remote 方法         | 参数（`request`）                                                                                               | 成功返回（除 `ok: true` 外）                                                                                    | 用途                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `artifacts/version` | 无                                                                                                              | `{ service, plugin, packageVersion, contract, kinds[], maxBytes, methods[] }`                                   | 契约探针：先问版本再决定用哪些字段                                    |
| `artifacts/list`    | `{ projectId?, sessionId?, threadId?, kind?, title?, since?, until?, includeArchived?, onlyArchived?, limit? }` | `{ contract, artifacts: Row[], summary: Summary }`                                                              | 列表 + 项目级汇总（Library 的主入口）                                 |
| `artifacts/latest`  | `{ id, since? }`                                                                                                | `{ contract, id, title, kind, mime, version, bytes, totalBytes, projectId, source, versionSource, changed, … }` | 轮询/预览；`since === version` 时只回 `changed: false`                |
| `artifacts/archive` | `{ ids?, projectId?, archived?, dryRun? }`                                                                      | `{ contract, dryRun, archived, count, bytes, ids[], unknown[] }`                                                | 归档（只读 + 默认不进列表）；可按项目级联                             |
| `artifacts/remove`  | `{ ids?, projectId?, dryRun? }`                                                                                 | `{ contract, dryRun, restorable: true, trashRoot, count, bytes, ids[], removed[], unknown[] }`                  | 级联清理（**移入回收站**，ADR 0002）                                  |
| `artifacts/restore` | `{ ids, dryRun? }`                                                                                              | `{ contract, dryRun, count, bytes, ids[], restored[], unknown[] }`                                              | 从回收站恢复（`ids` 可给 id 或 `trashKey`）                           |
| `artifacts/trash`   | 无                                                                                                              | `{ contract, artifacts: Row[], summary }`（行多 `trashKey` + `trashedAt`）                                      | 回收站清单                                                            |
| `artifacts/purge`   | `{ ids?, projectId?, dryRun? }`                                                                                 | `{ contract, dryRun, restorable: false, count, bytes, ids[], purged[], unknown[] }`                             | 硬删（**不可恢复**，只对回收站生效；`ids` 同样接受 id 或 `trashKey`） |

**`list` 过滤语义**（条件之间是 AND；全部不传 = 全量，兼容 0.1.0）：

| 参数              | 类型                 | 语义                                                                         |
| ----------------- | -------------------- | ---------------------------------------------------------------------------- |
| `projectId`       | `string \| null`     | 精确匹配；`null` = 只要**没有归属**的产物；**不传** = 不按项目过滤           |
| `sessionId`       | `string`             | 精确匹配产生它的会话                                                         |
| `threadId`        | `string`             | 精确匹配产生它的线程（项目自己维护线程 id 时用）                             |
| `kind`            | `string \| string[]` | `html` / `markdown` / `json` / `csv` / `image`；不认识 → `artifacts/invalid` |
| `title`           | `string`             | 标题子串、大小写不敏感                                                       |
| `since` / `until` | `number`（epoch ms） | 按 `updatedAt` 的时间窗（含端点）                                            |
| `includeArchived` | `boolean`            | `true` 时把已归档的一起列出来（默认排除）                                    |
| `onlyArchived`    | `boolean`            | `true` 时只列已归档的                                                        |
| `limit`           | `number`             | 截断条数（`summary` 同时按截断后的集合算）                                   |

**行 `Row`（跨插件只依赖这些字段）**：

| 字段                                      | 类型                                     | 说明                                                                         |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `id`                                      | `string`                                 | 稳定 id（删除后不复用）                                                      |
| `title` / `kind` / `mime`                 | `string`                                 | `kind` 是 `html` / `markdown` / `json` / `csv` / `image`                     |
| `latest`                                  | `number`                                 | 最新版本号（从 1 开始）                                                      |
| `bytes` / `totalBytes`                    | `number`                                 | 最新版本字节数 / 所有版本之和                                                |
| `createdAt` / `updatedAt`                 | `number`                                 | epoch ms                                                                     |
| `projectId` / `sessionId` / `threadId`    | `string \| null`                         | 归属；没有就是 `null`（不是缺字段）                                          |
| `source`                                  | `{ sessionId, toolCallId, via } \| null` | 来自哪个会话的哪次工具调用（"哪次线程跑出来的"）                             |
| `archived` / `archivedAt`                 | `boolean` / `number \| null`             | 归档后只读；列表默认不返回                                                   |
| `coverUrl` / `previewUrl` / `downloadUrl` | `string`                                 | **相对路径**（`/artifacts/<id>…`），客户端直接用；`downloadUrl` 触发附件下载 |

**破坏性方法的 `bytes` 语义**：`archive` / `remove` / `restore` / `purge`（以及它们的 `dryRun` 信封）里的 `bytes` 是**这次实际会移动 / 删除 / 恢复的全部字节（所有历史版本之和）**，不是行字段里的「最新版字节」——ADR 0002 要求确认框显示真实影响面。行与 `summary` 的 `bytes` 仍是「各工件最新版本字节之和」，`totalBytes` 才是含历史的占用；两处含义不同，不要混用。

**id / trashKey 的边界**：`list` 与 `latest` 的 `id` 必须是**单段目录名**——带 `/`、`\\`、控制字符、`.`/`..` 或以点开头的 id 一律拒绝（契约层给 `artifacts/invalid`，HTTP 路由给 `400`）。回收站里同名条目会加时间后缀，所以 `trash()` 行里的 **`trashKey` 才是权威键**：`restore` / `purge` 的 `ids` 接受 id 或 trashKey；找到了但恢复不了（目标 id 被占用）会出现在 `unknown[]` 里，**不会静默留字节**。

**`Summary`**：`{ count, bytes, byProject: [{ projectId: string \| null, count, bytes }] }`。
`bytes` 一律是"各工件**最新版本**字节数之和"，与行里的 `bytes` 同一口径（`totalBytes` 才是含历史的占用）。

**`latest` 的正文语义**：`kind=html` 给 `html`；`markdown` / `json` / `csv` 给 `text`；`image` **不给正文**（二进制不上行），用 `previewUrl` 交给 `<img>` 或浏览器。`changed: false` 也带 `kind`，客户端不需要猜类型。

**归属/来源字段（`meta.json`，写侧契约）**：`projectId?` / `sessionId?` / `threadId?` 由 `artifact` 工具的 `projectId` / `threadId` 参数与工具上下文（`exec.agent.id`、`exec.callId`）写入；`source` 记首次产生它的调用，`versions[].source` 记每一版各自的调用。旧数据缺这些字段时按 `html` + 无归属读，**不会迁移或改名**。

### 8.4 错误码与降级

| `code`                       | 含义                                                                             | 调用方应该做什么                                        |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `artifacts/invalid`          | 参数不合法（缺 `id`、缺 `ids`/`projectId`、未知 `kind`）                         | 修参数；**不要**重试                                    |
| `artifacts/not-found`        | id / 版本不存在                                                                  | 从列表里剔掉，刷新 UI                                   |
| `artifacts/archived`         | 已归档，拒绝追加版本                                                             | 提示"已归档，先取消归档"                                |
| `artifacts/kind-mismatch`    | 追加的类型与已有工件不同                                                         | 换新 id 发布，不要混版本                                |
| `artifacts/too-large`        | 单件超过 2 MiB                                                                   | 拆分或压缩                                              |
| `artifacts/unsupported-kind` | 不认识的类型/图片格式                                                            | 换支持的格式（png/jpeg/gif/webp/svg）                   |
| `artifacts/failed`           | 文件系统/内部错误（EACCES、ENOSPC、EIO…），或**版本内容损坏**（见下条 `reason`） | 提示失败原因；用信封里的 `processed[]` 判断已处理了哪些 |
| 网关 `404`（纯文本）/ 抛错   | **插件没装**，或方法名写错                                                       | 降级 + 明示"未安装 artifacts"                           |

**降级的正确姿势**（以 projects 的 Library 为例）：

1. host 侧：`ctx.get("artifacts")` 为 `undefined`，或 `typeof service.list !== "function"` → 判定未安装；
2. `await service.version()` 抛错或 `version().contract !== "artifacts/2"` → 判定版本不兼容（0.1.0 没有 `version()`）；
3. 未安装/不兼容 → 退回宿主 `workspaceFiles` 的文件列表，并在面板写明"产物库需要 artifacts 0.2"，**不要**显示"这个项目没有产物"；
4. client 侧同一套判断：RPC 抛错或 `value?.ok !== true` → 同上降级。

**`artifacts/failed` 的可选细分原因**：失败信封可能带一个可选 `reason` 字段，用来区分「同一错误码下的不同事实」：

| `reason`          | 含义                                                                                | 调用方应该做什么                                                                  |
| ----------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `corrupt-version` | 版本文件的实际字节数或 `sha256` 与 `meta.json` 记录不符（读到这一版就拒绝返回正文） | 提示「这一版已损坏」；不要重试，也别把坏正文当正常版本展示（HTTP 路由同判 `500`） |

`reason` 是**加可选字段**（不升契约版本，见 §8.6）；调用方不认识某个新 `reason` 时按通用失败处理即可。

**失败信封的形状**：任何方法都不会向调用方抛异常；失败时除 `{ ok:false, code, message }` 外，
破坏性方法还带 `dryRun` 与 `processed[]`（已经真处理过的 id/key），`restore`/`purge`/`remove` 的
`unknown[]` 是"请求了但没动成"的 id（不存在 / 目标 id 被占用 / 不安全 id）。

**破坏性操作由调用方负责确认框**：`remove` / `purge` 是 API 层，插件自己不带确认 UI。调用方必须先 `dryRun: true` 拿影响面（`count` / `bytes` / `ids`），把数量与"可恢复/不可恢复"写进确认框（ADR 0002），再执行。

### 8.5 从别的插件打开产物面板（client 半）

`artifacts` 的右栏页签类型是 `artifact`，参数如下：

| `params`                         | 效果                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `{ id }`                         | 预览该 id 的最新版本（html 用 iframe，文本用 `<pre>`，图片用 `<img>`） |
| `{ view: "library" }`            | 全局库视图（列表 + 缩略图 + 搜索/类型过滤）                            |
| `{ view: "library", projectId }` | **按项目过滤的库视图**（项目页点"产物"用它）                           |

```js
// 另一个插件的 client 半（自己 inject "sidebarRight"；拿不到就降级为自绘入口）
ctx.sidebarRight?.openTab?.("artifact", { params: { projectId } });
```

冒烟与桌面回归依赖的 `data-*` 锚点（改名等于拆测试）：`data-dsh-artifact-library`、`data-dsh-artifact-library-scope`、`data-dsh-artifact-summary`、`data-dsh-artifact-search`、`data-dsh-artifact-kind-filter`、`data-dsh-artifact-list`、`data-dsh-artifact-card`、`data-dsh-artifact-cover`、`data-dsh-artifact-frame`、`data-dsh-artifact-text`、`data-dsh-artifact-image`、`data-dsh-artifact-version`、`data-dsh-artifact-back`、`data-dsh-artifact-header`。

### 8.6 改契约的流程

- **加方法 / 加可选字段**：契约版本不变（`artifacts/2` 仍是 `artifacts/2`），但要同步：本节表格、`version()` 的 `methods`、`test/remote-declarations.test.js`。失败信封的 `reason` 就是按这条加的（例如 `artifacts/failed` + `reason: "corrupt-version"`）：调用方必须容忍未知值，按通用失败降级。
- **改字段含义 / 删字段 / 改默认值**：契约版本 +1（`artifacts/3`），在 CHANGELOG 写清迁移方式，并保留至少一个 minor 的旧行为或明确弃用窗口。
- **表里没写的字段不要依赖**：那是实现细节，不承诺稳定。
