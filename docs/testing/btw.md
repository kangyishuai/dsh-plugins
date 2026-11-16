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
