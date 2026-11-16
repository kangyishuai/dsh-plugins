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
