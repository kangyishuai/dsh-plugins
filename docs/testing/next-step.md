# next-step 测试清单

> 目的：证明四件事——**卡片确实出现在完整回答之后**、**点胶囊确实按「用户消息」发出**、
> **状态只来自会话日志且刷新/切会话后一致**、**关掉开关后真的不再请求模型**。
> 三层：**单测 → web 端到端冒烟 → 桌面只读回归 + 手工 GUI 验证**。
> 前两层每次提交都跑；第三层发版、DSH 升级、以及改动客户端私有 seam 后必须跑。

## 0. 测试环境

next-step 会**真的调一次模型**：没有模型凭据时卡片不会出现，那属于「静默失败」而不是 bug。
冒烟与手工验证都会消耗 provider 额度，也会往会话日志里写插件记录，所以一律在临时 `DSH_HOME` 里跑：

```bash
# 注意：冒烟脚本会把临时 profile 里的第三方插件全部摘掉（只留宿主 bundle + 待测插件），
# 避免无关插件的副作用把宿主启动搞挂；这是有意的「干净宿主」验证。
# SMOKE_KEEP=1 保留临时目录（排障用，host.log 现在常驻写盘）。
# 断言失败时**自动**保留临时目录（不必设 SMOKE_KEEP），并把插件自报的失败原因打出来。

# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/next-step && pnpm pack --pack-destination /tmp

# 2) 隔离 home：复制 profile + 会话 + 存储
H=/tmp/dsh-test-next-step
rm -rf $H && mkdir -p $H/profiles
cp -R ~/.dsh/profiles/desktop $H/profiles/ns
cp -R ~/.dsh/sessions $H/sessions
cp -R ~/.dsh/storages $H/storages
DSH_HOME=$H dsh plugin --profile ns install
DSH_HOME=$H dsh plugin --profile ns add /tmp/kangyishuai-dsh-next-step-*.tgz

# 3) 启动（端口 0 = 随机，--no-open 不弹浏览器）
DSH_HOME=$H dsh --profile ns --port 0 --no-open
```

**观测点**（出不出卡、有没有真的发请求，都对照这里，而不是只看界面）：

| 位置                                             | 看什么                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `$H/sessions/<projectKey>/<sessionId>/` 会话日志 | 有没有新的 `plugin:next-step/card` / `plugin:next-step/decision` 记录 |
| 会话日志里的 `user/message` 事件                 | 点胶囊后是否**恰好**多一条正常用户消息，文本等于胶囊上的按钮文本      |
| 插件诊断（`diagnostics`）                        | 生成次数、失败/超时/限流计数；关开关后计数应停住                      |

## 0.5 验证记录（2026-11-10，DSH 0.2.2-rc.1）

| 层                             | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test`（包内）          | 67 pass / 0 fail（settings 29 + prompt 38）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm probe:runtime`           | 60/60 PASS（含 8 条 next-step seam + 2 条 slot）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm smoke:next-step`         | **54 PASS + 0 SKIP（共 54 项）**（临时 `DSH_HOME`、真实宿主、真实模型调用）：投影健康、答后出卡、两粒胶囊、stance 互斥、**设置页开关 → updateSettings 写盘（点开关→读设置文件→点回）/ 幽灵提示出现 / 输入 @ 或斜杠时让位且关菜单后恢复 / 空草稿按 Enter 不发 / 输入即消失且 1.9s 不闪回 / Tab 接受进草稿 / 接受后消失 / Esc 清除不自动回来 / 清空草稿后胶囊仍可点**、点胶囊发送用户消息（文本 = `option.text` ≠ `label`）、点后胶囊消失且卡片保留为只读、只读态保留摘要与提问、刷新后仍只读、关开关后不再出卡；日志侧独立复核 `plugin:next-step/card` 与 `phase=sent` 记录形状。 |
| 设置页 UI 写入                 | `pnpm smoke:next-step` 覆盖：账号菜单 → 设置 → 「下一步建议」分节 → 点 `card` 开关 → 读临时 `$DSH_HOME` 的 `next-step.settings.json`（`card:false`）→ 点回（`card:true`），证明走的是 `updateSettings` RPC 而非缓存                                                                                                                                                                                                                                                                                                                                                              |
| 排队消息闸                     | `test/queue-gate.test.js` 5 项单测；`service.js` 在生成前判 `inbox.nextTurn + inbox.nextStep >= 2` 则跳过（`queuedMessageLimit`，与官方 action-cards 同规则）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 桌面真机回归（Electron + CDP） | **只读 9 PASS + 1 SKIP；`--deep` 19 PASS + 2 SKIP**（2026-11-10，真实桌面版、真实模型调用）：插件 client 半加载、投影健康、卡片结构不变量、最多一张可交互卡、答后出可交互卡、两粒 stance 互斥胶囊、点胶囊→`sent` 且胶囊消失、真的发出一条用户消息、仓库 cwd 无污染                                                                                                                                                                                                                                                                                                               |

## 0.4.2 在 0.2.2-rc.5 上的复核记录（2026-11-19，DSH 0.2.2-rc.5）

插件代码没有改动；这一版只验证「升级后仍然成立」。

| 层                                          | 结果                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test`（包内）                       | **176 pass / 0 fail**                                                                                                                                                                        |
| `pnpm verify`                               | 通过                                                                                                                                                                                         |
| `pnpm probe:runtime`                        | **72/72 PASS**                                                                                                                                                                               |
| `pnpm smoke:next-step`（web，真实模型调用） | **73/73**，0 SKIP / 0 FAIL（2026-11-20 复跑；新增「点 ✕ → dismissed / 刷新后仍在」两条，另有两项只在模型判「无需继续」时出现，项数以输出为准）                                               |
| `pnpm smoke:next-step-desktop --require`    | **23–25 PASS + 0–2 SKIP**，0 FAIL（**2026-11-28 起上限 25 项**：新增 3 条旧卡折叠断言；SKIP 都是数据相关分支：「该卡没有展开按钮」「只有一粒胶囊」「没有更早的只读卡」；保持默认只读不点 ✕） |

本轮 web 冒烟与桌面回归**串行**跑（不再并发），没有再出现 rc.3 那次「首跑两张卡 FAIL、重跑全绿」的瞬时失败。桌面脚本收尾也补了计数行，门禁能正确判定假绿。

### 2026-11-20：桌面回归改幂等（不再写 decision；胶囊按 1–2 粒断言）

跑 `pnpm gate next-step` 时暴露了两个测试设计问题，都只改脚本：

1. **「只读」回归本来会点 ✕。** 点 ✕ 会往会话日志追加 `plugin:next-step/decision`（phase=dismissed），
   把**那张卡**永久变成只读态且不可撤销。连跑几次就把可见会话里仅有的可交互卡消耗光，
   下一次运行连「找到可交互卡」都做不到（实测同一天第 2 次运行 4 项断言红）。
   现在默认只读**不点 ✕**；「刷新后重新打开会话 → 卡片仍是可交互态（只读没有写 decision）」由新断言覆盖，
   而「已决策卡片在刷新后仍是只读」继续由「已决策卡片（来自会话投影）」段用现有数据验证。
   点 ✕ 的写路径归 `--deep`。
2. **胶囊数被写死成 2。** 插件契约是 **1–2 粒**（ADR 0013），抽到只有一粒胶囊的卡时，
   「两粒胶囊的 stance 互斥」「按一次 Esc…」等断言全红。现在按 1–2 粒断言，只有一粒时 stance 互斥记 SKIP。

顺带把刷新后的「重开目标会话」改成轮询并先展开收起的工作区分组 / 「展开其余 N 个会话」——
刷新后侧栏行可能被折叠起来，一次性 `querySelector` 会误报「没找到会话行」。

2026-11-19 连续两次实测 **21 PASS / 1 SKIP / 0 FAIL**（完全一致）；2026-11-20 复跑出现 20/2 与 22/0——**数据相关分支允许漂移，幂等的判据是两次都 0 FAIL**（`pnpm gate:all --repeat 2` 已按这个口径判定）。

结论：**rc.5 上 next-step 无回归**。


## 0.3.0 在 0.2.2-rc.3 上的复核记录（2026-11-14，DSH 0.2.2-rc.3）

插件代码没有改动；这一版只验证「升级后仍然成立」。

| 层                                          | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node --test`（包内）                       | **99 pass / 0 fail**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm verify`                               | 通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm probe:runtime`                        | **72/72 PASS**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm smoke:next-step`（web，真实模型调用） | **59/59**，0 SKIP / 0 FAIL。首跑是 13 PASS + 2 FAIL（卡片与卡片日志），截图显示补生成按钮报「操作失败，请重试」，而回答明显超过 80 字闸门；之后三次单独重跑（含一次**刻意与三条桌面回归并发**）全部 59/59。归因已更正：并发负载**没能**重现，机制确定为生成超时的 abort 路径，但当时中止既不计数也不落日志，子原因事后无法还原（见 [runtime rc.3 §7](../runtime/0.2.2-rc.3.md)）。本轮已补可诊断性：诊断行新增「已中止」计数、失败文案区分超时/取消、冒烟在没出卡时读 `data-next-step-retry-error` 并在失败时自动保留临时 `DSH_HOME` |
| `pnpm smoke:next-step-desktop --require`    | **10 PASS + 2 SKIP**，0 FAIL（SKIP：当前会话没有决策卡 / 只读模式不造卡）                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

结论：**rc.3 上 next-step 无回归**；冒烟请串行跑，不要和桌面回归并发。

## 0.3.0 复核记录（2026-11-14，DSH 0.2.2-rc.2）

