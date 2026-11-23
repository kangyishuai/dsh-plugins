# artifacts 测试清单

> 目的：证明「工件确实落盘、面板确实原地刷新、旧行确实指向最新版、刷新后确实恢复、路由确实鉴权」，
> 以及 0.2 新增的「归属/来源可追溯、按项目查询、多类型、体积汇总、搜索过滤、删除/归档级联、跨插件契约」。
> 三层：**纯函数/单元测试 → 端到端冒烟 → 界面手测**。前两层每次提交跑；第三层发版与 DSH 升级后必跑。
> 取舍依据：[ADR 0016](../adr/0016-artifacts-local-first.md)、[ADR 0017](../adr/0017-artifacts-update-mechanism.md)、[ADR 0002](../adr/0002-destructive-operations.md)。

## 0. 测试环境（一律临时 `DSH_HOME`）

```bash
# 1) 打包（link: 安装不可用，见 docs/runtime 0.2.1-rc.5 §6.9）
cd packages/artifacts && pnpm pack --pack-destination /tmp

# 2) 隔离 home 并安装
H=/tmp/dsh-test-artifacts
rm -rf "$H" && mkdir -p "$H"
DSH_HOME="$H" dsh plugin --profile web add /tmp/kangyishuai-dsh-artifacts-0.2.0.tgz

# 3) 启动（随机端口、不弹浏览器）
DSH_HOME="$H" dsh --profile web --port 0 --no-open
```

数据落在 `$H/artifacts/<id>/`：`meta.json` + `v1.<ext> … vN.<ext>`（`html` / `md` / `json` / `csv` / 图片）；
删除的工件落在 `$H/artifacts-trash/<id>/`（ADR 0002），`artifacts/purge` 才真正硬删。

## 1. 自动化

