# @kangyishuai/dsh-casefile

> Evidence-first workbench for REA inside DeepSeek Harness: turn observations into citable evidence, handoff-ready spec packs, and recomputable acceptance — instead of conclusions that die with the session.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek. It is an adapter on top of [REA](https://github.com/morluto/rea) (MIT); it ships none of REA's code and no analysis engine.

> **Status: M3 complete (five checkers + one-call cycle + near-miss + coverage gate + report).** Persists projects, evidence, claims, features, unknowns, obligations and check records; exports a redacted spec pack; ships a workbench page (evidence / obligations / runs), a sidebar entry and a settings section. A **builder session** can be started from a project: casefile creates a child session, feeds it only the spec pack (never the original target), and returns the session id; `awaitBuilder` reports why it stopped. The build/check loop runs real commands: `case_build start` records a `BuildRun` with an implementation digest, `case_check run` records a result bound to that digest, and a later build whose digest differs automatically **reopens** the obligations it had closed. Verified by the package unit suite (counts and commands are listed in [docs/testing/casefile.md](../../docs/testing/casefile.md)) plus a web end-to-end smoke on a throwaway DSH home (including the stale-reopen path) and a desktop read-only regression. Treat it as young software.

## What it does

REA is very good at producing evidence-backed observations. What it does not do is keep them: the evidence lives inside the tool results of one session and is gone when the session ends.

Casefile is the missing layer:

- **Projects as first-class objects.** One target = one project directory under the plugin's data root, with its authorization tier (`owned` / `authorized` / `research`), scope (`all` / `selected`), and recorded REA version and capability hash.
- **Evidence ledger.** Each observation is stored as an `Evidence` record that keeps REA's own `confidence` (observed / derived / inferred) and `authority` (shipped-artifact / controlled-replay / live-observation / external), plus a `limitations` list and optional integrity value. Casefile never re-derives those judgments.
- **Claims you can cite and select.** A `Claim` is the unit you quote in a handoff: it references evidence ids, carries its own limitations, and can be selected (`case_claim select`) for export.
- **Feature grouping for scoped work.** Group selected claims into a `Feature` with boundaries and non-goals — the unit later used by "rebuild only these features".
- **Unknowns are shipped, not hidden.** Open unknowns are part of the spec pack; a pack that silently drops them is a lie.
- **Spec pack export.** `case_brief export` writes `spec/<timestamp>/spec.json` + `brief.md`: selected claims, their evidence, features, open unknowns, a coverage summary, and a content hash. Redaction is on by default and shared by spec packs, machine-readable bundles **and** the HTML/Markdown acceptance report (see [Privacy](#side-effects--risks)).

## Redaction

All three exports (spec pack, bundle, report) go through the same `redactPack` pass, and `case_project report` redacts by default too:

- **Paths:** any path under a common system root (`/Users`, `/home`, `/var`, `/tmp`, `/private`, `/Applications`, `/Volumes`, `/opt`, `/etc`, `/Library`, `/usr`, `/System`, `/bin`, `/sbin`, `/dev`, `/proc`, `/boot`, `/root`, `/mnt`, `/media`, `/snap`, `/nix`, `/data`, `/srv`, `/workspace`), any unexpanded `~/…`, and any **absolute** path ending in a **1–8 character** file extension — replaced with `<path>`.
- **Tokens:** `sk-…`, `ghp_…`, `github_pat_…`, AWS `AKIA…`/`ASIA…`, Google `AIza…`, `npm_…`, `xox[abp]-…`, `Bearer …`, JWT (`eyJ…`), PEM private-key blocks, and `password=` / `api_key=` / `secret=` / `token=` values — replaced with `[redacted]`.
- **Deliberately kept:** URLs and API routes **without a file extension** (`https://example.test/api/todos`, `POST /api/todos`, `/auth/token`) stay readable, because a spec pack that turns every route into `<path>` is useless to the builder. An absolute path ending in a file extension is redacted even when it looks like a route (`/static/app.js`, `/api/v1/openapi.json`).

Known limit: a path that contains spaces is redacted only up to the first space (the remainder stays). Redaction is a safety net, not a guarantee: review a pack before sharing it.
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
- **Obligations** — obligations, their status, and open unknowns. Closing an obligation needs a _fresh PASS check bound to the current implementation digest_; otherwise the button names the exact blocker (`no-fresh-check`, `coverage-below`, `open-unknowns`, …) instead of pretending.
- **Runs** — build rounds (status, implementation digest, command) and check verdicts bound to each digest.

The list view opens with an **overview strip** (project count, breakdown by target kind and state, obligation pass/total, unresolved unknowns across projects); `case_project overview` returns the same data as JSON. An **empty** workbench explains in plain words what a case file is, who it is for and what the first step is; tool names (`case_evidence`, `case_claim`, …) are folded under “For developers / the AI agent” instead of being the first thing a new user reads. The **New project** form labels every field (title, target, target kind, authorization) and validates the required title on blur and on submit, with a readable error instead of a dead button.

The panel header shows the selected project's **autonomy level** (L0–L3); the badge's tooltip explains in plain words what the level means, with L0–L3 kept as a subtitle.

The header also exposes a **Trash** entry. It lists projects dropped with `case_project drop` (id, size, file count), restores one with a click, and empties the trash only after a dry-run shows the impact (`N entries / size; unknown entries are kept`). Dropped projects are moved, never deleted, until you confirm the hard delete.

A project's detail page carries a collapsed **Danger zone → Move to trash** entry for the user: it first previews the impact (file count / size, restorable) and only moves the project after an explicit confirmation, then shows it in the trash. The agent-side `case_project drop` tool requires `confirm: true` **and** is documented as "only after the user explicitly agreed, never on your own initiative" — under a full-access permission preset the model could technically call it, so the tool description and this README both put the consent requirement in writing.

Per [ADR 0002](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0002-destructive-operations.md) there is also `case_project purge` (`dryRun` + `confirm`) for scripted use, and every drop/restore/purge is written to the data root's `audit.jsonl` (a dropped project can no longer write into its own audit file).

A settings section shows the data root, project count and REA connection state. REA being absent is shown as an **optional, unavailable notice** (it does not block creating projects or recording evidence), not as an error; the raw `mcp__rea__*` detection detail is available under the same advanced fold.

## Tools

| Tool              | Actions                                     | Purpose                                                                                                          |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `case_project`    | `open`, `list`, `get`, `update`             | Open a new **or existing** project, list, inspect, change authorization tier / scope / state                     |
| `case_evidence`   | `add`, `list`, `show`                       | Store an REA observation as evidence; filter; read one                                                           |
| `case_claim`      | `add`, `list`, `search`, `select`           | Store a citable conclusion; search; select it for export                                                         |
| `case_feature`    | `add`, `list`                               | Group claims into a feature with boundaries and non-goals                                                        |
| `case_unknown`    | `add`, `list`, `resolve`                    | Record unknowns; mark one resolved with a note                                                                   |
| `case_obligation` | `add`, `list`, `close`, `reopen`            | Acceptance obligations; `close` needs a fresh passing check                                                      |
| `case_build`      | `start`, `agent`, `status`, `loop`, `cycle` | Build runs, builder sessions, and the build→check→close loop                                                     |
| `case_check`      | `run`, `list`, `loop`                       | Run one checker and bind the result to the current implementation digest                                         |
| `case_access`     | `await-login`                               | Poll a CDP page until a sign-in predicate holds (ready / timeout / error)                                        |
| `case_app`        | `inspect`                                   | One-screen macOS `.app` summary (bundle id, versions, sandbox, ATS, UTI domains)                                 |
| `case_brief`      | `export`                                    | Write the redacted spec pack (`spec.json` + `brief.md`)                                                          |
| `case_ingest`     | `ingest`, `schema`                          | Ingest an external agent's report under a stable contract (recorded, not endorsed); `schema` prints the contract |

`case_project` also carries `close`, `report` (`format: md | html | both`, redacted by default), `bundle` (machine-readable, deterministic), `overview`, `archive`, `drop` (`dryRun` / `confirm`), `trash`, `restore`, `purge` (`dryRun` / `confirm`), and `autonomy` (L0–L3 gating).

**Session memory:** every call that receives an explicit `projectId` also makes it the session's current project, and that pointer is persisted under the data root — `case_project open` with an existing project id opens it instead of failing, and after a restart the same session can keep calling tools without repeating `projectId`. If a call still omits it, the error names the last opened project as a hint instead of just failing.

Every tool returns `{ ok, data?, error?{code,message,hint}, summary }`; errors carry a stable code, so the model can correct itself instead of guessing.

**Tool-surface cost:** these 12 definitions total ~13.6 KB of `description`+`parameters` JSON (≈3.4K tokens at ~4 bytes/token) and are resident in every session, while only a small fraction of sessions use casefile. That is a deliberate trade-off (each tool keeps a self-explanatory schema); the low-frequency ones (`case_access`, `case_app`, `case_ingest`) are the first candidates to merge into a `case_misc` tool if the surface needs shrinking.

Obligations may carry `featureIds`, so a **scoped replica** can report coverage per feature: an obligation tagged with a feature only counts toward that feature's ratio; untagged ones count only globally.

## Checkers

| Checker | What it judges                                                                 | Verdicts                                      |
| ------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `build` | a shell build command: exit code + configured output paths                     | pass / fail / unknown(timeout)                |
| `cli`   | a command against `{ exitCode, stdoutIncludes, stdoutEquals, stderrIncludes }` | pass / fail / unknown(timeout)                |
| `web`   | two PNG screenshots: similarity = 1 − mean-abs-diff/255, plus a size check     | pass / fail / unknown(missing or invalid PNG) |

Screenshots are captured elsewhere (REA's browser tools or any tool the user prefers); the `web` checker only judges. The PNG decoder is in-repo (`lib/core/png.js`, no third-party dependency) and supports 8-bit RGB/RGBA, non-interlaced.

## Authorization tiers

A project carries `authTier`: `owned`, `authorized`, or `research`. Starting a **replica build** (`case_build agent` / `cycle`) is refused when the tier is `research` unless the caller passes `allowResearchTier: true` with a `reason` — the override is written to the project audit log as `auth/research-override`. This keeps the tier from being decorative: a research-only project can be investigated and specified, but not quietly reconstructed.

## Closing a project

`case_project close` refuses until the project is actually done. The gate checks, in order: at least one obligation; no `open`/`fail`/`blocked` obligations; coverage ≥ `minCoverage` (default 100%); no unresolved unknowns; a fresh check whose implementation digest matches the current build. Each blocker is reported by name, so you know what to fix.

`case_project report` writes `reports/<timestamp>/report.md` + `report.json`: coverage (global and per feature), obligation table, check table with implementation digests, unknowns, loop state, and a declaration that `unknown` never means pass.

## Acquisition: ingest, don't acquire

casefile never fetches content itself. Evidence carries a **`producer`** record — tool, version, access mode (`headful` / `headless` / `api` / `archive` / `manual` / `stealth` / `unknown`), output kind, and whether you explicitly confirmed the access method. Reports render a producer table plus one statement: the operator chose and executed the acquisition.

That is what lets you feed it anything: REA's captures, a HAR from your proxy, an HTML snapshot from Scrapling, or a screenshot you took by hand. Tier 1 (human-equivalent browsing, official APIs, public archives) is supported as-is; Tier 2 (your own session, or a mode you label `stealth`) is recorded but not endorsed; Tier 3 (CAPTCHA solving, fingerprint forgery, proxy rotation, bulk high-rate scraping) is not provided and will not be — see [DISCLAIMER.md](DISCLAIMER.md#acquisition-boundary-three-tiers--采集边界三段式).

## Clean-room attestation

Every builder session writes an **attestation** (`attestations.jsonl`): the prompt digest, the spec digest, how many claims/evidence items were fed, the auth tier and any research override, and whether the "do not read the original target" clause was actually in the prompt. The report renders it as a `## 净室 attestation` section.

The attestation is deliberately honest about its limits: DSH has no per-agent tool whitelist (see `docs/runtime/0.2.2-rc.3.md` §12.7), so isolation is **information-flow only**. The statement says so instead of claiming clean-room certification.

## Anti-false-green

The suite includes **near-miss injection** tests: an obligation is closed against a correct implementation, then one character of the output is changed, and the next round must fail that obligation and reopen it. A failed build also skips checks entirely instead of producing a misleading pass. See `packages/casefile/test/near-miss.test.js`.

## Data layout

Everything lives under the plugin's data root (default `<DSH_HOME>/casefile`, override with `dataRoot`):

```
casefile/
├── projects/<project-id>/
│   ├── project.json          # version + target + authTier + scope + REA version
│   ├── evidence.jsonl        # append-only; same id later wins
│   ├── claims.jsonl
│   ├── features.jsonl
│   ├── unknowns.jsonl
│   ├── audit.jsonl           # who did what, append-only
│   ├── artifacts/            # archived artifacts (size-capped)
│   ├── checks/               # verification runs
│   ├── spec/<timestamp>/     # exported spec.json + brief.md
│   ├── reports/              # exported reports
│   └── bundles/              # exported agent-environment bundles
├── trash/                    # dropped projects, restorable
├── audit.jsonl               # data-root audit (drop / restore / purge)
├── last-opened.json          # last opened project (UI convenience)
├── session-pointers.json     # session → project pointers
└── builder-sessions.jsonl    # builder sessions (read-only guard)
```

Rules: JSON files carry a `version`; a file written by a newer casefile is reported as read-only instead of silently rewritten. Corrupt JSON is renamed `.broken` and kept. Records are append-only, so a project directory can be reviewed and diffed.

## Config

| Key                | Default               | Meaning                                                               |
| ------------------ | --------------------- | --------------------------------------------------------------------- |
| `dataRoot`         | `<DSH_HOME>/casefile` | Where project data lives; injectable for tests                        |
| `defaultAuthTier`  | `research`            | Default authorization tier for new projects                           |
| `cleanRoomDefault` | `true`                | Reserved for the builder milestone: builder cannot see the original   |
| `checkers`         | `["cli","web"]`       | Reserved for the verification milestone                               |
| `maxRounds`        | `5`                   | Reserved for the verification loop                                    |
| `maxArtifactBytes` | `67108864` (64 MiB)   | Reject archiving artifacts larger than this (stat pre-check, no read) |

Config is read from the `casefile` row in `cordis.patch.yml`. Do not edit the profile by hand — change the row's `config:`.

## Compatibility

| Plugin          | Verified on DSH                   | What was run                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.x–0.2.x     | 0.2.2-rc.3 (macOS, desktop + web) | 138 → 177 unit tests; 52-assertion web end-to-end smoke on a throwaway DSH home; **14-assertion desktop read-only regression on a real Electron renderer (CDP)**; `pnpm gate casefile` 4/4 steps green.                                                                                                                                                                                                                               |
| 0.3.x–0.5.x     | same                              | 172 → 177 unit tests; adds `case_access` (sign-in wait), `case_app` (app-bundle first hop), artifact archiving, and project `archive`/`drop`; **exercised on 8 real projects** (local macOS app, sign-in-gated page, external-collector ingestion).                                                                                                                                                                                   |
| **0.6.x–0.8.x** | same                              | 216 unit tests; **56-assertion web end-to-end** (adds external-report ingest dryRun/real assertions); **15-assertion desktop regression** (adds autonomy badge); `pnpm gate casefile` 4/4 green. Adds: HTML report, machine-readable bundle, L3 unattended runs, external-report ingest contract (incl. automatic Craft-shaped mapping), blank-screenshot guard.                                                                      |
| 0.8.1           | 0.2.2-rc.5 (macOS, desktop + web) | No code change needed for this DSH build. 216 unit tests; **56-assertion web end-to-end smoke**; **15-assertion desktop read-only regression (run twice, idempotent)**; `pnpm gate casefile` 4/4 steps green, plus **`pnpm gate:all --repeat 2`** green across all six plugins (631s). The 43-package host diff for this release ([runtime rc.5](../../docs/runtime/0.2.2-rc.5.md)) found no change in any host API this plugin uses. |

Host APIs used here were verified by runtime inspection; the findings are recorded in `docs/runtime/0.2.2-rc.3.md` §10 (including two pitfalls: a missed `declareRemote` silently 404s only that endpoint, and `agentPresets` cannot be composed from bundle names).

**Five** target kinds were exercised in real tasks (incl. a local Electron app): **a local macOS app bundle** (Info.plist, signature surface, binary inventory — the binary layer needs REA + Ghidra, see `docs/runtime/0.2.2-rc.3.md` §13–§14), **a sign-in-gated web page** (`case_access await-login`, structure-only capture), **external-collector artifacts** (`producer` + `artifactPath` archiving), and **an app's own release package** (survey → spec → acceptance, closed end to end).

## Side effects & risks

- **Files it writes:** only under the data root above. It never writes into the investigated project, never modifies the REA binary, and never edits the profile.
- **Destructive actions:** following [ADR 0002](https://github.com/kangyishuai/dsh-plugins/blob/main/docs/adr/0002-destructive-operations.md). `case_project drop` moves the whole project directory into `<dataRoot>/trash/<timestamp>-<id>` (recoverable), needs `confirm: true`, supports `dryRun` with a count / size / target path, and writes a data-root audit entry. The tool contract says the agent must only call it **after the user explicitly agreed**; the workbench offers the same action to the user behind a preview + confirmation (Danger zone). Note that under a `danger-full-access` / `approval: never` preset the host does not add an approval prompt for this tool — full-access sessions are trusted to follow their instructions, so this consent requirement is documented rather than enforced by the host. The trash can be listed, restored and emptied (`case_project purge`, `dryRun` + `confirm`; unknown entries in the trash are kept and reported, never `rm -rf`ed). Nothing is hard-deleted without an explicit confirmation.
- **Privacy:** project data stays on this machine. Spec packs, bundles and reports are redacted by default (system-root paths, `~/…`, extended paths, and the token shapes listed above) but **you should still review a file before sharing it** — redaction is a safety net, not a guarantee.
- **Evidence quality:** casefile stores what you tell it. It does not verify an observation, and it never upgrades a claim's confidence or authority.
- **Legal:** intended for research and for software you own or are authorized to analyze. It deliberately ships **no** DRM/anti-debugging bypass and no way to reuse third-party assets. Read [DISCLAIMER.md](./DISCLAIMER.md) before use.

## Uninstall

Uninstalling the plugin does **not** delete anything: the host only removes the package. Your case files stay on disk under the data root (`<DSH_HOME>/casefile` by default — see [Data layout](#data-layout)):

- `projects/<id>/` — project records plus `artifacts/`, `spec/`, `reports/`, `bundles/` and `checks/`;
- `trash/` — projects moved there by `case_project drop` (still restorable if you reinstall);
- `audit.jsonl`, `last-opened.json`, `session-pointers.json`, `builder-sessions.jsonl` — the data-root audit trail, the last-opened pointer, the session → project pointers and the builder-session records used by the read-only guard.

Nothing is uploaded, and nothing is cleaned up on uninstall — deliberately, so a reinstall keeps your evidence. To delete the data manually (only after you have exported what you need):

```bash
du -sh "$DSH_HOME/casefile"   # see the size first
rm -rf "$DSH_HOME/casefile"   # use your configured dataRoot if you overrode it
```

Exported spec packs, reports and bundles live **inside** the project directories (`spec/`, `reports/`, `bundles/`), so they are removed with the tree; copy them out first if they matter.

## Development

```bash
pnpm verify        # lint + typecheck + plugin checks + tests
pnpm check         # plugin conventions + index metadata
pnpm test          # package unit tests
```

## License

MIT. See [LICENSE](./LICENSE) and [DISCLAIMER.md](./DISCLAIMER.md).
