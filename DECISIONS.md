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

One loopback Express process serves the API and Vue application. An optional stdio MCP process uses the same task owner and database. Built-in node:sqlite avoids a Windows native-addon build; short synchronous queries are acceptable for this local tool. Discovery never runs project code or traverses symlinks.

The [original architecture rationale](decisions/MVP-architecture.md) also explains YAML ownership, filesystem safety and the import guard. Revisit before adding remote clients.

## D-0005 — Tasks shared by UI and local agents

`server/tasks.ts` owns task numbers, content, results, optimistic revisions and creation idempotency. HTTP and stdio MCP call that owner against the same OS user-data SQLite database. UUIDs and legacy JSON survive schema 4; a verified backup precedes upgrade. WAL, busy timeout and immediate write transactions serialize writers; stale revisions fail explicitly.

Tasks own current work. Legacy focus and next steps stay as saved context; importing next steps is explicit and repeatable. The UI never rewrites YAML as a side effect of task changes.

MCP exposes task operations and existing project/decision context, without arbitrary files, execution, settings or deletion. Directory resolution reads only registered repository worktree lists, never matches by remote or silently uses the MCP launch directory. Agent instructions cannot certify implementation or tests; the agent records factual results and keeps partial work open. Revisit for remote access, durable work history or retirement of legacy plan fields. [Usage and limits](docs/codex.md).

## D-0006 — Refresh known projects without rediscovery

The HTTP process periodically reads registered project directories inside the current roots through `Projects.refreshKnown`, using the existing access, Git, YAML, decision and context readers. Excluded projects and saved directories outside the roots remain unavailable and are skipped. The saved interval is 0–60 minutes, default 1; 0 disables scheduling. The next pass starts after the previous pass finishes. Discovery stays on startup and explicit scanning. MCP has no timer; `project_context` explicitly refreshes the selected project.

Reads of one project share an in-flight observation; scanning waits for active reads. Snapshots carry the read start time, and SQLite rejects an older observation from another process. A lost directory preserves the previous snapshot and user data; later passes retry. Settings are rechecked before publishing a snapshot, and shutdown drains the current read before closing SQLite. Manual metadata, tasks, YAML base hashes and external-action dates are independent of snapshot updates.

The UI shows snapshot time and failed automatic reads, and preserves drafts. A metadata edit keeps its original YAML hash even as the displayed project is refreshed. This avoids silently accepting a changed source while editing. Revisit for remote clients, a continuously running service or filesystem watchers. Implementation: `server/projects/refresh.ts`, `server/projects/projects.ts`; [user behavior](README.md).
