# DSH 插件开发约定

面向在本仓库开发 DSH 插件的人和 AI agent。这里只写**稳定的工程约定**；跟具体 DSH 版本绑定的勘察结果（可用的 slot、`ctx` 服务、磁盘布局、已知的坑）放在 [`docs/runtime/`](runtime/)：

- 当前目标运行时：[DSH 0.2.2-rc.2](runtime/0.2.2-rc.2.md)（旧版本记录保留在同目录）

重要决策的来龙去脉记在 [`docs/adr/`](adr/)。

---

## 1. 一个插件包的构成

不要手抄，用 `pnpm new <name> [描述]` 从 [`templates/plugin`](../templates/plugin) 生成：

```
packages/<name>/
├── package.json          # 必须声明 dsh.bundle / dsh.client
├── cordis.patch.yml      # bundle patch：往 profile 里 insert 一行
├── lib/
│   ├── index.js          # host 半（Node，可用 ctx 服务）
│   └── client.js         # client 半（浏览器 classic script，可选）
├── locale/
│   ├── zh.json
│   └── en.json
├── test/                 # node --test；不进发布包
├── README.md             # 英文
├── README.zh-CN.md       # 中文
└── LICENSE               # 脚手架从根目录复制（npm pack 不会带上根目录的文件）
```

`pnpm check` 会检查下面这些规则，CI 也会跑。

### package.json 关键字段

| 字段                   | 要求                                   | 原因                                                                    |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `name`                 | `@kangyishuai/dsh-<目录名>`            | 裸名已被社区大量占用                                                    |
| `type`                 | `"module"`                             |                                                                         |
| `files`                | 白名单，列出的文件必须存在             | 控制发布内容                                                            |
| `publishConfig.access` | `"public"`                             | scoped 包默认按私有发布，会失败                                         |
| `repository`           | `url` + `directory: "packages/<name>"` | npm provenance 需要和仓库对应                                           |
| `dsh.bundle.patch`     | 指向 `./cordis.patch.yml`              | `dsh plugin add` 据此自动接线，**不要手改 profile 的 cordis.patch.yml** |
| `dsh.client.platform`  | `"web"`                                | 桌面版和 Web 都是 web client                                            |
| `dsh.client.inject`    | 依赖的宿主 client 包                   | 决定加载顺序                                                            |
| 依赖                   | **不能**出现 `@deepseek-ai/*`          | 运行时由宿主提供                                                        |
| `engines.dsh`          | 先不写                                 | 见第 4 节                                                               |

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
- `docs/runtime/<版本>.md` 必须被至少一处文档引用。

升级 DSH 时：新建 `docs/runtime/<新版本>.md`，再把上面几处「当前版本」指向它——漏了任何一处，`pnpm check:docs` 会直接报出来。

## 6. 测试与验证

### 6.1 桌面端自动化测试是**硬性要求**

**凡是带 client 半（`dsh.client`）的插件，必须同时提供 DSH 桌面版（Electron）的自动化测试。**
`pnpm check`、`pnpm gate <plugin>` 和 CI 的 `--dry-run` 都会拦这条，缺了直接报错。

要求与原因：

| 要求                                                                                      | 原因                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根 `package.json` 有 `smoke:<name>-desktop` 脚本，指向 `scripts/smoke-<name>-desktop.mjs` | 一条命令可跑；`pnpm gate` 能自动串起来                                                                                                                     |
| 走 CDP（支持 `--port` / `DSH_CDP_PORT`，默认 9222）                                       | 真正驱动**用户的桌面版**，不是另起一个 web 组合                                                                                                            |
| 支持 `--require`：连不上端口时**失败**而不是跳过                                          | 否则「没跑」会被当成「通过」——这是最容易自欺的地方                                                                                                         |
| 默认**只读**：只开菜单/对话框/面板再 Esc 关闭，不执行破坏性操作                           | 要能安全地跑在默认 profile 上；破坏性流程要么放到 web 冒烟（临时 `DSH_HOME`），要么用专门的 `--deep --workspace <专用目录>`                                |
| 会打印截图目录与断言明细                                                                  | 失败时可复现、可留证                                                                                                                                       |
| 需要真机副作用的段落（如 `--deep`）**自己建立前置状态**：新建会话、确认工作区绑定后再动手 | 依赖前面段落「切回某个会话」不可靠——行在折叠分组里时点击不生效，会静默跑在**上一个会话**上，模型没有该工作区权限，表现为「文件不存在」而不是「会话没切对」 |
| 任何会写文件的段落，都要断言「没写进仓库 cwd」                                            | 会话没绑对工作区时，模型的 `write` 会落到脚本自身 cwd（本仓库根），留下未跟踪文件；断言只会显示「文件不存在」，污染完全静默                                |

为什么必须做：client 半大量依赖宿主**私有 seam**（slot、`extraActions`、`views` 接管、`commandUi.decorate`…），
这些没有类型、没有契约，单测和 web 冒烟都覆盖不到**真实 Electron 渲染进程**里的行为。

参考实现：

- `scripts/smoke-session-rewind-desktop.mjs`（25 项只读，2026-11-14 实测 25/25；`--recall` 再加 7 项输入框召回；`--deep` 再加文件模式 e2e，合计 40 项）
- `scripts/smoke-session-delete-desktop.mjs`（18 项只读，2026-11-13 实测 18/18；带 `--workspace` 时另有写文件段落）
- `scripts/smoke-advisor-desktop.mjs`（20 项，2026-11-14 实测 19 PASS + 1 SKIP；SKIP 是「该会话没有顾问记录」——脚本不制造徵询）
- `scripts/smoke-next-step-desktop.mjs`（12 项只读，实测 10 PASS + 2 SKIP；`--deep` 发消息造卡后合计 25 项，实测 23 PASS + 2 SKIP）

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

### 6.3 用 ego-browser 跑 GUI 冒烟时的两条硬约定

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
