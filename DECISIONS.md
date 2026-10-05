# Decisions

Current choices for contributors. Existing ADR metadata is retained because Control Center reads it as product data.

## D-0001 — Stable local storage

SQLite in the OS user-data directory owns saved metadata. Repository moves and YAML conflicts require an explicit choice. Removing a project preserves its files and detached records, and excludes its path from the next scan.

This prevents accidental replacement or silent rediscovery. [Storage contract](decisions/D-0001-local-data.md).

## D-0002 — External progress is separate from Git

Checks track external actions, evidence and an explicit outcome. Git never resets the external-action clock; pausing suppresses reminders without erasing history.

This separates implementation activity from learning whether an idea works. [Check semantics](decisions/D-0002-checks.md).

## D-0003 — Read decisions at their source

Files remain canonical. The application reads them and keeps only a disposable metadata index, avoiding competing editable versions in SQLite.

[Sources and compatibility](decisions/D-0003-decision-sources.md).

## D-0004 — Private context stays separate

Visibility, private-context root and publication confirmations are explicit local settings. Private paths never enter PROJECT.yaml. Reviewing the Git index does not prove remote publication or backup safety.

This separates public files from private context. [Context contract](decisions/D-0004-private-context.md).

## Runtime and code boundaries

One loopback Express process serves the API and Vue application. Built-in node:sqlite avoids a Windows native-addon build; short synchronous queries are acceptable for this local tool. Discovery never runs project code or traverses symlinks.

The [original architecture rationale](decisions/MVP-architecture.md) also explains YAML ownership, filesystem safety and the import guard. Revisit before adding remote clients or multiple writers.
