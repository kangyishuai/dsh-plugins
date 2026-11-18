---
"@kangyishuai/dsh-casefile": patch
---

修正 npm/插件索引里显示的英文描述：`package.json#description` 之前写成了中文，导致 Discover 卡片的 `description.en` 显示中文。改成英文一行说明（中文描述仍由 `scripts/index-meta.json#descriptionZh` 提供）。
