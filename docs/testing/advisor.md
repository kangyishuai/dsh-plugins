# advisor 测试清单

> 目的：证明三件事——**只有主模型真的徵询时才产生模型调用**、**账本与四级预算真的记在账上、到顶会停**、
> **客户端只读面（`/advisor` 选择器、`status`、`doctor`）在真实 Electron 里不崩、不误发、不误记**。
> 三层：**单测 → 桌面只读回归 → 手工 GUI 验证**。前两层每次提交都跑；第三层发版、DSH 升级、以及改动
> 客户端私有 seam（`commandUi.decorate`）后必须跑。
>
> P1 没有 web 端到端冒烟，原因见 [§2](#2-web-端到端冒烟p2-补)。

## 0. 测试环境

advisor 会**真的调一次模型**（`shadow` 模式也一样会调），并且会把会话内容发送给顾问 provider。
所以除了单测，所有验证都必须在临时 `DSH_HOME` 里跑，并先确认顾问路由是本地网关或你愿意接收数据的 provider：

```bash
# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/advisor && pnpm pack --pack-destination /tmp

# 2) 隔离 home：复制 profile + 会话 + 存储
H=/tmp/dsh-test-advisor
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/ad
cp -R ~/.dsh/sessions $H/sessions
cp -R ~/.dsh/storages $H/storages
DSH_HOME=$H dsh plugin --profile ad install
DSH_HOME=$H dsh plugin --profile ad add /tmp/kangyishuai-dsh-advisor-*.tgz

# 3) 启动（端口 0 = 随机，--no-open 不弹浏览器）
DSH_HOME=$H dsh --profile ad --port 0 --no-open
```

**观测点**（"有没有花钱"、"为什么没问"都以这里为准，而不是只看界面）：

| 位置                                             | 看什么                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `$H/advisor.settings.json`                       | 插件设置：`mode` / `provider` / `model` / 预算 / 隐私档位（改文件即生效）                    |
| `$H/advisor/usage.jsonl`                         | 账本，一次徵询一行：`trigger`（`tool`/`shadow`/`manual`）、`verdict`、token、`costUsd`、`ms` |
| 会话日志 `$H/sessions/<projectKey>/<sessionId>/` | `tool/call` + `tool/result`（工具路线的徵询）；`session/event` 里没有额外 usage              |
| 工具卡 / `/advisor status`                       | 本次结论（`reviewed`/`declined`/`unavailable`/`skipped`）+ 累计 token + 最近一次跳过原因     |

数据根优先级：`config.dataRoot` > `$DSH_HOME` > `~/.dsh`（所以上面的 `H` 变量就是它）。

## 0.5 本次核查记录（2026-11-11，DSH 0.2.2-rc.1）

| 层                                         | 结果                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test`（`packages/advisor`）        | **81 pass / 0 fail**（settings / route / guard / prompt / redact / tool-schema / transcript / anchors / adoption / catalog / budget / verifier / twopass / locale-parity）                                |
| `pnpm probe:runtime`                       | **67/67 PASS**（含 advisor 的 7 条 seam：`resolveModelInfo` / `prepareCall+configure` / `UNSUPPORTED_REASONING_EFFORT` / usage 分片 / `commands.register` / `commandUi.decorate` / `popupSelect`）        |
| `pnpm smoke:advisor-desktop --require`     | **18 PASS + 1 SKIP（19 项；P3 版脚本，真机 DSH 桌面版 0.2.2-rc.1）**：插件加载、选择器、设置卡（含 P3 字段）、分页 `status`/`doctor`（读会话日志）、收尾清理。`--advice` 再加 4 项共 23 项。P1 时为 12/12 |
| 真机徵询（`pnpm pack` → `add` → 手动徵询） | **未做**（P1 收尾的验收项，步骤见 [§4](#4-手工-gui-验证步骤)）                                                                                                                                            |

单测与 seam 数字都会随实现增长，上面只是本次核对时的快照。

## 1. 单测（每次提交）

```bash
cd packages/advisor && pnpm test   # node --test
pnpm verify                        # 仓库门禁（含单测、规范、文档一致性）
```

只测**纯函数**——不启动宿主、不连模型、不写真实数据根。应覆盖的范围：

| 主题        | 要证明的事                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置规整    | 默认 `mode: "off"`、未配置顾问；丢弃未知键；数字按区间夹紧（`0` 在预算字段里表示"不限"）；非法 `mode`/`privacyScope` 回落到默认；坏 JSON 不抛错只回落。                                                                                     |
| 设置合并    | `mergeSettings` 只覆盖 patch 里出现的键；写入是原子写、读回一致。                                                                                                                                                                           |
| 选路与配对  | 显式配置 > 会话当前模型 > 空路由（空路由 = 调用方放弃本次徵询）；档位比较 `ok` / `warn`（顾问更弱）/ `block` / `unknown`（**未校验**，不阻断也不假装通过）。                                                                                |
| 预算        | 四级预算按固定顺序返回**第一个**不满足的条件；到顶的 code 可区分是哪一级；`0` = 不限制。                                                                                                                                                    |
| 金额        | 单价为 0 时不算钱（只显示 token，不编金额）；单价存在时按输入/输出分别乘。                                                                                                                                                                  |
| 去重指纹    | 指纹忽略大小写、空白与标点差异；窗口内重复被拒、窗口外放行；指纹表有上限不会无界增长；免疫窗口只在窗口内为真。                                                                                                                              |
| 空洞建议    | "Looks good" 这类空洞结论被识别为 `declined` 而不是 `reviewed`（精确匹配，不做包含匹配）。                                                                                                                                                  |
| 严重度      | 严重度排序单调（`nit` < `concern` < `blocker`），预算/归因逻辑用它比较。                                                                                                                                                                    |
| 输出契约    | 严格 JSON 解析（容忍 ```json 围栏与前后散文）；非法 severity 回落；`reviewed` 但建议为空 → invalid；纯散文 → unparsed；超长建议被截断并**留痕**；证据条目被过滤。                                                                           |
| 脱敏        | 常见 token 形态（`sk-`、`ghp_`、`AKIA`、`Bearer`、`KEY=VALUE`）被替换；普通文本不被改动；递归处理嵌套对象的字符串，且有节点预算不无限递归。                                                                                                 |
| transcript  | 含工具调用与工具结果；**排除我们自己的工具调用**（`purpose: "advisor"` 那条）；`scope=off` 时不发工具往来；`system`/`developer` 消息不进 transcript；超长工具结果被截断并留痕；**脱敏在截断之前**生效；总预算超限时保留首尾并插入省略标记。 |
| 工具 schema | 工具名与参数形状对齐参照实现（**零必填**，只有可选 `focus`）；只使用宿主支持的关键字子集（`minimum` 这类会被抓出来）；`renderToolOutput` 覆盖四种状态且不抛。                                                                               |

**没覆盖**：真实宿主槽位、真实 Electron 渲染进程、真实的 `llm.prepareCall/stream` 行为、`commandUi.decorate`
在宿主里的实际渲染。所以下面两层不能省。

## 1.5 一条命令跑完门禁（发版前）

`scripts/gate.mjs` 是通用的：`pnpm gate advisor` 依次跑 `pnpm verify` → `pnpm probe:runtime` →
web 冒烟（`pnpm smoke:advisor`）→ 桌面只读回归（**永远带 `--require`**）。
任何一步失败立刻停并给出下一步提示；只有显式 `--skip-desktop` 才跳桌面端，且结束时会打印"门禁不完整"。

## 2. web 端到端冒烟（`pnpm smoke:advisor`）

临时 `DSH_HOME`（复制 desktop profile、剥掉第三方插件、只放一个临时工作区）里启动**真实宿主**，
装当前源码打出的包，再用 ego-browser 跑一遍「装得上、命令注册了、设置卡渲染了、且**什么都没花**」。

**13 项断言（2026-11-12 实测全 PASS）**：

1. 页面可交互（`contenteditable` 输入框存在）；
2. 插件 client 半已加载（`style[data-plugin]` 含 `@kangyishuai/dsh-advisor`）；
3. `/` 菜单里出现 `advisor`（证明 `commands.register` 生效）；
4. 能新建会话并拿到空输入框；
5. 设置卡默认是 `off` 紧凑态：只有模式、一句状态和「配置顾问」，不渲染 provider / 预算 / 隐私；
6. 点「配置顾问」并展开高级与状态后：provider 下拉有候选（实测 45 条）、每日预算/发送范围/工作区限额/模型白名单/预览都在，且有 15 个「?」按需帮助按钮、无 `[data-advisor-error]`；
7. 点开第一个「?」能展开内联说明（不是只靠 `title` 悬停）；
8. 关闭设置卡（宿主随后弹出的「首次配置凭据」对话框不算失败）；
   9–12. 会话日志里 `command/done` 依次有 `/advisor doctor`（含 ✅/⚠️ 结论）、`/advisor preview`（目标/将发送）、`/advisor confirm`（已允许或未配置）、`/advisor report all`（顾问报告或空态）；
9. **整段冒烟没有生成 `advisor/usage.jsonl` 或 `advice.jsonl`** —— 证明它没有发起任何模型调用、没有花钱。

设计边界：命令输出以**会话日志**为准（宿主的命令卡片在 DOM 里是折叠的，`innerText` 为空）；
不点保存、不发消息、不徵询；`SMOKE_KEEP=1` 保留临时目录与 `host.log` 排障。

> 不做「假 provider + 真实徵询」的原因：那需要把 provider 额度或回环网关写进冒烟，成本与可重复性都差；
> 真实徵询链路由桌面冒烟（只读）与真机手工验证覆盖。

## 3. 桌面只读回归

```bash
# 1) 带调试端口启动/重启桌面版（验证完正常重启一次即可关掉端口）
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 2) 跑（--require：连不上端口时失败而不是跳过）
pnpm smoke:advisor-desktop --require
# 端口不同时：DSH_CDP_PORT=9333 pnpm smoke:advisor-desktop --require
# 连真实徵询记录一起看（opt-in；只读，脚本不发起徵询）：
pnpm smoke:advisor-desktop --require --advice
```

默认**只读**：只开菜单/对话框、读 DOM/文本、再 Esc 关闭；**不选任何模型、不改任何设置值、不点保存、
不触发真实徵询、不写账本**，因此可以直接跑在真实 profile 上。默认 19 项、加 `--advice` 后 23 项
（没有顾问记录 / 没有选中 provider 的项记 SKIP，不算失败）。断言清单（✅ = 脚本已覆盖；⬜ = 仍是待补项）：

1. ✅ 连上桌面 UI（CDP）；
2. ✅ 插件 client 半已加载：`style[data-plugin="@kangyishuai/dsh-advisor"]`；
3. ✅（**web 冒烟**）`/` 菜单里能搜到 `advisor`，且描述非空（证明 `commands.register` 生效、宿主目录已刷新）；
4. ✅ 设置页卡片（只读）：账号菜单 →「设置」→「通用设置」；卡片有 provider 下拉（≥1 个候选）与 model 下拉，
   没有 `[data-advisor-error]`（宿主 RPC 正常），并出现新增字段「工作区」预算、「预览会发什么」、模型白名单、
   「确认跨 provider 发送」（没选 provider 时这项记 SKIP）；**不点保存、不改任何值**；关掉后对话框消失。
   文案从 `packages/advisor/locale/{zh,en}.json` 读，英文界面同样能过；
5. ✅ 回合尾部顾问线（只读）：页面上有 `.dsh-advisor-turn` 时 headline 为「顾问 · 严重度」
   （`declined` 时是「顾问认为无需建议」）；**没有记录就记 SKIP**——脚本不制造徵询；
6. ✅ 输入 `/advisor` 回车 → 打开**宿主选择器**（有搜索框、有行），按 Esc 关闭、焦点回到输入框；
7. ⬜（未断言）选择器行里至少有一条来自宿主已配置路由（`provider/model` 文本可读），且**没有任何一行**泄露
   `baseURL`/`apiKey`；
8. ⬜（未断言）没有可用路由时**不显示空列表**，而是显示引导项（"去 设置 → 模型 配置"）；
9. ✅ `/advisor status` 输出多行文本：模式、顾问、本会话用量、最近一次结果/跳过原因（主模型与配对结论在 P2 的设置卡里显示）；
10. ✅ `/advisor doctor` 每行都有结论（`✅`/`⚠️`/`❌`）+ 下一步动作，不允许只回一句 error；
11. ✅（**web 冒烟**）整段过程**账本行数不变**：断言临时 `DSH_HOME` 里没有生成 `advisor/usage.jsonl` 与 `advice.jsonl`（即没有任何模型调用）；
12. ⬜（未断言）仓库 cwd 没有多出文件（脚本自身 cwd 污染是最容易漏的一条）。

`--advice`（opt-in，只读已有记录，**脚本本身不发起徵询**；会被打印一行 `COST:` 提醒）再加 4 项：

- ✅ `/advisor report` 输出含「顾问报告」或「还没有顾问记录」；
- ✅ 有 `.dsh-advisor-turn` 时点开 headline，展开体含 `model · usage`（`910 in / 354 out`，上万会缩成 `9.1k`），
  再点一次收起；没有记录时两项都记 SKIP。

**注意**：脚本要求插件已装进**正在运行的那个 profile**。没装时第 2 项会失败，并把页面上全部
`data-plugin` 打出来——这是最省事的"是不是装错 profile / 没重启"判断依据。第 4 项的新字段是 P3 才有的：
桌面装的是旧构建（如 0.1.0；当前 0.2.0 已齐）时会失败，先 `pnpm pack` + `dsh plugin add` 再重跑，失败 detail 里也写了这句提示。

`--deep`（可选，P1 不做）：真要跑徵询链时再补，要求显式传专用工作区、并在临时 profile 里跑。

## 3.5 设置页卡片（写操作 5 步，CDP 脚本）

只读冒烟（§3 第 4 项）只**打开**设置读文本、不点保存。下面这段会**改 `maxTokens` 再改回**，
所以只跑在确认过基线的机器上：

1. 新 client bundle 已加载（`style[data-plugin]` 里含 `dsh-advisor-settings`）；
2. 设置 → 通用设置：卡片加载出 provider/model（**不是**「宿主未响应」），有预算与隐私分组；
3. 切 provider：model 下拉重新拉取并变化（实测 `zhinao` 5 个模型 ↔ `deepseek-official` 2 个）；
4. 选当前模型：思考档下拉出现**真实档位** + 「自动（模型默认）」（实测 `zhinao/deepseek/deepseek-v4.1-flash` → `自动/off/low/high/max`）；
5. 改 `maxTokens` → 保存 → 读 `$DSH_HOME/advisor.settings.json` 确认 → 改回 → 再确认（路由与模式必须不变）；再点「运行诊断」，检查项逐行渲染 `✅/⚠️/❌`。

**2026-11-11 真机结果：8/8 PASS**（DSH 桌面版 0.2.2-rc.1）。诊断输出含「44 条 provider 路由」「上下文 1000000 · 思考档 off/low/high/max」「账本 3 次 · 14428 in / 690 out」。

同一次真机会话里还验证了顾问线与报告（花一次徵询）：

- 回合尾部出现 `顾问 · 轻微 <摘要>`，点开可见完整建议与 `zhinao/deepseek/deepseek-v4.1-flash · 910 in / 354 out · 4.2s`；
- **只有带记录的回合渲染**（该会话恰好一条记录、页面恰好一个 `.dsh-advisor-turn`）；
- `/advisor report`：`投递 1 条 · 采纳 0 · 未判定 1`、`证据锚点：校验 1 条 / 对上 0 条`、最近一条给出「建议里没有可追踪的信号」；空会话时显示「还没有顾问记录」；
- 本次顾问确实引用了 1 个锚点且**没对上**，所以报告里的「对上 0 条」是真实结果，不是统计 bug。

两个踩过的坑：

- **同版本号重装会被 pnpm 跳过**：`dsh plugin add` 同一个 `0.0.0` tgz 时不会覆盖已装副本，表现为「装了但行为没变」。验证新构建一律 `remove` → `add`，或改版本号。
- **基线可能是脏的**：脚本若在上一轮失败后重跑，会把脏值当基线而"假通过"。脚本开头强制 `maxTokens === 4096`，否则 ABORT。

## 3.6 证据锚点、采纳归因与顾问线（P2）

**单测覆盖**（纯函数，`node --test` 直接跑）：

- `anchors.test.js`：索引只收真实 tool-call id / message id / 路径；编造的 id 与不存在的路径判未验证；未知 kind 退化为文本包含；**有锚点但全没对上 → 严重度降一档并追加提示**，一条对上或完全没给锚点则不降级。
- `adoption.test.js`：信号只认路径、反引号命令、证据 ref，过短的丢掉；后续事件出现信号才算采纳；没有信号就 `unknown`（不硬认领）。

**真机手工检查（有顾问记录之后）**：

1. `对话里发生过一次徵询` 后，回合尾部应出现「顾问 · <severity> <摘要>」一行；点开能看到完整建议与 `model · usage`；没有顾问记录的回合**不出现空壳**。
2. 若建议里引用的 tool-call id / 路径在对话里找不到，展开内容应带「证据锚点未对上（N 条）」且严重度已降档。
3. `/advisor report` 输出投递/采纳/锚点三行统计 + 最近 5 条；采纳判定必须给出依据（命中的信号），否则显示「未判定」。

## 3.7 P3 补齐项（内置目录 / 预算池 / 白名单 / 预览 / 两阶段取证）

**单测覆盖**：

- `catalog.test.js`：内置档位「最长匹配优先」、认不出返回 `undefined`；用户声明覆盖内置；单价三档来源（settings/builtin/none）；白名单（空=不限、`provider/model` 或裸 id 命中）。
- `catalog.test.js`（预算池部分）：跨日清零、调用数与金额双闸、边界按「已达上限」处理。
- `verifier.test.js`：`../`、绝对路径、符号链接逃逸被拒；缺失文件报 ENOENT；单文件截断留痕；一次最多 5 个；第二轮提示必须包含证据与不可读清单。

**手工/真机检查**：

1. `/advisor preview` 不触发任何模型调用，但输出里的「将发送 N 字符」「省略 M 字符」「脱敏命中」「单价来源」「工作区今日」要与实际相符。
2. 主模型与顾问 provider 不同时，首次徵询应返回 `needs_confirmation`；`/advisor confirm` 之后正常。
3. `advisorTools: true` 时，顾问若返回 `needs`，工具结果里应带 `verification.read`；读不到的文件出现在 `verification.refused`，且首轮结论保留。
4. `/advisor report all` 读跨会话账本，按严重度/模型/日期汇总。
5. `workspaceMaxCallsPerDay` 到顶后，任何会话的徵询都返回 `workspace_calls`（跨会话共享）。
6. 有顾问记录的回合，展开回合尾部顾问线应看到 `本次徵询：<触发方式> · <HH:mm> · <model> · <字符数> · <in/out/耗时/≈$>`；旧记录没有 `requestChars` 时缺字符数，但其余已有字段仍应显示。

## 3.8 P3 真机结果（2026-11-12）

| 项                    | 结果                                                                                                                                                                                                                       | 证据                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 设置卡 P3 字段        | **PASS**：`工作区每日调用上限` / `工作区每日预算` / `预览会发什么` / `模型白名单` / `确认跨 provider 发送` 全部渲染（默认折叠，桌面冒烟会先展开），`data-advisor-error` 不存在                                             | DOM（`[data-advisor-settings]` 的 `innerText`） |
| `/advisor preview`    | **PASS**：输出「目标 / 发送范围 / 将发送 60022 字符（约 20008 tokens）/ 上下文省略 20947 字符 / 工具往来 376 调用 376 结果 / 脱敏命中 kv-assignment / 白名单 未设置 / 跨 provider 否 / 单价 内置参考价 / 工作区今日 0 次」 | 会话日志 `command/done`（seq 2736）             |
| `/advisor confirm`    | **PASS**：「已允许把会话内容发送到「zhinao」」                                                                                                                                                                             | 会话日志（seq 2720）                            |
| `/advisor report all` | **PASS（空态）**：「还没有任何建议记录。」——P3 之前的 3 次徵询发生在建议账本上线前，所以文件为空                                                                                                                           | 会话日志（cmd-…-14 / -18）                      |

**一个 UI 观测**：命令结果卡片在聊天流里是**折叠**的，且展开后 `innerText` 仍为空（宿主命令卡片的渲染方式）；命令**执行结果本身**可从会话日志的 `command/done.data.text` 读到。因此自动化断言命令输出时，优先读会话日志而不是 DOM。

**补充（2026-11-12 02:00 真机，重启后）**：

| 项                   | 结果                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shadow`             | **PASS**：`/advisor shadow` + 一轮「回复两个字」→ 账本新增 `trigger=shadow`、`turn=16`（绝对回合号）；回合尾部渲染出「顾问认为无需建议」                                                                                                                                                |
| 顾问线渲染           | **PASS**，但修了两个真 bug：①`turn` 曾用插件自己累计的计数，与 `props.turn` 对不上；②client 把 `advice` 结果按 sessionId 永久缓存，而影子建议在 `turn/end` 之后才落盘 → 永不刷新。现在缓存带 3s TTL 且未命中本回合时 2.5s/4s 各强制重取                                                 |
| 锚点校验（advisory） | **PASS**：真机一次徵询 `anchors: {checked:2, verified:0, downgraded:true}`，即顾问引用的 2 个锚点在会话里都对不上，严重度被降档                                                                                                                                                         |
| 两阶段取证           | **未端到端触发**：连续三次徵询（含显式 focus）顾问都没有返回 `needs`。编排已抽成 `runEvidencePass` 纯函数并用 4 条单测固定语义（无 needs 不动 / 读到文件则第二轮生效 / 越界记为 refused / 第二轮失败保留首轮）；提示词已把 `needs` 写进契约。模型是否请求证据属于模型行为，不是代码路径 |
| `/advisor cancel`    | **无法自动化**：命令面串行执行，`/advisor ask` 在 handler 内同步等待，第二个命令进不来；真机没有可并发的在途请求可取消                                                                                                                                                                  |

## 4. 手工 GUI 验证步骤

按顺序做一遍，每步都对照"期望"。`$H` 用 [§0](#0-测试环境) 的临时 `DSH_HOME`：

1. **装包**：`cd packages/advisor && pnpm pack --pack-destination /tmp`，然后
   `DSH_HOME=$H dsh plugin --profile ad add /tmp/kangyishuai-dsh-advisor-*.tgz`。
2. **重启桌面版**（host 半）并**刷新页面**（client 半）：侧栏/会话区正常，插件已激活，无报错。
3. **确认默认关闭**：打开一个会话，直接问一句普通问题 → 模型**不应该**徵询（账本文件不存在或行数不变）；
   工具卡里不该出现顾问结果。
4. **选顾问**：输入 `/advisor` 回车 → 宿主选择器弹出，列出宿主已配置的 provider × model；
   选中一条 → toast 提示"顾问已设为 `provider/model`"；`/advisor status` 里的顾问变了。
   刻意选一条缺凭据的路由 → 行上标 ⚠ 且选中后给"去配置"提示，而不是静默失败。
5. **徵询一次**：问一个需要动手的任务（例如"先看这个仓库的测试命令再改一个地方"），让模型在动手前调用
   `advisor` → 工具卡出现结论（`reviewed` / `declined` / `unavailable`），展开能看到建议文本与 token；
   账本 `$H/advisor/usage.jsonl` **多一行**，`verdict`/`provider`/`model`/token 与工具卡一致。
6. **看账本**：`/advisor status` 的累计 token 与账本最后一行对得上；`/advisor doctor` 每行都有结论。
7. **shadow 模式**：`/advisor off` → 编辑 `$H/advisor.settings.json` 把 `mode` 改成 `shadow`（或按实现提供的
   命令）→ 再完成一轮 → **账本增长，但主模型上下文里没有建议**（工具结果不注入；表现是模型行为不变，
   而账本多一行 `trigger: "shadow"`）。
8. **off 真的不发请求**：`/advisor off` → 完成一轮 → 账本行数不变。**注意**：`off` 时工具仍然注册
   （缓存安全），`execute` 直接返回 `disabled`——所以你可能看到一条 `skipped`/`disabled` 的工具结果，
   但那不是一次模型调用。
9. **预算到顶**：把 `maxCallsPerTurn` 或 `maxCallsPerSession` 临时改成 0/1，再让模型徵询 → 得到
   `budget_exhausted`（说清是哪一级），账本不再增长；改回后恢复。
10. **隐私**：把 `privacyScope` 改成 `off` → 徵询应被跳过并说明原因；改回 `summary` 后恢复。
    检查脱敏：在会话里贴一段形如 `sk-xxxx` 的假 token，徵询后看账本/工具卡里没有原文。
11. **子代理会话**：在子代理会话里让模型徵询 → 要么按配置拒绝（`no_session` 一类原因），要么行为与主会话
    一致且账本记录 `sessionId`；不允许出现"子代理里徵询把主会话带崩"。
12. **递归**：跑一个多步回合并让模型徵询 2–3 次，观察**不出现自我循环**（账本行数应等于模型实际徵询次数，
    不是指数增长）。这是本插件唯一能把自己跑死的缺陷，手工也要看一眼。
13. **升级回归**：升级 DSH 后重跑第 4–12 步；选择器打不开、`status` 空白、或账本突然停记，多半是宿主私有
    seam 变了——先看 `/advisor doctor`，再对照 [§5](#5-dsh-升级时要重点看的宿主事实) 核对。

## 5. DSH 升级时要重点看的宿主事实

逐条都有源码证据（见 [runtime 0.2.2-rc.1 §9.15](../runtime/0.2.2-rc.1.md)）。建议把下面这些
（§9.15 第 11 条给的 5 条是主干；`settings.general.item` 槽等 P2 用到时再加）补进
`scripts/probe-runtime.mjs` 的 `SEAM_CHECKS`，让宿主升级时能直接 FAIL 而不是功能静默消失：

1. `llm.prepareCall` / `llm.stream` 仍是 `dsh-llm` 的服务定义成员，且 dispatch 前仍只重核路由字段
   （`callConfigEquals` 的口径不变）；一次 prepared call 仍只能 dispatch 一次；
2. `commands.register` 仍在，`commands/list` 仍是 Typert Remote（`/advisor` 出现在 `/` 菜单的唯一来源）；
3. `commandUi.decorate` 仍接受 `{name, available, ui: {kind: "popupSelect", options, onSelect}}`，
   且 `available` 仍被宿主直接调用（缺了会"回车没反应"）；
4. `usage` 仍只由主循环写进 `assistant/message`（**如果哪天宿主给额外调用记 usage，账本要重新设计**）；
5. `user/message` 的 `source.kind !== "user"` 仍渲染成不可见的 `context` 节点（隐藏注入通道）；
   `purpose` 仍能自由传值（递归防护的判据）；
6. `resolveModelInfo` 返回的 `reasoning.efforts` / `context.contextWindow` 形状不变，
   且 `UNSUPPORTED_REASONING_EFFORT` 仍是**抛错**而不是 clamp（否则 effort 降级逻辑可以简化）；
7. `LlmModelInfo` 仍然**没有价格字段**（有的话金额就不用用户填单价了）。
