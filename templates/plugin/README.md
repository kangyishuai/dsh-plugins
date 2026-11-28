# @kangyishuai/dsh-**NAME**

> **DESCRIPTION**

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

## What it does

TODO

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-__NAME__
```

Restart the DSH desktop app afterwards.

## Side effects & risks

TODO: list every file it reads/writes and every destructive action. Write "None" if there are none.

## Compatibility

| Plugin | Verified on DSH |
| ------ | --------------- |
| 0.0.0  | 0.2.2-rc.5      |

## Before publishing

The scaffold already wires the plugin identity DSH reads without activating the plugin. Replace the placeholders before you publish:

- `icon.svg` — a neutral 36×36 placeholder; draw your own icon (transparent, no background tile, no text).
- `locale/en.json` / `locale/zh.json` — root `meta.title` and `meta.description`; the scaffold fills a sentence-case English title plus your description, and leaves explicit Chinese "replace me" placeholders in `zh.json`. Replace both before publishing.
- `package.json` — keep `icon`, `files` (must list `icon.svg`) and the `"./locale/*.json"` export together. If DSH cannot resolve a locale file it silently falls back to the npm package name and the long English description.

Then register the plugin following AGENTS.md (development flow step 6): add a row to **both** root plugin lists — `README.md` and `README.zh-CN.md` — and an entry in `scripts/index-meta.json`. `pnpm check` errors until all three are there, and the Chinese `title` / `descriptionZh` in `index-meta.json` must be the **same text** as `locale/zh.json`'s `meta` (otherwise `pnpm check` reports a mismatch between the index and the installed plugin). Once the version leaves `0.0.0`, `pnpm check` also enforces the identity fields above.

## License

MIT
