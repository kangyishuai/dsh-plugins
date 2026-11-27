# @kangyishuai/dsh-artifacts

> 给 DSH 会话加"本地工件页"：模型发布一个自包含 HTML 页面，时间线只留一行摘要，右栏面板原地刷新最新版本。

[English](./README.md)

非官方 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，与 DeepSeek 官方无关。

> **当前状态：机制已验证，库能力已在 web + 桌面验证。** 预览与版本这些行为在临时 `DSH_HOME` 的真实 `dsh --profile web` 上实测过；库能力（项目归属、多类型、过滤、级联清理、跨插件契约）由单测、`pnpm smoke:artifacts`（web，10 条断言）与桌面只读回归（4 条断言，`pnpm gate artifacts`）共同覆盖。验证范围见兼容性表。

## 它做什么

- **一个工具、四个动词。** `artifact` 工具的 `action` 为 `publish`（新工件）、`append`（同一 id 追加版本）、`list`、`read`。正文走 `content`（HTML 也可以用旧参数 `html`），存在 DSH 数据根下，**不上传任何地方**。
- **五种类型、一个库。** `kind` = `html`（默认）/ `markdown` / `json` / `csv` / `image`。文本类型按 UTF-8 落盘、在面板里用 `<pre>` 预览；图片（PNG / JPEG / GIF / WebP / SVG）用 `data:` URL 或裸 base64 传入，按原始字节落盘，经只读路由用 `<img>` 预览。列表行都带 `kind`。
- **归属与来源可追溯。** 每个工件记录调用方给的 `projectId` / `threadId`，以及从工具上下文推导的 `sessionId` / `toolCallId`：`meta.json` 记首次产生它的那次调用，每个版本另记自己的来源，所以能回答"这一版是哪次线程跑出来的"。
- **查询与计量。** `artifacts/list` 支持按项目、会话、线程、类型、标题子串与时间窗过滤（条件 AND），并返回 `summary`：条数、字节、以及按项目的汇总。
- **时间线只放摘要行。** 每次调用渲染成 `Artifact <id> 类型 最新 vN [打开预览]`（`tool.call.toolview` keyed slot），正文不进会话日志。
- **库是列表，不再只有封面网格。** 没有选中工件时：每行一张生成的 SVG 封面（`GET /artifacts/<id>/cover.svg`）当缩略图，加标题 / 类型 / 版本 / 体积 / 项目 / 时间；顶部有 `n 条 · X KiB` 汇总、标题搜索框与类型过滤。页面还接受 `projectId` 参数——别的插件可以打开"本项目的产物"而不是全局库。
- **右栏实时面板。** `artifact` 页签类型渲染最新版：html 用 `sandbox="allow-scripts"` 的 iframe，文本用 `<pre>`，图片用 `<img>`；轮询宿主 Remote `artifacts/latest`，新版本只替换同一个 iframe 的 `srcDoc`，**不重建 iframe**。
- **旧行指向最新版。** 每一行都按 artifact id 打开面板，面板永远读最新版本——所以 v1 时创建的行，在页面更新到 v3 后打开就是 v3。
- **级联清理按 ADR 0002 来。** `artifacts/remove` 移进 `artifacts-trash/`（不是裸 `rm -rf`），`artifacts/restore` 能恢复，`artifacts/purge` 才是显式硬删；`artifacts/archive` 把工件标成只读（版本文件保留、拒绝追加）。每个破坏性调用都支持 `dryRun: true` 先报影响面（条数 / 字节 / ids）。
- **只读 URL。** `GET /artifacts/<id>[?v=N][&download=1]` 在宿主连接鉴权之后返回某个版本，带 `Content-Security-Policy`、`nosniff`、`no-store`；`download=1` 变成附件下载。

## 给其它插件用的库接口

`artifacts` 同时是一个服务：别的插件通过**带版本的 Remote 契约**读产物，而不是去读本插件的存储目录。

- host 半：`ctx.get("artifacts")` → 返回 `undefined` 就是"没装"（降级并明示，别把空列表当成"没有产物"），然后调 `list` / `latest` / `version` 等；
- client 半：`ctx.connection.rpc.call("/api", "artifacts/list", { args: { request: { projectId } } })`；
- 契约版本：`artifacts/2`，用 `artifacts/version` 探测。

