# @kangyishuai/dsh-artifacts

## 0.1.0

### Minor Changes

- [#147](https://github.com/kangyishuai/dsh-plugins/pull/147) [`d4a3e95`](https://github.com/kangyishuai/dsh-plugins/commit/d4a3e9570d6ccd244fd653f9466c93915e7302fa) Thanks [@kangyishuai](https://github.com/kangyishuai)! - Initial release: local artifact pages for DSH sessions. One `artifact` tool publishes a self-contained HTML page (publish / append / list / read), the timeline keeps a compact summary row, and the latest version refreshes in place inside a sandboxed right-sidebar panel. Every save is a version file under the DSH data root; a generated SVG cover grid lists them. Nothing is uploaded, and `/artifacts/<id>` serves one version behind the host connection check.
