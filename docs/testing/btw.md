# btw 测试与验证

## 分层次

| 层                   | 命令                                      | 覆盖                                                                                     |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| 单测                 | `pnpm --filter @kangyishuai/dsh-btw test` | 路径解析、历史上限与坏行、提示词消毒、只读 guard、locale 键集、白名单解析（14 项）       |
| 规范 + 类型 + 文档   | `pnpm verify`                             | biome / tsc / check-plugins / index-meta / docs 一致性                                   |
| web 冒烟（不花钱）   | `pnpm smoke:btw`                          | 临时 `DSH_HOME` 起真实宿主：页面可交互、过掉预览版说明、能新建会话、**斜杠菜单列出 btw** |
| web 冒烟（真实调用） | `pnpm smoke:btw --deep`                   | 上述 + **真跑一次 `/btw`**，断言 history 落盘与耗时/缓存数字                             |
| 桌面回归             | _v0.2 起_                                 | 有 client 半后按约定 §6.1 补 `pnpm smoke:btw-desktop --require`                          |

## web 冒烟为什么默认不提交

无凭据时**宿主自己拒收**：composer 显示「请选择模型 / 登录 DeepSeek 账号，或添加 API Key」，
命令根本到不了宿主。所以默认模式只验证「注册与可见性」，提交与执行由 `--deep` 覆盖 —— 这不是跳过失败，
而是把「无凭据时做不到的事」显式标成 SKIP 并写清原因（约定 §6.4）。

## `--deep` 的实测输出（2026-11-16，DSH 0.2.2-rc.3）

```
7 PASS / 2 SKIP / 0 FAIL（--deep）
PASS history 文件已生成（session-b0d1cea0-…jsonl）
  record status=done answerLen=2 cost={"inputTokens":1382,"cacheReadTokens":9216,"outputTokens":2,"totalTokens":10600}
```

`cacheReadTokens 9216 / 10600 ≈ 87%` 命中（另一次运行 84.5%），`cacheWriteTokens` 为 0 —— 与
`notes` 里的独立实验（57%→94%）一致，说明插件的实际调用路径确实复用了主会话前缀缓存。

2 项 SKIP 是 DOM 命令卡片断言没抓到（时序/选择器），执行本身已由 history 落盘证明；卡片断言留待桌面回归补。

## 排障记录（踩过的坑，别再踩）

1. **`dsh plugin add` 建出的 profile 只有 base bundle**，没有 web bundle → `dsh --port 0` 不启 web server、不打印带 token 的 URL。冒烟里显式把 `@deepseek-ai/dsh-web-app` 补上。
2. **工作区路径必须 `realpath`**：macOS 上 `/var` 是 `/private/var` 的符号链接，存原始路径宿主认不出该工作区，composer 会停在 inert 的「选择一个工作区开始」。
3. **workspace.json 需要 `unit` 字段**（`{name:"workspace",version:2}`），否则存储校验不过、工作区不被采纳。
4. **页面会先弹「预览版说明」**，不点「继续」时 composer 是 inert 的。
5. **斜杠菜单开着时 Enter 会被菜单吃掉**（只清空草稿、不提交）→ 提交前先关菜单。
6. **contenteditable 用 click 拿不到焦点**：要 `el.focus()` + 把选区设进节点，再 `keyboard.insertText`。
7. **清理临时目录要等宿主退出并重试**，否则 `ENOTEMPTY`。

## 发版门禁（`pnpm gate btw`，2026-11-16 实测）

```
[1/4] ✓ pnpm verify
[2/4] ✓ 宿主能力体检（pnpm probe:runtime）—— 合计 72 项：72 PASS, 0 WARN, 0 FAIL
[3/4] ✓ web 端到端冒烟（pnpm smoke:btw）—— 4 PASS / 2 SKIP / 0 FAIL
[4/4] -  桌面回归（pnpm smoke:btw-desktop）—— 无 client 半，跳过

PASS btw 门禁全绿（3 步，19s）
```

第 4 步被跳过是**预期行为**：v0.1 没有 client 半，按约定 §6.1 不强制桌面回归。
加 client 半（v0.2）后这一步会自动变成必需。

## 桌面回归的前置（v0.2 起，有 client 半之后）

`pnpm gate btw` 的第 4 步会跑 `pnpm smoke:btw-desktop --require`，它**驱动的是用户真实的桌面版**，
所以插件必须**先装进 desktop profile 并重启**，否则 client 半不会注入，门禁按设计变红：

```
FAIL client 半已注入（style[data-plugin]） — 页面有 196 个插件样式，但没有 btw
      —— 多半是没装进 desktop profile
```

装法：

```bash
cd packages/btw && pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-btw-0.<x>.tgz
# 重启桌面版（host 半改动也必须重启；只改 client 半刷新页面即可）
```

另外一条**agent 自己跑会撞上的前置**：脚本检测到「停止生成」按钮（当前会话正在跑回合）时只报 SKIP，
因为 agent 的回合就跑在同一个桌面版里。做法是把可见会话切到一个空闲会话再跑。

## v0.2 client 半端到端实测（2026-11-16，分支 `spike/btw-service`）

在临时宿主 + ego-browser 里驱动真实页面，走完整链路（浮层内发问）：

```
BEFORE: {"overlay":true,"input":true,"send":true,"items":1}
TYPED:  "reply with exactly OK"
POLL2:  {"items":2,
         "meta":"新增 2429 · 命中缓存 8192 · 1815ms",
         "answer":"OK","err":""}
```

→ 浮层打开、输入、提交（经 composer façade 的 `setDraft` + `submit`）、
host fork 作答、历史自动刷新、成本徽章渲染，全部工作。
缓存命中 `8192/(2429+8192) ≈ 77%`，与 host-only 时期的 84–87% 同量级。

