# Backup and maintenance

Restoring data, working with project files and running developer checks. Run commands from the Control Center project folder.

## Running and updating

The launcher uses the current source files. The server stays running when you close the browser, so refresh and any enabled review schedules can continue. It does not start automatically when Windows starts. Restart the server after updating backend code. A busy port is reported without stopping another program. Startup logs are stored in `.local/launcher/`.

## Storage, backup and restore

SQLite stores settings, project snapshots, manual data, history, reviews, analysis packets/results, permissions and accepted proposals. The default `control-center.sqlite` location is:

- Windows: `%USERPROFILE%/.control-center`
- macOS: `~/Library/Application Support/ControlCenter`
- Linux: `$XDG_DATA_HOME/control-center` or `~/.local/share/control-center`

`CONTROL_CENTER_DATA_DIR` overrides the directory. Creating a backup in settings captures committed WAL data and verifies the copy. Backups contain private data; store them privately. Repository files, dialog archives and private-context documents are not included.

Windows previously used `%LOCALAPPDATA%/ControlCenter`. Packaged apps can redirect that location to their own `LocalCache/Local/ControlCenter`, so a desktop shortcut and a terminal inside a packaged app could open separate databases. The profile directory above avoids that redirection for HTTP, MCP and the desktop launcher. When the new database is absent and an old one is found, startup stops instead of creating an empty database.

For an existing Windows installation, inspect the database path in Settings in each previous launch environment and create a verified backup of the copy containing your records. If copies differ, keep both; do not overwrite or merge them blindly. Stop all HTTP and MCP writers, create `%USERPROFILE%/.control-center` and restore the chosen verified backup there using the steps below. Keep the original files and backups until records have been checked after launching from both the desktop shortcut and the terminal. A temporary explicit `CONTROL_CENTER_DATA_DIR` can still select a previous directory; an AppData override remains subject to Windows redirection.

Verified backups disable schedule/Codex grants and cancel pending analysis approvals in the copy; running attempts become unknown. Completed reports and accepted evidence remain intact. Ordinary restart retains current permissions and is not restoration.

To restore:

1. Note the active database path and stop **all** HTTP and MCP processes.
2. Move the current database and matching `-wal`/`-shm` files together to a recovery location. Keep them until recovery is confirmed.
3. Copy the verified backup to the active directory as `control-center.sqlite`. Do not reuse the old WAL/SHM files.
4. For a raw copy made outside the verified backup flow, first run `npm start -- --restore-recovery` (or `npm run dev -- --restore-recovery`) before starting other processes. Raw replacement is not automatically detectable.
5. Inspect records/settings, restore external files separately if needed, refresh projects and explicitly renew permissions where desired.

Supported older databases upgrade with a verified pre-upgrade backup and transactional compatibility checks. Stop older HTTP and MCP writers before upgrade. Schema 12 removes task `state` from current records and drops additional decision-directory settings. Task numbers, priorities, project links, results, completion dates and historical snapshots are preserved; external files are never deleted or imported. Old HTTP/MCP requests containing task `state` are rejected; update clients to use completion and priority. Existing pending AI packets and schedules must pass the current access guards again. Schema 13 adds project closure and reopening history without inventing dates or reasons for projects that were already completed. Schema 14 adds task cancellation history, preserving previous snapshots and task numbers. Existing closed projects are not changed retroactively. Current schema is 14; the unused schema-1 prototype is unsupported. Downgrade requires restoring a compatible pre-upgrade copy, never opening a newer database with an older build. Restore replaces state; it does not merge databases.

For a moved project, scan the new location and relink the existing project to preserve its ID/history. Removing a project excludes its path from discovery and detaches records; it removes local metadata, project notes and relations, but never repository/private-source files. Clearing the exclusion creates a new project identity. Recover removed local state from an earlier backup.

## Checks and project files

### Closing a project

Open a project and choose to close it. Select whether it is completed or you no longer plan to develop it, optionally add an explanation, then confirm. The closing date is recorded automatically. Open tasks are shown before confirmation and are automatically cancelled for either closing outcome. Completed tasks and saved results stay unchanged.

Closed projects remain available through the closed-project filter. Their pages show the latest outcome, date and explanation. Cancelled tasks have their own filter and a link to the closing explanation. Returning a project to active work does not reopen tasks automatically; return individual tasks when needed. Each closure and reopening remains in its history, where you can read earlier explanations in full. Projects completed before this feature keep their status without an invented closing date.

### Checks and files

Checks record a question, external actions, evidence and an explicit outcome. Git activity does not reset their external-action clock. Default in-app reminders are 3/7/14 days; settings can change them. Paused checks suppress reminders. No activity alone proves neither failure nor success.

`PROJECT.yaml` is an optional starting summary. Saved local edits take priority; a changed source hash requires explicit reconciliation. Export is explicit and preserves unknown YAML fields.

Control Center still reads decisions from connected projects' `DECISIONS.md` and `decisions/*.md`, including structured and older Markdown records. It never edits them. Bodies remain in their source files; a disposable metadata index is refreshed. Conflicting IDs remain visible separately, and unavailable sources do not serve cached bodies.

Repository visibility, private-context links and exact-path publication confirmations are local settings. Private-context roots must be outside the repository. These paths never enter YAML. The publication check examines the Git index, including staged files; it does not audit remote visibility, Git history or secrets. It never commits or publishes. Keep private sources backed up separately.

## Development

React 19, TypeScript, Vite, Express, SQLite, React Router, TanStack Query and React Hook Form. One loopback HTTP server; no accounts, cloud sync or autonomous code execution.

```sh
npm run check            # Lint, boundaries, typecheck, Node/React tests, build
npm run test:react       # React tests separately
npm run test:e2e         # Isolated browser tests; requires Microsoft Edge
npm run test:production  # Built app, persistence, backup and restart
npm run test:codex       # Optional CLI check in an empty home, no personal chats
npm run eval:period -- prepare .local/period-evaluation
npm run eval:period -- review .local/period-evaluation
npm start               # Run the built app
```

The evaluator creates eight frozen fictional cases, separate rubrics and explicit `analysis_evaluation` artifacts. It makes no provider call and does not read the user's database. Structural validity and human judgment of language/usefulness are separate. Do not substitute synthetic cases for a review of selected real projects. Tests and generated artifacts use isolated data; personal data, private documentation and credentials must never enter commits.
