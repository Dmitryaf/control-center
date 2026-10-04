---
schema_version: 1
id: D-0003
title: Read canonical decisions without copying ownership
date: "2026-10-04"
status: accepted
area: architecture
implementation: implemented
supersedes: []
superseded_by: null
visibility: repository
---

## Context and choice
The updated Agent Engineering Kit defines structured decision records and private versioned sources. The owner requested read-only indexing. Files remain canonical; Control Center keeps only a disposable in-memory index, with source paths and errors. Copying decisions into the editable SQLite journal would create two competing owners and is rejected.

## Boundaries and consequences
Read root DECISIONS.md and Markdown files in decisions/; a plain index is a navigation document when individual records exist. Old standalone Markdown remains visible as unstructured. Additional directories are explicitly configured per project and stored only in SQLite. No private path is exported into PROJECT.yaml. Symlinks and oversized files are rejected; Markdown is displayed as text, never executed. Invalid metadata affects one record, not the whole project. Duplicate IDs are visible as ambiguous sources instead of silently merging.

New SQLite decisions default to ecosystem-wide; previously project-linked local decisions remain editable and clearly identified. Superseded/rejected file decisions do not generate active reminders.

## Implementation and review
Owner: `server/decisions/`; frontend reads the resulting contract. `tests/decisions.test.ts` verifies structured, legacy, invalid, missing and private sources, duplicate IDs, due review and not-implemented state. The browser scenario checks connecting a private directory and exporting YAML without leaking its path. Revisit if full-text search or measured indexing cost justifies a persistent cache.