**为什么发问必须借 composer**：真实 `Agent` 只能从命令/工具调用上下文取（`ctx.agents.get()` 返回
`undefined`，见 ADR 0016），所以浮层把 `/btw <问题>` 塞进输入框再提交，而不是直接调 Remote。

## 冒烟脚本的 cookie 卫生（约定 §6.3，必须做）

多次跑 web 冒烟后出现过 `net::ERR_HTTP_RESPONSE_CODE_FAILURE` —— 这是约定 §6.3 记录的 **431 坑**：
ego 与用户共用浏览器，宿主每轮用新 token 生成 `dsh-auth-<hash>` cookie，累积后请求头超限。

修法（已实现在 `scripts/smoke-btw.mjs`）：**只删回环地址上的 `dsh-auth-*`**，且每轮开头与结尾各清一次；
绝不动用户自己的其它 cookie。

## 设置分节（v0.2）的验证状态

**已验证（单测，17 项）**：

- `sanitizeSettings`：默认值、上下限夹紧（1–200）、去空/去重、**拒绝 `send_message`**、白名单条数上限
- `loadSettings`：文件缺失返回默认；坏 JSON 静默回落（不让插件因设置损坏而不可用）
- `saveSettings`：原子替换（临时文件 + rename）、只合并已知字段、未知字段丢弃

**未验证（如实标注）**：`settings.section` 的**渲染与交互**还没在真机上看过。
在临时 profile 里点「设置」会先弹「开始使用 / 添加 API Key」门禁，拿不到真正的设置对话框；
换到已登录的桌面版即可验证（v0.2 发版前的待办）。

对应的 `data-*` 锚点已就位，桌面回归可直接断言：
`data-btw-settings`、`data-btw-setting-tools`、`data-btw-setting-limit`、
`data-btw-settings-more`、`data-btw-settings-extra`、`data-btw-settings-save`。

### 桌面回归现在覆盖设置分节

`pnpm smoke:btw-desktop --require` 新增一段：账号菜单 → 设置 → 点「旁问」nav →
断言 `[data-btw-settings]`、工具白名单输入、**无改动时保存按钮禁用**、「更多设置」默认折叠 → Esc 关闭。

三种无法断言的情形都只报 **SKIP 并说明原因**，不制造假失败：

| 情形                     | SKIP 文案                                                               |
| ------------------------ | ----------------------------------------------------------------------- |
| 找不到账号/设置入口      | `打不开设置入口（account=…, settings=…）`                               |
| 设置对话框被登录门禁挡住 | `设置对话框被「开始使用 / 添加 API Key」门禁挡住（需要已登录的桌面版）` |
| 设置里没有「旁问」nav    | `设置对话框里没有「旁问」nav（可见：…）`                                |

这样一旦把插件装进已登录的 desktop profile，一条命令即可验证设置 UI（当前在临时
profile 里无法验证，因为有登录门禁）。

## v0.2 发版就绪度（2026-11-17，变基到合并后的 main 之后重验）

```
pnpm gate btw --skip-desktop   → PASS btw 门禁全绿（3 步，20s）
pnpm smoke:btw --deep          → 7 PASS / 2 SKIP / 0 FAIL
  history status=done cost={"inputTokens":2400,"cacheReadTokens":8192,"outputTokens":2,"totalTokens":10594}
```

结论：变基没有让 host 路径回归（`status=done`、缓存命中 77%、写缓存 0）。
**唯一未完成的是桌面回归**，它要求先把包装进已登录的 desktop profile 并重启：

```bash
cd packages/btw && pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-btw-0.<x>.tgz
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
pnpm gate btw          # 这次不跳过第 4 步
```

桌面回归会断言：client 半注入、浮层开关、设置分节（`data-btw-settings` 等）。
不满足前置时会打印可操作的安装提示，而不是裸 FAIL。

## 发布包体检（2026-11-17）

`cd packages/btw && pnpm pack --pack-destination /tmp` 后检查 tarball：

```
18 个文件 / 22K：
  cordis.patch.yml
  lib/{index,service,subagent,history,prompts,limits,messages,paths,config,settings}.js
  lib/client.js
  locale/{en,zh}.json
  LICENSE / README.md / README.zh-CN.md / package.json
```

`test/` 未进包（`files` 白名单生效）。

依赖检查（约定 §1）：

| 项                                                      | 结果                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `dependencies` / `peerDependencies` / `devDependencies` | 全空                                                                                                              |
| 是否把 `@deepseek-ai/*` 写进依赖                        | **没有**（`lib/service.js` 里 `import "@deepseek-ai/dsh-typert-protocol"` 是运行时由宿主解析，与 next-step 同形） |
| `engines.dsh`                                           | 未声明（按约定 §4，预发布阶段不写范围，用 README 兼容性表代替）                                                   |
| `dsh.client`                                            | `{ platform: "web", inject: ["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-slots"] }`    |
| `exports`                                               | `.` / `./package.json` / `./client`                                                                               |

## v0.3 真机验证（2026-11-17）

临时宿主 + ego-browser 驱动真实页面，验证线程视图、追问、转正三项：

```
T1 {"overlay":true,"threads":1,"promote":1,"followup":1,"err":""}   ← 线程卡片与两个按钮
T2 {"threadInput":true}                                            ← 追问输入框展开
T3 {"before":0,
    "notice":"已插入输入框草稿（未发送）",
    "draft":"## 我问了什么\n\nreply with exactly OK\n\n\n\n\n## 结论\n\nOK",
    "flowKinds":0,                                                  ← 关键：零消息产生
    "promoteDisabled":false}
```

