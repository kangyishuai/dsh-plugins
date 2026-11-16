# @kangyishuai/dsh-artifacts

> Local artifact pages for DSH sessions: the model publishes a self-contained HTML page, a compact row appears in the timeline, and the page refreshes in place in the right sidebar.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: mechanics verified, feature work in progress.** The three behaviours below were measured on a real `dsh --profile web` host in a temporary `DSH_HOME`; the debug hooks used to drive them are still in the code and must be removed before a release. See the compatibility table for exactly what was verified.

## What it does

- **One tool, four verbs.** `artifact` with `action` = `publish` (new page), `append` (new version of the same id), `list`, `read`. The page body is passed as `html` and stored under the DSH data root — nothing is uploaded.
- **A compact timeline row.** Each call renders as `Artifact <id> 最新 vN [打开预览]` through the `tool.call.toolview` keyed slot, so page markup never enters the conversation log.
- **A cover grid.** With no artifact selected the tab shows every artifact as a card with a generated SVG cover (`GET /artifacts/<id>/cover.svg`): title, palette picked from the id, first heading as the subtitle, version and size. No headless renderer is involved, so nothing stays resident.
- **A live sidebar panel.** The `artifact` tab type renders the latest version inside `sandbox="allow-scripts"` and polls the host Remote `artifacts/latest`; a new version replaces `srcDoc` on the **same** iframe instead of remounting it.
- **Old rows point to the latest version.** Every row opens the panel by artifact id, and the panel always reads the newest version, so a row created for `v1` shows `v3` once the page has moved on.
- **A read-only URL.** `GET /artifacts/<id>[?v=N]` serves one version behind the host's connection check, with a strict `Content-Security-Policy`, `nosniff`, and `no-store`.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-artifacts
```

Restart the DSH desktop app afterwards. For the web profile, use `dsh plugin --profile web add @kangyishuai/dsh-artifacts` and reload the page.

## Side effects & risks

- **Writes files.** Each artifact is a directory `<data root>/artifacts/<id>/` holding `meta.json` and one `vN.html` file per version. The data root is `config.dataRoot`, else `$DSH_HOME`, else `~/.dsh`. Deleting the directory deletes the artifact; ids carry a random suffix so a deleted id is never reused.
- **Adds one HTTP route.** `/artifacts/` is registered on the host web server. It rejects unauthenticated requests, answers `GET`/`HEAD` only, and never serves a directory listing.
- **Serves model-authored markup.** The preview iframe is sandboxed without `allow-same-origin`, and the route sends `default-src 'none'` with inline styles only. Page scripts run only inside that sandbox; treat artifact content as untrusted, the same way the model's other output is treated.
- **No network egress, no telemetry, no install scripts.**
- **Debug surface (to be removed):** `window.__dshArtifacts` and the `appendDev` Remote method are enabled only when `DSH_ARTIFACTS_DEV=1` or the plugin config sets `dev: true`; they exist to drive the verification scripts.

## Limits

- Single page, 2 MiB of HTML, no backend, no sharing, no comments. The route serves static markup only (`script-src 'none'`); interactive pages are previewed in the panel, not through the URL.
- The panel polls once per second while visible; a push channel is a later optimization.
- A restored sidebar tab currently loses its navigation params, so it shows an empty panel until reopened. Tracked in the research notes.

## Compatibility

| Plugin | Verified on DSH |
| ------ | --------------- |
| 0.0.0  | 0.2.2-rc.3      |

## License

MIT
