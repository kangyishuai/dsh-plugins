# 插件索引源的测试与发布

索引源不是一个插件包：它是一份 **format 1 的 JSON**，由 `scripts/build-index.mjs` 生成、由 `.github/workflows/index.yml` 在发版后发布成 npm 数据包 `@kangyishuai/dsh-plugin-index`，用户把它加进 **插件 → 发现 → 添加索引源**。格式与实测坑位见 [docs/runtime/0.2.2-rc.3.md §9](../runtime/0.2.2-rc.3.md#9-插件索引源discover格式与实测坑位)，取舍见 [ADR 0015](../adr/0015-plugin-index-source.md)。

线上地址（唯一需要告诉用户的地址）：

```
https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json
```

## 1. 自动化

| 命令                                                                   | 覆盖什么                                                                                                                                                                                                                                    | 前置                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `node --test scripts/test/index-build.test.js`（`pnpm test` 的一部分） | 生成器与校验器的离线单测：预发布/stub/无发布时间被排除、版本降序、`repository` 转换、meta 双向一致、图标内联/校验（8 个正常、缺文件、超限、坏 SVG、非法 data URL）、宿主会拒的形态                                                          | 无                              |
| `pnpm check` / `pnpm check:index`                                      | `scripts/index-meta.json` 与 `packages/` 双向一致；每个正式插件的图标文件（`package.json#icon`，默认 `icon.svg`）能内联成宿主接受的 data URL（反解后 sha256 与本地一致）；`build/index.json` 存在时校验结构、双向核对条目并逐条核对图标字节 | 无                              |
| `pnpm index`                                                           | 从 npm registry 现场生成 `build/index.json`（不提交）                                                                                                                                                                                       | 联网                            |
| `pnpm smoke:index`                                                     | 真机端到端：临时 `DSH_HOME` + 真实宿主 + 真实「发现」页；加 `SMOKE_INDEX_URL=<url>` 则直接验**线上**索引源                                                                                                                                  | 本机 `dsh`、`ego-browser`；联网 |

`pnpm smoke:index` 的 13 条断言（2026-11-20 在 0.2.2-rc.5 上 **13/13 PASS**；rc.3 那轮是 12 条）：

两种索引来源，断言同一套：

- 默认：`build-index.mjs` 从 npm registry 现场构建，本地 http 服务喂给宿主（验生成器产物）；
- **线上**：`SMOKE_INDEX_URL=https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json pnpm smoke:index`
  直接验 jsDelivr 上的真实索引（发版后用它验证 registry → CDN 整条链路）。
  标题与「默认版本」都从**当前索引文档派生**（线上会随时间前进，写死版本号会在发版后误报）；
  坏索引仍由本地服务提供（格式错乱只用于拒收断言）。2026-11-20 线上模式实测 **13/13**（索引 8 个插件）。

1. 页面可交互；
2. **首启「预览版说明」已关闭**（不挡发现页；rc.5 复核新加，见下面的两个坑）；
3. 侧栏能打开「插件」页（有「已安装」「发现」两个页签）；
4. 发现页有空状态与「添加索引源」入口；
5. 索引源对话框能填 URL；
6. **坏索引被宿主拒收**（把 `versions[0].version` 改成 `1.0`，要求页面出现「此索引的格式无效」）；
7. 索引标题出现在发现页；
8. 4 个代表插件（session-delete / session-rewind / next-step / advisor，索引共 8 个）都在列表里；
9. 分类 pill 有 会话 / 工作流 / 工具；
10. 卡片展示的默认版本与索引里读到的一致（脚本从索引现场取，不写死）；
11. 搜索 `rewind` 只剩「会话回滚」；
12. 条目详情页有安装入口与来源事实；
13. 详情正文来自 README。

### 两个坑（2026-11-20 在 rc.5 上实测暴露）

1. **临时 profile 会继承真实 profile 的索引源。** 冒烟从 `~/.dsh/profiles/desktop` 复制 profile，而真实 profile 的
   `cordis.patch.yml` 里可能已经有 `- id: plugin-market` + `config.indexes`（用户自己加过索引源）。
   继承下来后「发现页空状态 / 添加索引源」两步全部错位：URL 被填进了**搜索框**，后面 5 条断言连环红。
   现在复制后会整条删掉 `plugin-market` 行，交给 market bundle 用默认配置挂载。
2. **首启「预览版说明」比第一次点击晚一拍出现。** 只在页面刚加载时点一次「继续」会漏关，
   弹窗盖住发现页，后续交互全错位。现在用 `dismissNotice()` 轮询到它真正消失，并单独断言。

这两条都不是宿主变化（`dsh-client-ui-plugin-market` / `dsh-plugin-market-index` rc.3→rc.5 逐字节相同），
是脚本对环境（用户 profile 状态、首启时序）的假设过强。

排障开关：`SMOKE_DEBUG=1` 打印浏览器脚本完整输出；`SMOKE_KEEP=1` 保留临时目录（`host.log`、生成的 `index.json`、截图）。冒烟**从不等**安装完成，也不发起模型调用。

### 发现页图标（来自索引的 `icon`，2026-11-28）

「已安装」页的图标来自插件包 `package.json` 顶层 `icon`（文件路径，默认 `icon.svg`，也可以是 png/jpeg/webp）；**「发现」页不读包内文件**，
只读索引条目的 `icon` 字段。所以只把图标文件放进包里，发现页仍是通用图形——必须重建索引（`index.yml`）。

- **宿主规则**（随包源码 `app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/src/index.ts` 的 `icon()`）：
  `icon` 可选；内联形态**只接受 base64** 的 `image/svg+xml|png|jpeg|webp` data URL，解码后 **≤32 KiB**
  (`MAX_INLINE_ICON_BYTES`)；URI 编码的 data URL 会让整份索引被拒收；非 data URL 按索引 URL 解析，
  必须解析到 https 或与索引源同源。发现页用 36px 渲染（48px 帧），**加载失败静默回退通用图形**，
  所以坏图标只能靠生成器与 `--check` 提前拦。
- **生成器**：`scripts/build-index.mjs` 按 `package.json#icon` 找图标文件（默认 `icon.svg`，也支持
  png/jpeg/webp 并按扩展名校验文件头），内联成 `data:<mime>;base64,…` 写进条目 `icon`——跟着宿主的
  顶层 `icon` 走，避免某插件以后换 png 时「已安装」与「发现」两个页面的图不一致。
  8 个图标源文件合计 **5 412 B**；索引内 data URL 合计 **7 440 B**（其中 base64 载荷 **7 232 B**，
  其余是 8 个 `data:image/svg+xml;base64,` 前缀）；`build/index.json` **15 019 B → 22 539 B**
  （均含末尾换行）。单个图标解码后超过 32 KiB 或文件头与扩展名不符都直接报错，不生成索引。
- **离线防线**：`pnpm check:index` / `pnpm check` 会
  1. 校验每个正式插件（登记进 `scripts/index-meta.json` 且版本非 `0.0.0`）都有可内联的图标文件
     （`package.json#icon`，默认 `icon.svg`）
     （`0.0.0` 脚手架只告警：模板已自带占位 `icon.svg`，发版前要换成该插件自己的图）；
  2. 把内联 data URL 反解，按 sha256 与本地文件比对（不依赖 `build/index.json` 是否存在）；
  3. 若 `build/index.json` 存在，再双向核对条目（索引多出的 ghost 插件也报错）、核对图标存在、可解码、
     与本地图标文件字节一致——
     读不到、缺图标或内容不一致都让 check 退出码非 0。
     单测见 `scripts/test/index-build.test.js` 的「索引图标」段：8 个正常且互异、缺 icon 文件、超 32 KiB、
     坏文件头（SVG/PNG）、非法 data URL（URI 编码/非 base64/长度非 4 倍数/坏 payload）、同长度内容改动、
     索引缺图标/ghost 条目/内容过期、0.0.0 脚手架豁免、模板占位图标告警、`package.json#icon` 推导（含 png）。
- **【实测】2026-11-28 隔离桌面实例（CDP 9417，profile 复制自 live、只把 `plugin-market` 的索引源换成
  `http://127.0.0.1:…/index.json`）**：发现页 8 张卡片的 `<img src>` 与本地索引条目的 `icon` 逐字节相同，
  `naturalWidth×naturalHeight = 36×36`，8 个图标互不相同；点进条目详情页头部也显示同一个图标。
  这证明宿主接受本生成器的 data URL 且按 36px 渲染（此前线上索引没带 icon，卡片是通用图形）。
- **本地真机验证（发版前）**：`pnpm index` 生成 `build/index.json` → 用本地 http 服务把它作为索引源
  （隔离 profile 的 `plugin-market` 配置或发现页「添加索引源」）→ 打开「插件 → 发现」，确认 8 张卡片
  图标互不相同、不是通用图形。注意索引源 URL 必须 http(s)、不带 query/fragment。
- **发布后才对用户生效**：`index.yml` 在 Release 后重建并发布 `@kangyishuai/dsh-plugin-index`；之后按
  [§2](#2-发版后要确认什么) 的清单核对。本地 `build/index.json` 不会改变用户已配置的线上索引源。

## 2. 发版后要确认什么

`.github/workflows/index.yml` 由 `release: published`（每个包一条 Release）触发，依次做：

1. `node scripts/build-index.mjs --out dist/index.json`；
2. 与 npm 上已发布版本的 `index.json` 逐字节比较，相同就跳过（一次发版会触发多条 Release，只有第一条真正发布）；
3. 发布 `@kangyishuai/dsh-plugin-index`（版本 `0.0.<run_id>`）；
4. purge jsDelivr 缓存；
5. 从 CDN 取回 `index.json`，用 `node scripts/build-index.mjs --check` 验证，并把**全部**插件与版本打进 job summary。

发版后人工核对（一次即可，约 1 分钟）：

- [ ] Actions 里 `Plugin index` 最近一次是绿的，summary 里有全部插件（当前 8 个）和正确版本；
- [ ] `curl -s https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json | head -c 200` 返回 JSON（不是 404）；
- [ ] 真实桌面版：**插件 → 发现**，切换索引后卡片上的版本等于刚发的版本；
- [ ] 真实桌面版：**插件 → 发现**，8 张卡片各有自己的图标（互不相同、不是通用图形）——图标只来自索引，
  本地 `build/index.json` 不会改变用户已配置的线上索引源；CDN 滞后时先用固定版本 URL 核对；
- [ ] 点一张卡进详情页，**安装**按钮可用（不要真装，除非是在临时 profile 里）。

**CDN 滞后（2026-11-21 实测）**：`index.json` 的 `cache-control` 是 `max-age=604800, s-maxage=43200`，
workflow 里的 purge 之后仍可能有约 20 分钟的边缓存。`dsh-next-step@0.4.3` 发布（02:08）后立刻
`curl` 文档里的 `@latest` URL 拿到的还是 0.4.2，02:35 才可见。要**立刻**验证「发布本身对不对」，
用固定版本 URL（`.../@kangyishuai/dsh-plugin-index@0.0.<run_id>/index.json`）或
`SMOKE_INDEX_URL=<固定版本 URL> pnpm smoke:index`；验线上 `@latest` 则等缓存过期再跑。
另外 `npm view <pkg> version` 也会读到本地 npm 缓存，别拿它当发布判据——直接查 registry 文档。

## 3. 手工补发（workflow 失败或漏跑时）

```bash
node scripts/build-index.mjs            # 生成 build/index.json
# 检查内容：8 个插件、每个版本的 publishTimestamp 都是刚发的时间
cat build/index.json | head -c 400
```

然后在 Actions 里手动跑 `Plugin index`（`workflow_dispatch`），或：

```bash
gh workflow run index.yml --ref main
gh run watch "$(gh run list --workflow=index.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

它自己会比对内容、发布、purge。不要手工 `npm publish` 索引包——provenance 与版本号规则都在 workflow 里。**合并 PR 后第一件事就是跑它**：在这之前索引包还不存在，那个 URL 是 404。


### 3.1 registry 传播慢导致 workflow 失败（2026-11-22 实测）

`0.9.0` 发版时 `Plugin index` 失败，报：

```
Error: 等不到这些版本出现在 npm（重试 12 次后）：@kangyishuai/dsh-projects@0.9.0（registry 上是 0.8.2）
```

原因是 **npm 元数据与 tarball/CDN 分开传播**：`npm view` 已经有版本号，tarball（和 workflow 读的
packument）却还落后几分钟。原来的等待是固定 `12 × 20s`（共 4 分钟），撞上这次延迟就用完了。

**已改**（`scripts/build-index.mjs`）：指数退避 + 总预算。

| 环境变量                 | 默认                | 含义                                                                 |
| ------------------------ | ------------------- | -------------------------------------------------------------------- |
| `INDEX_VERSION_WAIT_MS`  | `900000`（15 分钟） | 等待总预算；超时才抛错，报错里带**已等秒数**与每个包的 registry 版本 |
| `INDEX_VERSION_DELAY_MS` | `5000`              | 首次等待间隔；之后每次翻倍，封顶 60 秒                               |

日志会持续打印「已等 Ns，下次再等 Ms」，因此从失败日志就能判断是"还没传播完"还是"根本发错了版本"。

**验证方式**（不依赖真实 npm 延迟）：起一个假 registry，让每个包**前两次请求少一个版本**、之后返回真实版本。

- 成功路径：退避若干次后拿到版本，正常写出索引；
- 失败路径：预算耗尽后抛错，报错包含已等时长与各包 registry 上的最新版本。

失败后**不要改代码**，先确认 npm 上版本是否可见（`npm view <pkg>@<ver> version` 与
tarball 的 HTTP 状态），可见后 `gh run rerun <run-id> --failed` 即可。

## 4. 已知边界

- **每个插件只显示默认版本**：卡片上的版本是索引里最高稳定版；更老的版本在条目详情页的 **版本** 列表里（format 1 里我们列出了全部正式版本）。
- **索引没有签名**：条目是索引作者的声明。发现页自己也提示「索引由第三方提供」。别把别人的索引当成安全审查。
- **缓存**：宿主侧 `cacheTtlMs` 默认 10 分钟，读者点「刷新」即可；jsDelivr 侧 12 小时，workflow 发布后会主动 purge。
- **不带版本号的 CDN URL 可能仍发旧内容**（2026-11-22 实测）：npm 已是 `0.9.1`、jsDelivr 的**版本化** URL 也已是 `0.9.1`，
  但不带版本号的 `…/dsh-plugin-index/index.json` 仍返回 `0.9.0`——purge 之后也可能滞后到边缘缓存过期（最长 12 小时）。
  发版后如果用户看不到新版本，先按 `…/index.json?cb=<时间戳>` 击穿缓存自检，再用
  `curl https://purge.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json` 手动清一次。
  workflow 现在会对比线上内容与本次构建，不一致只告警不失败（npm 才是权威）。
- **首次发布会有延迟**：2026-11-15 实测，registry 约 **5 分 21 秒**才可见、jsDelivr 的 `latest` 约 **9 分钟**（第二次 purge 后才 200）。后续发版仍要等 registry，但 CDN 已经认识这个包，通常快得多。
- **灾备 URL**：如果 jsDelivr 不可达，可以把 `build/index.json` 放到任意 https 直链（GitHub raw 对现成文件不跳转，实测 `cache-control: max-age=300`）临时顶上；宿主要求 URL **不带 query/fragment** 且**不跟随重定向**。
- **发现页的图标来自索引条目的 `icon` 字段**（不是包内 `icon.svg`）：生成器已内置 8 个图标（data URL，源文件合计 5 412 B），发版后由 `index.yml` 重建索引才在用户端生效；`icon` 在格式里是可选字段，别人的索引条目没带图标时宿主回退通用图形。详见上文「发现页图标」小节。
- **不写 `engines.dsh`**：发现页因此不会按版本过滤；兼容性以各插件 README 的表格为准。

## 4. 2026-11-28 全插件体检/修复后的当前计数（18:00 复核）

> 来源：2026-11-28 的审计修复与 3 个用户模拟画像修复批次（PR #352–#371）合并后的实测；
> 历史记录保留在各插件文档里，下列是**当前状态**。web 冒烟已在独占 ego 窗口全量复跑（2026-11-28 11:00，8/8 全绿）；桌面只读回归在隔离桌面实例（`--port`）上跑（**8/8 插件 174 PASS / 16 SKIP / 0 FAIL**，每插件重启后跑）。

| 插件           | 单测（`node --test`） | 桌面只读回归（2026-11-28 复跑） | web 冒烟（2026-11-28 复跑）    |
| -------------- | --------------------- | ------------------------------- | ------------------------------ |
| advisor        | **244**               | 24 PASS / 2 SKIP                | **16/16 PASS**                 |
| artifacts      | **100**               | 4 PASS                          | **12/12 PASS**                 |
| btw            | **125**               | 21 PASS / 1 SKIP                | **24 PASS / 3 SKIP**（默认段） |
| casefile       | **283**               | 26 PASS / 5 SKIP                | **69/69 PASS**                 |
| next-step      | **252**               | 22 PASS / 3 SKIP                | **72 PASS / 2 SKIP**           |
| projects       | **839**               | 24 PASS / 1 SKIP                | **271 PASS / 1 SKIP**          |
| session-delete | **138**               | 18 PASS / 4 SKIP                | **33/33 PASS**                 |
| session-rewind | **300**               | **35 PASS**（含确认框默认聚焦） | **63/63 PASS**                 |

基线命令：`pnpm verify`（lint/typecheck/check/check:docs/check:public/全部单测）+ `pnpm probe:runtime`（**100 项**，见 [runtime §23](../runtime/0.2.2-rc.5.md#23-2026-11-28-第二轮实测能力挂载时序导航调度契约与命令回执)）。

### 插件身份（meta/icon）实测（2026-11-28）

「插件 → 已安装」的标题、描述与图标现在由插件包自己提供：`locale/en.json`、`locale/zh.json` 根对象的 `meta.title` / `meta.description`
（英文 title + 一句英文短描述，中文 title + `scripts/index-meta.json` 的 `descriptionZh`），以及 `package.json` 顶层的 `icon`。
8 个插件在 DSH 0.2.2-rc.5 的隔离桌面实例实测：中文标题、中文短描述、8 个互不相同的图标全部渲染（U1-01/U1-19）。

两个易错点（同一次实测确认，宿主源码路径与结论见 [runtime §23.8](../runtime/0.2.2-rc.5.md#238-插件身份locale-meta-经-exports-解析顶层-icon-不走-exports2026-11-28-实测)）：

- 宿主要通过 Node 的模块解析器读 `locale/en.json`，所以 locale 文件必须能被 `exports` 解析：逐文件显式或
  `./locale/*.json` 通配都行（官方带 `locale/` 的 269 个包全部用通配）；只放进 `files` 不够，解析不到会静默回退成
  npm 包名 + `package.json` 的英文长描述。`dictionariesOf()` 会遍历 locale 目录里**每一个** `.json`，新增语言文件
  漏进 exports 时宿主直接返回 `{error}`，连 title/description/icon 整套都会丢——本仓库 8 包因此改用通配。
- 顶层 `package.json` 的 `icon` 优先于 `./icon` 导出，解析时不走 exports；图标只需留在包目录内并加入 `files`。

`scripts/check-plugins.mjs` 现在机械检查这几条：exports 通配按包内文件 glob 匹配（至少命中 1 个）、locale 目录
每个 `.json` 都被 exports 覆盖、正式插件（已登记索引源且版本非 `0.0.0`）的 `locale/{en,zh}.json` 必须有非空
`meta.title`/`meta.description`、中文身份与 `scripts/index-meta.json` 的 `title.zh`/`descriptionZh` 一致（`descriptionZh`
超过 200 字符时要求截断成它的前缀）、顶层 `icon` 存在且进 `files`、≤256 KiB、文件头是 SVG/PNG/JPEG/WebP。
