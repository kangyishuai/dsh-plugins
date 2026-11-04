# DSH 插件开发约定

面向在本仓库开发 DSH 插件的人与 AI agent。基于对 DSH 桌面版 **0.2.1-rc.5** 的实际勘察（`app.asar` 内 `@deepseek-ai/dsh-*` 包文档 + 已安装社区插件源码）。

---

## 1. 一个插件包的最小构成

```
packages/<name>/
├── package.json          # 必须声明 dsh.bundle / dsh.client
├── cordis.patch.yml      # bundle patch：往 profile 里 insert 一行
├── lib/
│   ├── index.js          # host 半（Node，可用 ctx 服务）
│   └── client.js         # client 半（浏览器，可选）
├── locale/
│   ├── zh.json
│   └── en.json
└── README.md
```

### package.json 关键字段

```json
{
  "name": "@kangyishuai/dsh-<name>",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["cordis.patch.yml", "lib", "locale", "README.md", "LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-workspace", "@deepseek-ai/dsh-client-ui-slots"]
    }
  }
}
```

- `dsh.bundle.patch`：`dsh plugin add` 会据此自动接线，**不需要手改 profile 的 cordis.patch.yml**
- `dsh.client.platform: "web"`：桌面版与 Web 都是 web client
- `dsh.client.inject`：声明本插件的 client 半依赖哪些宿主 client 包（用于加载顺序）

### cordis.patch.yml

```yaml
- insert:
    - id: <plugin-id>
      name: '@kangyishuai/dsh-<name>'
```

`id` 是 profile 里的行标识，同一 profile 内唯一，与包名解耦。

---

## 2. host 半（lib/index.js）

导出 `apply(ctx, config)`（Cordis 插件约定），可用 `ctx` 上的宿主服务。常用：

| 服务 | 用途 |
|---|---|
| `ctx.sessions` | 会话注册表；`flush()` 把 live 状态落盘 |
| `ctx.sessionPersistence` | 持久化 seam；`stat(id)` 读日志体积等元信息。**没有删除接口** |
| `ctx.workspaceRegistry` | 工作区注册表；`archiveSession(id, { stopActivity })`、`unarchiveSession(id)`、`detachSession(id)`、置顶/排序 |
| `ctx.logger` | 日志（`warn` / `info` / `error`） |

**重要**：持久化与存储 seam 都**不提供删除 API**（官方明确「剪枝已存储会话属于带外后端维护」）。需要真删时只能自己操作文件系统，并自行清理三处引用：归档集合、工作区归属、投影缓存。

### 会话在磁盘上的位置

```
~/.dsh/sessions/<workspace-key>/<session-id>/
    session.lock              # 写入方排他锁（flock）
    session.v4.jsonl.zstd     # 会话日志，vN 中的 N 是格式版本，会随 DSH 升级变化
~/.dsh/storages/workspace.json        # archivedSessionIds / pinnedSessionIds / workspaceIds
~/.dsh/storages/session_projcache/    # 投影缓存 checkpoint
```

---

## 3. client 半（lib/client.js）

**无需打包器**。这是一段以 classic script 原样下发的代码，注册一个 factory：

```js
window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-<name>",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    // 所有副作用（含 React.createElement）都写在这里面

    exports.inject = ["slots", "locale", "connection"];
    exports.apply = function apply(ctx) {
      // ctx.slots.inject("<slot-name>", () => ctx.slots.register({ ... }))
    };
  },
});
```

### 已验证可用的 slot（0.2.1-rc.5）

| slot | 形态 | 用途 |
|---|---|---|
| `sidebar.workspaces.session.menu.item` | list | 会话行 "…" 菜单项 |
| `sidebar.workspaces.session.row.action` | list | 会话行尾部悬停按钮 |
| `sidebar.session.row.leading` | list | 行首图标（仅 idle 时渲染） |
| `sidebar.session.row.hover` | list | 行悬停卡片 |
| `shell.overlay` | single | 全局浮层（确认框等） |

**内置 action 的 order**（决定你的条目插在哪）：`pin` 100、`rename` 200、`fork` 300、`archive` 400（菜单）、`session-id` 450。想排在 Archive 之后、Copy ID 之前，取 `order: 420`。

**坑**：菜单项会随菜单一起卸载，所以确认框必须注册到 `shell.overlay`，由菜单项发出请求，不能用菜单内的局部状态。

---

## 4. 命名

| 位置 | 规则 | 例 |
|---|---|---|
| npm 包 | `@kangyishuai/dsh-<name>` | `@kangyishuai/dsh-session-delete` |
| 目录 | `<name>`（不带 `dsh-` 前缀） | `packages/session-delete` |
| cordis 行 id | kebab-case | `session-delete` |
| locale 命名空间 | camelCase | `sessionDelete` |

裸名（如 `dsh-session-delete`）已被社区占用多个，务必用 scope。

---

## 5. 版本与兼容性

- 本仓库目标运行时 **0.2.1-rc.5**。预发布版本下 semver 范围匹配不可靠：`^0.2.0-rc.2` 严格来说**不包含** `0.2.1-rc.5`。
- 因此：**先不声明** `engines.dsh`，也先不在 `peerDependencies` 里写 `@deepseek-ai/dsh-*` 的范围。等验证稳定后再加精确约束。
- 装进 profile 时若出现 `incompatible-version` 拒绝，用 `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <runtime> --accept-risk` 授权（了解风险后再做）。

---

## 6. 测试与验证

- 单元测试：`node --test`（无需框架）
- 真实验证：`dsh plugin --profile desktop add "link:$PWD/packages/<name>"` → 重启桌面版 → 在 GUI 里手动点一遍
- 验证后可以 `dsh plugin --profile desktop remove <name>` 卸掉，再 `add` 正式版

---

## 7. 已勘察的坑位（持续补充）

1. client 半改动不是 HMR：**要刷新页面**才能看到。
2. 直接 `import('@deepseek-ai/dsh-*')` 在仓库外单独跑会 `ERR_MODULE_NOT_FOUND`——这些 peer 由宿主在启动时通过 runtime resolution 注入，属于正常现象。
3. `desktop` profile 由 Electron 独占管理：`dsh --profile desktop --dump-config` 会被拒绝，但 `dsh plugin --profile desktop add/remove` 正常工作。
4. 想在装之前验证组合是否正确，可以复制一份 profile 成自定义名字再 `--dump-config`（Electron 只管 `desktop` 这个名字）。