**`flowKinds: 0 → 0` 是「只插草稿、不发送」语义的硬证据**：转正后对话流没有任何新节点，
草稿落在 composer 里等用户自己决定。

转正草稿是四节模板（我问了什么 / 结论 / 关键细节 / 仍未解决），
只有传了 `details`/`unresolved` 才出现后两节。

### 追问的实现方式

浮层里点「追问」后提交的是 `/btw --thread <threadId> <问题>`，由 `parseThreadFlag` 解析。
之所以用命令行标记而不是 Remote：浮层发问必须走 composer（真实 Agent 只能在命令上下文取，
见 ADR 0016），线程 id 只能随这行文本一起传进来。host 侧再按线程回放历史给模型。

### 上下文徽章（v0.3 第 4 步）

```
BADGE {"badge":"基于 1 条旁问记录 · 模型可见完整会话，范围只约束回答",
       "hasBadge":true,"threads":1}
```

**为什么必须这样写**：fork 子代理继承父会话**全部已完成轮次**，第三方插件无法只继承一部分
（`ctx.llm` 拿不到 adapter，见 ADR 0016）。所以「上下文范围」只能在提示词里声明，
徽章必须如实告诉用户「模型看得到全部，范围只约束回答」——**不能**声称限制了上下文。

单测锁死了这条：`renderBadge` 的用例断言文案必须包含「模型可见完整会话」，
`renderScopeInstruction` 必须包含 `advisory only` 与 `you can see the whole session`。

### 范围档位与线程上限（v0.3 第 4 步收尾）

档位选择器真机验证：

```
S1 {"hasScope":true,
    "options":[":范围：不限","session:范围：整个会话","recent:范围：最近几轮","selection:范围：仅选中片段"],
    "badge":"基于 1 条旁问记录 · 模型可见完整会话，范围只约束回答"}
S2 {"value":"recent",
    "badge":"… · 已要求只看：最近几轮"}      ← 徽章用人类可读标签，不是枚举原值
```

- 档位是**封闭枚举**（`session` / `recent` / `selection`），非法值丢弃
- 提交时拼成 `/btw --scope <档位> <问题>`，host 用 `parseCommandArgs` 解析
- 范围只写进提示词的 `renderScopeInstruction`（含 `advisory only`），**不裁剪上下文**
- 单线程满 `LIMITS.threadTurns`（10）轮时返回 `threadFull` 提示，要求开新线程

### 桌面回归覆盖 v0.3（设计第 5 步）

`pnpm smoke:btw-desktop --require` 新增断言（**全部只读**）：

| 断言                         | 说明                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| 档位选择器存在且有 4 个档位  | `[data-btw-scope]` 的 `options.length === 4`                  |
| 徽章如实写明模型可见完整会话 | 正则匹配「完整会话 / whole conversation」                     |
| 每条线程都有追问与转正按钮   | `[data-btw-followup]` / `[data-btw-promote]` 数量与线程数一致 |
| 点追问后出现线程内输入框     | `[data-btw-thread-input]` 出现                                |
| **转正只插草稿、不发送**     | 比较点击前后 `[data-chat-flow-kind]` 数量，必须相等           |
| 转正后清空草稿               | Cmd+A / Backspace，避免污染用户输入框                         |

无法断言时只报 SKIP 并说明原因，不制造假失败：

- 当前会话没有旁问记录 → 跳过追问/转正按钮断言
- 输入框已有内容 → 跳过转正（插件会拒绝，属预期保护）
- 当前会话有运行中的回合 → 整个交互段 SKIP（agent 自己跑回归时会这样）

上次自跑时就是最后一种情形，输出：

```
SKIP 桌面交互 — 当前会话有运行中的回合
0 PASS / 1 SKIP / 0 FAIL
```

### 桌面回归的两条安全边界（2026-11-17 加固）

**1. cookie 只清 DSH 自己的**

web 冒烟（`scripts/smoke-btw.mjs`）每轮开头与结尾各清一次 cookie，条件是**双重限定**：

```js
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const mine = found.cookies.filter(
  (c) => LOOPBACK.includes(c.domain) && String(c.name).startsWith("dsh-auth-"),
);
```

→ 只删回环地址上、名字以 `dsh-auth-` 开头的 cookie，**绝不触碰用户其它站点的 cookie**。

桌面回归（`scripts/smoke-btw-desktop.mjs`）走 CDP 连正在运行的桌面版，不碰浏览器 cookie 存储，
所以没有也不需要清理逻辑。

**2. 不把测试草稿留在用户输入框里**

桌面回归会往 composer 插转正草稿。保护分两层：

- **事前快照**：进来时若输入框已有内容，跳过所有会改动输入框的断言（`skip` 并说明原因）
- **事后兜底**：仅当进来时是空的，结束时调用 `clearComposerDraft` 清空，并断言「结束时输入框已还原为空」

清理只聚焦 DSH 的 `[data-composer-input]`，不触碰页面其它状态。

### web 冒烟现在也覆盖 v0.3 客户端（不需要凭据）

2026-11-17 补：此前 v0.3 的 client 半只被一次性探针验证过，没有进仓库的自动化测试。
现在 `pnpm smoke:btw`（默认模式，零模型调用）也断言：

```
PASS 浮层可打开
PASS 浮层有 4 个范围档位
PASS 徽章写明模型可见完整会话
SKIP 线程卡片带追问/转正按钮 — 本会话还没有旁问记录
```

→ **CI 的 web 冒烟步骤即可覆盖档位选择器与徽章诚信文案**，桌面回归只负责「真实安装环境」这一层。

