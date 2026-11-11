# Backup and maintenance

## Running and architecture

One Express process binds to loopback, default `127.0.0.1:4310`. Development uses Vite middleware; production serves the built React application. The optional stdio MCP server uses the same SQLite. `/api/health` identifies the checkout/database instance.

`server/app.ts` composes HTTP routes; domain owners are `projects/`, `tasks.ts`, `task-history.ts`, `checks/`, `observations.ts`, `reviews.ts`, `history.ts`, `analysis/` and `codex/`. `shared/` holds schemas/DTO without React or Node dependencies. `src/features/` owns screens, `src/shared/` owns common UI/query/drafts. Dirty forms are protected; mutations are not automatically retried. Boundaries are checked by `scripts/check-boundaries.ts`.

The Windows launcher uses `Control Center.vbs` and `scripts/launch.ps1`, verifies instance identity and serializes concurrent starts. It does not stop unrelated processes. Closing the browser leaves the HTTP process running; restart it after backend updates. Logs are in `.local/launcher/`.

## Storage, backup and restore

SQLite stores project identities/snapshots, settings, tasks and immutable result history, observations, reviews, analysis and permissions. Current schema is 15.

| Platform | Default data directory                                             |
| -------- | ------------------------------------------------------------------ |
| Windows  | `%USERPROFILE%/.control-center`                                    |
| macOS    | `~/Library/Application Support/ControlCenter`                      |
| Linux    | `$XDG_DATA_HOME/control-center` or `~/.local/share/control-center` |

`CONTROL_CENTER_DATA_DIR` overrides the directory. Older Windows AppData copies are detected when the new database is missing; startup refuses to hide them behind an empty workspace. Inspect the actual path and choose a verified copy before migration. Retain differing originals.

Create a backup in Settings. It captures committed WAL data and verifies the copy. In the copy, schedule/Codex grants are disabled, pending approvals cancelled and running attempts marked unknown. Successful reports and accepted evidence remain intact. Repository files, private context, dialog archives and separate CLI credentials are outside this backup.

To restore:

1. Record the active database path and stop every HTTP/MCP writer.
2. Preserve the existing database and its matching WAL/SHM together in a recovery directory.
3. Copy the verified backup as `control-center.sqlite` into the chosen data directory; do not attach old WAL/SHM sidecars.
4. For a raw copy outside the verified backup flow, run `npm start -- --restore-recovery` or `npm run dev -- --restore-recovery` before other processes.
5. Inspect records/settings, recover external files separately and renew desired grants explicitly.

Supported schema upgrades make a verified pre-upgrade backup and migrate transactionally. Stop old writers before upgrading. Schema 1 is unsupported. A downgrade requires a compatible backup; restore replaces state and does not merge databases.

## Project and task lifecycle

Task completion stores its result/history atomically. Current tasks have no generic `state`; open/completed/cancelled are derived from completion and cancellation fields. Task numbers, identities and historical snapshots persist through reopening.

Closing a project records completed/stopped, an optional explanation and event date. Open tasks are cancelled in the same transaction, while completed work stays intact. Returning the project does not reopen its tasks automatically. Old completed projects retain unknown historical dates rather than invented closure events.

Removing a project deletes its catalogue metadata/notes/relations, detaches records, removes its exact explicit scan root and excludes rediscovery. Shared parent roots and external files remain. Rediscovery creates a new identity. Restore removed local state from an earlier backup.

## Project files and checks

`PROJECT.yaml` is an optional initial summary. Saved metadata take precedence; a changed source hash needs explicit reconciliation. Export is explicit and preserves unknown fields. Relink a moved repository to preserve its identity.

Decisions are read from connected projects' `DECISIONS.md` and `decisions/*.md`. Bodies stay at the source; the metadata index is disposable. Unavailable sources do not return cached bodies. Private context paths and publication allowlists are local settings, excluded from YAML. A Git-index publication check does not audit remote visibility, all history or secrets and never publishes.

Checks distinguish question, external actions, evidence and conclusion. Git activity does not reset the external-action clock; pause suppresses reminders. A period without activity is not itself a failed check.

## Developer checks

```sh
npm run check
npm run test:e2e
npm run test:production
```

`check` runs lint/boundaries, types, Node/React tests and build. E2E uses Edge and isolated data. Production smoke tests persistence, backup and restart. `test:codex` is an optional CLI probe in an empty profile; `eval:period` works with synthetic cases. None of these runs establishes the usefulness of a real model response.

Production launch: `npm run build`, then `npm start`. MCP: `npm run mcp`. API mutations require matching Host/Origin, JSON and `x-control-center: 1`; the service is intended for local access.
