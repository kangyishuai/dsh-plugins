# @kangyishuai/dsh-projects

> Project-level context for DeepSeek Harness: group sessions into projects, inject project instructions and memory, run isolated parallel threads, and coordinate them with an optional auditable coordinator.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: M2 (parallel work, still pre-1.0).** Projects, context injection, and parallel threads with Git worktree isolation are implemented and covered by end-to-end tests. The coordinator (wake, routing, autonomy) and any remote write are **not** shipped yet.

## What it does

DSH groups sessions by working directory and gives the model no project-level memory. This plugin adds the missing layer:

- **Project as a first-class context unit** — a durable record with a goal, directories, budget, and policy. Session membership is stored by the plugin (not derived from an immutable `cwd`).
- **Project instructions and memory injection** _(M1, in progress)_ — every session attached to a project receives the project's standing rules and `MEMORY.md` index before each request.
- **Project-level budget gate** — a daily thread cap and a concurrent cap are enforced before a thread is created (token-level spend caps come with the coordinator).
- **Pause, archive, delete** — pause is reversible and only blocks new threads; delete follows ADR 0002: one-line impact (threads, size, running, restorable), a two-step confirm, and everything moved into `trash/` with a `manifest.json`.
- **In-app notifications** — a global overlay poller raises a toast when a thread newly fails or starts waiting on you; the browser Notification API stays off by default.
- **Isolated parallel threads** — one session per task. When the project directory is a Git repository, the thread gets its own worktree under `<repoParent>/.dsh-worktrees/<repo>/`; otherwise it degrades to a shared directory with an explicit warning instead of failing.
- **Overview with what needs you** — five thread states (`waiting-user > failed > working > done > idle`) derived from the durable session event log, not from model self-reports; whatever needs you sorts first.
- **Optional coordinator** _(M3)_ — event-driven wake, rule-first routing with an auditable decision record, and a per-project autonomy level. Off by default (`L1` = propose, do not start).
- **Opt-in remote writes** _(M4)_ — draft PRs and an auto-fix loop, all default off, each gated by a human-originated authorization.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-projects
```

Restart the DSH desktop app afterwards.

## Side effects & risks

- **Writes metadata** under `$DSH_HOME/projects/projects.json` (or `config.dataRoot` when set). Atomic replace via a temp file; a corrupt file is renamed aside and never deleted.
- **Creates Git worktrees** next to your repository (never inside it and never inside `.git/`) when you create a thread for a project that has a Git directory. Archiving the thread removes the worktree again **only** when it is clean, has no unpushed commits, and is not the current session's directory; otherwise it is kept and reported.
- **Runs `git`** through `node:child_process` for worktree create/remove and the cleanliness checks. No network, no credentials.
- **Never touches session logs.** Detaching or archiving a project leaves every `session.v*.jsonl.zstd` untouched.
- On startup the plugin reconciles its records: a recorded worktree that no longer exists is dropped from the record, while an unrecorded directory on disk is **kept** and only reported.
- **No remote writes in this release.** `git push`, `gh`, and any merge action are not implemented yet; they will ship opt-in and default off.
- **No credentials are read into model context** by design.
- If the metadata file cannot be read (permissions, newer format), the plugin stays inert and logs a warning instead of failing the harness.

## Compatibility

| Plugin | Verified on DSH |
| ------ | --------------- |
| 0.1.x  | 0.2.2-rc.3      |

## License

MIT
