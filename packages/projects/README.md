# @kangyishuai/dsh-projects

> Project-level context for DeepSeek Harness: group sessions into projects, inject project instructions and memory, run isolated parallel threads, and coordinate them with an optional auditable coordinator.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: early development (M1).** The project store is implemented and tested; context injection, the threads panel, and the coordinator are not shipped yet. Nothing in this release touches a remote repository.

## What it does

DSH groups sessions by working directory and gives the model no project-level memory. This plugin adds the missing layer:

- **Project as a first-class context unit** — a durable record with a goal, directories, budget, and policy. Session membership is stored by the plugin (not derived from an immutable `cwd`).
- **Project instructions and memory injection** _(M1, in progress)_ — every session attached to a project receives the project's standing rules and `MEMORY.md` index before each request.
- **Isolated parallel threads** _(M2)_ — one session per task, each with its own Git worktree when the project directory is a repository.
- **Overview with what needs you** _(M2)_ — thread states derived from the session event log, not from model self-reports.
- **Optional coordinator** _(M3)_ — event-driven wake, rule-first routing with an auditable decision record, and a per-project autonomy level. Off by default (`L1` = propose, do not start).
- **Opt-in remote writes** _(M4)_ — draft PRs and an auto-fix loop, all default off, each gated by a human-originated authorization.

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-projects
```

Restart the DSH desktop app afterwards.

## Side effects & risks

- **Writes metadata** under `$DSH_HOME/projects/projects.json` (or `config.dataRoot` when set). Atomic replace via a temp file; a corrupt file is renamed aside and never deleted.
- **Never touches session logs.** Detaching or archiving a project leaves every `session.v*.jsonl.zstd` untouched.
- **No remote writes in this release.** `git push`, `gh`, and any merge action are not implemented yet; they will ship opt-in and default off.
- **No credentials are read into model context** by design.
- If the metadata file cannot be read (permissions, newer format), the plugin stays inert and logs a warning instead of failing the harness.

## Compatibility

| Plugin | Verified on DSH |
| ------ | --------------- |
| 0.0.0  | 0.2.2-rc.3      |

## License

MIT