方法名、参数 schema、行形状、错误码与降级清单见 [docs/plugin-conventions.md §8](../../docs/plugin-conventions.md#8-跨插件调用契约remote-api)。

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-artifacts
```

装完重启 DSH 桌面版。web profile 用 `dsh plugin --profile web add @kangyishuai/dsh-artifacts`，然后刷新页面。

## 副作用与风险

- **会写文件。** 每个工件一个目录 `<数据根>/artifacts/<id>/`，内含 `meta.json` 与每个版本一个 `vN.html`。数据根依次取 `config.dataRoot` → `$DSH_HOME` → `~/.dsh`。删目录即删工件；id 带随机后缀，删掉的 id 不会被复用。
- **注册一条 HTTP 路由。** 宿主 web server 上的 `/artifacts/`：拒绝未认证请求、只接受 `GET`/`HEAD`、不提供目录列表。
- **会渲染模型写的 markup。** 预览 iframe 不带 `allow-same-origin`，路由发 `default-src 'none'` 且只允许内联样式。页面脚本只在该沙箱里跑；工件内容按不可信数据处理，和模型的其它输出一样。
- **无外联、无遥测、无 install 脚本。**

## 共享与局域网

工件是**本地**的：URL 是 `http://127.0.0.1:<端口>/artifacts/<id>`，由持有数据的 DSH 宿主提供。本插件不提供"一键局域网共享"，在给出显式开关之前也不会提供——宿主无法只暴露单条路由：

- **桌面版不能绑定局域网地址。** 它的 host 子进程不接受 `--host`，`dsh-app://app/*` 只向 loopback 转发并附带 host cookie。0.2.2-rc.3 实测：`lib/main.js` 里完全没有 `--host` / `--trusted-host` 的处理。
- **`--host` 属于 web profile。** `dsh --profile web --host <局域网 IP>` 只绑定一个具体的本机接口，并且暴露的是**整个 GUI**——所有 `/api` 路由、所有插件路由，以及本插件的 `/artifacts/`。`--public-url` 只改对外广告的地址、不授予任何信任，通配地址会被拒绝。让别人访问之前请自行加 `--trusted-host`、反向代理与 `--tls-cert/--tls-key`，并把它当作你自己的安全决策。

需要给别人看时，优先走这三条：

1. **导出单文件**（默认、最安全）：自包含 HTML，任何渠道都能发。
2. **你自己的静态托管**（GitHub Pages、对象存储、内网 web 服务器）——访问控制与生命周期由你掌握。
3. **本机反向代理**：网络里已有反代时，转发这条 loopback URL。

不要把工件 URL 当作访问控制边界：路由鉴权的是浏览器会话，不是"某个人"。

## 限制

- 每个版本上限 2 MiB（按真实字节算，不按 base64 字符数）；没有后端、没有共享、没有评论。HTML 页面的 URL 带 `script-src 'none'`，可交互预览只在面板里；markdown / CSV 以 `text/plain` 送出，浏览器直接预览而不是下载。
- 工件的类型在创建时固定：`append` 必须同类型（不同类型会被拒绝，不会悄悄混格式）。
- **界面文案目前只有中文：本插件暂不做 i18n。** `locale/` 里只有插件标题；把全部文案搬进 `ctx.locale.register` 是独立一批。`artifact` 工具描述与所有接口字段是英文。
- 面板可见时每秒轮询一次；推送通道属于后续优化。
- 刷新后恢复的侧栏页签目前会丢导航参数，面板显示空态，需重新打开。已记录在调研笔记里。

## 兼容性

| 插件  | 验证过的 DSH | 说明                                                                                                                                                                     |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.0.0 | 0.2.2-rc.3   | 预览/版本机制                                                                                                                                                            |
| 0.2.0 | 0.2.2-rc.5   | `pnpm smoke:artifacts` 10/10（web，临时 `DSH_HOME`）；`pnpm gate artifacts` 全绿——桌面只读回归 **4 PASS**                                                                |
| 0.2.1 | 0.2.2-rc.5   | 仅 a11y 补丁：`pnpm smoke:artifacts` **11/11**（web，含搜索 label 与筛选 `aria-pressed` 断言）；桌面只读回归 **4 PASS**（0.2.0 已验证；0.2.1 差异只在 client 半的 a11y） |

## 许可证

MIT