线程卡片断言在默认模式下 SKIP（没有旁问记录），`--deep` 或桌面回归里才会真正执行。

## 发版后验证：从 npm 装已发布版本（`--npm`）

`pnpm smoke:btw --npm` 不打包本地源码，改从 registry 安装**当前 package.json 版本**对应的已发布包。

2026-11-17 首次发版实测（`@kangyishuai/dsh-btw@0.1.0`）：

```
从 npm 安装：@kangyishuai/dsh-btw@0.1.0
宿主已启动：127.0.0.1:59946
PASS 页面可交互且有输入框
PASS 过掉预览版说明
PASS 能新建会话
PASS 斜杠菜单出现并列出 btw
PASS 浮层可打开
PASS 浮层有 4 个范围档位
PASS 徽章写明模型可见完整会话
7 PASS / 3 SKIP / 0 FAIL（默认，未发起模型调用）（npm 已发布版本）
```

→ 证明**发布出来的产物**（而不是工作区源码）能正常激活：命令注册、client 半注入、v0.3 的档位与徽章都工作。

发布产物核对：

```
20 个文件 / 30K，含 lib/threads.js 与 lib/badge.js（v0.3 新模块）
dependencies: none
dsh.client: { platform: "web", inject: [...] }
exports: "." / "./package.json" / "./client"
```

**新包首次发布有注册延迟**：npm 提示「Your package is being processed and may take a few minutes
to become available」，实测约 8 分钟后 `registry.npmjs.org` 才能查到；期间 `npm view` 返回 404，
但 git tag 已建、CI 全绿。判断发布是否成功要以**工作流日志里的 `+ <pkg>@<version>` 与 `Created git tags`**
为准，别只看 npm 查询结果。

## 门禁假绿修复（2026-11-17，`scripts/gate.mjs`）

### 问题

`pnpm gate btw` 报「4 步全绿」，但桌面回归那一步实际输出是：

```
SKIP 桌面交互 — 当前会话有运行中的回合
0 PASS / 1 SKIP / 0 FAIL
```

**脚本退出码 0，所以门禁把它当成通过** —— 一条断言都没跑，却宣布「全绿」。
而门禁自己的文件头写着「门禁存在的意义就是不能没跑还说通过」，这是自相矛盾的漏洞。

### 修法

门禁现在解析每个阶段的 `N PASS / M SKIP / K FAIL` 收尾行，**桌面阶段若 `pass === 0 && fail === 0` 直接判失败**：

```
FAIL 门禁中止：「桌面只读回归（需要调试端口）」跑完了但**一条断言都没执行**
      计数：0 PASS / 1 SKIP / 0 FAIL
      退出码 0 不代表验证过任何东西。常见原因：可见会话有运行中的回合
      （agent 在自己会话里跑回归时），把可见会话切到空闲会话再跑。
```

退出码 1，`pnpm gate btw` 不再假绿。

### 新增导出与单测

`scripts/gate.mjs` 现在可被 import（尾部包了 `isMain`），导出：

- `parseCounts(output)` → `{ pass, skip, fail } | undefined`，取**最后**一条计数行、剥 ANSI、容忍多余空白
- `isVacuousPass(counts)` → `pass === 0 && fail === 0`

`scripts/test/gate.test.js` 6 项锁住：标准收尾行、取最后一条（中间统计不算）、ANSI 剥离、
空白容忍、无计数行返回 `undefined`、假绿判定。

`pnpm verify` → EXIT 0，脚本测试 **55/55**。

## 桌面回归实跑（2026-11-17，18 项全绿零 SKIP）

装进 desktop profile 后真正执行：

```
dsh plugin --profile desktop add @kangyishuai/dsh-btw   # 0.1.0
pnpm gate btw

PASS client 半已注入（style[data-plugin]）
PASS 输入框左侧出现 btw 按钮
PASS 点开后浮层出现
PASS 浮层是 dialog
PASS 档位选择器存在且有 4 个档位
PASS 徽章如实写明模型可见完整会话
PASS 每条线程都有追问按钮
PASS 每条线程都有转正按钮
PASS 点追问后出现线程内输入框
PASS 转正把草稿插进输入框
PASS 转正没有发送任何消息
PASS Esc 后浮层消失
PASS 没有遗留浮层
PASS 结束时输入框已还原为空
PASS 设置分节渲染
PASS 首屏有工具白名单输入
PASS 无改动时保存按钮禁用
PASS 「更多设置」默认折叠

18 PASS / 0 SKIP / 0 FAIL
PASS btw 门禁全绿（4 步，34s）
```

连跑 3 次全绿（抖动已消除）。

### 三条 SKIP 是怎么消掉的

首跑是 `8 PASS / 3 SKIP`。逐条查根因，**两条是我的检测写错了，不是真的做不到**：

| SKIP           | 真实根因                                                                                                         | 修法                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 设置分节打不开 | 账号菜单里**明确有**「设置 ⌘,」，但 menuitem 的 `textContent` 带快捷键标记（`设置⌘,`），精确匹配 `/^设置$/` 失败 | 改成「以设置开头」并排除「意见反馈/退出登录」    |
| 转正只插草稿   | 我加的 `initial.running` 守卫**过度保守**——实测回合进行中也能往 composer 打字并提交                              | 删掉该守卫；只保留 `draftBefore !== ""` 的真保护 |
| 结束时草稿还原 | 同上，被 `running` 守卫连坐                                                                                      | 同上                                             |

### 两个顺带修掉的真问题

**1. SKIP 文案撒谎**：草稿明明为空，却报「进来时已有草稿」——因为 `running` 与「草稿非空」两个分支共用了一条消息。已分开。

