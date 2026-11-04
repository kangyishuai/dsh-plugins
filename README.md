# DSH Plugins

我的 DeepSeek Harness (DSH) 插件开发仓库。**单仓多包**：每个插件是 `packages/` 下的一个独立 npm 包，可独立发布、独立安装，共享本仓库的约定与文档。

## 插件清单

| 包名 | 目录 | 说明 | 状态 |
|---|---|---|---|
| _（待添加）_ | — | — | — |

## 环境

| 项目 | 版本 |
|---|---|
| DSH 桌面版 | 0.2.1-rc.5 |
| Node | >= 22.19（本机 v24.14.0） |
| pnpm | >= 11（本机 11.28.10） |

## 快速开始

```bash
pnpm install

# 把某个插件以 link 方式装进 desktop profile（改代码即时生效）
dsh plugin --profile desktop add "link:$PWD/packages/<plugin-dir>"

# 卸载
dsh plugin --profile desktop remove <package-name>
```

host 半改动后重启 DSH 桌面版；client 半改动后刷新页面。

## 目录结构

```
dsh-plugins/
├── AGENTS.md                  # 给 AI agent 的开发约定（DSH 进入本目录工作时自动加载）
├── docs/
│   └── plugin-conventions.md  # 插件结构、可用 slot/API、踩坑记录
├── packages/
│   └── <plugin>/              # 一个插件 = 一个独立 npm 包
└── scripts/                   # 仓库级工具脚本
```

## 设计约定（摘要）

- 包名统一用 `@kangyishuai/dsh-<name>` scope，避免与 npm 上已有裸名冲突。
- client 半是普通 classic script（`window.__ModuleLoader__.load({ id, factory })`），**无需打包器**。
- 不写死 DSH 内部文件格式；破坏性操作必须有确认框。
- 详细规范见 [docs/plugin-conventions.md](docs/plugin-conventions.md)。

## License

MIT
