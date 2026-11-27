# @kangyishuai/dsh-artifacts

## 0.2.0

### Minor Changes

- [#319](https://github.com/kangyishuai/dsh-plugins/pull/319) [`d194ed4`](https://github.com/kangyishuai/dsh-plugins/commit/d194ed4cedb27987517e23bbbbb638394b248132) Thanks [@kangyishuai](https://github.com/kangyishuai)! - feat(artifacts): library 0.2 — attribution + provenance, five kinds, filtering/metering, cascade cleanup, cross-plugin contract
  
  - **Attribution & provenance.** `meta.json` gains optional `projectId` / `sessionId` / `threadId` and a `source` block (`sessionId` + `toolCallId`); the `artifact` tool derives `sessionId` / `toolCallId` from the tool-call context and writes the creator on the artifact plus each version's own source. Older `meta.json` files without these fields keep working unchanged (read as HTML, no owner).
  - **`artifacts/list` filters.** `{ projectId, sessionId, threadId, kind, title, since, until, includeArchived, onlyArchived, limit }`, conditions AND-ed; no arguments still means "everything". It also returns `summary: { count, bytes, byProject[] }` for storage metering.
  - **Five kinds.** `html` (default) plus `markdown` / `json` / `csv` / `image`, stored as `vN.<ext>`; images are accepted as a `data:` URL or bare base64, stored as raw bytes, and served with the matching MIME type (no UTF-8 round-trip). The 2 MiB limit and tmp+rename write are unchanged; `latest` / list rows / covers all carry `kind`.
  - **Cascade cleanup following ADR 0002.** New Remotes `archive`, `remove`, `restore`, `trash`, `purge`: `remove` moves artifacts to `artifacts-trash/` instead of deleting them, every call supports `dryRun: true` to report count/bytes/ids first, and archived artifacts stay readable but refuse new versions.
  - **Stable cross-plugin contract.** New `artifacts/version` probe and `artifacts/2` contract documented in `docs/plugin-conventions.md` §8 (method names, parameter schemas, row shape, error codes, `ctx.get("artifacts")` / `rpc.call("/api", "artifacts/list", …)` entry points, degradation checklist). Other plugins must not read this plugin's storage directory.
  - **Sidebar library.** The `artifact` tab now renders a list view (thumbnail, title, kind, version, size, project, time) with a count/size summary, title search and kind filters; it accepts a `projectId` parameter so a project page can open "this project's artifacts" instead of the global grid.

## 0.1.0

### Minor Changes

- [#147](https://github.com/kangyishuai/dsh-plugins/pull/147) [`d4a3e95`](https://github.com/kangyishuai/dsh-plugins/commit/d4a3e9570d6ccd244fd653f9466c93915e7302fa) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Initial release: local artifact pages for DSH sessions. One `artifact` tool publishes a self-contained HTML page (publish / append / list / read), the timeline keeps a compact summary row, and the latest version refreshes in place inside a sandboxed right-sidebar panel. Every save is a version file under the DSH data root; a generated SVG cover grid lists them. Nothing is uploaded, and `/artifacts/<id>` serves one version behind the host connection check.