**2. 手势断言抖动**：`点追问后出现线程内输入框` 实测 2 次里偶发 1 次失败（面板刚渲染完时第一次点击被吞）。
按约定 §6.1「手势断言加一次不降低断言的重试」处理，连跑 3 次稳定。

### 需要一次真实 /btw 记录

首跑时 `~/.dsh/btw/` 不存在（本机从没跑过 `/btw`），所以线程断言只能 SKIP。
在真实桌面版里跑了一次 `/btw reply with exactly OK` 之后就全通了：

```
question: reply with exactly OK
answer:   OK
status:   done | ms: 26403
cost:     {"inputTokens":809,"cacheReadTokens":365056,"outputTokens":3,"totalTokens":365868}
```

顺带证明**缓存命中 365056 tokens ≈ 97%** —— 比早期实测的 84–87% 更高（会话越长，复用比例越高）。

## 桌面 `--deep` 写文件端到端（2026-11-17 新增）

`pnpm smoke:btw-desktop --require --deep` / `pnpm gate btw --deep`：

```
PASS --deep：真实 /btw 在真实数据根落盘
PASS --deep：record 状态为 done 且有答案
PASS --deep：record 带成本与耗时
PASS --deep：写了 threadId（v0.3 线程字段）

22 PASS / 0 SKIP / 0 FAIL
PASS btw 门禁全绿（5 步，70s）
```

### 这层补的是什么

web 冒烟跑在**临时 `DSH_HOME`** 里，验证不了「真实桌面版是否把 history 写到用户的 `~/.dsh/btw/`」。
btw 没有 `--workspace` 概念（它写的是数据根，不是工作区），所以桌面 `--deep` 的职责就是
**真实 app + 真实数据根的完整往返**：

1. 记录跑前的 history 条数（`~/.dsh/btw/*.jsonl` 的行数）
2. 经 composer 提交 `/btw reply with exactly OK`（一次真实模型调用）
3. 轮询直到出现新记录（最多 80s）
4. 读回最后一条，断言 `status === "done"`、`answer` 非空、`ms > 0`、`cost` 存在、`threadId` 非空

实测记录：

```
question: reply with exactly OK
answer:   OK
status:   done | ms: 31950
threadId: t_mwkej6qi_46xv
cost:     {"inputTokens":859,"cacheReadTokens":393984,"outputTokens":3,"totalTokens":394846}
```

**缓存命中 393984 / 394846 ≈ 99.8%** —— 会话越长，前缀复用比例越高（早期实测 57%→84%→97%→99.8%）。

### 注意

`--deep` 会**真实花费一次模型调用**，并往用户 data root 写一条 history 记录（记录本身是正常使用产物，不清理）。
所以默认不跑，只有 `pnpm gate btw --deep` 才执行。

## 三画像用户实测（2026-11-17，零先验）

用 CDP 驱动真实桌面版，真实鼠标点击 + 截图判读，模拟三个零先验用户：

| 画像     | 行为                              | 发现                                           |
| -------- | --------------------------------- | ---------------------------------------------- |
| A 效率型 | 点「旁问」→ 输入问题 → 点「提问」 | 提交后 40 秒无变化、按钮永久卡死               |
| B 探索型 | 点「追问」→ 线程内提问            | 同样卡死；两个相似输入框易混                   |
| C 组织型 | 点「转正」                        | 草稿全是 `##`/`**`/`\|表格\|` 源码，撑满输入框 |

### 已修（P0/P1）

**P0-1 刷新卡死**（`lib/client.js`）

旧实现两个叠加缺陷：轮询窗口 `20 × 1.5s = 30s` < 实测 `/btw` 耗时 32–40s；且 `.then()` 无 `.catch()`，一次失败整条链断掉、`setBusy(false)` 永不执行。

改为「deadline + try/finally」：窗口提到 120s、单次失败继续轮询、任何路径都恢复按钮。

**P0-2 提示不可见**（`lib/client.js` + CSS）

`notice` 原是浮层最后一个子元素，列表一长就被推到滚动区外（实测浮层底 616px、提示在 918px，还需再滚 343px）。改为头部下方的 `position:sticky` 状态条，并带 `⟳` 与「正在等待答案…（通常 20–40 秒）」。

**P1-4 转正草稿是 Markdown 源码**（`lib/threads.js` + `lib/limits.js`）

新增 `stripMarkdown()`：去标题井号、`**`、反引号、代码围栏、列表符、引用，表格行 `| a | b |` → `a — b`；模板改用 `【标题】`；`promoteChars` 4000 → 1200。

**P1-3 长答案折叠**（`lib/client.js`）：答案超 400 字折叠为 6 行 + 「展开全文」。

### 实测验证（client 改动刷新页面即生效）

```
提交后 1.2s  状态条：「⟳ 正在等待答案…（通常 20–40 秒）」，在浮层内可见
答案返回后   按钮恢复可用、列表自动刷新（最新问题出现在第一条）
转正后       状态条「已插入输入框草稿（未发送）」在浮层顶部可见
折叠         长答案显示「展开全文」
门禁          18 PASS / 0 SKIP / 0 FAIL
```

### 尚未处理

- **答案区 Markdown 仍是原文**：仓库没有 Markdown 渲染器（ADR 0001 不引入构建），
  手写渲染器风险高。当前只做了折叠。这是 v0.4 需要决策的点。
- **`--thread t_xxx` 会短暂出现在主输入框**：浮层发问必须借 composer 提交
  （真实 Agent 只能从命令上下文取，ADR 0016），命令文本无法隐藏。已用状态条把
  注意力留在浮层。
