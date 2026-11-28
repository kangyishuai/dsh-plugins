# @kangyishuai/dsh-**NAME**

> **DESCRIPTION**

[English](./README.md)

非官方 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，与 DeepSeek 无关。

## 做什么

TODO

## 安装

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-__NAME__
```

装完重启 DSH 桌面版。

## 副作用与风险

TODO：列出读写的每个文件、每个破坏性操作。没有就写「无」。

## 兼容性

| 插件版本 | 已验证的 DSH 版本 |
| -------- | ----------------- |
| 0.0.0    | 0.2.2-rc.3        |

## 发布前

脚手架已经把宿主在不激活插件时读取的「插件身份」接好了。发布前把占位内容换掉：

- `icon.svg` —— 中性的 36×36 占位图；换成自绘图标（透明背景、不要画底块、不要有文字）。
- `locale/en.json` / `locale/zh.json` —— 根对象的 `meta.title` 与 `meta.description`；英文侧 `pnpm new` 已按目录名和描述参数生成 sentence case 占位，`zh.json` 里是中文「待替换」占位，发布前换成真实中文文案。
- `package.json` —— 顶层 `icon`、`files`（必须列上 `icon.svg`）与 `"./locale/*.json"` 导出要一起保留。宿主解析不到 locale 文件时会静默回退成 npm 包名 + 英文长描述。

改完在 `scripts/index-meta.json` 里登记（见 AGENTS.md）；版本离开 `0.0.0` 后 `pnpm check` 就会强制检查这些身份字段。

## License

MIT