| 命令                                            | 覆盖什么                                                                                                                                                                         | 前置                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pnpm --filter @kangyishuai/dsh-artifacts test` | 存储 9 条、封面 10 条、工具 14 条、路由 13 条、契约层 28 条、契约对账 6 条、审计 6 条（共 **86** 条）                                                                            | 无                                      |
| `pnpm verify`                                   | 上面全部 + lint/typecheck/check/check:docs/check:public                                                                                                                          | 无                                      |
| `pnpm smoke:artifacts`                          | 临时 home + 真实宿主 + 浏览器：库 → 面板 → 追加两版 → 原地刷新 → 刷新恢复 → **按 projectId 过滤的库视图** → **markdown/图片预览** → 路由 200/401/404/**400**/封面（**10 PASS**） | 本机 `dsh`、`ego-browser`               |
| `pnpm smoke:artifacts-desktop --require`        | 真实桌面版只读回归：插件已加载、页签类型存在、库能打开且不崩                                                                                                                     | 桌面版 + `--remote-debugging-port=9222` |

> 桌面回归是**发版前手工门禁**：CI 只跑 `pnpm smoke:artifacts`（web、临时 home）。
> 验收桌面时临时安装，验完卸载，不把开发版留在共用 profile：
>
> ```bash
> cd packages/artifacts && pnpm pack --pack-destination /tmp
> dsh plugin --profile desktop add /tmp/kangyishuai-dsh-artifacts-0.2.0.tgz
> open -a "DeepSeek Harness" --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
> pnpm smoke:artifacts-desktop --require
> dsh plugin --profile desktop remove @kangyishuai/dsh-artifacts
> ```

> `pnpm smoke:artifacts` 的浏览器脚本仍按 `data-dsh-artifact-card` / `data-dsh-artifact-cover`（`naturalWidth=320`）等锚点断言，
> 0.2 把封面网格改成"列表 + 缩略图"后这些锚点保持不变；**改名等于拆冒烟**。

### 1.1 artifacts 0.2 九条需求 → 对应测试

| #   | 需求                            | 测试（`test/`）                                                                                                                                     |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 归属元数据 + 旧 meta 兼容       | `library.test.js`「来源可追溯」「旧 meta 兼容：缺 kind / ext / 归属字段照样能读」；`tool.test.js`「归属：sessionId/toolCallId 从 exec 推导」        |
| 2   | `artifacts/list({ projectId })` | `library.test.js`「按 projectId 过滤」「组合过滤」                                                                                                  |
| 3   | 产物来源可追溯                  | `library.test.js`「来源可追溯」（meta.source + `versions[].source` + `latest.versionSource`）                                                       |
| 4   | 多类型（列 + 预览 + kind）      | `library.test.js`「多类型」「图片 PNG 往返」「图片超限/空/未知格式」；`route.test.js` 多类型 Content-Type 与图片原始字节；`tool.test.js` 多类型     |
| 5   | 体积/条数汇总                   | `library.test.js`「汇总口径」「多项目汇总」                                                                                                         |
| 6   | 搜索/过滤组合                   | `library.test.js`「组合过滤 projectId + kind + title + 时间窗 + limit」「kind 支持数组」「sessionId/threadId」                                      |
| 7   | 删除/归档级联（保留只读）       | `library.test.js`「归档：默认隐藏…只读可取消」「级联清理 dry-run」「级联清理只删本项目」「恢复与清空回收站」；`route.test.js` 归档仍可读            |
| 8   | 稳定跨插件契约写进 conventions  | `remote-declarations.test.js`（service 方法集 == declareRemote == 契约表 == [conventions §8](../plugin-conventions.md#8-跨插件调用契约remote-api)） |
| 9   | 面板按 projectId 过滤的列表视图 | `client.js` 的 `ArtifactLibrary`（`data-dsh-artifact-library-scope`）；桌面/冒烟手测（见 §2.6），Node 层无法覆盖 DOM                                |

### 1.3 调试接口（默认关闭）

`client.js` 有一个**默认不挂**的窗口函数，用来从页面上下文"带 params 打开页签"——这是冒烟断言
"按 projectId 过滤的库视图"与多类型预览的唯一入口（正常 UI 没有带 params 的入口）：

- 打开方式（二选一）：`localStorage["dsh-artifacts:debug"] = "1"` 后刷新，或页面 URL 带 `?debug=1`；
- 只有 `window.__dshArtifactsOpenTab`，参数 `{ id? , projectId? }`：

```js
window.__dshArtifactsOpenTab({ id }); // 打开某个工件
window.__dshArtifactsOpenTab({ projectId }); // 打开该项目的库视图
```

它只转发页签导航（`openTab`），**不暴露数据、不暴露服务**；发布包默认没有任何 `window.__dsh*` 全局，
生产 UI 不依赖它。`scripts/smoke-artifacts.mjs` 开头会写 `localStorage` 并重载一次来打开门禁，
两条新断言用它；面板 params 的正式约定见 `docs/plugin-conventions.md` §8.5。

### 1.2 不启宿主、跑一遍跨插件契约（可复制）

```bash
cd packages/artifacts
node --input-type=module -e '
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "./lib/store.js";
import { createArtifactLibrary } from "./lib/library.js";
const root = await mkdtemp(join(tmpdir(), "artifacts-probe-"));
const store = createArtifactStore({ root });
const lib = createArtifactLibrary({ store });
const meta = await store.create({
  title: "probe", kind: "markdown", content: "# hi", projectId: "p1", sessionId: "s1",
  source: { sessionId: "s1", toolCallId: "call-1", via: "tool" },
});
console.log("version:", JSON.stringify(await lib.version()));
console.log("list:", JSON.stringify(await lib.list({ projectId: "p1" })));
console.log("dry-run:", JSON.stringify(await lib.remove({ projectId: "p1", dryRun: true })));
console.log("live:", JSON.stringify((await lib.list()).artifacts.length));
console.log("trash:", JSON.stringify((await lib.trash()).artifacts.length), meta.id);
'
```

预期：`version.contract === "artifacts/2"`；`list` 只返回 `p1` 且 `summary.byProject[0].projectId === "p1"`；
`dry-run` 的 `count === 1` 且磁盘没动：`live` 仍是 1、`trash` 是 0。

## 2. 界面手测（发版 / 升级后）

1. **发布**：在新会话里对模型说「用 artifact 工具发布一个标题为 X 的页面，内容 `<h1>v1</h1>`」→ 时间线出现一行 `Artifact <id> html 最新 v1 [打开预览]`，不出现大段 HTML。
2. **追加**：让模型再 append 两次 → 行数增加（每次调用一行），每行都显示「最新 v3」。
3. **面板**：点任意一行的「打开预览」→ 右栏出现面板，header 显示标题 / `html` / `v3` / 字节数；iframe 渲染 `<h1>v3</h1>`；**旧行与最新行打开的是同一个最新版**。
4. **原地刷新**：面板打开时再 append 一版 → 版本号变化、iframe 不闪不重建（同一元素）。
5. **刷新恢复**：刷新页面 → 之前打开的页签仍在，显示最新版；若页签被恢复但参数丢失，应回退到"上次打开的工件"，不得出现空白错误态。
6. **库（0.2 起是列表视图）**：右栏页签的添加入口 → 「Artifacts」→ 列表：每行有缩略图（`naturalWidth=320`）、标题、类型、`vN`、字节、项目 id、更新时间；顶部有 `n 条 · X KiB` 汇总；搜索框按标题过滤，类型按钮按 `html/markdown/json/csv/image` 过滤；点行打开面板，`‹` 返回库。
7. **多类型预览**：让模型用 `kind: "markdown"` / `"json"` / `"csv"` 各发布一个 → 面板显示 `<pre>` 文本；用 `kind: "image"` + data URL 发布 → 面板显示图片；三者都能在库里列出并显示类型。
8. **项目过滤视图（需求 9）**：在页面 console 执行 `window.__dshArtifactsOpenTab({ projectId: "<id>" })`（见 §1.3）→ 右栏 `artifact` 页签变成库视图，`data-dsh-artifact-library-scope` 等于项目 id，行只含该项目产物；没有产物时显示「这个项目还没有产物。」。正式入口是 projects 0.13 项目页的「产物」，它用同一组 params 打开。
9. **路由**：浏览器打开 `http://127.0.0.1:<port>/artifacts/<id>` → 有内容；未登录/无 token 访问应为 401；未知 id 404；`?v=1` 返回第一版；`?download=1` 变成附件下载；图片 URL 返回 `image/png`。
10. **级联清理**：调用 `artifacts/remove`（先 `dryRun: true`）→ 只移走该项目的产物，别的项目原样；`artifacts-trash/` 里能看到；`artifacts/restore` 能恢复；`artifacts/purge` 之后目录消失。
11. **降级**：在 `headless` profile 里装同一包 → 能启动、无报错、工具可用（`url` 省略）。