- **两个相似输入框**（线程内追问 / 底部新建）：文案有区分，但视觉相近。

### host 侧改动需重启（2026-11-17 重启后已实测）

`stripMarkdown` / `promoteChars` 在 host 半（`lib/threads.js`、`lib/limits.js`），
**刷新页面不会生效，必须重启 DSH**。client 侧改动（状态条、折叠、轮询）刷新即可。

重启后装 0.1.1 实测：

```
draftLen: 206
hasHashHeading: false   ← 没有 ## 
hasBold: false          ← 没有 **
hasTableSep: false      ← 没有 |---|
hasBracketHeading: true ← 用 【】

【我问了什么】
用一句话说明这个插件的入口在哪

【结论】
入口有两个，都在输入框区域：
1. 底部输入框左侧那一排里的小按钮「旁问」...
2. /btw 斜杠命令 —— 直接在输入框敲 /btw 你的问题...

PASS btw 门禁全绿（4 步，33s）  18 PASS / 0 SKIP / 0 FAIL
```

对照修复前：`## 我问了什么` + `**底部输入框...**` + `|---|---|` + 撑满整屏。

## 0.2.0：层叠来源与 answerPlain 验证（2026-11-17 重启后）

### 发版

```
npm   @kangyishuai/dsh-btw@0.2.0（latest）
tag   @kangyishuai/dsh-btw@0.2.0
验证  pnpm smoke:btw --npm → 7 PASS / 3 SKIP / 0 FAIL（npm 已发布版本）
```

### 浮层改 `shell.overlay`（修裁剪根因）

`conversation.input.overlay` 的 slot 文档明确写着 "**fixed overlays must portal to the
document body because the docked composer contains them**"，而浮层原本就挂在这个 composer
内部 slot 上 —— 这就是「提示条跑到浮层外 302px」「位置随对话流滚动漂移」的根因。

改挂 `shell.overlay`（frame-wide，所有列之上、滚动容器之外）后：

- `position: fixed` 居中，`display: flex`：标题栏固定、列表 `flex:1; overflow-y:auto`、
  底部档位/说明/徽章常驻可见
- 按钮仍留在 `conversation.input.left`，两者通过 apply 作用域的 store 共享状态

### answerPlain：答案按纯文本显示

重启后实测（同一批历史记录，只是展示层变了）：

| 修复前                                                                | 修复后                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| `1. **底部输入框左侧那一排里的小按钮「旁问」**（挨着 `` `+` `` ...）` | `1. 底部输入框左侧那一排里的小按钮「旁问」（挨着 + ...）` |
| `\| 检查名 \| 说明 \|` + `\|---\|`                                    | `检查名 — 说明`                                           |
| ``\| `verify (node 22.19)` \| 主验证链...``                           | `verify (node 22.19) — 主验证链...`                       |

### 边界案例：glob 路径里的 `**` 必须保留

程序化检查发现「某条答案里仍有 `**`」，追查是：

```
· test = node --test "scripts/test/**/*.test.js" && pnpm -r --if-present test
```

这是 **glob 模式**，不是 Markdown 粗体。`stripMarkdown` 的粗体规则要求成对 `**...**`，
所以没有误伤它；`keepCode` 也保护了代码块内的同类字符。

**这条要记住**：不要改成全局 `replace(/\*\*/g, "")` —— 会毁掉路径、正则和代码。

## 0.4.0：原生右侧栏 + 流式 + Markdown（2026-11-17）

用户提出 5 项体验问题：面板居中遮挡主对话、答案不流式、答案不渲染 Markdown、
成本徽章的数字/耗时不可读、最新消息在最上面。这版逐条处理，并推翻了 0.1.1 的
「转正草稿去 Markdown」决定（当时是因为面板不渲染 Markdown，源码落进输入框像乱码；
现在面板渲染了，转正改为**保留源码**，发送后由 DSH 渲染）。

### 设计取舍

**流式：host 缓冲 + 短轮询，不让 client retain 子会话**

- host 在已有的 `llm/stream` waterfall 旁听器上按 `childSessionId` 截取 `text-delta`，
  最多留 `LIMITS.liveTextChars`（12k）字符；`btw/live` 返回 `{runs:[{threadId,question,ms,blocks}]}`，
  面板有 run 时 350ms 轮询、空闲 1s。
- 为什么不走「client `sessions.retain(childId)` + 订阅 `assistant/live-chunk`」：fork 子会话
  带着父会话**全部已完成轮次**作为种子，retain 会触发历史打开，把整段父会话拉到浏览器；
  旁问只需要最后几 KB 的增量，轮询内存快照更省，也不额外制造一个 client session scope。
- 文本只在内存里，run 结束（`finally`）即删；不落盘，不增加历史记录。

**Markdown：host 解析成 JSON 块树，client 只做元素映射**

- `lib/markdown.js`：标题 / 段落 / 围栏代码（含未闭合的流式态）/ 有序无序列表 / 引用 /
  表格 / 分隔线；行内代码、粗体、斜体、删除线、链接、裸 URL。不引依赖、不生成 HTML。
- 为什么放 host：可被 `node --test` 覆盖；client 是 classic script 无法 import。
  为什么不让 client `require('@deepseek-ai/dsh-client-ui-primitives')`：宿主明确禁止插件加载
  自己的 Client 包（会随版本变、组件抛错会把 slot entry 打空）。
- 安全：输出纯 JSON，client 建 React 元素，文本永远是文本节点，无 `innerHTML`。

**位置：DSH 原生右侧栏 tab（首选），浮层抽屉作为旧宿主回退**

