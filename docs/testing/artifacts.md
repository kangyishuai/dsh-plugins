# artifacts 测试清单

> 目的：证明「工件确实落盘、面板确实原地刷新、旧行确实指向最新版、刷新后确实恢复、路由确实鉴权」五件事。
> 三层：**纯函数/单元测试 → 端到端冒烟 → 界面手测**。前两层每次提交跑；第三层发版与 DSH 升级后必跑。
> 取舍依据：[ADR 0016](../adr/0016-artifacts-local-first.md)、[ADR 0017](../adr/0017-artifacts-update-mechanism.md)。

## 0. 测试环境（一律临时 `DSH_HOME`）

```bash
# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/artifacts && pnpm pack --pack-destination /tmp

# 2) 隔离 home 并安装
H=/tmp/dsh-test-artifacts
rm -rf "$H" && mkdir -p "$H"
DSH_HOME="$H" dsh plugin --profile web add /tmp/kangyishuai-dsh-artifacts-0.0.0.tgz

# 3) 启动（随机端口、不弹浏览器）
DSH_HOME="$H" dsh --profile web --port 0 --no-open
```

数据落在 `$H/artifacts/<id>/`：`meta.json` + `v1.html … vN.html`。

## 1. 自动化

| 命令                                                 | 覆盖什么                                                                                                                                   | 前置                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `pnpm --filter @kangyishuai/dsh-artifacts test`      | 存储 9 条（版本、原子写、上限、数据根）、封面 8 条（转义/色板/折行/体积）、工具 7 条（四动词与错误）、路由 8 条（鉴权/方法/404/封面/异常） | 无                                      |
| `pnpm verify`                                        | 上面全部 + lint/typecheck/check/check:docs/check:public                                                                                    | 无                                      |
| `pnpm smoke:artifacts`（**待补**）                   | 临时 home + 真实宿主 + 浏览器：库 → 面板 → 追加两版 → 原地刷新（元素标记证明未重建）→ 刷新恢复 → 路由 200/401/404                          | 本机 `dsh`、`ego-browser`               |
| `pnpm smoke:artifacts-desktop --require`（**待补**） | 真实桌面版只读回归：插件已加载、页签类型存在、库能打开且不崩                                                                               | 桌面版 + `--remote-debugging-port=9222` |

> 冒烟脚本尚未落地（模板 TODO），这是合并前必须补齐的硬性约定（`docs/plugin-conventions.md` §6.1）。上面两行是脚本应覆盖的断言清单。

## 2. 界面手测（发版 / 升级后）

1. **发布**：在新会话里对模型说「用 artifact 工具发布一个标题为 X 的页面，内容 `<h1>v1</h1>`」→ 时间线出现一行 `Artifact <id> 最新 v1 [打开预览]`，不出现大段 HTML。
2. **追加**：让模型再 append 两次 → 行数增加（每次调用一行），每行都显示「最新 v3」。
3. **面板**：点任意一行的「打开预览」→ 右栏出现面板，header 显示标题 / `v3` / 字节数；iframe 渲染 `<h1>v3</h1>`；**旧行与最新行打开的是同一个最新版**。
4. **原地刷新**：面板打开时再 append 一版 → 版本号变化、iframe 不闪不重建（同一元素）。
5. **刷新恢复**：刷新页面 → 之前打开的页签仍在，显示最新版；若页签被恢复但参数丢失，应回退到"上次打开的工件"，不得出现空白错误态。
6. **库**：右栏页签的添加入口 → 「Artifacts」→ 封面网格；每张封面能加载（`naturalWidth=320`），点卡片打开面板，`‹` 返回库。
7. **路由**：浏览器打开 `http://127.0.0.1:<port>/artifacts/<id>` → 有内容；未登录/无 token 访问应为 401；未知 id 404；`?v=1` 返回第一版。
8. **降级**：在 `headless` profile 里装同一包 → 能启动、无报错、工具可用（`url` 省略）。

## 3. 每次提交的最小集

```bash
pnpm --filter @kangyishuai/dsh-artifacts test
pnpm verify
```

## 4. DSH 升级后额外检查

- `pnpm probe:runtime` 是否仍 PASS（宿主包/API/slot）。
- 右栏页签注册、`tool.call.toolview` keyed 行、`ctx.inject` 取服务的写法是否仍成立。
- 主题 token 快照（`pnpm tokens:host:check`）——面板用的是内联中性色，暂不依赖 token，但封面/iframe 主题后续会用到。