| 层                                          | 结果                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test`（包内）                       | **99 pass / 0 fail**（prompt 50 + gates 8 + 其余）                                                                                                                                                                                                      |
| `pnpm probe:runtime`                        | **72/72 PASS**                                                                                                                                                                                                                                          |
| `pnpm smoke:next-step`（web，真实模型调用） | **59/59**；胶囊数量断言已放宽为 1–2 条（真实模型这次就返回了 1 条）                                                                                                                                                                                     |
| `pnpm smoke:next-step-desktop --require`    | **10 PASS + 2 SKIP**，0 FAIL（SKIP：当前会话没有决策卡 / 只读模式不造卡）                                                                                                                                                                               |
| 同上加 `--deep --workspace <临时目录>`      | **23 PASS + 2 SKIP**，0 FAIL（真实模型调用：新建会话 → 发提示词 → 补生成卡片 → 点胶囊 → 校验 `sent` 与回显）。deep 的一句话提示词正好被「回答 < 80 字不出卡」的便宜闸挡住，脚本走的是「生成下一步建议」补生成路径——这是设计里的兜底，顺带验证了那道闸。 |
| 设置页                                      | 已迁到「设置 → 下一步建议」独立分节；桌面只读核验读到 3 开关 + 生成节奏 + 诊断（`版本 0.3.0`）                                                                                                                                                          |

内容规则变化见 [ADR 0009](../adr/0009-next-step-architecture.md) 的 v0.3.0 增补。

本轮踩到的两个**真 bug**（都属"静默失效"，值得记住）：

1. **投影缺 `stateSchema` / `wire.viewSchema` 会让整条会话历史加载失败**（页面「历史加载失败」、卡片永不渲染，但发消息与日志都正常）。注册表在读取路径上无条件 `parse`，注册时却不校验。修法：给恒等桩 `{ parse: (v) => v }`，详见 [runtime 0.2.2-rc.1 §9.14](../runtime/0.2.2-rc.1.md)。
2. **macOS `/var` 是 `/private/var` 的软链**：冒烟里把未 realpath 的工作区路径写进 `workspace.json`，宿主校验失败 → 新会话 `session/workspace-attach-failed`，表现为"模型没权限"。脚本必须 `realpath`。

## 0.6 0.1.2 全量回归记录（2026-11-11 14:26，macOS 本机）

在仓库根目录依次跑三套，全部通过：

| 顺序 | 命令                                                                       | 结果                                                                                          | 耗时       |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| 1    | `pnpm verify`（lint + typecheck + 规范 + docs + 公开边界 + 全仓单测）      | **exit 0**；单测 **334 pass / 0 fail**（next-step 79、session-delete 50、session-rewind 205） | **5.6s**   |
| 2    | `pnpm smoke:next-step`（临时 `DSH_HOME`、真实宿主、真实模型调用）          | **54 PASS + 0 SKIP**                                                                          | **102.8s** |
| 3    | `pnpm smoke:next-step-desktop --require`（真实 Electron，插件 0.1.2 已装） | **21 PASS + 1 SKIP**（SKIP：该卡摘要未折叠、没有「展开」按钮）                                | **30.1s**  |

环境：desktop profile 已装 `@kangyishuai/dsh-next-step@0.1.2`，app 以 `--remote-debugging-port=9222` 运行，
设置页诊断行显示 `版本 0.1.2 · 构建 833e886a`。

结论：**0.1.2 无回归**。三层覆盖（单测 / web 端到端 / 桌面真机只读）均通过；唯一的 SKIP 是数据相关的正常分支
（摘要没有超两行自然不出现展开按钮），不是失败。

## 0.7 0.1.2 发布记录（核对时间 2026-11-11）

| 项                     | 值                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| npm `dist-tags.latest` | `0.1.2`（发布于 `2026-11-11T02:51:16Z`）                                                            |
| npm `gitHead`          | `f8334abfbd78355141fe8643a7cf9a1c97901253`                                                          |
| git tag                | `@kangyishuai/dsh-next-step@0.1.2` → 提交 **`f8334ab`**（`chore(release): version packages (#45)`） |
| tag 内 `package.json`  | `0.1.2`；`lib/` 含 `queue-gate.js`                                                                  |
| provenance             | 有（SLSA，`npm publish --provenance`）                                                              |
| GitHub Release         | 非 Draft / 非 Pre-release；**body 已更新为英文版（2,616 字节）**                                    |
| 可安装性               | 干净目录 `npm i @kangyishuai/dsh-next-step@0.1.2` 成功，装出 8 个 `lib/*.js`                        |

核对命令（可复现）：

```bash
# npm 侧
curl -s "https://registry.npmjs.org/%40kangyishuai%2Fdsh-next-step?t=$(date +%s)" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); v=d["versions"]["0.1.2"]; print(d["dist-tags"]["latest"], v["gitHead"])'
# git / Release 侧
git rev-parse --short '@kangyishuai/dsh-next-step@0.1.2^{commit}'
gh release view '@kangyishuai/dsh-next-step@0.1.2' --json tagName,body --jq '{tag:.tagName, bodyBytes:(.body|length)}'
```

## 0.8 v0.2 交互改动回归（2026-11-11，macOS 本机）

覆盖：**按钮文本即消息（WYSIWYG）**、**点后回显被点那一粒**、**`needed` 门控 + 补生成按钮**、**设置渐进披露**、
**作用域 `⌘↵`**、以及两处 harness 修复（临时 profile 去第三方插件、host.log 常驻写盘）。

| 层                                     | 结果                                                                                                                                                  | 耗时   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `pnpm verify`                          | **exit 0**；单测 **338 pass / 0 fail**（next-step 83、session-delete 50、session-rewind 205）                                                         | ~6s    |
| `pnpm probe:runtime`                   | **60/60 PASS**（seam 与 slot 全在；本次没有新增私有 seam）                                                                                            | ~1s    |
| `pnpm smoke:next-step`（SMOKE_KEEP=1） | **59 PASS + 0 SKIP / 0 FAIL**（真实宿主 + 真实模型调用）：冒烟第一轮模型就返回了 `needed=false`，于是走「补生成按钮」兜底路径出卡，后面 57 项照常通过 | ~4 min |

重要观察：**当时的默认提示词（「用一句话解释二分查找」）下模型返回 `needed=false`**（该提示词后来换掉了，见上文的现役记录）——这正是 v0.2 想避免的噪音卡。
冒烟因此改成「自动出卡 **或** 点补生成按钮出卡」两条合法路径，并额外断言按钮存在、可点、点后出卡；
真实会话里这条路径已在 0.7 之前的人工验证中确认。

**桌面真机回归（同日 20:0x 补跑）**：把待测 tarball 装进 desktop profile 并重启宿主后，
`pnpm smoke:next-step-desktop --require --deep` 得到 **32 PASS + 3 SKIP + 0 FAIL**（发版前 tarball，版本 0.1.2 / 构建 `1ba08e8b`）。
首跑曾因模型对「用一句话解释二分查找」返回 `needed=false` 而不出卡失败——桌面深测已改成和 web 冒烟
同一条兜底（等「生成下一步建议」按钮 → 点它 → 再断言可交互卡、点胶囊、回显），详见 §0.9。
`SMOKE_KEEP=1`（或断言失败时自动保留）的临时目录 / `/tmp/dsh-smoke-next-step-shots` 用完请删掉（可能含真实会话内容，别提交）。

## 1. 单测（每次提交）

```bash
cd packages/next-step && pnpm test   # node --test
pnpm verify                          # 仓库门禁（含单测、规范、文档一致性）
```

应覆盖的范围（与 `lib/`、`test/` 同步维护）：

| 主题               | 要证明的事                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输出校验           | 严格 JSON 解析；**1–2 条** option、两条时 `stance` 必须不同、`label` **2–20 字**且必须含具体对象（泛化按钮被丢弃）、`nextPrompt` ≤150 字且与推荐项共享具体对象（否则退化成该按钮文案）、`value` 必须是三档之一（旧字段 `needed` 兼容映射）、**超长展示文本截断**、**单条不合格只丢这一条**；只有「结构不可用 / 三档缺失 / 一条可用建议都不剩」才 `problem=json\|value\|options` 并交给修复调用。                                                                    |
| 触发门             | 只有 `reason.kind === "completed"` 的回合会**生成**；非 completed 的回合也会进一次便宜闸并落 `gate:"turn-error"` 事件（AUD-NS-05，仍不调模型）；`enabled` / `card` 关上、暂停、**出过的卡**数到 `maxCardsPerSession` 都不生成；短答闸是「**本轮回答总字数 <80 且本轮无工具调用**」；同一 turn 已有 card 或 decision 不重复。三档 × 档位的 `shouldShow` 有 9 格真值表。                                                                                              |
| 子代理与会话状态   | `origin === "subagent"` 或 `delegationDepth > 0` 的会话跳过；会话不 live 时跳过。                                                                                                                                                                                                                                                                                                                                                                                   |
| 投影折叠           | card + decision + reveal 记录折叠成 `{ cards, decisions, reveals }`；`turn` 是 key；旧记录（无 `value`/`shown`）读成 `shown:true / value:"must"`；`resolveVisibility` 覆盖「显示 × 揭示 × 决策 × 是否最新轮」全组合。                                                                                                                                                                                                                                               |
| RPC                | `act` 返回 `stale` / `missing` / `disabled` / `error` 的优先级；`act` 只写 decision 并回按钮文本，**不发送**；`generateNow` 只对「最近一个已完成回合」生效（`no-turn` / `stale` / `exists` / `inflight` / `budget` / `disabled`），`force` 时忽略 `needed=false`；`dismiss`、`settings`、`updateSettings`、`diagnostics`（含 `lastSkip` / `skippedByModel`）形状。                                                                                                  |
| 设置 v3            | `cardThreshold` 只认三值（非法回落 `could`）、`telemetry` 只认布尔、预算默认 **60**；迁移只改「恰好等于旧默认值」的字段：v1 的 30 → 60、v2 的 120 → 60，显式 `schemaVersion:2/3` 的 30 / 45 / 120（非旧默认值）不动；读取不凭空建文件。                                                                                                                                                                                                                             |
| 客户端纯函数       | 只对最后一轮渲染可交互卡；有 decision 即只读并回显被点那一粒（`decision.index` → `label`）；ghost 显示条件（ghost 开、草稿空、无附件/`@`/`/`、`phase === "plain"`、空闲）；草稿非空时胶囊禁用；`⌘↵` 只在「输入干净 + 空闲 + 卡片可交互」时接管；关闭总开关时依赖设置项不渲染。                                                                                                                                                                                      |
| 旧卡折叠           | `test/client-card-collapse.test.js`：`state="readonly"` 的卡必须折叠成一行（`data-next-step-collapsed`，只有摘要首句、无提问/胶囊/✕，完整摘要在 `title`）；可交互卡与已决策卡不折叠；`firstSentenceOf` 的截断/压空白/上限。                                                                                                                                                                                                                                         |
| i18n 键集 parity   | `test/locale-parity.test.js`：`client.js` 内联 zh/en 字典与 `locale/{zh,en}.json` 键集一一对应；`error.aborted` 这类漏键会直接红（AUD-NS-07）。                                                                                                                                                                                                                                                                                                                     |
| 生成失败反馈与超时 | `test/generate-status.test.js`：宿主侧「每会话最近一次生成」记录（成功/失败归一、detail 截断、FIFO、空 id）。`test/client-retry-feedback.test.js`（迷你 hooks 驱动真实 client）：手动失败 → loading 结束 + 一行原因 + 「重试」+ 详情可展开；自动生成失败/刷新后靠 `generateState` 显示同一套反馈；RPC 挂起 → 客户端超时、**先 `cancelGenerate` 再**显示「生成超时，可重试」；`inflight` 进入等待态轮询后台状态；旧宿主缺 `generateState` 时静默降级（USIM-U2-04）。 |
| 卡片 ⌘↵ 登记时序   | `test/client-card-shortcut.test.js`（迷你 hooks 运行时驱动**真实 client 源码**）：尾部先挂载、卡片晚到后 `⌘↵` 仍须被接管（一粒 / 两粒胶囊都覆盖）；草稿非空 / 未揭示 / 已决策一律透传。回归哨兵：卡片是投影晚到的，登记 effect 漏了可见性就永远登记不上（点击正常、快捷键静默失效）。**别按胶囊数量归因**：0.4.0 上晚到的**一粒**卡片同样不接管。                                                                                                                   |

**时序用例用假时钟，不要用 `sleep` 猜时序**：`test/client-retry-feedback.test.js` 的 grace /
`generateState` 轮询 / 客户端超时，以及 `test/settings-save-status.test.js` 的「已保存」复位窗口，都走
`setTimeout` + `Date.now()`（线上 2.5s / 2s / 30–60s / 2.5s，测试里缩短成 5ms / 10ms / 40ms / 300ms）。
这两个文件共用 **`test/helpers/clock.js`**：`installClock()` 接管 `setTimeout` / `clearTimeout` /
`Date.now`，由 `waitFor()` 一步一步推进假时间并断言「等到目标状态」，**没有真实 sleep**。原因是
2026-11-28 复审记录的已知 flake：并行全仓测试（`pnpm verify` 里 8 包并发、机器负载高）时真实定时器会被
调度抖动吃掉——

- `client-retry-feedback`：40ms 窗口里两次 10ms 轮询还没跑完就判成 `error.timeout`（期望
  `error.schema`），`sleep(4)` 也可能实际睡几百毫秒，把「loading」断言拖成「error」（断言「后台失败 →
  `error.schema`」的两条用例还把客户端超时窗口另放大到 5s 作双保险）；
- `settings-save-status`：`sleep(4)` 睡过 client 内 300ms 的「已保存」复位窗口，断言 `saved` 时状态
  已经回落成 `clean`（2026-11-28 实测：16 路并发 ×6 轮共 96 次里红 4 次，报错 `'clean' !== 'saved'`，
  两个用例都会中；单包顺序跑则一直是绿的）。

假时钟下这些用例的时序完全确定（整个 `client-retry-feedback` 单跑从 ~430ms 降到 ~60ms，
`settings-save-status` 从 ~500ms 降到 ~5ms），并且 `settings-save-status` 仍保留完整语义：
`waitFor()` 等到 `saved` 出现后，再 `advance(RESET_MS + 1)` 越过复位窗口，断言必须回落 `clean`——
不靠真实毫秒，也没有弱化「已保存是短暂态」这条断言。

**约束**：新增时序用例沿用 `installClock()` + `waitFor()`，不要再抄第二份实现、更不要退回
`sleep(ms)`。两个文件共用同一个 helper 的前提是它只碰全局定时器与 `Date.now`，且每个用例的 `finally`
里都 `clock.restore()`（`node --test` 按文件隔离进程，但同一文件内的用例共用进程，漏 restore 会把假时钟
漏给后面的用例）。`test/helpers/clock.js` 会被 `node --test` 当成一个空测试文件收进去（与
`packages/advisor/test/temp.js` 同一情况），所以包内 `node --test` 的计数从 **248 → 249**，多出来的这
一条不是新用例；全仓计数表（`docs/testing/index.md`）由计数回填批次统一更新。

**没覆盖**：真实宿主槽位、真实 Electron 渲染进程、真实的 `setDraft` → `submit` 时序。所以下面两层不能省。
（`test/client-card-shortcut.test.js` 已经用迷你 hooks 运行时贴近了「投影晚到 + 重渲染」的时序，但仍不是真实 React 与真实槽位。）

## 1.5 一条命令跑完门禁（发版前）

`scripts/gate.mjs` 是通用的：`pnpm gate next-step` 会按「便宜的先跑」依次跑
`pnpm verify` → `pnpm probe:runtime` → `pnpm smoke:next-step` → 桌面只读回归（**永远带 `--require`**），
加 `--deep` 再跑桌面发送链 e2e。任何一步失败立刻停并给出下一步提示；只有显式 `--skip-desktop`
才跳桌面端，且结束时会明确打印「门禁不完整」。

## 2. web 端到端冒烟（每次提交，改 client 后必跑）

```bash
pnpm smoke:next-step
```

在临时 `DSH_HOME` 里启动真实宿主 + ego-browser，用真实模型走完整链路。断言应覆盖：

| 分组          | 断言                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 出卡          | 发一条能正常结束的提问 → 等 `turn/end` → 最后一条回答下方出现卡片（摘要 + 提问 + 两粒胶囊）；胶囊标签非空且互不相同。                                                |
| 卡片结构      | 摘要超过两行时出现「展开 / 收起」，点击只影响摘要显示；卡片不抢焦点（`document.activeElement` 不因渲染改变）。                                                       |
| 点胶囊        | 点第一粒 → 草稿先被写入再提交（与手动回车同一条链）→ 会话日志**恰好**多一条 `user/message`，文本 === 该胶囊的按钮文本（WYSIWYG）。                                   |
| 变只读        | 点击后卡片保留、胶囊消失、摘要与提问仍在；`sent` 态把被点的那一粒换成选中态（✓ + 按钮文本）并跟一行「已发出」；更早的卡不可点。                                      |
| 日志形状      | 解压会话日志：card 记录字段齐全（`turn` / `summary` / `question` / `options[2]` / `nextPrompt` / `model`），点击后有对应 decision 记录；卡片记录不是伪造的用户消息。 |
| 持久化        | 刷新页面 → 卡片与只读态仍在；切走会话再切回 → 同上；重开（或重载）后仍一致。                                                                                         |
| 收起 / 关闭   | 点 ✕ → decision 写入、卡片转只读、不发送；全局开关关闭后完成一轮 → **不新增 card 记录、诊断生成计数不增**（证明不是只隐藏 UI）。                                     |
| 预算 / 暂停   | 暂停或达到每会话预算后再完成一轮 → 不新增卡片，已有卡片仍可读。                                                                                                      |
| 草稿保护      | 输入框有草稿时胶囊禁用，点击不发送、草稿不被覆盖。                                                                                                                   |
| 幽灵提示      | 开 ghost → 空且空闲的输入框出现最新卡的 `nextPrompt`；`Tab` / `→` 接受进草稿且 `Ctrl+Z` 可撤销；输入字符后消失；`Esc` 清除；草稿非空/有附件/有 `@`/有 `/` 时不显示。 |
| 不发误消息    | 幽灵提示可见时按 Enter 不会发出任何消息（提示不在草稿里）。                                                                                                          |
| 子代理        | 子代理会话完成一轮 → 不出卡。                                                                                                                                        |
| 失败静默      | 伪造/诱导不合法 JSON（或断开模型）→ 不出卡、不弹错误框、只增诊断计数（可 mock 时在单测覆盖，冒烟按可操作性取舍）。                                                   |
| 门控 / 补生成 | 模型返回 `needed=false` → 不写卡、诊断出现「最近跳过：model · <理由>」；最新回答下方出现「生成下一步建议」。                                                         |
| 设置渐进披露  | 总开关关闭 → 设置行只剩总开关 + 说明（card/ghost/暂停/预算/诊断都不在 DOM 里）；点开 → 三开关 + 预算 + 暂停 + 诊断回来。                                             |

失败时的截图与断言明细写进 `/tmp/dsh-next-step-smoke-shots/`（临时 home 里可能有真实会话内容，**不要提交**）。

## 2.5 自动化**没有**覆盖的部分（发版前必须手工补）

| 未覆盖                                         | 为什么                                                     | 怎么补                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `act` 的 `stale` / `missing` / `disabled` 分支 | 需要构造并发或过期状态（两个窗口同时点同一张卡）           | 双窗口打开同一会话，先后点同一张卡的胶囊，第二次应提示「已过期」                                                                                           |
| `⌘↵` 快捷键                                    | CDP 里发真实键盘组合要抢焦点，容易与宿主原生键盘桥互相干扰 | 桌面真机：卡片可交互 + 空输入框 + 空闲时按 `⌘↵` → 应发出 primary；有草稿/有排队时按同样组合 → 仍走宿主 Queue/Steer。登记时序已有单测兜底，这里补**真键盘** |
| 手动补生成（成功的分支）                       | 每次点击都消耗一次真实模型调用                             | 暂停生成（设置页「暂停 1 小时」）→ 完成一轮 → 点「生成下一步建议」→ 应强制出卡                                                                             |

幽灵面已打开却没显示时，页面里会留一个隐藏标记 `[data-next-step-ghost-off]`，取值直接说出是哪条门挡住的：
`no-session` / `no-prompt`（最新卡没有 nextPrompt）/ `decided`（最新卡已决策）/ `cleared`（刚被 Esc 清掉）/
`suppressed`（输入后 2s 抑制）/ `draft`（输入框有内容）/ `phase:*` / `claim` / `menu`（斜杠或 @ 候选菜单开着）/ `attachments` / `refs` / `not-idle`。
排障先看它，比猜快。

## 3. 桌面只读回归（有 client 半，硬性要求）

```bash
# 1) 带调试端口启动/重启桌面版（验证完正常重启一次即可关掉端口）
open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
# 2) 跑（--require：连不上端口时失败而不是跳过）
pnpm smoke:next-step-desktop --require
# 端口不同时：DSH_CDP_PORT=9333 pnpm smoke:next-step-desktop --require
```

默认**只读**：只切会话、读 DOM、开关卡片（不点胶囊、不发模型请求、不写文件），可以直接跑在真实 profile 上。
当前脚本的 **12 项断言**：

1. 连上桌面 UI（CDP）
2. 插件 client 半已加载：`style[data-plugin="@kangyishuai/dsh-next-step"]`
3. 输入框可编辑（Esc / 点击不会把界面搞坏的前提）
4. 幽灵提示默认不出现（`ghost` 默认关 + 草稿为空）
5. 当前会话卡片总数可读
6. 投影健康：没有「会话历史加载失败」的报错（投影坏掉时是静默全灭，必须有这条）
7. 每张卡结构不变量：≤2 粒胶囊、只读态无胶囊、摘要与提问非空
8. 最多一张可交互卡
9. 找一个带可交互卡的会话（探测现有会话；**没有就 FAIL，不静默跳过**）
10. 该会话的卡片结构（无卡时 SKIP）
11. 设置页出现「下一步建议」分节（3 开关 + 预算 + 暂停）——入口：账号菜单 → 设置 → 左栏「下一步建议」
12. 诊断行显示运行时版本与构建哈希（`版本 x.y.z · 构建 abcdef12`）

**注意**：脚本要求插件已装进**正在运行的那个 profile**。没装时第 2 项会失败，并把页面上全部
`data-plugin` 打出来——这是最省事的「是不是装错 profile / 没重启」判断依据。

### `--deep`：真正发一轮（会消耗额度）

```bash
pnpm smoke:next-step-desktop --require --deep --workspace /tmp/next-step-deep
```

只有 `--deep` 才做有副作用的链路：在专用工作区里新建会话 → 发一条消息 → 等卡出现 →
点胶囊 → 断言草稿被写入且消息发出、卡片转只读、刷新后仍只读。会消耗模型额度，
且**不要**在正在跑本 agent 的会话里跑（会打断当前回合）。

### 运行时自证版本（2026-11-10 实测，0.1.1）

装 `0.1.1` 并重启后，用 CDP 打开 设置 → 下一步建议 读到的诊断行：

```
已生成 0 · 失败 0 · 跳过 0 · 在途 0
无错误
版本 0.1.1 · 构建 f6492802
```

四方核对全部一致（`buildHash` 前 12 位）：

| 来源                          | 结果                                             |
| ----------------------------- | ------------------------------------------------ |
| 运行时 diagnostics            | `f6492802…`（11 个文件）                         |
| `dsh plugin list`             | `@kangyishuai/dsh-next-step@0.1.1`               |
| profile 内已装 `package.json` | `0.1.1`                                          |
| npm tarball 0.1.1（现算）     | `f649280256b1…`（11 个文件，清单与已装逐一对上） |
| 仓库 main（055b1ba）          | `f649280256b1…`                                  |

结论：**不需要启动日志**，`dsh plugin list` + 诊断行 + npm tarball 三方对照即可确认「装的是哪版、跑的是不是那份代码」。
（顺带发现一个坑：本地 main 若没拉到 release 提交，`packages/next-step` 会停在旧版本、少 `lib/build-info.js`，算出来的哈希自然不同——先 `git pull` 再比对。）

### 本机实测记录（2026-11-10 · 真实 Electron · 插件已装进 `desktop` profile）

第一次跑是在**装包之前**，用来确认脚本「没装插件时不会假绿」：8 PASS / 2 FAIL / 1 SKIP
（FAIL 分别是「插件 client 半未加载」与「找不到带可交互卡的会话」）。

装包（`pnpm pack` → `dsh plugin --profile desktop add <tgz>` → 重启桌面版）之后：

| 命令                                                                            | 结果                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm smoke:next-step-desktop --require`                                        | **9 PASS + 1 SKIP**（SKIP = 只读模式没有可交互卡，正常） |
| `pnpm smoke:next-step-desktop --require --deep --workspace /tmp/next-step-deep` | **19 PASS + 2 SKIP**                                     |

`--deep` 段验证到的真实链路：专用工作区建空会话 → 发提示词 → 回合结束 → **答后出现可交互决策卡** →
**两粒 stance 互斥的胶囊** → 点其中一粒 → **卡片进入 `sent` 且胶囊消失** → **发送出一条新的用户消息** →
仓库根目录没有多出文件。

真机暴露并修掉的两处**脚本**问题（不是插件问题）：
1. 只读卡按设计不渲染 ✕，脚本却无条件要求 ✕ → 改成「摘要/提问必查，✕ 只在可交互态要求」；
2. 只有最后一轮可交互，只读回归不发消息时「找到带可交互卡的会话」必然是空 → 改为 SKIP（要验交互用 `--deep`）。

## 4. 手工 GUI 验证步骤（发版、DSH 升级、改私有 seam 后）

按顺序做一遍，每步都对照「期望」；步骤里的 `$H` 用上一节的临时 `DSH_HOME`：

1. **装包**：`cd packages/next-step && pnpm pack --pack-destination /tmp`，然后
   `DSH_HOME=$H dsh plugin --profile ns add /tmp/kangyishuai-dsh-next-step-*.tgz`。
2. **重启桌面版**（host 半）并**刷新页面**（client 半）：侧栏/会话区正常，插件已激活，无报错。
3. 打开一个空闲会话，**发一条会正常结束的提问**（例如让它解释一个小概念）。
4. **观察卡片**：回答下方出现卡片——摘要、提问、两粒胶囊；摘要过长时可展开/收起；卡片不抢焦点、不改变输入框。
5. **点胶囊**：点其中一粒 → 该胶囊背后的完整文本作为**用户消息**出现在对话里并正常触发下一轮；卡片保留、胶囊消失、变只读（`sent` 态可能多一行「已发出」）。
6. **再次刷新**：卡片仍在且仍只读；切换会话再切回也一样；更早的卡只读。
7. **关开关**：在插件设置里关闭 card 面，再完成一轮 → **不再出卡**；查看诊断，生成计数不再增加（证明请求真的停了）。重新打开开关，下一轮恢复出卡。
8. **暂停 / 预算**：暂停后再完成一轮 → 不出新卡；已有卡片仍可读。恢复暂停。
9. **草稿保护**：先在输入框里留一段草稿，再让本轮结束 → 卡片可显示，但胶囊禁用；hover 提示先清空输入框；清空草稿后胶囊恢复可点。
10. **幽灵提示（ghost）**：打开 ghost 面，清空输入框并让它空闲 → 灰色提示出现（与 placeholder 对齐、单行省略）；`Tab` 或 `→` 接受进草稿（可撤销）；输入第一个字符后消失且 2 秒内不闪回；`Esc` 清除本次建议；有草稿/附件/`@`/`/` 时不出现；提示可见时按 Enter 不会误发。
11. **子代理**：在子代理会话里完成一轮 → 不出卡。
12. **升级回归**：升级 DSH 后重跑第 4–10 步；卡片不出、胶囊点了没反应、或幽灵提示消失，多半是宿主私有 seam 变了——先看诊断，再对照[第 5 节](#5-dsh-升级时要重点看的宿主事实)核对。

## 4.5 运行时自证版本（0.1.1 起）

`nextStep/diagnostics` 返回 `{ version, buildHash, buildFiles, packagePath }`，设置页诊断行也会显示「版本 x.y.z · 构建 abcdef12」。
排查「装没装 / 装的是哪个版本」时按这个顺序对照，**不需要启动日志**：

```bash
# 1) profile 声明与磁盘上的包
node -e "console.log(require(process.env.HOME+'/.dsh/profiles/desktop/package.json').dependencies['@kangyishuai/dsh-next-step'])"
node -e "console.log(require(process.env.HOME+'/.dsh/profiles/desktop/node_modules/@kangyishuai/dsh-next-step/package.json').version)"
# 2) npm 上发布了什么
npm view @kangyishuai/dsh-next-step version
# 3) 运行时自己报的（设置页诊断行，或页面里调 nextStep/diagnostics）
```

`buildHash` 覆盖 `package.json`、`cordis.patch.yml`、`lib/**`、`locale/**`（**不含** README / LICENSE：改文档不该改变构建身份），
按相对路径排序后对「路径 + 长度 + 内容」做 sha256，跨平台一致。

### 4.5.1 哈希怎么比才算数（2026-11-14 实测踩坑）

`buildHash` 覆盖 `package.json`，而 **pnpm 把包装进 profile 时会重写 `package.json`**（键顺序重排、
末尾换行）。于是同一个提交、同样逐字节的 `lib/**`，会因为「怎么装的」报出不同哈希：

| 安装方式                                                             | profile 内哈希               | 能否直接和仓库 / 发布包对照                |
| -------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| 从 **npm** 安装（`dsh plugin add @kangyishuai/dsh-next-step@0.4.0`） | `3afdd017` = 仓库 `3afdd017` | **能**：npm 包里的 `package.json` 未被改写 |
| 用 **`file:` 本地 tarball** 安装（`dsh plugin add /tmp/xxx.tgz`）    | `89b56034`                   | 不能：pnpm 重排了 `package.json`           |
| 更早的构建（缺并发 meta 修复）                                       | `fbdc7b61`                   | 与上面两者都不是同一份代码                 |

（三个哈希都来自 0.4.0 这一轮，`lib/` 与 `locale/` 在前两种情况下逐字节相同。）

规则：

1. **先看安装方式**。npm 安装 → 直接和仓库同一提交比；`file:` 安装 → 和 **profile 内已安装的那份**比，
   不要拿仓库的哈希去对。
2. 比哈希之外更硬的证据是逐字节 diff：

   ```bash
   diff -r packages/next-step/lib ~/.dsh/profiles/desktop/node_modules/@kangyishuai/dsh-next-step/lib
   diff -r packages/next-step/locale ~/.dsh/profiles/desktop/node_modules/@kangyishuai/dsh-next-step/locale
   ```
3. 算任意一份包（仓库、已安装、下载来核对的 npm tarball）的哈希——`build-info.js` 用自身位置定位包根：

   ```bash
   cd ~/.dsh/profiles/desktop/node_modules/@kangyishuai/dsh-next-step   # 或 packages/next-step
   node --input-type=module -e 'const {computeBuildIdentity}=await import("./lib/build-info.js");const id=await computeBuildIdentity();console.log(id.buildHash.slice(0,8), id.version, id.buildFiles)'
   ```
4. **哈希在每个进程内只算一次**（`buildIdentity()` 有缓存）。所以「运行时报出另一个哈希」只能说明
   「这个进程启动时加载的是别的文件」。确认新代码真的生效要同时满足两点：
   **进程启动时间晚于安装时间**，且 **host 半已重启**——`lib/index.js` / `service.js` 只在启动时加载，
   `lib/client.js` 改完刷新页面即可；只刷新不重启会出现「client 新、host 旧」的半新状态
   （诊断行缺「提示词 vN」这一段就是这种状态的特征——`PROMPT_VERSION` 是多少就应显示 `vN`，不要按固定数字记）。

**实测：0.4.0 重启后核对（2026-11-14）**

从 npm 装 `@kangyishuai/dsh-next-step@0.4.0` 后重启桌面版（进程启动 21:15:56，晚于安装），
设置页诊断行：

```text
已生成 0（未显示 0） · 失败 0 · 已中止 0 · 跳过 0 · 在途 0 | 无错误
版本 0.4.0 · 构建 3afdd017 | 提示词 v3 · 口径 v0.4 | 事件 34 条 · 8.2 KB
~/.dsh/next-step/events.jsonl
```

按上面的规则逐项对账：

| 字段       | 期望                      | 实际                               |
| ---------- | ------------------------- | ---------------------------------- |
| 版本       | `package.json` 的 0.4.0   | `0.4.0`                            |
| 构建哈希   | 仓库同一提交的 `3afdd017` | `3afdd017`（npm 安装，可直接对照） |
| 提示词版本 | `PROMPT_VERSION` = 3      | `v3`                               |
| 采集口径   | `SCHEME` = `v0.4`         | `v0.4`                             |
| 事件文件   | 存在且在增长              | 34 条 · 8.2 KB                     |

两点补充：

- 同一份代码用 `file:` tarball 装，这一行会报 `89b56034`——不是装错，就是规则 1 说的
  `package.json` 被 pnpm 重写。
- 「提示词 v3 / 口径 v0.4」这两段由 **host 半**提供：它们出现即说明 host 已重启到新代码；
  只有 client 半更新时（只刷新页面），这两段会缺失。

## 5. DSH 升级时要重点看的宿主事实

1. `conversation.chat.turnTail` 槽位是否还在、props 是否仍是 `{ turn, seq, openFile, t }`，以及
   `turn/end` 不存在时宿主是否仍不渲染该槽（流式中不出卡依赖这一点）；
2. `ctx.sessionProjections.register` 与客户端 `useProjection("nextStep")` 的注册/读取形状是否还一致
   （这是刷新、切会话后状态还在的唯一来源）；
3. `conversation.input.shell(sessionId).actions` 的 `setDraft` / `submit` 是否还在，以及
   `submit` 仍固定 `queue` 模式、`setDraft` 之后需要等草稿落定（同一 tick 连调会发空消息）；
4. `conversation.input.overlay` 与宿主 placeholder 的 class/内联样式是否还在（幽灵提示的渲染与对齐依赖它）；
5. `ctx.on("session/event")` 的 `turn/end` 事件形状（`reason.kind === "completed"`）与
   `appendPluginRecord` 的记录格式；
6. `ctx.get("llm")` 的 `prepareCall` / `call.stream` 形状，以及
   `ctx.get("agents").get(sessionId)?.model?.current?.()` 的读取方式。

## 0.11 0.4.1 发布记录（核对时间 2026-11-15）

| 项                     | 值                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm `dist-tags.latest` | `0.4.1`（发布于 2026-11-14T14:50:42Z）                                                                                                                      |
| git tag                | `@kangyishuai/dsh-next-step@0.4.1` → `5f3a349`（`chore(release): version packages (#124)`）                                                                 |
| GitHub Release         | `@kangyishuai/dsh-next-step@0.4.1`，Latest，2026-11-14T14:48:38Z（body 即 CHANGELOG）                                                                       |
| 发版前门禁             | `pnpm verify` 全绿（175 单测，含新增 `test/client-card-shortcut.test.js`；文档一致性 0 错、公开边界 0 问题）                                                |
| 合并提交               | 修复 PR #123 → `45bc54a`；版本 PR #124 → `5f3a349`                                                                                                          |
| 发布后自证             | desktop profile 从 npm 装 0.4.1（`lib/client.js` 含修复）；真机「晚到约 2.3s 的两粒卡」按 `⌘↵` 成功发出 primary 胶囊并转 `sent`（0.4.0 上同类晚到卡不接管） |

> 0.4.1 只有客户端改动（`lib/client.js` 一处 effect 依赖数组），host 半未变，装完**刷新页面**即可生效。
> 同一轮还修了两份 README 兼容性表的表头/分隔行错位（0.4.0 行被插在表头与分隔行之间，GFM 下整张表渲染不出）。

## 0.10 0.4.0 发布记录（核对时间 2026-11-14）

| 项                     | 值                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm `dist-tags.latest` | `0.4.0`                                                                                                                                               |
| git tag                | `@kangyishuai/dsh-next-step@0.4.0` → `b2004cf`（`chore(release): version packages (#119)`）                                                           |
| GitHub Release         | `@kangyishuai/dsh-next-step@0.4.0`，Latest，2026-11-14T12:59:13Z（body 即 CHANGELOG）                                                                 |
| 发布物与仓库对照       | 下载 npm tarball → `lib/` 与 `locale/` **逐字节一致**、`package.json` 字段无差异、构建哈希 `3afdd017` = 仓库同一提交                                  |
| 发版前门禁             | `pnpm verify` 全绿（170 单测 / 文档一致性 0 错 / 公开边界 0 问题）、`probe:runtime` 72/72、web 冒烟 **71/71**、桌面只读回归 12 PASS + 1 SKIP + 0 FAIL |
| 合并提交               | 特性 PR #118 → `dc9cdf8`；版本 PR #119 → `b2004cf`                                                                                                    |
| 发布后自证             | 桌面版重启后诊断行 `版本 0.4.0 · 构建 3afdd017 · 提示词 v3 · 口径 v0.4`（详见 §4.5.1）                                                                |

> 0.4.0 的浏览器端与桌面端验证是在**本地 `file:` tarball** 上做的，随后 profile 已改为从 npm 安装 0.4.0；
> 两者哈希不同属预期（见 §4.5.1）。0.4.0 没有 `--deep` 的桌面发送链重跑记录。

## 0.9 0.2.0 发布记录（核对时间 2026-11-11）

| 项                     | 值                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| npm `dist-tags.latest` | `0.2.0`（发布于 `2026-11-11T12:32:31Z`）                                                                                       |
| npm `gitHead`          | `a68a8a6484ce0f8249ef334cc1c9ee5260a477d2`（PR #50 squash）                                                                    |
| git tag                | `@kangyishuai/dsh-next-step@0.2.0` → 提交 **`a68a8a6`**（`chore(release): version packages (#50)`）                            |
| provenance             | 有（SLSA；`search.sigstore.dev` logIndex `3809882388`）                                                                        |
| GitHub Release         | 非 Draft / 非 Pre-release；body 1,424 字节                                                                                     |
| 可安装性               | 干净目录 `npm i @kangyishuai/dsh-next-step@0.2.0` 成功；装出 8 个 `lib/*.js`，`package.json` 版本 0.2.0                        |
| 合并提交               | 特性 PR #49 → `86e2cea`；版本 PR #50 → `a68a8a6`                                                                               |
| 桌面真机（发布前）     | `pnpm smoke:next-step-desktop --require --deep`：**32 PASS + 3 SKIP + 0 FAIL**（发版前 tarball，版本 0.1.2 / 构建 `1ba08e8b`） |
| 发布后自证（0.2.0）    | 只读回归 **20 PASS + 2 SKIP + 0 FAIL**；诊断 `版本 0.2.0 · 构建 ce72c9dd`（哈希含 `package.json` 版本，与发版前不同属预期）    |
| 发版门禁（发布前）     | `pnpm gate next-step`：**4 步全绿，152s**（verify → probe 60/60 → web 冒烟 59/59 → 桌面只读 22/22）                            |

核对命令（可复现）：

```bash
curl -s "https://registry.npmjs.org/%40kangyishuai%2Fdsh-next-step?t=$(date +%s)" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); v=d["versions"]["0.2.0"]; print(d["dist-tags"]["latest"], v["gitHead"], list(v["dist"]["attestations"]))'
git rev-list -n1 '@kangyishuai/dsh-next-step@0.2.0'
gh release view '@kangyishuai/dsh-next-step@0.2.0' --json tagName,isDraft,isPrerelease,body --jq '{tagName,isDraft,isPrerelease,bodyBytes:(.body|length)}'
```

本轮发布后 desktop profile 已装 `0.2.0`（`dsh plugin --profile desktop add @kangyishuai/dsh-next-step@0.2.0`），
**需要重启桌面版**才会加载新的 host 半；重启后设置页诊断显示 `版本 0.2.0 · 构建 ce72c9dd`。构建哈希包含 `package.json` 的版本号，所以「发版前 tarball（0.1.2 / `1ba08e8b`）」与「发布包（0.2.0 / `ce72c9dd`）」哈希不同是预期的，代码内容一致。

## 6. v0.4：采集与复盘（2026-11-14 起）

v0.4 把「这一轮为什么没出卡」变成可查的数据，所以测试要多看两层：**事件文件**与**报告**。

### 6.1 冒烟新增的断言（`pnpm smoke:next-step`，71 项全绿）

| 断言                                                                  | 证明什么                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 首屏只有 3 行（2 开关 + 档位三选一），其余折叠                        | 设置页按 §7.2 收敛，且**档位不是隐藏开关**                                                      |
| 「更多设置」展开后 4 开关 + 预算 + 暂停 + 诊断 + 回顾                 | 渐进披露没有把功能藏丢                                                                          |
| 档位切「严格」→ 文件 `cardThreshold=must`；切回「平衡」→ `could`      | UI ↔ RPC ↔ 磁盘闭环                                                                             |
| 设置文件带 `schemaVersion=3`、预算 60                                 | v3 契约与迁移结果（AUD-NS-02：默认 120 → 60）                                                   |
| `events.jsonl` 存在且第一条是 `meta`（`scheme` + `tier`）             | 采集起算点先于一切事件                                                                          |
| 每个合格回合都有 `turn` 行（`gate` / `sid` / `feat` 齐全）            | **没出卡的回合也留痕**（这是复盘的地基）                                                        |
| 出过的卡带 `cand.value` / `cand.shown` / `latencyMs` / `model`        | 三档判定与耗时可用于分组                                                                        |
| 点过胶囊 → `action{clicked}`（带 `index` / `stance`）                 | 正反馈有记录                                                                                    |
| 点击发送后 → `followup`（`typed` / `textChars` / `overlap` 都是数字） | 隐式负反馈有记录；**顺序坑：宿主先发 `turn/start` 再发 `user/message`**，不能在前者清理待追踪卡 |
| 事件文件不含 `用户：` / `助手：`                                      | 隐私边界：不写对话原文                                                                          |
| 点「生成报告」落 `report-*.md`，含五段结构                            | 报告真的能生成                                                                                  |
| 新环境报告明写「样本不足」                                            | 样本门禁生效，不会拿噪声下结论                                                                  |

### 6.2 手工清单（发版前补）

1. 三档各跑一轮：确认「严格」漏掉的卡在「平衡」下出现，`events.jsonl` 里 `cand.shown` 跟着变。
2. **揭示**：让一轮判成 `no`（问一个已被完整回答的问题）→ 出现补卡按钮 → 点击 → 卡片出现，
   且诊断里 `已生成` **没有**增加（是揭示，不是重新生成）。
3. **曝光两态**：把窗口滚到卡片下方（离开视口）等 5 s → 该轮 `impression.visibleMs = 0`；
   滚回来 → 另一轮的 `impression.visibleMs > 0`。
4. 手改设置 `cardThreshold: "x"` → 页面回落「平衡」、不报错；改 `maxCardsPerSession: 30` 且删
   `schemaVersion`（v1）→ 读成 60；写 `schemaVersion: 2` + `maxCardsPerSession: 120` → 读成 60（v2 旧默认）；
   写 `schemaVersion: 2` + `maxCardsPerSession: 45` → 保持不变。
5. 关掉「本地采集与复盘数据」→ 新回合不再写事件，但卡片与决策记录照旧。
6. 报告保留策略：连续生成 21 份 → 目录里只剩 20 份，最早的那份被删（只在 `next-step/` 内）。

### 6.3 怎么复盘（3–5 天之后）

```bash
# 在设置页「更多设置 → 回顾」点「生成报告」，或直接读文件：
ls ~/.dsh/next-step/report-*.md
```

报告五段：样本量 → 频率 → 归因（漏判/噪音/曝光）→ 内容与按钮 → 建议动作。读法：

1. **先看样本量**：`<80` 回合或 `<25` 张卡时报告只列计数，别下结论。
2. **再看曝光率**：低于 60% 说明卡大半没被看见——先修位置/时机，别去改提示词。
3. **然后看漏判率**（被抑制却事后想要的占比）：>20% 就把档位从「平衡」往「积极」调一档。
4. **最后看按钮有效性**：第 2 条点击率区间上界 <10% → 默认只给 1 条；label 长度分桶看哪种更点得动。
5. **看 schema 失败的拆分**：报告 §3 会把 `schema` 拆成「空输出（`json:empty`）」与「非空格式失败」。
   空输出多时会出现 `empty-generations` 判读——那是 provider / 输出长度（`maxTokens`）问题，**不是**
   「解析要放宽」；本机实测同一请求重发只救回 2/81 次空输出，遇到它先查模型/路由与 `maxTokens`。
6. **一次只改一类**（阈值 / 提示词 / 按钮长度），改完 `PROMPT_VERSION + 1`，再等 3 天按版本对比。

复盘记录写在私有仓库 `notes/next-step/review-YYYYMMDD.md`；公开仓库只留 ADR 增补与 README 的变化说明。

## 7. 0.4.3：卡片必须落在对话上（2026-11-21 起）

### 7.1 单测覆盖（`node --test packages/next-step`）

| 用例                                                                  | 钉住的不变量                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 恢复链路回归：首次输出为空 → 重发**同一个**请求，第二次请求里对话还在 | 空输出不许「修格式」；重发的请求必须仍是带对话的那一条                                |
| 恢复链路回归：有内容但格式不对 → 修复请求里**仍然带着同一段对话**     | 修卡调用丢对话就是事故根因；修复请求必须同时有对话、原文、禁止自述                    |
| `buildRepairMessage` 空原文                                           | 空原文照实标「（空）」，但对话与「对话就在上面」的约束必须在                          |
| `identityTokens` / `isGroundedIn` / `groundableText`                  | 认得出文件/命令/PR 号；**不认** JSON / summary / 文件名这类泛化词；对话为空一律不落地 |
| `hasContext` / 便宜闸 `no-context`                                    | 空/极短 transcript 不调模型；没有 `contextChars` 的调用点行为不变                     |

### 7.2 真机复核记录（2026-11-21，DSH 0.2.2-rc.5，本机桌面版）

本机包安装：`dsh plugin --profile desktop add <本地 tgz>`，重启桌面版生效。
`nextStep/diagnostics` 自证构建：最终 `版本 0.4.2 · 构建 e62f1edb · 提示词 v4`（迭代过程中依次是 `a7aa9e92` → `9cd2c06f` → `e62f1edb`）。

| 层                                   | 结果                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面只读回归 `--require`（中间构建） | **22 PASS / 0 SKIP / 0 FAIL**（构建 `a7aa9e92`，客户端半已加载、卡片渲染、刷新后只读态、设置页分节与诊断行）                                                                                                                   |
| 桌面 `--deep`（第一次）              | **35 PASS / 1 FAIL** —— 失败的是**脚本**：断言写死「两粒胶囊」，而模型这次合法地只给了一粒（`补一个二分查找代码示例`）。同日修脚本（见 §7.3）                                                                                  |
| 桌面 `--deep`（第二次）              | 卡片被**落地校验误杀**：`error{kind:"ungrounded", detail:"identityTokens=36 matched=0"}`。该回合是一句话回答（「二分查找是在一个已排序的序列中……」），卡片在**改写**答案、没有文件名/命令 → 当时的「只看具体对象」口径必然误判 |
| 单测 + 语料复算                      | 补「共享 ≥2 条中文 4 字片段」通道后：正常卡 918/919 → **919/919**，自述卡拦下 98/119 **不变**（4 字片段通道只赚不亏）                                                                                                          |
| web 冒烟（含两项修复的构建）         | **73 PASS / 0 SKIP / 0 FAIL**；两轮 `cand.parse:"ok"`、`pv:4`，卡片分别命中 4 个具体对象                                                                                                                                       |
| **最终构建 `e62f1edb` 只读回归**     | **20 PASS / 2 SKIP / 0 FAIL**（SKIP 都是数据分支：当前会话没有可折叠摘要 / 只有一粒胶囊）                                                                                                                                      |
| **最终构建 `e62f1edb` `--deep`**     | **33 PASS / 3 SKIP / 0 FAIL** —— 上次红的那一项已绿：卡片 1 粒胶囊按契约通过、stance 互斥记 SKIP；`cand.parse:"repaired"` 的回合产出了落地卡片（`讲讲二分查找的边界条件`，被点击），短回答的改写式卡片不再被误杀               |
| 落地不变量真机取证                   | 重启后窗口内 `pv:4` 全覆盖、**自述式空卡 0 条**（重启前 12 小时 4 条）；`repaired` 路径产出的卡片指向该轮对话                                                                                                                  |

本轮还暴露一个**既有**的失败形态（与本 ADR 无关，但同样让用户「没卡」）：模型把 label 写成 21–22 字
（上限 20），两次修复都没修回来 → 整张卡作废（web 冒烟第一次 14 PASS / 2 FAIL 即此原因）。
修法：修复请求里带上**上一次的实际字数与压缩目标**（`overlongLabelHint`），而不是只重复「2–20 字」。

### 7.2.1 发版门禁记录（0.4.3 合并后，`main@82141d5`）

`pnpm gate:next-step --deep --workspace <临时目录>`：**PASS 门禁全绿（5 步，288s）**

| 步骤                        | 结果                          |
| --------------------------- | ----------------------------- |
| 1 单测 + lint + 类型 + 规范 | ✓（单测 194）                 |
| 2 宿主能力体检              | ✓ 72/72                       |
| 3 web 端到端冒烟            | **73 PASS / 0 SKIP / 0 FAIL** |
| 4 桌面只读回归              | **20 PASS / 2 SKIP / 0 FAIL** |
| 5 桌面 `--deep` 端到端      | **33 PASS / 3 SKIP / 0 FAIL** |

注意：不带 `--deep` 的 4 步门禁（191s）也是全绿，但**不覆盖**「真发一轮 + 点胶囊」的写路径；
发版前请用带 `--deep --workspace` 的版本，SKIP 只允许来自数据分支（胶囊数、可折叠摘要）。

### 7.3 桌面回归脚本的两处修正（2026-11-21）

1. **`--deep` 段把胶囊数写死成 2。** 插件契约是 1–2 粒（ADR 0013），模型经常只给一条；
   现在与只读段一致：1–2 粒都算通过，只有一粒时「stance 互斥」记 SKIP。
2. **胶囊文案取 `textContent` 会把 primary 的键帽（⌘↵）也算进去。** 改成以 `data-text` 为准
   （与 web 冒烟一致，`data-text` 就是点下去真正发出去的那句话）。

### 7.4 这批不变量下次再动时要复核什么

| 项                                       | 状态                                                         | 怎么验                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 正常回合照常出卡（落地校验不误杀）       | 已验证（§7.2.1：`--deep` 33/3/0、web 73/73）                 | 跑一轮带工具调用的真实任务，看 `cand.parse` 是 `ok`/`retried`/`repaired` 且卡片有对象            |
| 空输出走 `retried` 而不是「修格式」      | 已验证（2026-11-21 实测两次，均产出正常卡片）                | `events.jsonl` 里 `cand.parse:"retried"` 的回合必须有卡片、且没有「没有拿到任何对话内容」类文本  |
| 修复请求带对话                           | 已验证（`cand.parse:"repaired"` 的卡片指向该轮内容，§7.2.1） | 找一条 `repaired` 记录，逐字核对摘要里的对象出现在该回合对话里                                   |
| `no-context` / `ungrounded` 可达且可诊断 | 逻辑与单测覆盖，**真机未触发**（正常回合不产生这两种情况）   | 手改 `next-step.settings.json` 把 `maxTokens` 调到 128 制造坏输出；再看「最近跳过」与 error kind |
| 桌面回归                                 | 每次发版必跑                                                 | `pnpm smoke:next-step-desktop --require --deep --workspace <临时目录>`                           |

### 7.5 复盘口径：空输出 vs 格式失败（2026-11-28 增补）

0.4.3 上线后 `schema` 错误从 pv3 的 19 涨到 pv4 的 102，复核结论是**统计口径变化**、不是校验变严：

- 0.4.3 把「模型返回空文本」的恢复方式从「换个请求再要一次」（0.4.2 几乎总能拿到文本 → 写出一张
  「这一轮没有拿到对话内容」的垃圾卡并记为成功）改成「把同一个请求原样重发」——同一请求仍为空 →
  记成 `schema` 失败。所以同一类空输出从「成功出卡」翻成「schema 错误」。
- pv4 的 102 条 `schema` = **79 条 `json:empty`（77%）+ 23 条非空格式失败**；81 次空输出里重发只救回
  **2** 次（若空输出是独立随机、按 31% 估算，重发应救回约 69%）⇒ 空输出是「同一请求确定性为空」。
  格式类只从 17 涨到 23，`options` 类反而 12→2（提示词/修复调用其实变好了）。
- **读报表**：`schemaShare` 现在只算**非空格式失败**（>15% 才触发 `schema-failures`），新增
  `emptyShare`（空输出占 schema 失败的比例）与 `empty-generations` 判读（空输出 ≥5 且占 schema ≥50%）。
  `schema-failures` 才指向「解析/修复调用」；`empty-generations` 指向 provider / 输出长度（`maxTokens`），
  不要拿它去放宽校验。

代码与测试（先红后绿）：`lib/report.js` 的 `summarize()` 拆 `errors.byDetail` / `errors.empty` /
`errors.format`，`verdicts()` 与 `renderMarkdown()` 同步；`test/report.test.js` 新增
「pv4 形态（78 空 + 24 格式）拆 byDetail」「pv3 形态（2 空 + 17 格式）两条判读都不触发」
「非空格式失败仍走 schema-failures」「renderMarkdown 归因段」四条。同批小修：

- **F-2 补生成小回归**：被取代的旧生成现在会跑到 20s，用户此时点「补生成」不再拿到 `inflight`——
  在途的是别的回合或已 superseded 时先取消再生成；只有「本次回合且未被取代」才等。
  纯判断 `inflightBlocksGenerateNow()` + `test/inflight.test.js` 单测。
- **F-6 折叠首句**：`firstSentenceOf` 补英文 `.`（后接空白/结尾才切，不吃 `v0.5.0`）；测试见
  `test/locale-parity.test.js`「英文句号只在后接空白/结尾时切句」。
- **F-7 测试有效性**：`foldSessionRecords` 的非法卡片 fixture 换成三种「能过 `readCard()`、只有
  `isCardData` 该拒」的形状（0 条选项 / 同 stance / 3 条选项）；删掉校验后该用例变红（已实测变异）。

单测总数：**223 → 229**（`node --test packages/next-step`，0 fail）。

## 8. 0.4.4 噪音与可观测性修复（2026-11-28，审计 AUD-NS-01…08）

> 来源：`notes/audit/2026-11-28/nextstep-session-delete.md` §3（P2/P3）。
> 原则：能复现旧行为的先写失败测试再修（NS-03 / NS-07 / 设置迁移都是先红后绿）；新抽出的纯模块由
> 「变异检查」反向证明——删掉旧卡折叠分支、让 `supersede` 直接 abort，对应断言立刻变红（已实测）。
> client 半的交互改动由桌面只读回归兜底（**本轮未运行**，归发版门禁）。

### 8.1 逐条修法与测试

| issue     | 修法（一句话）                                                                                                                                                                                                                                 | 先红后绿证据（测试）                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| AUD-NS-01 | `turn/start` 不再 abort 在途生成，只标记 superseded；生成跑完以 `shown:false` 落库（**不是省钱**：跑完比中止多付输出 token；收益 = 近完成调用不再被丢弃 + `superseded` 可观测；候选不进对话流、不占 `maxCardsPerSession`、不进曝光、不可揭示） | `test/inflight.test.js`「supersede 只打标记、绝不 abort」；`test/service-logic.test.js`「superseded 一律写 shown:false」 |
| AUD-NS-02 | 更早轮次、未决策的卡默认折叠成一行（「更早的一轮 · 摘要首句」）；`maxCardsPerSession` 默认 120 → 60 + 设置 v3 迁移                                                                                                                             | `test/client-card-collapse.test.js`（3 项，含「旧卡只有摘要首句、无提问/胶囊/✕」）；`test/settings.test.js` v2→v3 迁移   |
| AUD-NS-03 | `byIndex` 分母 = 该位置被**展示**的次数（原来只在点击时 bump，`second-option-useless` 结构上不可达）                                                                                                                                           | `test/report.test.js`「byIndex 的分母是该位置被展示的次数」+「真实事件形态下 second-option-useless 可命中」              |
| AUD-NS-04 | `closeFollowup` 接线：`turn/end` 结算更早回合、TTL 15 分钟结算、会话级上限 32 挤出（同一个幂等入口）；**会话切走在宿主里没有事件，只能靠 TTL 兜底**                                                                                            | `test/followup.test.js`（7 项：consume / close 幂等 / TTL / 上限挤出 / 空 label 不登记 / 常量）                          |
| AUD-NS-05 | completed 过滤下移到便宜闸之后：非 completed 的回合也落 `gate:"turn-error"` 事件（仍不调模型）；**缺 `reason` / `kind` 非字符串统一归一化成 `unknown`，同样只落遥测、绝不放行生成**                                                            | `test/service-logic.test.js`「非 completed 的回合也要进流程」+「endKindOf」+「接线组合：只有 completed 会放行生成」      |
| AUD-NS-06 | 把 `inflight` / `pendingFollowup` / `scanSession` 的可纯化部分抽成 `inflight.js` / `followup.js` / `session-records.js` 等纯模块并补测                                                                                                         | 上述三个测试文件 + `test/service-logic.test.js`（`foldSessionRecords` 三张表口径、坏记录降级）                           |
| AUD-NS-07 | `error.aborted` 补进 `locale/{zh,en}.json`；新增内联字典 ↔ locale 文件的键集 parity 测试                                                                                                                                                       | `test/locale-parity.test.js`（3 项；修复前缺 `error.aborted` 即红，parity 断言失败）                                     |
| AUD-NS-08 | README（中英）隐私段补「生成的胶囊文案会原样记录」                                                                                                                                                                                             | 文档改动，无测试                                                                                                         |

单测总数：**194 → 223**（`node --test packages/next-step`，0 fail）；Wave 2 增补（§7.5）后 **229**；USIM-U2-04（§9）后 **245**。

### 8.2 口径变化（读报表 / 诊断时注意）

1. **`byIndex` 的 `n` 现在等于该位置被展示的次数**（不再是点击次数）。报表「第几条」的点击率 = `clicked / n`，
   与「选项数」「label 长度」两张表的口径一致；`second-option-useless` 因此第一次可能真的出现。
2. **`gate:"superseded"` 是新的闸门值**：生成跑完时这一轮已经翻过去了。它计入 `counters.superseded` 与
   `counters.hidden`，**不计**入 `failed` / `aborted` / `skipped`。报表「闸门分布」与诊断「最近跳过」都能看到。
   **成本方向是增加**：abort 只结算已生成部分，跑完要付全额输出 token —— 这是「不丢近完成调用 + 可诊断」的
   代价，不是省钱；候选本身**不占 `maxCardsPerSession`**（只统计 `shown:true`）、**不喂 ghost**、**不进曝光**
   （不渲染、不上报 impression）、**不可揭示**（`generateNow` 只对最近一个正常结束的回合生效）。
   预期效应：`error.kind=cancelled` 会明显下降；`cand.latencyMs` 与 `shown` 的分母不变，但 **`turns` 会变大**
   （非 completed 回合现在也写 turn 事件）→ 报表「出卡率」`shown/turns` 跨版本**不再可比**（判读不用这个数，
   只是显示）。
3. **`gate:"turn-error"` 现在真的会出现**（含 `reason.kind` 缺失的回合——归一化成 `unknown`）。它只影响遥测与诊断，不放行生成；若这个值异常多，先查宿主是否改了 `turn/end` 的形状。
4. **`followup` 事件第一次有 `typed:false` 的来源**：15 分钟没再说话、下一轮已结束、或会话级上限挤出。
   它会抬高「忽略」的分母解释力，但注意它最多晚 15 分钟——不要拿「今天的 followup 条数」当实时指标。
5. **`maxCardsPerSession` 默认 60**（旧文件里**恰好 120** 的值自动迁移；v1 的 30 也迁移）。
   报表里 `gates.budget` 从「永远 0」变成可能在长会话末段出现，属预期。

### 8.3 桌面只读回归新增断言（`scripts/smoke-next-step-desktop.mjs`，**未运行**）

- `cardsNow` 增加 `collapsed` / `hasQuestion` 两个只读字段（`data-next-step-collapsed` / 查询提问节点）。
- `structureCheck` 区分两种只读形态：**折叠行**（只允许摘要首句，禁止提问 / 胶囊 / ✕）与
  **决策回显**（sent / dismissed，摘要 + 提问 + ✓ 回显）；`state="readonly"` 却未折叠直接判红。
- 新增数据相关分支断言／SKIP：「旧卡默认折叠成一行（只读态：摘要首句 ≤60 字、无提问/胶囊/✕）」。
  `structureCheck` 在初始会话 / 目标会话 / 刷新后各调一次，所以项数**上限 25**（22 + 3）；当前会话没有可交互卡时
  「目标会话」「刷新后」两段不执行 → **23 项**。SKIP 数随数据分支变化，判据是 0 FAIL。
- 仍然**默认只读不点 ✕**：折叠态没有 ✕，写路径（点胶囊 / 点 ✕）只在 `--deep` 下执行。

### 8.4 本轮未验证 / 需要发版门禁覆盖的点

| 项                                                          | 现状                                   | 怎么验                                                                    |
| ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| NS-01 的**集成行为**（真的在生成中发下一条消息 → 候选落库） | 纯逻辑已测；真实时序未跑               | web 冒烟或手工：回答后 2s 内发下一条，检查会话日志多一条 `shown:false` 卡 |
| 桌面只读回归（折叠断言、折叠态无 ✕）                        | **未运行**（本轮不操作 live DSH）      | `pnpm smoke:next-step-desktop --require`，预期 25 项、SKIP 均为数据分支   |
| 会话切走时立即结算 followup                                 | 宿主没有该事件，靠 TTL 15 分钟兜底     | 已知限制，已写进两份 README；不要据此判缺陷                               |
| ADR 0013 的预算默认值（120）与本次 60                       | ADR 属于 repo 级文档，不在本批改动范围 | 由 lead 在 repo 批次统一（ADR 增补或勘误）                                |

## 9. 生成失败反馈与客户端超时（2026-11-28，USIM-U2-04）

> 来源：`notes/audit/2026-11-28/user-sim-u2.md` USIM-U2-04（用户实测 P2）。现象：点「生成下一步建议」后
> 聊天区一直显示「正在生成，请稍候」，2 分钟以上不结束、无取消/重试；诊断里其实已记录失败（`json:empty`）；
> 整页刷新后重试，聊天区又静默恢复原状、无失败提示——与两份 README 里「补生成按钮会说明卡片被丢弃 /
> 超时或被取消」的承诺不一致。
>
> 用户给的判据：失败必须在聊天区/触发按钮处**可见、可操作**；要有**客户端超时**且与服务端真实状态对齐；
> 失败后能**重试**；**手动生成**与**自动生成后的**两条入口都要覆盖；默认仍**只读**（不写 decision）。

### 9.1 三个根因

1. 自动生成（`turn/end` 之后那次调用）失败**不写会话日志**，客户端没有任何通道得知「刚才失败了」，
   于是按钮永远写着「生成下一步建议」，用户看不出刚才失败过（刷新后更是什么都不剩）。
2. 手动生成撞上在途生成时，`generateNow` 回 `inflight`，客户端把它当**静态错误文案**「正在生成，请稍候」
   显示一次——后台随后失败也不会有人清掉它，于是变成永久提示。
3. 客户端没有自己的超时：`generateNow` RPC 挂住时 loading 态无限持续。

### 9.2 修法

| 层          | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| host 纯逻辑 | 新增 `lib/generate-status.js`：每会话记录最近一次**已结束**的生成 `{turn, ok, reason, detail, at}`（成功也记，供客户端清掉旧失败；FIFO 上限 64；detail 截断 240 字）。`writeCardFor` 包一层 `generateCardFor`，在**唯一出口**记录结局；所有失败分支统一带 `reason` + `detail`（schema 的 `json:empty`、宿主错误消息、`generation timeout after 20s` 等），超时/取消的 reason 从笼统的 `aborted` 细分为 `timeout` / `cancelled`。                                                                       |
| host RPC    | 新增**只读** `nextStep/generateState`（`{ inflight, turn, last }`）与 `nextStep/cancelGenerate`（客户端超时兜底：取消该会话在途生成，返回 `{cancelled}`）。`generateNow` 的失败返回继续带 `reason` 并新增 `detail`；`inflight` 也带 detail。两者都不写会话日志、不写 decision。                                                                                                                                                                                                                        |
| client      | 补生成入口变成四态状态机 `idle / loading / waiting / error`：挂载时查一次 `generateState`（自动生成失败或刷新后 → 直接「重试 + 一行原因」；同回合在途 → 等待态）；`waiting` 每 2 秒轮询，后台失败转 error、成功则随投影出卡；失败显示一行原因摘要 + 「查看详情」展开 detail；按钮文案「重试」。客户端超时 = `clamp(服务端 timeoutMs + 5s, 30s, 60s)`，超时**先调 `cancelGenerate` 再结束 loading**，显示「生成超时，可重试」。换轮次/换会话会重置状态并作废晚到的 RPC 回执；旧宿主缺新方法时静默降级。 |

### 9.3 先红后绿与变异证据

- **旧代码红**：把 `git show HEAD:packages/next-step/lib/client.js`（修复前的 client）放进 `/tmp` 的包副本，
  用本次新增的 `test/client-retry-feedback.test.js` 跑 → **6/6 红**（旧 client 没有状态机/超时/状态查询）。
- **变异红**（都在 `/tmp` 包副本上做，不动工作区）：`inflight` 不进等待态 / 去掉客户端超时定时器 /
  超时前不调 `cancelGenerate` / 去掉挂载时状态查询的失败分支 / 轮询里忽略后台失败 → 对应用例逐个变红
  （5/5 命中）。
- 新测试：`test/generate-status.test.js` 8 项（纯记录层）+ `test/client-retry-feedback.test.js` 8 项（交互状态机，含换轮次状态重置）。

单测计数：**229 → 245**（`node --test packages/next-step`，0 fail）。

### 9.4 口径与未验证项

- 服务端仍有自己的生成超时（默认 20 秒，设置可调 3–120 秒）；客户端兜底（30–60 秒）只在 RPC 自身挂住时
  触发，且会**取消服务端在途生成**，所以默认路径下不会出现「UI 结束、后台还在跑」。
- `inflight` 语义变化：它不再作为用户可见的错误，而是「后台仍在生成」的等待信号；等待结束后由
  `generateState.last` 决定「出卡 / 重试 + 原因」。
- 自动生成失败能显示，依赖宿主新增的 `generateState`。新 client + 旧 host 的混搭（DSH 换文件 + 刷新的
  旧 bundle 缓存问题）会静默降级：按钮回到「生成下一步建议」，不影响首生成。
- **未验证**：`generateState` / `cancelGenerate` 的真实 RPC 注册与返回形状不在 `node --test` 覆盖范围内
  （`service.js` 依赖 `@deepseek-ai/*`，加载不了），本轮只做静态核对 + 纯记录层单测。发版门禁需要补齐：
  web 冒烟新增两条断言（没出卡时 `data-next-step-retry-phase === "error"`、按钮文案不再是「正在生成」），
  以及「自动生成失败后刷新仍显示重试」的桌面手工路径。

## 设置保存状态（USIM-U1-10，2026-11-28）

设置分节统一加了「保存状态」行与稳定锚点（[plugin-conventions §7.2.6](../plugin-conventions.md#72-设置页)）。
本节记录**桌面只读断言**（按约定只写不跑；真机证据见下面的 2026-11-28 记录）与单测覆盖位置。

**单测（每次提交都跑）**：`test/settings-save-status.test.js` —— 用迷你 hooks 运行时驱动
`lib/client.js` 里的真实组件，不复制实现。时序走 `test/helpers/clock.js` 的假时钟（与
`test/client-retry-feedback.test.js` 共用）：`waitFor()` 等到 `saved` 出现，再 `advance()` 越过
`timings.settingsSaveResetMs` 断言回落 `clean`，**不依赖真实毫秒**（见 §1 的已知 flake 说明）。

**桌面只读断言**（不拨开关）：

1. 设置 → 下一步建议：`[data-next-step-settings]` 存在。
2. `[data-next-step-settings-status]` 的 `data-state` 为 `clean`，文本含「已保存」。
3. 该分节没有显式保存按钮（改即存）。

**真机记录（同上）**：

| 场景                     | 结果                             | 截图                                                    |
| ------------------------ | -------------------------------- | ------------------------------------------------------- |
| 无改动                   | `data-state=clean`、「· 已保存」 | `/tmp/dsh-sim-rel/shots/settings-next-step-clean.png`   |
| 拨「回答下方的决策卡」后 | `data-state=saved`、「已保存」   | `/tmp/dsh-sim-rel/shots/settings-next-step-changed.png` |