- 先按「右侧浮层抽屉」实现并用真实构建截图验证，发现 DSH 对话区是**整宽**的：
  1920 宽屏下 400px 抽屉仍会盖住主对话右缘约 400px（原型确认环节抓到了这点），
  于是按用户选择改为原生右侧栏。
- 注册 `sidebarRightTabs.register({ id, kind:'btw', title, priority:'extension' })` +
  `sidebar.right.pane.tab` keyed body：点「旁问」调用 `sidebarRight.openTab('btw')`，
  主对话被挤窄（当前侧栏默认 864px，可拖到 300px）但完全不遮挡。
- 收起整栏用宿主自己的右上角收起按钮/⌥⌘B（`actions.toggleExpanded`）；点「旁问」时先显式
  `layout.openRightbar(true,false)` 再 `openTab` —— `openTab` 对**已存在**的 tab 只会
  focus、不会展开已收起的栏（真机踩到，已写进断言）。tab 自带 × / 面板「关闭」按钮关闭 tab。
- 不要用 `layout.closeRightbar()` 作为收起：实测它只改 frame 轨道、不更新 dockkit 的 expanded，
  面板会留在原地盖住已展开的主对话（已改用宿主按钮）。
- 宿主没有 `sidebarRightTabs` / `sidebarRight` 时自动回退到 `shell.overlay` 浮层抽屉
  （fixed 右侧、底边按 docked composer 留 140px、可收起成右边缘小条），旧版本 DSH 仍可用。
- tab 内容限宽 820px 居中（右栏更宽时不至于把表格/代码块拉成一行）。

**排序：`listThreads` 旧→新，线程内全部轮次**

- 面板是聊天式：最新一条在底部，打开/新内容到达时自动滚到底（用户向上翻历史时不抢滚动条）。
- 每条线程展开全部轮次（首问 + 每次追问），长答案保留 320px 折叠 + 「展开全文」。

**数字：`lib/format.js`**

- token：`999` / `1.2K` / `12.3K` / `123K` / `1.2M` / `3.4B` / `5T`，999.5K 升档成 1M。
- 耗时：`999ms` / `1.2s` / `12.3s` / `1.5m` / `1.5h`。
- host 用于命令结果 meta；client 有一份行为等价副本（classic script 无法 import），
  面板徽章与流式 elapsed 用它。两处都有单测/真机冒烟覆盖。

**转正：保留 Markdown 源码**

- 四节改成 `## 我问了什么` / `## 结论` / …；不再 `stripMarkdown`。
- 仍受 `LIMITS.promoteChars=1200` 约束；截断点若在代码围栏内，先补闭合，补不下就回退到围栏前，
  避免输入框里留半段代码。

### 测试与验证

- 单测 **56 项全过**（新增 markdown 解析 8 项、format 2 项、live tracker 4 项，改写 threads/promote 断言）。
- web 冒烟（`pnpm smoke:btw`，默认模式）：`11 PASS / 3 SKIP / 0 FAIL`；
  新断言覆盖「原生右侧栏 tab」「不遮挡主对话」「收起整栏（tab 保留）」「再点展开」「关闭 tab」。
- 真实流式观察（临时 home + ego-browser，tab 内 composer 提问）：
  `t≈2.2s` 出现 live 卡片与 elapsed；run 结束后线程数 1→2，live 卡片被真实线程替换。
  截图确认 Markdown 表格/代码块/引用/行内样式、折叠、成本徽章与 tab 布局均正常。
- 桌面回归（`pnpm smoke:btw-desktop --require`）断言改为「右侧栏 tab / 不遮挡 / 收起展开 / 关闭」；
  0.4.0 装进 desktop profile 后已在真机跑过，结果见下。

### 0.4.0 发版与发版后验证（2026-11-17）

- 合并：#172（squash `885eae6`）→ Version Packages #173（`5c37082`）；npm 已发布
  `@kangyishuai/dsh-btw@0.4.0`（tag / Release 已建），插件索引重建后 btw 为 0.4.0。
- `pnpm smoke:btw --npm`（从 npm 装发布包，临时 `DSH_HOME`）：**11 PASS / 3 SKIP / 0 FAIL**。
- `pnpm smoke:btw --npm --deep`（真实模型一次）：**14 PASS / 3 SKIP / 0 FAIL**，history `status=done`。
- `pnpm smoke:btw-desktop --require`（发布版装进真实 desktop profile、重启后）：
  **14 PASS / 1 SKIP / 0 FAIL**；SKIP 是「当前可见会话没有旁问记录」，
  线程按钮断言需要先提一个 `/btw` 再跑。
- `pnpm gate btw`：**PASS，4 步 35s**（verify → probe:runtime → web 冒烟 → 桌面回归）。
- 跑桌面回归前把可见会话切到空闲会话、跑完切回：agent 自己的回合会让脚本按只读保护全部 SKIP，
  门禁会把「一条断言都没执行」判成假绿。

### 0.5.0 可用性修复（2026-11-18）

依据三画像桌面可用性测试（私有 notes 的可用性报告与 9 张截图，不公开）按 P1/P2/P3 修复：

- **P1 徽章刷新**：提交完成 / live 结束后重拉 `stats`，不再出现「已有 3 条记录但徽章写 2」。
- **P1 展开锚点**：展开全文时记录答案元素视口位置，`useLayoutEffect` 里补偿 `scrollTop`，不再跳回顶部。
- **P2 追问 composer**：追问输入打开时隐藏底部「新旁问」（只保留一个输入框）；按钮改「追问」/「取消追问」，
  追问输入框自带范围档位，不再与底部「提问」混淆。
- **P2 线程级转正**：用线程**首问**当「我问了什么」、**最后一轮答案**当「结论」；host 仍只返回文本、
  客户端只插草稿不发送。
