# @kangyishuai/dsh-artifacts

## 0.2.3

### Patch Changes

- [#380](https://github.com/kangyishuai/dsh-plugins/pull/380) [`483e815`](https://github.com/kangyishuai/dsh-plugins/commit/483e8151a7867aff613bfa967b5cba0fa2787f8d) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 插件身份（U1-01/U1-19）：8 个包在 `locale/en.json`、`locale/zh.json` 根对象新增 `meta.title` / `meta.description`（英文短描述 + `scripts/index-meta.json` 的中文描述），并用 `"./locale/*.json": "./locale/*.json"` 通配把 locale 目录加进 `exports`（宿主经 Node 解析器读 locale，通配能覆盖未来新增语言，漏文件会让整套 meta/icon 丢失），让「插件 → 已安装」不再只显示 npm 包名 + 英文长描述；每个包新增自绘 `icon.svg`（36×36、透明背景、无文字），在 `package.json` 顶层 `icon` 声明并加入 `files`，8 个插件的图标互不相同。`scripts/check-plugins.mjs` 新增对应机械检查（exports 通配/覆盖、locale 身份与索引源一致、icon 存在/白名单/体积/文件头）。已在 DSH 0.2.2-rc.5 隔离桌面实例实测（暗色主题、中文界面），并用真实 `readPluginMeta()` 复核 8/8 无 error。

## 0.2.2

### Patch Changes

- [#360](https://github.com/kangyishuai/dsh-plugins/pull/360) [`897c3c7`](https://github.com/kangyishuai/dsh-plugins/commit/897c3c734ee72c85001b7dfb16797b1ceafebb90) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 修复 artifacts 审计修复批次（P1 并发完整性 + P2 时间线 + P3 安全/路由硬化），契约方法集与错误码不变。
  
  - **并发写不再静默损坏（AUD-ARTIFACTS-02，P1）**：版本文件改为唯一临时名 + 用 `O_EXCL` 独占创建 `vN.<ext>` 抢占版本号，同一 id 的写路径（append/archive/remove/restore/purge）在**同一进程内**串行化；同一 id 的并发 `append` 各拿各的版本，不再互相覆盖或用同一个 `.tmp` 写坏内容。`read()` 现在核对 `meta.json` 记录的 `bytes` / `sha256`：不一致（含版本文件缺失）时报 `artifacts/failed` + 可选细分原因 `reason: "corrupt-version"`，HTTP 路由回 `500 artifact version corrupted`，绝不把坏内容当最新版送出。旧 meta 没有可核对摘要时按只读处理，不误判。跨进程只保证字节不被覆盖，`meta.json` 仍是最后写者赢（已知边界，见 README）。
  - **时间线行支持中文 id（AUD-ARTIFACTS-01，P2）**：id 解析从 ASCII 正则改为「行首 `artifact ` 到 ` · `」切片 + 与 id 生成同源的边界校验，`q3-报告-2026` 这类保留中文的 id 能正确显示并打开（修复前显示「（未识别 id）」、按钮打开的是工件库）。`list` / `read` 调用保留一行紧凑中性行（`Artifact 列表 · 3 项` / `Artifact 读取 · <id> [vN]`，失败时 `失败 · …`），不再返回空：宿主 `tool.call.toolview` 是 keyed 替换点，返回空会让整张工具卡（含失败信封）在时间线消失。中性行没有预览按钮，也不发 RPC。
  - **面板预览硬化（AUD-ARTIFACTS-03，P3）**：html iframe 改为**完全沙箱**（`sandbox=""`，去掉 `allow-scripts`），并在**任何产物字节之前**（DOCTYPE 之后或文档开头）注入文档级 CSP：`default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'`。脚本不可能执行；即使产物在注释/属性/脚本字符串里伪造 `<head` 也无法让 CSP 失效。内联样式与 `data:` 图片照常显示（无脚本时 `blob:` 不可达）。HTTP 路由的 CSP 保持不变。
  - **路由错误语义（AUD-ARTIFACTS-04 / 05，P3）**：畸形百分号编码的 id → `400`（修复前是 `500` 且把内部错误文本写进响应体）；`?v=` 存在但不是**规范**正整数（前导零 / 小数点 / 空白也算）→ `400`（修复前静默回落最新版）；其它内部错误 500 只回通用文案。
  - **崩溃残骸行（AUD-ARTIFACTS-07，P3）**：`create()` 改为先落 v1 再写 meta；`scan()` / `list()` 跳过 `latest === 0` 且没有版本的残骸目录并告警，旧数据里已经产生的残骸也不再出现在列表里。
  - **破坏性操作的影响面体积（AUD-ARTIFACTS-08，P3）**：`archive` / `remove` / `restore` / `purge` 返回的 `bytes` 改为**所有版本体积之和**（即"实际会移动/删除的字节"，与 `totalBytes` 同口径），不再只算最新版；行与 `summary` 的 `bytes` 仍是最新版口径。这是一处语义修正（0.2.x 补丁级），原本按"最新版"理解 `remove.bytes` 的调用方请改用行/`summary` 的 `bytes`。
  - **复审 F6 / F7 / F12 / F13 顺带修复**：`latest.versionSource` 改为按版本号查记录（跳号时不再静默丢来源）；`purge` 与 `restore` 共用同一把回收站条目锁（并发"恢复 + 清空"不会双成功或撞 ENOENT）；`scripts/smoke-artifacts.mjs` 补一条"srcDoc 含 CSP、sandbox 无 allow-scripts"断言（本批未运行，冒烟计数 11 → 12）；`exports.__test` 注明只测试用、生产无副作用。
  - **接口新增可选字段**：失败信封里的 `reason`（目前只有 `"corrupt-version"`），属于 §8.6 允许的可选附加字段，按 `code` 降级的既有调用方无需改动。

- [#376](https://github.com/kangyishuai/dsh-plugins/pull/376) [`7445d66`](https://github.com/kangyishuai/dsh-plugins/commit/7445d665a7d050eb744c31f79247afdad355b521) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 工件库的类型筛选行允许换行（`flexWrap`）：窄窗口/窄右栏（如 1280 宽桌面窗口）下「全部/html/markdown/json/csv/image」不再被推出视口，刷新/搜索仍可用（USIM-U3-12）。

## 0.2.1

### Patch Changes

- [#331](https://github.com/kangyishuai/dsh-plugins/pull/331) [`6031d9a`](https://github.com/kangyishuai/dsh-plugins/commit/6031d9a645b1dee05208aa6c61bee276dc834683) Thanks [@kangyishuai](https://github.com/kangyishuai)! - 产物面板补可访问性：搜索框 `aria-label`、类型筛选按钮 `aria-pressed`（选中态现在可被读屏读出）。

## 0.2.0

### Minor Changes

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - feat(artifacts): library 0.2 — attribution + provenance, five kinds, filtering/metering, cascade cleanup, cross-plugin contract
  
  - **Attribution & provenance.** `meta.json` gains optional `projectId` / `sessionId` / `threadId` and a `source` block (`sessionId` + `toolCallId`); the `artifact` tool derives `sessionId` / `toolCallId` from the tool-call context and writes the creator on the artifact plus each version's own source. Older `meta.json` files without these fields keep working unchanged (read as HTML, no owner).
  - **`artifacts/list` filters.** `{ projectId, sessionId, threadId, kind, title, since, until, includeArchived, onlyArchived, limit }`, conditions AND-ed; no arguments still means "everything". It also returns `summary: { count, bytes, byProject[] }` for storage metering.
  - **Five kinds.** `html` (default) plus `markdown` / `json` / `csv` / `image`, stored as `vN.<ext>`; images are accepted as a `data:` URL or bare base64, stored as raw bytes, and served with the matching MIME type (no UTF-8 round-trip). The 2 MiB limit and tmp+rename write are unchanged; `latest` / list rows / covers all carry `kind`.
  - **Cascade cleanup following ADR 0002.** New Remotes `archive`, `remove`, `restore`, `trash`, `purge`: `remove` moves artifacts to `artifacts-trash/` instead of deleting them, every call supports `dryRun: true` to report count/bytes/ids first, and archived artifacts stay readable but refuse new versions.
  - **Stable cross-plugin contract.** New `artifacts/version` probe and `artifacts/2` contract documented in `docs/plugin-conventions.md` §8 (method names, parameter schemas, row shape, error codes, `ctx.get("artifacts")` / `rpc.call("/api", "artifacts/list", …)` entry points, degradation checklist). Other plugins must not read this plugin's storage directory.
  - **Sidebar library.** The `artifact` tab now renders a list view (thumbnail, title, kind, version, size, project, time) with a count/size summary, title search and kind filters; it accepts a `projectId` parameter so a project page can open "this project's artifacts" instead of the global grid.

## 0.1.0

### Minor Changes

- [#147](https://github.com/kangyishuai/dsh-plugins/pull/147) [`d4a3e95`](https://github.com/kangyishuai/dsh-plugins/commit/d4a3e9570d6ccd244fd653f9466c93915e7302fa) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Initial release: local artifact pages for DSH sessions. One `artifact` tool publishes a self-contained HTML page (publish / append / list / read), the timeline keeps a compact summary row, and the latest version refreshes in place inside a sandboxed right-sidebar panel. Every save is a version file under the DSH data root; a generated SVG cover grid lists them. Nothing is uploaded, and `/artifacts/<id>` serves one version behind the host connection check.
