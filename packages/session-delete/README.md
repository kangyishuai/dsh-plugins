# @kangyishuai/dsh-session-delete

> Real session deletion for DeepSeek Harness: trash by default, a plan before you delete, an audit log, and a receipt for whatever is left behind.

[中文](./README.zh-CN.md)

Unofficial plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Not affiliated with DeepSeek.

> **Status: v0.4.2, early.** Verified on DSH 0.2.1-rc.5 with `pnpm smoke:session-delete` (24 end-to-end assertions) plus a manual pass in the desktop GUI. Treat it as young software and keep backups of anything you cannot lose.

## What it does

DSH's built-in _archive_ only hides a session: the id goes into the workspace's archived set and the log files stay on disk forever. This plugin does the real deletion, with the guard rails that go with it.

- **Real deletion.** The session directory is moved out of `~/.dsh/sessions/`, and the bookkeeping that still points at it (archived set, pinned set, workspace membership, projection cache) is cleaned up — so the session doesn't come back and doesn't leave a ghost entry behind.
- **Trash by default.** The first click erases nothing: the session goes to `~/.dsh/session-trash/` and can be restored. Permanent deletion is a separate, explicit action.
- **Plan before you delete (dry-run).** The confirmation dialog is generated from a plan: on-disk size, whether the session is live, how many sub-sessions it has, and which references will be cleaned. Right before execution the plan is recomputed and compared with what you confirmed; a mismatch aborts the operation instead of deleting something you didn't see.
- **Audit log.** Every delete / restore / purge appends one JSON line to `~/.dsh/session-trash/audit.log`, readable from the trash panel.
- **Receipt after delete.** After the move, the plugin checks the places a session can be referenced and reports anything left behind (deletion is one session at a time; the trash tab supports batch restore / batch permanent delete).

## Install

```bash
dsh plugin --profile desktop add @kangyishuai/dsh-session-delete
```

