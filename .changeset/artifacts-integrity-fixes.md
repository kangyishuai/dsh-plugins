---
"@kangyishuai/dsh-artifacts": patch
---

修复 artifacts 体检（2026-11-28 审计）里的 P1/P2/P3 真实问题；契约方法集与错误码不变。

- **并发写不再静默损坏（AUD-ARTIFACTS-02，P1）**：版本文件改为唯一临时名 + 用 `O_EXCL` 独占创建 `vN.<ext>` 抢占版本号，同一 id 的写路径（append/archive/remove/restore）进程内串行化；同一 id 的并发 `append` 各拿各的版本，不再互相覆盖或用同一个 `.tmp` 写坏内容。`read()` 现在核对 `meta.json` 记录的 `bytes` / `sha256`：不一致（含版本文件缺失）时报 `artifacts/failed` + 可选细分原因 `reason: "corrupt-version"`，HTTP 路由回 `500 artifact version corrupted`，绝不把坏内容当最新版送出。旧 meta 没有可核对摘要时按只读处理，不误判。
- **时间线行支持中文 id（AUD-ARTIFACTS-01，P2）**：id 解析从 ASCII 正则改为「行首 `artifact ` 到 ` · `」切片 + 与 id 生成同源的边界校验，`q3-报告-2026` 这类保留中文的 id 能正确显示并打开（修复前显示「（未识别 id）」、按钮打开的是工件库）；`list` / `read` 调用不再渲染无意义的时间线行（报告 A-伪-5）。
- **面板预览补 CSP（AUD-ARTIFACTS-03，P3）**：`iframe srcDoc` 渲染前注入文档级 `Content-Security-Policy`（`default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`），与只读路由同一口径；内联样式、`data:` / `blob:` 图片照常显示，页面脚本不再执行。HTTP 路由的 CSP 保持不变。
- **路由错误语义（AUD-ARTIFACTS-04 / 05，P3）**：畸形百分号编码的 id → `400`（修复前是 `500` 且把内部错误文本写进响应体）；`?v=` 存在但不是正整数 → `400`（修复前静默回落最新版）；其它内部错误 500 只回通用文案。
- **崩溃残骸行（AUD-ARTIFACTS-07，P3）**：`create()` 改为先落 v1 再写 meta；`scan()` / `list()` 跳过 `latest === 0` 且没有版本的残骸目录并告警，旧数据里已经产生的残骸也不再出现在列表里。
- **破坏性操作的影响面体积（AUD-ARTIFACTS-08，P3）**：`archive` / `remove` / `restore` / `purge` 返回的 `bytes` 改为**所有版本体积之和**（即"实际会移动/删除的字节"，与 `totalBytes` 同口径），不再只算最新版；行与 `summary` 的 `bytes` 仍是最新版口径。这是一处语义修正（0.2.x 补丁级），原本按"最新版"理解 `remove.bytes` 的调用方请改用行/`summary` 的 `bytes`。
- **接口新增可选字段**：失败信封里的 `reason`（目前只有 `"corrupt-version"`），属于 §8.6 允许的可选附加字段，按 `code` 降级的既有调用方无需改动。
