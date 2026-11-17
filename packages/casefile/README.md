# @kangyishuai/dsh-casefile

> Evidence-first workbench for REA inside DeepSeek Harness: turn observations into citable evidence, handoff-ready spec packs, and recomputable acceptance — instead of conclusions that die with the session.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek. It is an adapter on top of [REA](https://github.com/morluto/rea) (MIT); it ships none of REA's code and no analysis engine.

> **Status: M3 (five checkers + auto loop + near-miss proof).** Persists projects, evidence, claims, features, unknowns, obligations and check records; exports a redacted spec pack; ships a workbench page (evidence / obligations / runs), a sidebar entry and a settings section. A **builder session** can be started from a project: casefile creates a child session, feeds it only the spec pack (never the original target), and returns the session id; `awaitBuilder` reports why it stopped. The build/check loop runs real commands: `case_build start` records a `BuildRun` with an implementation digest, `case_check run` records a result bound to that digest, and a later build whose digest differs automatically **reopens** the obligations it had closed. Verified by 70 unit tests, a 30-assertion web end-to-end smoke on a throwaway DSH home (including the stale-reopen path), and a manual GUI pass in a real browser; the desktop read-only suite is written but still needs the plugin installed in the desktop profile before it can run. Treat it as young software.

## What it does

REA is very good at producing evidence-backed observations. What it does not do is keep them: the evidence lives inside the tool results of one session and is gone when the session ends.

Casefile is the missing layer:

- **Projects as first-class objects.** One target = one project directory under the plugin's data root, with its authorization tier (`owned` / `authorized` / `research`), scope (`all` / `selected`), and recorded REA version and capability hash.
- **Evidence ledger.** Each observation is stored as an `Evidence` record that keeps REA's own `confidence` (observed / derived / inferred) and `authority` (shipped-artifact / controlled-replay / live-observation / external), plus a `limitations` list and optional integrity value. Casefile never re-derives those judgments.
- **Claims you can cite and select.** A `Claim` is the unit you quote in a handoff: it references evidence ids, carries its own limitations, and can be selected (`case_claim select`) for export.
- **Feature grouping for scoped work.** Group selected claims into a `Feature` with boundaries and non-goals — the unit later used by "rebuild only these features".
- **Unknowns are shipped, not hidden.** Open unknowns are part of the spec pack; a pack that silently drops them is a lie.
- **Spec pack export.** `case_brief export` writes `spec/<timestamp>/spec.json` + `brief.md`: selected claims, their evidence, features, open unknowns, a coverage summary, and a content hash. Redaction is on by default (home directory, absolute paths, common token shapes).
- **Capability detection.** `case_project` and `diagnose()` report whether `mcp__rea__*` tools are visible and which casefile-required tools are missing, instead of silently degrading.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-casefile
```

To run the working tree instead of a published version, pack it first — `link:` installs do not work (the host's `@deepseek-ai/*` resolution only covers packages whose real path is inside the profile):

```bash
cd packages/casefile
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-casefile-*.tgz
```

Re-run `pnpm pack` + `add` after changing the code. Restart the DSH desktop app afterwards (this plugin is a host half).

## Requirements

- A REA MCP server registered in DSH, exposing tools named `mcp__rea__*` (REA's own `rea setup`, or any community bridge). Casefile **does not** register that row itself — it would collide with REA's `rea-mcp` entry.
- Casefile works without REA for manual evidence entry, but capability detection will report `missing` and later milestones' checks will degrade.

## Workbench

The plugin adds a **Casefile** entry to the sidebar. The page lists projects on the left and shows the selected project on the right with three tabs:

- **Evidence** — claims (with confidence, limits and evidence count) and the evidence records they cite;
- **Obligations** — obligations, their status, and open unknowns. Closing an obligation needs a _fresh PASS check_; until checkers land in M2 the button explains what is missing instead of pretending;
- **Runs** — build rounds, check verdicts and the loop stop condition.

A settings section shows the data root, project count and REA capability status, so "is REA actually connected" is answerable without reading logs.

## Tools

| Tool            | Actions                           | Purpose                                                                         |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `case_project`  | `open`, `list`, `get`, `update`   | Create/open a project, list, inspect, change authorization tier / scope / state |
| `case_evidence` | `add`, `list`, `show`             | Store an REA observation as evidence; filter; read one                          |
| `case_claim`    | `add`, `list`, `search`, `select` | Store a citable conclusion; search; select it for export                        |
| `case_feature`  | `add`, `list`                     | Group claims into a feature with boundaries and non-goals                       |
| `case_unknown`  | `add`, `list`, `resolve`          | Record unknowns; mark one resolved with a note                                  |
| `case_brief`    | `export`                          | Write the redacted spec pack (`spec.json` + `brief.md`)                         |

Every tool returns `{ ok, data?, error?{code,message,hint}, summary }`; errors carry a stable code, so the model can correct itself instead of guessing.

## Checkers

| Checker | What it judges                                                                 | Verdicts                                      |
| ------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `build` | a shell build command: exit code + configured output paths                     | pass / fail / unknown(timeout)                |
| `cli`   | a command against `{ exitCode, stdoutIncludes, stdoutEquals, stderrIncludes }` | pass / fail / unknown(timeout)                |
| `web`   | two PNG screenshots: similarity = 1 − mean-abs-diff/255, plus a size check     | pass / fail / unknown(missing or invalid PNG) |

Screenshots are captured elsewhere (REA's browser tools or any tool the user prefers); the `web` checker only judges. The PNG decoder is in-repo (`lib/core/png.js`, no third-party dependency) and supports 8-bit RGB/RGBA, non-interlaced.

## Anti-false-green

The suite includes **near-miss injection** tests: an obligation is closed against a correct implementation, then one character of the output is changed, and the next round must fail that obligation and reopen it. A failed build also skips checks entirely instead of producing a misleading pass. See `packages/casefile/test/near-miss.test.js`.

## Data layout

Everything lives under the plugin's data root (default `<DSH_HOME>/casefile`, override with `dataRoot`):

```
casefile/
└── projects/<project-id>/
    ├── project.json          # version + target + authTier + scope + REA version
    ├── evidence.jsonl        # append-only; same id later wins
    ├── claims.jsonl
    ├── features.jsonl
    ├── unknowns.jsonl
    ├── audit.jsonl           # who did what, append-only
    └── spec/<timestamp>/     # exported spec.json + brief.md
```

Rules: JSON files carry a `version`; a file written by a newer casefile is reported as read-only instead of silently rewritten. Corrupt JSON is renamed `.broken` and kept. Records are append-only, so a project directory can be reviewed and diffed.

## Config

| Key                | Default               | Meaning                                                             |
| ------------------ | --------------------- | ------------------------------------------------------------------- |
| `dataRoot`         | `<DSH_HOME>/casefile` | Where project data lives; injectable for tests                      |
| `defaultAuthTier`  | `research`            | Default authorization tier for new projects                         |
| `cleanRoomDefault` | `true`                | Reserved for the builder milestone: builder cannot see the original |
| `checkers`         | `["cli","web"]`       | Reserved for the verification milestone                             |
| `maxRounds`        | `5`                   | Reserved for the verification loop                                  |
| `redactOnExport`   | `true`                | Force redaction on spec pack export                                 |

Config is read from the `casefile` row in `cordis.patch.yml`. Do not edit the profile by hand — change the row's `config:`.

## Compatibility

| Plugin | Verified on DSH                                                                              |
| ------ | -------------------------------------------------------------------------------------------- |
| 0.0.x  | 0.2.2-rc.3 (host API inspected via runtime inspection; see `docs/runtime/0.2.2-rc.3.md` §10) |

## Side effects & risks

- **Files it writes:** only under the data root above. It never writes into the investigated project, never modifies the REA binary, and never edits the profile.
- **Destructive actions:** none in M0. Future milestones (project deletion, artifact cleanup) follow the repo's [ADR 0002](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0002-destructive-operations.md): trash by default, confirmation with a one-line impact, dry-run, audit log.
- **Privacy:** project data stays on this machine. Spec packs are redacted by default (`HOME`, absolute paths, common token shapes) but **you should still review a pack before sharing it** — redaction is a safety net, not a guarantee.
- **Evidence quality:** casefile stores what you tell it. It does not verify an observation, and it never upgrades a claim's confidence or authority.
- **Legal:** intended for research and for software you own or are authorized to analyze. It deliberately ships **no** DRM/anti-debugging bypass and no way to reuse third-party assets. Read [DISCLAIMER.md](./DISCLAIMER.md) before use.

## Development

```bash
pnpm verify        # lint + typecheck + plugin checks + tests
pnpm check         # plugin conventions + index metadata
pnpm test          # package unit tests
```

## License

MIT. See [LICENSE](./LICENSE) and [DISCLAIMER.md](./DISCLAIMER.md).
