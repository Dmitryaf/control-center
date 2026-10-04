---
schema_version: 1
id: D-0001
title: Stable storage and explicit reconciliation
date: "2026-10-04"
status: accepted
area: data
implementation: implemented
supersedes: []
superseded_by: null
visibility: repository
---

## Context and choice
Use a stable OS user-data directory and explicit reconciliation for repository moves and external YAML edits. Initialize the current schema directly; there is no supported upgrade path from the unused prototype database. A working-directory database and automatic remote-based identity matching were considered and rejected: both can silently select the wrong state.

## Consequences
Backups use SQLite snapshots, including committed WAL data. Rebinding preserves the old project ID and accepts only an unused discovered target; merging two independently edited project records requires a separate explicit workflow. Forgetting detaches records and removes relations, never repository files.

Local metadata stores the YAML hash it was based on. A changed hash requires choosing a source; no field merging.

## Implementation and review
Owners: `server/db.ts`, `server/storage.ts`, `server/projects/`. Verified by `tests/reliability.test.ts`, `tests/api.test.ts`, the browser scenario, and the production smoke: database initialization, restart, WAL backup, preservation, conflict rejection, and explicit reconciliation. The project owner should revisit when multiple simultaneous writers or cross-device use becomes a real requirement.
