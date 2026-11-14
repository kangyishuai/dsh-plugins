# 插件索引源的测试与发布

索引源不是一个插件包：它是一份 **format 1 的 JSON**，由 `scripts/build-index.mjs` 生成、由 `.github/workflows/index.yml` 在发版后发布成 npm 数据包 `@kangyishuai/dsh-plugin-index`，用户把它加进 **插件 → 发现 → 添加索引源**。格式与实测坑位见 [docs/runtime/0.2.2-rc.3.md §9](../runtime/0.2.2-rc.3.md#9-插件索引源discover格式与实测坑位)，取舍见 [ADR 0015](../adr/0015-plugin-index-source.md)。

线上地址（唯一需要告诉用户的地址）：

```
https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json
```

## 1. 自动化

| 命令                                                                   | 覆盖什么                                                                                                           | 前置                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `node --test scripts/test/index-build.test.js`（`pnpm test` 的一部分） | 生成器与校验器的离线单测：预发布/stub/无发布时间被排除、版本降序、`repository` 转换、meta 双向一致、宿主会拒的形态 | 无                              |
| `pnpm check` / `pnpm check:index`                                      | `scripts/index-meta.json` 与 `packages/` 双向一致；`build/index.json` 存在时校验其结构                             | 无                              |
| `pnpm index`                                                           | 从 npm registry 现场生成 `build/index.json`（不提交）                                                              | 联网                            |
| `pnpm smoke:index`                                                     | 真机端到端：临时 `DSH_HOME` + 真实宿主 + 真实「发现」页                                                            | 本机 `dsh`、`ego-browser`；联网 |

`pnpm smoke:index` 的 12 条断言（2026-11-15 在 0.2.2-rc.3 上 12/12 PASS）：

1. 页面可交互；
2. 侧栏能打开「插件」页（有「已安装」「发现」两个页签）；
3. 发现页有空状态与「添加索引源」入口；
4. 索引源对话框能填 URL；
5. **坏索引被宿主拒收**（把 `versions[0].version` 改成 `1.0`，要求页面出现「此索引的格式无效」）；
6. 索引标题出现在发现页；
7. 4 个插件都在列表里；
8. 分类 pill 有 会话 / 工作流 / 工具；
9. 卡片展示默认版本（0.5.0 / 0.7.0 / 0.4.2 / 0.6.2）；
10. 搜索 `rewind` 只剩「会话回滚」；
11. 条目详情页有安装入口与来源事实；
12. 详情正文来自 README。

排障开关：`SMOKE_DEBUG=1` 打印浏览器脚本完整输出；`SMOKE_KEEP=1` 保留临时目录（`host.log`、生成的 `index.json`、截图）。冒烟**从不等**安装完成，也不发起模型调用。

## 2. 发版后要确认什么

`.github/workflows/index.yml` 由 `release: published`（每个包一条 Release）触发，依次做：

1. `node scripts/build-index.mjs --out dist/index.json`；
2. 与 npm 上已发布版本的 `index.json` 逐字节比较，相同就跳过（一次发版会触发多条 Release，只有第一条真正发布）；
3. 发布 `@kangyishuai/dsh-plugin-index`（版本 `0.0.<run_id>`）；
4. purge jsDelivr 缓存；
5. 从 CDN 取回 `index.json`，用 `node scripts/build-index.mjs --check` 验证，并把 4 个插件与版本打进 job summary。

发版后人工核对（一次即可，约 1 分钟）：

- [ ] Actions 里 `Plugin index` 最近一次是绿的，summary 里有 4 个插件和正确版本；
- [ ] `curl -s https://cdn.jsdelivr.net/npm/@kangyishuai/dsh-plugin-index/index.json | head -c 200` 返回 JSON（不是 404）；
- [ ] 真实桌面版：**插件 → 发现**，切换索引后卡片上的版本等于刚发的版本；
- [ ] 点一张卡进详情页，**安装**按钮可用（不要真装，除非是在临时 profile 里）。

## 3. 手工补发（workflow 失败或漏跑时）

```bash
node scripts/build-index.mjs            # 生成 build/index.json
# 检查内容：4 个插件、每个版本的 publishTimestamp 都是刚发的时间
cat build/index.json | head -c 400
```

然后在 Actions 里手动跑 `Plugin index`（`workflow_dispatch`），或：

```bash
gh workflow run index.yml --ref main
gh run watch "$(gh run list --workflow=index.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

它自己会比对内容、发布、purge。不要手工 `npm publish` 索引包——provenance 与版本号规则都在 workflow 里。**合并 PR 后第一件事就是跑它**：在这之前索引包还不存在，那个 URL 是 404。

## 4. 已知边界

- **每个插件只显示默认版本**：卡片上的版本是索引里最高稳定版；更老的版本在条目详情页的 **版本** 列表里（format 1 里我们列出了全部正式版本）。
- **索引没有签名**：条目是索引作者的声明。发现页自己也提示「索引由第三方提供」。别把别人的索引当成安全审查。
- **缓存**：宿主侧 `cacheTtlMs` 默认 10 分钟，读者点「刷新」即可；jsDelivr 侧 12 小时，workflow 发布后会主动 purge。
- **灾备 URL**：如果 jsDelivr 不可达，可以把 `build/index.json` 放到任意 https 直链（GitHub raw 对现成文件不跳转，实测 `cache-control: max-age=300`）临时顶上；宿主要求 URL **不带 query/fragment** 且**不跟随重定向**。
- **不写 `engines.dsh`**：发现页因此不会按版本过滤；兼容性以各插件 README 的表格为准。
