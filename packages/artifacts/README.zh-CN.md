# @kangyishuai/dsh-artifacts

> 给 DSH 会话加"本地工件页"：模型发布一个自包含 HTML 页面，时间线只留一行摘要，右栏面板原地刷新最新版本。

[English](./README.md)

非官方 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，与 DeepSeek 官方无关。

> **当前状态：机制已验证，功能开发中。** 下面三条行为都在临时 `DSH_HOME` 的真实 `dsh --profile web` 上实测过；驱动验证用的调试钩子还留在代码里，发版前必须删掉。验证范围见兼容性表。

## 它做什么

- **一个工具、四个动词。** `artifact` 工具的 `action` 为 `publish`（新页面）、`append`（同一 id 追加版本）、`list`、`read`。正文走 `html` 参数，存在 DSH 数据根下，**不上传任何地方**。
- **时间线只放摘要行。** 每次调用渲染成 `Artifact <id> 最新 vN [打开预览]`（`tool.call.toolview` keyed slot），页面正文不进会话日志。
- **封面网格。** 没有选中工件时，页签显示「全部工件」：每张卡片配一张生成的 SVG 封面（`GET /artifacts/<id>/cover.svg`），含标题、按 id 取的色板、首屏标题作副标题、版本与体积。不依赖 headless 渲染器，没有常驻进程。
- **右栏实时面板。** `artifact` 页签类型在 `sandbox="allow-scripts"` 里渲染最新版，并轮询宿主 Remote `artifacts/latest`；新版本只替换同一个 iframe 的 `srcDoc`，**不重建 iframe**。
- **旧行指向最新版。** 每一行都按 artifact id 打开面板，面板永远读最新版本——所以 v1 时创建的行，在页面更新到 v3 后打开就是 v3。
- **只读 URL。** `GET /artifacts/<id>[?v=N]` 在宿主连接鉴权之后返回某个版本，带严格 `Content-Security-Policy`、`nosniff`、`no-store`。

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

- 单页、HTML 上限 2 MiB；没有后端、没有共享、没有评论。路由只发静态 markup（`script-src 'none'`），可交互页面在面板里预览，不通过 URL 提供。
- 面板可见时每秒轮询一次；推送通道属于后续优化。
- 刷新后恢复的侧栏页签目前会丢导航参数，面板显示空态，需重新打开。已记录在调研笔记里。

## 兼容性

| 插件  | 验证过的 DSH |
| ----- | ------------ |
| 0.0.0 | 0.2.2-rc.3   |

## 许可证

MIT
