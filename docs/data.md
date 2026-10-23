# Backup and restore

The database contains local settings, discovered project IDs and snapshots, metadata overrides, notes, records, observations, period reviews, relations, checks, their history, saved task work history, repository visibility, private-context and legacy decision-directory paths, publication confirmations, and whether private canonical records were previously found. Treat backups as private data. Canonical document bodies are not stored in the database.

## Create a backup

Open **Settings → Create backup**. The app uses SQLite to capture committed data, including the write-ahead log, then verifies the copy. Backups are stored in the `backups` directory beside the database. The interface shows the full path. Copy the backup to your preferred private backup location; no automatic retention or cloud upload runs.

Repository files, private-context folders, local Agent Kit files, and external decision directories are **not** included. Version and back up those sources separately. A database backup restores their configured paths, not the files themselves. Disconnecting a private context only removes its database link; restoring an older backup can restore that link.

## Restore

Project-removal exclusions are stored in local settings and included in backups. Older settings without `excludedProjectPaths` use an empty list. Removing a project changes only the database: its records and check history are preserved without a project link, while project notes, metadata overrides and relations are removed. Rediscovery creates a new project; recovering the former local state requires a backup from before removal.

1. Note the active database path in Settings and stop every Control Center process, including all MCP processes launched by Codex.
2. Move the current `control-center.sqlite` and any matching `control-center.sqlite-wal` and `control-center.sqlite-shm` files together to a separate recovery directory. Keep them until recovery is confirmed.
3. Copy the selected verified backup into the active data directory as `control-center.sqlite`. Do not reuse the old WAL/SHM files with this copy.
4. Start the app, inspect your records and settings, then refresh projects. Restore moved repository/private-source directories separately or update their configured paths.

Use the current application version or a newer compatible version. An older app must not open a newer database schema. Restoring a backup replaces the active state; databases are not merged.

Schema version 3 adds context settings to existing projects, with visibility `unknown`, no private-context link, and no publication confirmations. Legacy decision directories, local decisions, checks, and IDs are preserved. Existing supported databases upgrade on opening; keep a backup made with the previous app before upgrading if you need to return to that version. Downgrading a version 3 database is not supported.

Schema version 4 introduced task numbers, revisions and creation request keys in a separate table, preserving UUIDs and existing record JSON. Upgrading a pre-v4 supported database uses a verified `backups/before-tasks-v4-*.sqlite` snapshot; failure stops the upgrade. Reopening does not renumber tasks. See the [task migration guide](codex.md#данные-и-переход).

Schema version 5 adds read-only task work history. A version 4 database first receives a verified `backups/before-history-v5-*.sqlite` backup; earlier supported versions use the previous `before-tasks-v4` prefix and upgrade in the same transaction. Only known results or completions are seeded as baseline records, using the last task-save time; unknown earlier work is not reconstructed. Migration preserves record JSON, IDs, links, numbers and revisions. Backup failure leaves the old schema untouched, and reopening does not duplicate history. Stop **all** older app and MCP writers before upgrading; a schema 5 database must not be opened by an older build. Restore the pre-upgrade backup to return to the previous version.

Deleting a task preserves its work history; removing a project clears live history links but retains its historical name and task snapshots. These remain private database data until the database is removed or replaced through restore. No history-edit/delete API, automatic retention cleanup, export to repositories or cloud upload is provided. A backup includes the history, and restoring it replaces the current history along with other database state.

Schema version 6 adds observations without converting project notes or task results. Existing version 5 databases receive a verified `backups/before-observations-v6-*.sqlite` snapshot; earlier supported versions retain the previous backup prefixes and complete the upgrades in one transaction. Backup or DDL failure leaves the old schema intact; reopening does not duplicate observations or task history. Compatibility is rechecked under the write lock before DDL. Stop **all** old app and MCP processes before opening the new build. Downgrade is unsupported: restore the pre-upgrade backup with every process stopped before returning to an older build.

Observation backups contain the current text, date, revisions, creation request keys and retained project identity/name. Project removal clears the live link but preserves the historical identity; explicitly choosing a general observation clears it. Renaming a project does not rewrite the saved name. Deleting an observation removes its text and creation key; only an earlier backup can recover it. No archive of prior text editions or cloud upload is created.

Schema version 7 adds manual period reviews and a missing timezone setting, defaulting to Asia/Yekaterinburg. A version 6 database first receives a verified `backups/before-reviews-v7-*.sqlite` snapshot; older supported versions retain their previous backup prefixes. Migration preserves existing records and IDs, checks compatibility under the write lock and rolls back on DDL failure. Stop every old app/MCP writer before opening the new build. Returning to an older build requires restoring the pre-upgrade backup with all processes stopped.

Review backups include current user text, revisions, stable scope/name, declared period dates, timezone and frozen UTC boundaries. Reopening a calendar period reuses its document; settings changes do not move saved reviews. Project removal detaches its live link but retains the scope and advances revisions. Related reviews and events are current read projections, not archived copies; deleting a review removes its text without deleting source records. Earlier text editions require an earlier backup. No AI run, schedule or external context is activated by this migration or restore.

Schema version 8 adds saved period-analysis runs after a verified `backups/before-analysis-v8-*.sqlite` snapshot for a version 7 database; older supported databases retain their earlier backup prefixes. The migration keeps existing records, IDs, review text and event history, rechecks compatibility under the write lock and rolls back on DDL failure. Stop every old app/MCP writer before upgrading. Downgrade requires the pre-upgrade copy with all processes stopped.

Analysis packets, minimal source evidence, reports, model/usage/response metadata and errors are private database data. In backups, pending runs become cancelled and running requests become unknown; completed variants remain intact, and the live database is unchanged. Restore does not resume dispatch. A request marked unknown may have been charged; a new variant needs explicit acknowledgement and send approval. Removing the review detaches its saved analyses and cancels pending packets, without erasing completed reports. Deleting a local analysis removes its packet and result, not the user review or sources. Provider retention is separate from local deletion.