To run the working tree instead of a published version, pack it first — `link:` installs do not work (the host's `@deepseek-ai/*` resolution only covers packages whose real path is inside the profile):

```bash
cd packages/session-delete
pnpm pack --pack-destination /tmp
dsh plugin --profile desktop add /tmp/kangyishuai-dsh-session-delete-*.tgz
```

Re-run `pnpm pack` + `add` after changing the code.

Restart the DSH desktop app afterwards. A fresh install adds a host half, so reloading the page is not enough.

## Usage

**Batch (in trash)**: the trash tab supports select-all / clear / batch restore / batch permanent delete; each entry is handled independently and failures are reported inline.

**Agent tool**: models can call `session_delete`, but only in two steps — `action=plan` returns the impact summary plus a single-use token (2 minutes), and `action=delete` needs that token. It refuses to delete the calling session, and a changed session invalidates the token. Deleting from the UI never requires the tool.

**Keyboard**: Tab between controls, Enter/Space to activate, Esc to close a dialog. In the trash panel, ↑/↓/Home/End move focus between rows. `⌘/Ctrl + Alt + T` opens the trash. There is no one-key delete shortcut — deletion always goes through the menu and a confirmation dialog.

**Refresh**: the trash panel has no refresh button. It loads on open and re-syncs every 5 seconds, when the window becomes visible again, and after every restore or permanent delete.


Everything starts from a session row in the sidebar:

1. Open the session's "…" menu and choose **删除会话…** (Delete session…).
2. The confirmation dialog shows:
   - how much disk space the session occupies;
   - whether the session is live (running turn, subagents, background jobs) — a live session is stopped first, not refused;
   - how many sub-sessions it has, with a checkbox to delete them together (off by default; each child goes to trash separately);
   - the references that will be cleaned: archived set, pinned set, workspace membership, projection cache.
3. Confirm. The session moves to the trash and disappears from the sidebar.
4. **回收站…** (Trash…) in the same menu opens the trash panel, where you can:
   - see each trashed entry (title, size, deletion time);
   - **restore** it to the sidebar;
   - **purge** it permanently;
   - read the audit log.

**Health check**: the trash panel has a third tab. It reconciles the session store against the workspace bookkeeping and reports dangling references (archived/pinned ghosts, workspace membership, orphan session dirs, broken trash entries, unfinished operations). Cleaning removes **bookkeeping only** — session files are never touched.

## Side effects & risks

Files and directories it touches:

| Path                                     | Access                          | What happens                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.dsh/sessions/<workspace>/<session>/` | read + move                     | Located through the host's persistence seam (`stat` / `locate`); the log filename is never hardcoded. On delete the whole session directory is moved into the trash, on restore it is moved back. Same-volume moves are a rename; across volumes it falls back to copy + verify + delete. |
| `~/.dsh/storages/workspace.json`         | through host API only           | Archived / pinned sets and workspace membership change via `workspaceRegistry` methods (archive, unarchive, pin, unpin, detachSession). The file is never edited by hand.                                                                                                                 |
| `~/.dsh/storages/session_projcache/`     | through host API, file fallback | Projection-cache entries for the session are cleared so a deleted session can't resurface in search. Direct file access happens only in the "internal" capability tier.                                                                                                                   |
| `~/.dsh/session-trash/`                  | create + write                  | One entry per deleted session (with a `meta.json`), `audit.log` (JSONL, one line per operation) and `journal/` (two-phase-commit records so an interrupted operation can be finished or rolled back on the next start).                                                                   |

- **No network access, no telemetry.**
- **Restorable by default.** Delete moves files; it does not erase them.
- **Purge is irreversible.** "Purge" (and emptying the trash) really deletes the bytes. There is no undo toast and no recovery.
- **Restore is not a full undo.** The log and workspace membership come back; the pin and archive flags do not. DSH clears a pin when it archives a session and doesn't restore it when it unarchives.
- **Uninstalling the plugin does not empty the trash.** `~/.dsh/session-trash/` is your recovery path and stays until you delete it yourself.
- **Data root.** Resolved as plugin config `dataRoot` → `DSH_HOME` → `~/.dsh`. If your DSH keeps its data somewhere else, point the plugin at it. If the root doesn't look like a DSH data directory, the plugin refuses instead of guessing.
- **Alpha software operating on your data.** It has passed GUI acceptance on the version in the table below, but it is still early software: back up anything you cannot lose.

## How this differs from the built-in archive

Archive is a bookmark, not a deletion: DSH adds the session id to the workspace's archived set and everything on disk stays where it was, still taking space and still indexed. This plugin moves the files out of the session tree, drops the references that pointed at them, keeps a recoverable copy in its own trash, and logs what it did. Archive keeps working exactly as before — this plugin adds a menu item, it doesn't replace anything.

## Compatibility & degradation

The package declares no `engines.dsh` range. Instead there are three layers of defense:

| Layer                    | When it runs         | What it does                                                              | What you see                                                   |
| ------------------------ | -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| L1 version gate          | install / activation | `engines.dsh` version range. **Not declared**, so this layer is inactive. | nothing                                                        |
| L2 startup self-check    | plugin activation    | Probes every host capability it depends on.                               | a capability grade: `api` / `internal` / `minimal` / `unknown` |
| L3 per-operation refusal | every operation      | Each operation re-checks its own prerequisites; unknown always refuses.   | structured error code + reason, no half-deleted state          |

Capability grades:

- `api` / `internal` — full operation. `internal` means some steps rely on host contracts that are not in the public docs; they run and are reported.
- `minimal` — the host has no `workspaceRegistry` (for example the headless composition). Deletion works; the archive gate, pin/workspace bookkeeping and projection-cache steps are skipped and listed in the receipt.
- `unknown` — the persistence seam itself is missing: **read-only mode**. Plan, audit and trash listing keep working; delete/restore/purge are disabled.

| Plugin | Verified on DSH          | Notes                                                                                       |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------- |
| 0.4.2  | **0.2.1-rc.5** (desktop) | `pnpm smoke:session-delete`: 24 assertions green; manual GUI pass on the same host version. |

After a DSH upgrade: restart, then open the plugin status (settings → plugins). If it reports read-only mode, the host API changed — upgrade the plugin or report the version pair; don't force it.

## Troubleshooting

| Symptom                                                    | Likely cause                                                                     | What to do                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| No 「删除会话…」 in the session menu                       | The client half didn't load: plugin inactive, or the menu slot was renamed       | Check the plugin status, make sure the plugin is enabled, restart the app after installing            |
| The menu item is there, clicking it reports read-only mode | The L2 probe can't find a host capability it needs (a DSH update changed an API) | Upgrade the plugin; if it stays read-only, open an issue with the status output and your DSH version  |
| Delete succeeded but the row stays in the sidebar          | The client-side removal channel changed                                          | Refresh the page; if the row survives, open an issue with your DSH version                            |
| A restored session lost its pin or archive flag            | DSH clears pin when archiving and doesn't restore it when unarchiving            | Expected for now; retry from the trash, and file an issue if the log itself didn't come back          |
| Purge left something behind                                | Residue that the post-delete receipt lists                                       | Read the receipt and the audit log, clean the listed path by hand, and open an issue with the receipt |
| The trash panel is empty after a delete                    | The plugin resolved a different data root than your DSH (`DSH_HOME` / config)    | Look at `~/.dsh/session-trash/` on disk and check the plugin's `dataRoot` config                      |

## License

MIT — see [LICENSE](./LICENSE). The repository's [NOTICE](https://github.com/kangyishuai/dsh-plugins/blob/main/NOTICE) credits the community projects whose _design_ informed this plugin; no code was copied from them.
