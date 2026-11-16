---
"@kangyishuai/dsh-artifacts": minor
---

Initial release: local artifact pages for DSH sessions. One `artifact` tool publishes a self-contained HTML page (publish / append / list / read), the timeline keeps a compact summary row, and the latest version refreshes in place inside a sandboxed right-sidebar panel. Every save is a version file under the DSH data root; a generated SVG cover grid lists them. Nothing is uploaded, and `/artifacts/<id>` serves one version behind the host connection check.
