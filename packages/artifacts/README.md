# @kangyishuai/dsh-artifacts

> Local artifact pages for DSH sessions: the model publishes a self-contained HTML page, a compact row appears in the timeline, and the page refreshes in place in the right sidebar.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: mechanics verified, interface extended, desktop pass pending.** The preview/versioning behaviours below were measured on a real `dsh --profile web` host in a temporary `DSH_HOME`. The newer library features (project attribution, multi-kind artifacts, filtering, cascade cleanup, cross-plugin contract) are covered by unit tests only — their desktop smoke pass has not been run yet. See the compatibility table for exactly what was verified.

## What it does

- **One tool, four verbs.** `artifact` with `action` = `publish` (new artifact), `append` (new version of the same id), `list`, `read`. The body is passed as `content` (or `html` for HTML) and stored under the DSH data root — nothing is uploaded.
- **Five kinds, one library.** `kind` = `html` (default), `markdown`, `json`, `csv`, `image`. Text kinds are stored as UTF-8 and previewed as `<pre>` in the panel; images (PNG / JPEG / GIF / WebP / SVG) are passed as a `data:` URL or bare base64, stored as raw bytes, and previewed with `<img>` through the read-only route. Every list row carries `kind`.
- **Attribution and provenance.** Each artifact records the owning `projectId` / `threadId` (passed by the caller) and the `sessionId` / `toolCallId` derived from the tool call context — `meta.json` keeps the first creator, and every version keeps its own source, so you can answer "which thread produced this version?".
- **Query and metering.** `artifacts/list` filters by project, session, thread, kind, title substring and time window (conditions AND-ed), and returns a `summary` with count/bytes plus a per-project rollup.
- **A compact timeline row.** Each call renders as `Artifact <id> 最新 vN [打开预览]` through the `tool.call.toolview` keyed slot, so page markup never enters the conversation log.
- **A library list.** With no artifact selected the tab shows a list: generated SVG cover (`GET /artifacts/<id>/cover.svg`) used as a thumbnail, title, kind, version, size, project and timestamp, plus a `n items · X KiB` summary, a title search box and kind filters. No headless renderer is involved, so nothing stays resident. The same view accepts a `projectId` parameter, so another plugin can open "this project's artifacts" instead of the global library.
- **Cascade cleanup, by the book.** `artifacts/remove` moves matching artifacts to `artifacts-trash/` (never a bare `rm -rf`), `artifacts/restore` brings them back, and `artifacts/purge` is the explicit hard delete. `artifacts/archive` marks artifacts read-only (the version files stay, appends are refused), and every destructive call supports `dryRun: true` to report count/bytes/ids first.
- **A live sidebar panel.** The `artifact` tab type renders the latest version inside `sandbox="allow-scripts"` and polls the host Remote `artifacts/latest`; a new version replaces `srcDoc` on the **same** iframe instead of remounting it.
- **Old rows point to the latest version.** Every row opens the panel by artifact id, and the panel always reads the newest version, so a row created for `v1` shows `v3` once the page has moved on.
- **A read-only URL.** `GET /artifacts/<id>[?v=N]` serves one version behind the host's connection check, with a strict `Content-Security-Policy`, `nosniff`, and `no-store`.

## Library API for other plugins

`artifacts` is also a service: other plugins read artifacts through a versioned Remote contract instead of touching this plugin's storage directory.

- host half: `ctx.get("artifacts")` → `undefined` means "not installed" (degrade, do not pretend the library is empty), then call `list` / `latest` / `version` / …
- client half: `ctx.connection.rpc.call("/api", "artifacts/list", { args: { request: { projectId } } })`
- contract version: `artifacts/2`; probe it with `artifacts/version`.

Method names, parameter schemas, row shape, error codes and the degradation checklist live in [docs/plugin-conventions.md §8](../../docs/plugin-conventions.md#8-跨插件调用契约remote-api).

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

## Sharing and LAN access

Artifacts are **local**: the URL is `http://127.0.0.1:<port>/artifacts/<id>`, served by the DSH host that owns the data. This plugin does not offer "one-click LAN sharing", and it never will without a deliberate opt-in, because the host cannot expose a single route:

- **The desktop app cannot bind a LAN address.** Its host child process takes no `--host`, and `dsh-app://app/*` forwards to loopback with a host cookie. Verified on 0.2.2-rc.3: `lib/main.js` contains no `--host` or `--trusted-host` handling at all.
- **`--host` belongs to the web profile.** `dsh --profile web --host <LAN IP>` binds one concrete local interface and exposes **the whole GUI** — every `/api` route, every plugin route, and this plugin's `/artifacts/` route. `--public-url` only changes the advertised address; it grants no trust, and wildcard hosts are rejected. Add `--trusted-host`, a reverse proxy, and `--tls-cert/--tls-key` before letting anyone else reach it, and treat it as your own security decision.

If someone else needs to see an artifact, use one of these instead:

1. **Export a single file** (the default, safest): self-contained HTML you can send over any channel.
2. **Your own static hosting** (GitHub Pages, an object store, an internal web server) — you own the access control and the lifetime.
3. **A local reverse proxy** in front of the loopback URL, if your network already has one.

Do not treat an artifact URL as an access-control boundary: the route authenticates the browser session, not a person.

## Limits

- 2 MiB per version (counted on the stored bytes, not on the base64 text), no backend, no sharing, no comments. HTML pages are served with `script-src 'none'` through the URL and previewed interactively in the panel; markdown/CSV are served as `text/plain` so a browser previews instead of downloading them.
- An artifact's kind is fixed at creation: `append` must use the same kind (a different kind is rejected instead of silently mixing formats).
- **UI strings are Chinese-only: this plugin does not implement i18n yet.** The `locale/` files only carry the plugin title; moving every string into `ctx.locale.register` is tracked as a separate batch. The `artifact` tool description and all API fields are English.
- The panel polls once per second while visible; a push channel is a later optimization.
- A restored sidebar tab currently loses its navigation params, so it shows an empty panel until reopened. Tracked in the research notes.

## Compatibility

| Plugin | Verified on DSH | Notes                                                                                  |
| ------ | --------------- | -------------------------------------------------------------------------------------- |
| 0.0.0  | 0.2.2-rc.3      | preview/version mechanics                                                              |
| 0.2.0  | 0.2.2-rc.5      | `pnpm smoke:artifacts` 10/10 (web, temporary `DSH_HOME`); desktop **not verified yet** |

## License

MIT
