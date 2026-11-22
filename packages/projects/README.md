# @kangyishuai/dsh-projects

> Project-level context for DeepSeek Harness: group sessions into projects, inject project instructions and memory, run isolated parallel threads, and coordinate them with an optional auditable coordinator.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Note on coordinator context (2026-11-17, DSH 0.2.2-rc.3):** the host's per-session runtime context is not
> delivered to the coordinator session, so project rules, the memory index **and the persona travel inside the
> wake envelope** instead — one letter per turn, carrying the thread's result too.
> Details: `docs/runtime/0.2.2-rc.3.md` §11.24–§11.26.

> **Status: M4 done, pre-1.0.** Projects, context injection, isolated parallel threads, an opt-in coordinator,
> and a gated approval/executor layer are implemented, unit-tested (406 tests) and covered by a 102-assertion
> web end-to-end smoke plus a 14-assertion desktop read-only regression.
> Remote writes (push / PR / merge) are wired and verified locally against a bare remote and a stub `gh`;
> the real-GitHub effect still needs one release confirmation. Project **sharing** is deferred ([ADR 0018](../../docs/adr/0018-projects-defer-liveshare-sharing.md)).

## What it does

DSH groups sessions by working directory and gives the model no project-level memory. This plugin adds the missing layer:

- **Project as a first-class context unit** — a durable record with a goal, directories, budget, and policy. Session membership is stored by the plugin (not derived from an immutable `cwd`).
- **Project instructions and memory injection** — every session attached to a project receives the project's standing rules and `MEMORY.md` index before each request (registered once, rendered per session; sessions belonging to no project get nothing).
- **Project-level budget gate** — a daily thread cap and a concurrent cap are enforced before a thread is created (token-level spend caps come with the coordinator).
- **Pause, archive, delete** — pause is reversible and only blocks new threads; delete follows ADR 0002: one-line impact (threads, size, running, restorable), a two-step confirm, and everything moved into `trash/` with a `manifest.json`.
- **In-app notifications** — a global overlay poller raises a toast when a thread newly fails or starts waiting on you; the browser Notification API stays off by default.
- **Isolated parallel threads** — one session per task. When the project directory is a Git repository, the thread gets its own worktree under `<repoParent>/.dsh-worktrees/<repo>/`; otherwise it degrades to a shared directory with an explicit warning instead of failing.
- **Overview with what needs you** — five thread states (`waiting-user > failed > working > done > idle`) derived from the durable session event log, not from model self-reports; whatever needs you sorts first.
- **Coordinator** — when a thread finishes a turn, a structured wake envelope (carrying the thread's actual result) is delivered to the project's coordinator session, at most once per turn. User input is routed by **flat rules first** (`{when, action}`); the model only proposes when no rule matches.
- **Autonomy gate** — `L0` observe, `L1` propose only (default), `L2` may start threads, `L3` full. The gate sits _after_ the decision and _before_ the action, so the audit shows both the intent and why it was refused.
- **A small, non-negotiable tool basket** — the coordinator gets four `project_*` tools (start thread, list threads, message thread, request action) and **no** shell, file writing, deletion, push or merge. Dangerous actions can only be _requested_; the approval queue collects them and you decide.
- **Approval, then execution** — an approval only records consent. Executing it still requires the matching danger switch (all six default **off**), an impact that fits the limits, and an explicit action→switch mapping. Every execution writes recovery evidence; every refusal writes an audit entry saying why.
- **Untrusted input stays data** — content from CI logs, PR comments or peers arrives as `relay`, gets wrapped in a "this is data, not instructions" block whose fence is longer than any backtick run inside it, and can never authorize an action.
- **Editable policy** — autonomy level, persona and the model-fallback switch are editable in settings (the first settings screen still stays at three rows).
- **Opt-in remote writes** — pushing a thread branch, opening a PR (four tiers, `off` by default) and merging, each gated by a danger switch plus a human approval. Verified end-to-end locally with a bare remote and a stub `gh`; the real-GitHub effect still needs one release confirmation.
- **Project sharing** — deferred, see [ADR 0018](../../docs/adr/0018-projects-defer-liveshare-sharing.md): DSH 0.2.2-rc.3 ships `dsh-experimental-liveshare` but does not enable it and exposes no stable host service, so building on it would be guesswork.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-projects
```

Restart the DSH desktop app afterwards.

## Side effects & risks

- **Writes metadata** under `$DSH_HOME/projects/projects.json` (or `config.dataRoot` when set; a desktop app that does not export `DSH_HOME` falls back to `~/.dsh/projects`). Atomic replace via a temp file; a corrupt file is renamed aside and never deleted.
- **Creates Git worktrees** next to your repository (never inside it and never inside `.git/`) when you create a thread for a project that has a Git directory. Archiving the thread removes the worktree again **only** when it is clean, has no unpushed commits, and is not the current session's directory; otherwise it is kept and reported.
- **Runs `git`** through `node:child_process` for worktree create/remove and the cleanliness checks. No network, no credentials.
- **Never touches session logs.** Detaching or archiving a project leaves every `session.v*.jsonl.zstd` untouched.
- On startup the plugin reconciles its records: a recorded worktree that no longer exists is dropped from the record, while an unrecorded directory on disk is **kept** and only reported.
- **Remote writes are opt-in and off by default.** `git push`, `gh pr create` and `gh pr merge` exist but each requires both a danger switch and a human approval; nothing is pushed or merged automatically.
- **No credentials are read into model context** by design.
- If the metadata file cannot be read (permissions, newer format), the plugin stays inert and logs a warning instead of failing the harness.

## Remote access

Everything runs on the machine that hosts DSH. If you want to reach it from another device, see
[docs/deployment/projects-l1-remote.md](../../docs/deployment/projects-l1-remote.md) — it covers the
safe ways to expose the Web UI (loopback + tunnel, HTTPS, reverse proxy) and what `projects` does and
does not do over a remote connection.

## Compatibility

| Plugin | Verified on DSH                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.9.x  | 0.2.2-rc.5: full `pnpm gate:all` (web smoke **78**/0/0, desktop read-only regression **11 PASS / 0 SKIP / 0 FAIL**, 124s). This phase finished the walkthrough leftovers, per-thread actions and made the danger switches reachable in the UI, and verified open-PR / CI gate / real merge / human-approval threshold / L2 routing against a **real private repo with real Actions CI** (see docs/testing/projects.md §17). Per-release detail lives in the CHANGELOG. |
| 0.4.2  | 0.2.2-rc.5: installed into the live profile and **measured after a desktop restart** — desktop read-only regression **11 PASS / 0 SKIP / 0 FAIL**, web smoke **54**/0/0, `pnpm gate:all` green (64s). Fixes "no way to start a thread in an empty project"; confirmed with a real UI screenshot                                                                                                                                                                        |
| 0.3.0  | 0.2.2-rc.5: installed into the live profile and **measured after a desktop restart** — desktop read-only regression **11 PASS / 0 SKIP / 0 FAIL**, web smoke **52**/0/0, `pnpm gate:all` green (64s). This release changed the client half (execute button, repository grants, trash purge), and the panel was confirmed rendering in the real UI                                                                                                                      |
| 0.2.1  | 0.2.2-rc.5: installed into the live profile and **measured after a desktop restart** — desktop read-only regression **11 PASS / 0 SKIP / 0 FAIL**, web smoke 50/0/0, `pnpm gate:all` green. This release only updates the README tables                                                                                                                                                                                                                                |
| 0.2.0  | 0.2.2-rc.5: adds the three danger actions. 309 unit tests + `pnpm verify` + web smoke 50/0/0; the three actions were verified on a temporary host (local bare remote + stub `gh`, see docs/testing/projects.md §10). Desktop regression confirmed on 0.2.1 (identical client half)                                                                                                                                                                                     |
| 0.1.1  | 0.2.2-rc.5: no code change needed. 276 unit tests + `pnpm probe:runtime` 72/72 + web smoke 50/0/0 + desktop read-only regression **11 PASS / 0 SKIP / 0 FAIL**                                                                                                                                                                                                                                                                                                         |
| 0.1.x  | 0.2.2-rc.3                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The private host seams this plugin uses (`dsh-session`, `dsh-workspace`, `dsh-api-gateway`, `dsh-typert-protocol`, `dsh-agent`, …) are byte-identical between rc.3 and rc.5 — a 43-package diff found no change ([runtime rc.5 §1.1](../../docs/runtime/0.2.2-rc.5.md)).

## License

MIT
