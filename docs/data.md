# Backup and restore

The database contains local settings, discovered project IDs and snapshots, metadata overrides, notes, records, relations, checks, their history, repository visibility, private-context and legacy decision-directory paths, publication confirmations, and whether private canonical records were previously found. Treat backups as private data. Canonical document bodies are not stored in the database.

## Create a backup

Open **Settings → Create backup**. The app uses SQLite to capture committed data, including the write-ahead log, then verifies the copy. Backups are stored in the `backups` directory beside the database. The interface shows the full path. Copy the backup to your preferred private backup location; no automatic retention or cloud upload runs.

Repository files, private-context folders, local Agent Kit files, and external decision directories are **not** included. Version and back up those sources separately. A database backup restores their configured paths, not the files themselves. Disconnecting a private context only removes its database link; restoring an older backup can restore that link.

## Restore

1. Note the active database path in Settings and stop every Control Center process.
2. Move the current `control-center.sqlite` and any matching `control-center.sqlite-wal` and `control-center.sqlite-shm` files together to a separate recovery directory. Keep them until recovery is confirmed.
3. Copy the selected verified backup into the active data directory as `control-center.sqlite`. Do not reuse the old WAL/SHM files with this copy.
4. Start the app, inspect your records and settings, then refresh projects. Restore moved repository/private-source directories separately or update their configured paths.

Use the current application version or a newer compatible version. An older app must not open a newer database schema. Restoring a backup replaces the active state; databases are not merged.

Schema version 3 adds context settings to existing projects, with visibility `unknown`, no private-context link, and no publication confirmations. Legacy decision directories, local decisions, checks, and IDs are preserved. Existing supported databases upgrade on opening; keep a backup made with the previous app before upgrading if you need to return to that version. Downgrading a version 3 database is not supported.