## 3. 每次提交的最小集

```bash
pnpm --filter @kangyishuai/dsh-artifacts test
pnpm verify
```

## 3.1 已知缺口 / backlog（本批不做）

| 项                   | 说明                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| i18n                 | 插件 UI 文案（含 0.1.0 旧文案）目前是硬编码中文，`locale/` 只放插件标题；**本批明确不做 i18n**，需要整批搬进 `ctx.locale.register` 词典 |
| `latest` 全量读      | 轮询每次都 `readFile` 整个版本文件；方向是先读 meta/stat，或加短缓存（大工件 1s 轮询的 I/O）                                            |
| 封面 ETag            | 封面按 id 稳定，可加 `ETag`/`if-none-match`；现在每次重算 SVG                                                                           |
| 列表分页默认 limit   | 现在默认全量扫目录；加默认 limit 属契约语义变更，需契约版本 +1                                                                          |
| 回收站 UI            | `trash`/`purge`/`restore` 只有 Remote，没有面板入口（ADR 0002 的"查看/清空"目前是 API 级）                                              |
| 契约对账**反向**校验 | 现在只校验"§8.3 写了 → 源码里存在"；反过来"源码返回了没写进 §8 的字段"没有约束（多返回字段会静默漂移）                                  |

## 4. DSH 升级后额外检查

- `pnpm probe:runtime` 是否仍 PASS（宿主包/API/slot）。
- 右栏页签注册、`tool.call.toolview` keyed 行、`ctx.inject` 取服务的写法是否仍成立。
- 工具上下文里的 `exec.agent.id` / `exec.callId` 是否仍按当前字段名提供（归属与来源靠它们）。
- `window.__dshArtifactsOpenTab` 仍在（冒烟 §1.3 依赖它）。
- 主题 token 快照（`pnpm tokens:host:check`）——面板用的是内联中性色，暂不依赖 token，但封面/iframe 主题后续会用到。