- **P2 `echoAnswer` 设置**：设置 → 旁问首屏新增「主对话显示完整答案」开关（默认开）；关闭后 `/btw`
  在主对话只回一行提示，完整答案仍在面板历史。
- **P3 细节**：`Esc` 在焦点位于面板时关闭 tab；面板可见时自动聚焦输入框；header 显示「N 个线程」；
  流式推理阶段显示「思考中」；面板底部给出「拖动分隔条调宽 / ⌥⌘B 收起」提示。

验证：

- 单测 **58 项全过**（新增 paths/echoAnswer/线程转正/`buildSettingsPatch` 漏字段回归断言，locale 中英齐平）。
- web 冒烟默认：**14 PASS / 3 SKIP / 0 FAIL**（新增宽度提示、Esc 关闭）。
- web 冒烟 `--deep`：**21 PASS / 3 SKIP / 0 FAIL**（新增：面板重开有线程且徽章有条目、追问只留一个输入框、
  转正草稿含 Markdown + 线程首问、面板提交后徽章立即 1→2、聚焦面板 Esc 关闭）。
- 桌面回归（dev build 装进真实 desktop profile、可见会话有 3 条旁问记录）：
  **24 PASS / 0 SKIP / 0 FAIL**；新增断言：追问时只留一个输入框且按钮叫「追问」、转正草稿保留 `##` 源码、
  Esc 关闭且可重开、设置首屏有「主对话显示完整答案」开关。
- echo 开关真机手测：关闭并保存后从面板提问，主对话命令结果只回一行提示、完整答案在面板；
  重新打开并保存后恢复完整答案（设置文件 `echoAnswer` 与复选框一致）。
- `pnpm gate btw`：**PASS，4 步 40s**（verify → probe:runtime → web 冒烟 → 桌面回归）。

> 已知既有问题（本次未改）：host 侧文案加载没有把 locale 的 `answer`/`error` 嵌套展平，
> `/btw` 的命令结果实际一直用英文 FALLBACK；本次新增的 `panelOnly` 同样走 FALLBACK。
> 面板 client 文案不受影响。

### 0.6.0 第二轮可用性修复（2026-11-18）

0.5.0 复测又发现 3 个 P2 + 3 个 P3，按优先级修复：

- **P2 转正语义**：多轮线程把每轮追问的 Q/A 写进「关键细节」（`renderThreadDetails`），
  避免「首问当标题、末答当结论」的错位。
- **P2 展开/收起**：长答案展开后按钮变成「收起」，再次点击恢复折叠，并保持阅读位置。
- **P2 重复答案发现性**：面板底部直接加「只在旁问面板显示答案」开关（等同 `echoAnswer`），
  零先验用户不用进设置页；默认仍保留主对话回显（此前明确要求）。
- **P3 Esc 一致性**：焦点在主输入框时 Esc 也关闭面板；设置对话框拥有焦点时不抢。
- **P3 底部密度**：提交提示、宽度提示合并为一行 footer，减少一行常驻文本。

验证（本分支）：

- 单测 **59 项全过**（新增多轮线程「关键细节」断言）。
- web 冒烟默认：**15 PASS / 3 SKIP / 0 FAIL**（新增 echo 开关、主输入框 Esc）。
- web 冒烟 `--deep`：**23 PASS / 3 SKIP / 0 FAIL**。
- 桌面回归（dev build 装进真实 desktop profile、重启后，可见会话有 3 条旁问记录）：
  **25 PASS / 0 SKIP / 0 FAIL**（新增「只在面板显示答案」开关断言）。
- `pnpm gate btw`：**PASS，4 步 42s**。
- 0.6.0 发布：Version Packages #180 → `@kangyishuai/dsh-btw@0.6.0`（npm latest / tag / Release 已建），
  插件索引已更新到 0.6.0。
- 发布版冒烟（`--npm`）：默认 **15 PASS / 3 SKIP / 0 FAIL**；`--npm --deep` **23 PASS / 3 SKIP / 0 FAIL**。
- 发布版桌面复验（安装 0.6.0、重启桌面后）：`pnpm gate btw` **PASS，4 步 42s**，桌面回归 **25 PASS / 0 SKIP / 0 FAIL**。
- 真机手测：
  - 多轮线程转正草稿出现 `## 关键细节`，含「追问 1」的 Q/A。
  - 长答案「展开全文 → 收起」往返，答案视口 top 保持 220px，`scrollTop` 229→235→229。
  - 面板底部 echo 开关关闭后提问：主对话命令结果只回一行提示、完整答案在面板；重新打开后恢复完整答案。

### 已知边界

- **右侧栏宽度是宿主偏好**：当前默认 45% 视口（1920 下 864px），打开时主对话被挤到 776px；
  用户拖动侧栏分隔条可以变窄（最小 300px），插件无法替用户设置宽度。
- 浮层抽屉仍是**回退形态**：仍会盖住主对话右缘约 400px，只在宿主没有右侧栏服务时出现。
- 流式是 350ms 轮询，不是逐 token 推送；首 token 与最后一次轮询之间最多差一个间隔。
- 表格在窄 tab / 窄抽屉里横向滚动，不做列宽自适应。
- **转正草稿会把主 composer 撑高**：DSH composer 随内容自动增高，插件没有高度 API；草稿最长 1200 字符，
  发送前需要用户自己滚动/收起输入框。
- **host 命令结果文案未本地化（既有问题）**：host 加载 locale 时没有把 `answer`/`error` 嵌套展平，
  `/btw` 的命令结果一直走英文 FALLBACK；面板 client 文案不受影响。
