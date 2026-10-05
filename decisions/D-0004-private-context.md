---
schema_version: 1
id: D-0004
title: Separate private context from repository publication
date: "2026-10-05"
status: accepted
area: data
implementation: implemented
supersedes: []
superseded_by: null
visibility: repository
---

## Context and choice

Contributors need a clear boundary between repository files, private canonical documents, and application-owned records. A repository URL does not establish visibility, and a document name does not establish whether publication is intended. This record documents the product's storage and audit contract for external developers.

Keep explicit `unknown/private/public` visibility, one private-context root, and an exact-path publication allowlist in SQLite. A root represents the project's private layer, not just a decisions directory. Do not infer visibility through a remote or write these settings into the project. The source model extends [D-0003](D-0003-decision-sources.md); legacy decision directories and local SQLite decisions keep their existing ownership.

## Consequences

The read-only journal combines repository and private-context Markdown, shows each source, and flags duplicate IDs across sources without picking a winner. Only metadata is indexed in memory. Bodies are read on opening. Scan/refresh replaces the index; inaccessible sources expose no cached text. SQLite retains a per-link indication of previously seen private records, so losing a source remains actionable after restart. Changing or removing the link resets that indication and never changes source files.

Publication review uses the Git index, including staged additions and removals. Infrastructure paths are strong signals; decisions and maps ask for an audience review. Explicit per-path confirmations suppress future signals until revoked, including after file edits. The audit makes no claim about remote publication, history, secrets, or the adequacy of private backups.

SQLite schema 3 adds defaults without moving existing records. Export remains restricted to project-summary metadata. Private-context roots must be separate from the repository, and symbolic-link roots are rejected. Source versioning and backup remain the user's responsibility; the application neither creates nor publishes private repositories.

## Implementation and review

Owners: `server/projects/context.ts`, `server/git/tracked.ts`, `server/decisions/index.ts`, and `server/db.ts`; the UI consumes `shared/context.ts`. Evidence: `tests/context.test.ts`, `tests/e2e/context.spec.ts`, and the production smoke check. Revisit if multiple complete private contexts, content-sensitive publication confirmations, or another export format becomes a concrete requirement. No AI or remote API abstraction is introduced.
