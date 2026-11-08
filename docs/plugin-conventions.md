# DSH 插件开发约定

面向在本仓库开发 DSH 插件的人和 AI agent。这里只写**稳定的工程约定**；跟具体 DSH 版本绑定的勘察结果（可用的 slot、`ctx` 服务、磁盘布局、已知的坑）放在 [`docs/runtime/`](runtime/)：

- 当前目标运行时：[DSH 0.2.2-rc.1](runtime/0.2.2-rc.1.md)（旧版本记录保留在同目录）

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

1. 单元测试：`node --test`，放在 `packages/<name>/test/`。文件系统相关逻辑一律在 `mkdtemp` 临时目录里测。
2. `pnpm verify`：lint + 类型检查 + 规范检查 + 测试。
3. 真实验证（必须做）：`cd packages/<name> && pnpm pack --pack-destination /tmp`，再 `dsh plugin --profile desktop add /tmp/<tgz>`，然后重启桌面版（host 半改动）或刷新页面（client 半改动），在 GUI 里手动点一遍。改完代码要**重新 pack 并再次 add** 才会更新已装副本；`link:` 安装会因宿主包解析不到而激活失败（[runtime](runtime/0.2.1-rc.5.md) §6.9）。
4. 验证完可以 `dsh plugin --profile desktop remove <包名>`，再 `add` 正式版。
