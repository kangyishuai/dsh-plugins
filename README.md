# DSH Plugins

[![CI](https://github.com/kangyishuai/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/kangyishuai/dsh-plugins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文](README.zh-CN.md)

Unofficial plugins for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai). This is a monorepo: every directory under `packages/` is an independent npm package that can be published and installed on its own.

> **Disclaimer**: this is a personal, community project. It is not affiliated with or endorsed by DeepSeek. Some plugins operate on local DSH data. Read each plugin's "Side effects & risks" section before installing.

## Plugins

| Package                                                      | Description                                                                              | Verified on DSH |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------- |
| [`@kangyishuai/dsh-session-delete`](packages/session-delete) | Real session deletion: trash by default, dry-run plan, audit log, residue reconciliation | 0.2.1-rc.5      |

## Install a plugin

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-<name>
```

Then restart the DSH desktop app.

## Development

Requirements: Node 24 (minimum 22.19), pnpm >= 11, a local DSH desktop app.

```bash
pnpm install                   # also installs git hooks
pnpm new my-plugin "What it does"
cd packages/my-plugin && pnpm pack --pack-destination /tmp && cd ../..
dsh plugin --profile desktop add /tmp/<tgz>
pnpm verify                    # lint + typecheck + convention check + tests
```

After changing the host half (`lib/index.js`), restart DSH. After changing the client half (`lib/client.js`), reload the page.

- [CONTRIBUTING.md](CONTRIBUTING.md): commands, commit conventions, release flow
- [docs/plugin-conventions.md](docs/plugin-conventions.md): plugin structure and rules (in Chinese)
- [docs/runtime/](docs/runtime/): findings about specific DSH versions (slots, host services, disk layout)
- [docs/adr/](docs/adr/): architecture decision records
- [AGENTS.md](AGENTS.md): working agreement for AI coding agents

## Repository layout

```
dsh-plugins/
├── packages/<name>/     # one plugin = one npm package
├── templates/plugin/    # scaffold used by `pnpm new`
├── scripts/             # scaffold, convention checker, helpers
├── types/               # hand-written DSH host/client type declarations (JSDoc checking)
├── docs/                # conventions, runtime notes, ADRs, research notes
└── .changeset/          # pending release notes (Changesets)
```

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
