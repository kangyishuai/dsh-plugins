# DSH Plugins

[English](README.md)

非官方的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 插件集合。**单仓多包**：`packages/` 下的每个目录都是一个独立的 npm 包，可以单独发布、单独安装。

> **声明**：个人社区项目，与 DeepSeek 没有关联，也未获其认可。部分插件会操作本地的 DSH 数据，安装前请阅读插件 README 的「副作用与风险」一节。

## 插件清单

| 包名         | 说明 | 已验证的 DSH 版本 |
| ------------ | ---- | ----------------- |
| _（待添加）_ |      |                   |

## 安装插件

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-<name>
```

装完重启 DSH 桌面版。

## 开发

| 项目       | 版本                                     |
| ---------- | ---------------------------------------- |
| DSH 桌面版 | 0.2.1-rc.5                               |
| Node       | 开发用 24（`.node-version`），最低 22.19 |
| pnpm       | >= 11                                    |

```bash
pnpm install                   # 同时安装 git hooks
pnpm new my-plugin "一句话描述"
dsh plugin --profile desktop add "link:$PWD/packages/my-plugin"
pnpm verify                    # lint + 类型检查 + 规范检查 + 测试
```

改了 host 半（`lib/index.js`）要重启 DSH 桌面版；改了 client 半（`lib/client.js`）刷新页面就行。

- [CONTRIBUTING.md](CONTRIBUTING.md)：常用命令、提交规范、发版流程
- [docs/plugin-conventions.md](docs/plugin-conventions.md)：插件结构和规则
- [docs/runtime/](docs/runtime/)：针对具体 DSH 版本的勘察记录（slot、宿主服务、磁盘布局）
- [docs/adr/](docs/adr/)：架构决策记录
- [AGENTS.md](AGENTS.md)：给 AI agent 的工作约定

## 目录结构

```
dsh-plugins/
├── packages/<name>/     # 一个插件 = 一个 npm 包
├── templates/plugin/    # pnpm new 用的脚手架模板
├── scripts/             # 脚手架、规范检查等仓库脚本
├── types/               # 手写的 DSH 宿主/client 类型声明（供 JSDoc 检查）
├── docs/                # 约定、运行时勘察、ADR、调研笔记
└── .changeset/          # 待发布的变更说明（Changesets）
```

## 安全

请私下报告漏洞，见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
