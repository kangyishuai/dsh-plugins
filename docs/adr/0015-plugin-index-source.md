# 0015. 自建插件索引源：发版后用 npm 数据包 + jsDelivr 发布 format 1 索引

- 状态：已接受
- 日期：2026-11-15
- 涉及：scripts / ci / repo

## 背景

DSH 0.2.1 起，插件页多了一个「发现」标签页：它不内置任何插件目录，只列出**用户自己添加的索引源**（[官方 bundle 的已知限制](../runtime/0.2.2-rc.3.md#9-插件索引源discover格式与实测坑位)）。一个索引源是一份 **format 1 的 JSON**，宿主用 `@deepseek-ai/dsh-plugin-market-index` 校验后展示、安装。

这份仓库有 4 个已发 npm 的插件，但：

- 仓库里没有 `index.json`，npm 上也没有索引包，所以**不存在一个指向本仓库插件的索引源**；
- 社区事实标准 `dsh-plugin-catalog` 里也没有本仓库条目（投稿还没做，见私有笔记里的待办）。

结论：不建索引源，这些插件只能在 README 里让用户手敲 `dsh plugin add`，发现页永远搜不到。投稿社区索引是另一条路，但那条路要每个插件一条 YAML、一次最多 3 条，而且收录与否要过人工评审——不适合作为唯一入口。

## 可选方案

1. **等社区索引收录，不自建**：零维护。缺点：收录前的空窗期没有发现入口；条目的版本由对方的夜间构建决定；文案与分类受对方规则约束。
2. **自建，托管在 GitHub raw**：零发布成本、无重定向（实测 `cache-control: max-age=300`）。缺点：`raw.githubusercontent.com` 在国内常被污染，而 DSH 的用户群大量在国内。
3. **自建，托管在 GitHub Pages**：无重定向、内容类型正确。缺点：要在仓库设置里开 Pages；社区索引作者实测「宿主只给 15 秒，GitHub Pages 在某些网络会超时」。
4. **自建，发布成 npm 数据包，走 jsDelivr**（选定）：jsDelivr 的 npm 入口实测 200、无重定向，边缘缓存 12 小时且可主动 purge；社区索引自己也选了同一条路（"served from npm so it loads quickly everywhere"）。缺点：多发一个 npm 包，发版链多一步。

## 决定

采用方案 4。要点：

- **产物**：`scripts/build-index.mjs` 从 `packages/*/package.json` + `scripts/index-meta.json` 生成，版本列表**现场从 npm packument 枚举**（去掉预发布与 stub），`publishTimestamp` 取 registry 的 `time`。不在仓库里存 `index.json`：format 1 是写死的版本清单，存一份就会过期。
- **发布**：`.github/workflows/index.yml` 在 `release: published` 后（以及手动 `workflow_dispatch`）跑；与 npm 上已发布版本逐字节比较，内容没变就跳过，变了就发布 `@kangyishuai/dsh-plugin-index`（版本号 `0.0.<run_id>`，包内只有 `index.json`），然后 purge jsDelivr 的缓存，最后从 CDN 取回来用仓库自己的校验器验一遍。
- **元数据**：分类、中英标题、中文描述写在 `scripts/index-meta.json`；`pnpm check` 会校验它与 `packages/` 双向一致（新插件漏写、旧条目没删都会红）。英文描述直接取 `package.json#description`，避免同一句话维护两遍。
- **版本口径**：列出每个插件的**全部正式版本**，不只是 latest。Discover 因此可以直接装/回退到旧版本；"推荐"仍由宿主按最高稳定版算。
- **不写 `engines.dsh`**：沿用 [ADR 0005](0005-dsh-version-compatibility.md) 的判断——预发布阶段的 semver 范围不可靠，写了反而会把能用的版本标成不兼容。兼容性以各插件 README 的表格为准。
- **校验不引入宿主依赖**：仓库硬性约定 3 禁止把 `@deepseek-ai/*` 加进依赖（连 devDependencies 也不行），所以 `scripts/build-index.mjs` 内置了一份按宿主规则写的结构校验器；真正的权威验收是 `pnpm smoke:index`——临时 `DSH_HOME` + 真实宿主 + 真实「发现」页面，其中一条断言故意喂坏索引，要求宿主报 `invalid-index` 而不是静默空列表。

## 影响

- 用户多了一个安装入口：**插件 → 发现 → 添加索引源**
  `https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json`。
- 发版链多一个 job：它与 npm publish 解耦（触发器是 Release 创建），索引发布失败不会影响插件发版；索引陈旧只影响发现页显示，不影响已安装的插件。
- 多一个 npm 包要维护：包内只有一份 JSON，没有代码、没有依赖、没有 install 脚本；`NPM_TOKEN` 缺失时该 job 会红，但仓库其余流程照常。
- 依赖 jsDelivr 与 npm 两个外部服务；两者的失败模式都已想好（`docs/testing/index.md` 里有手工补发与灾备 URL 的做法）。
- 社区索引投稿仍然值得做，只是不再是唯一入口；两条路可以并存，同一个插件会在两个索引里各出现一次。

## 重新考虑的时机

- 社区索引收录之后如果发现「自建索引没人用」：可以只保留社区那条，把 workflow 降级成手动重建。
- 如果 jsDelivr 的 12 小时缓存 + purge 开始出现明显延迟，或国内可达性变差：改指向 GitHub Pages，或同时发布 raw 分支做灾备。
- 如果 DSH 给索引源加了签名/官方目录：优先接官方机制。
