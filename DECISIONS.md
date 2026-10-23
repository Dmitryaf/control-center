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

One loopback Express process serves the API and React application. An optional stdio MCP process uses the same task owner and database. Built-in node:sqlite avoids a Windows native-addon build; short synchronous queries are acceptable for this local tool. Discovery never runs project code or traverses symlinks.

React Router owns client navigation, TanStack Query owns server state, and React Hook Form owns editable drafts. Successful writes refresh saved data without replacing dirty forms; stale task revisions remain explicit conflicts. One route guard aggregates dirty forms. HTTP writes keep the loopback header contract and have no automatic retry. The React migration preserves schema 5, API routes, task identities and MCP behavior. Vite serves the same SPA routes in development and production.

The [original architecture rationale](decisions/MVP-architecture.md) also explains YAML ownership, filesystem safety and the import guard. Revisit before adding remote clients.

## D-0005 — Tasks shared by UI and local agents

`server/tasks.ts` owns task numbers, content, results, optimistic revisions and creation idempotency. HTTP and stdio MCP call that owner against the same OS user-data SQLite database. UUIDs and legacy JSON survive schema 4; a verified backup precedes upgrade. WAL, busy timeout and immediate write transactions serialize writers; stale revisions fail explicitly.

Tasks own current work. Legacy focus and next steps stay as saved context; importing next steps is explicit and repeatable. The UI never rewrites YAML as a side effect of task changes.

MCP exposes task operations and existing project/decision context, without arbitrary files, execution, settings or deletion. Directory resolution reads only registered repository worktree lists, never matches by remote or silently uses the MCP launch directory. Agent instructions cannot certify implementation or tests; the agent records factual results and keeps partial work open. Revisit for remote access, durable work history or retirement of legacy plan fields. [Usage and limits](docs/codex.md).

## D-0006 — Refresh known projects without rediscovery

The HTTP process periodically reads registered project directories inside the current roots through `Projects.refreshKnown`, using the existing access, Git, YAML, decision and context readers. Excluded projects and saved directories outside the roots remain unavailable and are skipped. The saved interval is 0–60 minutes, default 1; 0 disables scheduling. The next pass starts after the previous pass finishes. Discovery stays on startup and explicit scanning. MCP has no timer; `project_context` explicitly refreshes the selected project.

Reads of one project share an in-flight observation; scanning waits for active reads. Snapshots carry the read start time, and SQLite rejects an older observation from another process. A lost directory preserves the previous snapshot and user data; later passes retry. Settings are rechecked before publishing a snapshot, and shutdown drains the current read before closing SQLite. Manual metadata, tasks, YAML base hashes and external-action dates are independent of snapshot updates.

The UI shows snapshot time and failed automatic reads, and preserves drafts. A metadata edit keeps its original YAML hash even as the displayed project is refreshed. This avoids silently accepting a changed source while editing. Revisit for remote clients, a continuously running service or filesystem watchers. Implementation: `server/projects/refresh.ts`, `server/projects/projects.ts`; [user behavior](README.md).

## D-0007 — Preserve reported work independently of current tasks

`Tasks` appends result changes, completion and reopening to `task_history` in the same transaction as the task revision. Ordinary content/state edits are not work events. `TaskHistory` owns read-only, bounded HTTP/MCP queries by task, project and inclusive UTC dates. Each event keeps the task and project name at that time; later edits cannot rewrite earlier results. The current task remains the source for planning, while history preserves reported work, not independently proven checks or agent identity.

History survives task deletion. Project removal clears its live link but keeps the historical name and snapshot; formerly linked work is distinct from originally general tasks. Rebinding a project preserves its ID and history, and a target with history cannot be silently merged. History is private local data included in database backups, with no repository export or automatic retention cleanup.

Schema 5 creates and verifies a pre-upgrade backup before migration and rechecks the schema under the write lock, so overlapping startups cannot seed history twice. It seeds only known results/completions as `baseline` using the last record-save timestamp; it cannot reconstruct earlier events. Original record JSON, IDs and task numbers are retained. Stop all older HTTP/MCP writers before upgrading; rollback uses the previous backup, never an older build on schema 5. Revisit for event removal/retention, authorship or broader audit needs. [Restore contract](docs/data.md); implementation: `server/task-history.ts`, `server/tasks.ts`, `server/db.ts`.

## D-0008 — Choose work from tasks, keep legacy plans as context

The overview shows projects with their saved goal, explicit status/stage, open `now` tasks, next task and latest persisted task-history entry. Current tasks appear once in project context; general tasks have a separate group. Links open the exact task. Paused, completed and unavailable projects retain their explicit state; missing work records do not imply inactivity. The catalog uses the same project card. Each overview card reads one latest entry through the existing bounded history API, without deriving result dates from mutable task timestamps.

Attention keeps every actionable project/check signal and decision priority, including pending general decisions. Checks and Git remain expandable details. The recent-work section reads up to five task-history entries for all time or the last 7/30 inclusive UTC days and links to the same dates in history. It names its task-only coverage and incomplete current day. Loading/error/empty states are explicit; failed refreshes retain previously loaded records. Observations and period reviews are separate future work. Reported work and commits never replace external check actions or reset their clock.

The project UI treats `current_focus` and `next` as read-only legacy context, separate from current tasks. Explicit next-step import is repeatable and retains the original plan. The editor omits legacy fields; the API preserves their latest values under the write lock, while existing clients can still explicitly update them. Explicit YAML export retains the plan; tasks/results are not copied into YAML. The YAML format and metadata HTTP API remain compatible. No automatic conversion, deletion or schema migration is needed for this UI transition.

This reduces competing plans and repeated detail while retaining access to signals and history. Revisit before retiring legacy API fields or supporting a different overview workflow. Implementation: `src/features/overview/Overview.tsx`, `src/features/projects/ProjectDetail.tsx`; [usage](docs/codex.md).

Attention does not require legacy focus/next fields or treat an empty task board as a problem. Git inactivity is informational; pending local decisions carry decision priority. Tasks remain the visible source of current work, while existing operational errors and blockers retain their signals.

## D-0009 — Review selected saved data before requesting AI proposals

Manual analysis uses a whitelisted packet from selected saved project metadata, open tasks and five recent work records per project. It excludes repository/Git paths, files, notes, private context and decision bodies. The server freezes the exact packet shown for approval, bounds its size without truncation and rejects recognizable secrets/paths. Text may still contain private information; explicit review is required. Snapshot dates and reported work retain their meaning. No refresh, model tool, file execution or automatic task write is introduced.

`ProjectAnalysis` owns up to ten previews/results in HTTP-process memory, accessible for 15 minutes; expired entries are reclaimed on subsequent operations and restart invalidates them. A project removed after preparation prevents dispatch. One preview can initiate at most one Responses API request, with one active call per process, a timeout, bounded input/output and no automatic retries. Success or failure is cached for safe local retry; a new preview is a new possible charge. The fixed OpenAI HTTPS adapter reads key/model only from server environment, uses `store: false`, rejects redirects and hides raw provider errors. This does not claim zero provider retention or a fixed monetary budget.

Model output is untrusted: the schema, project/source references and recognizable secrets/paths are checked independently; React renders it as text. Each approved proposal goes through the existing Tasks API with duplicate protection and a stable request key. Only accepted tasks persist in SQLite/backups; analysis packets/results disappear from memory after expiry or restart. Revisit for persisted analysis history, background work or execution capabilities. Implementation: `server/analysis/`, `shared/analysis.ts`, `src/features/analysis/Analysis.tsx`; [operator guide](docs/analysis.md).

## D-0010 — Read history from its original owners

The common/project timeline is a read projection of task-history snapshots, check starts/conclusions/entries, local decisions, observations, period reviews and dated metadata from the existing file-decision index. `server/history.ts` owns `/api/history`; `shared/history.ts` defines its contract and `src/features/history/` owns `/timeline`. `/history`, `/api/task-history` and MCP remain compatible. No event-copy table, file-body archive or additional filesystem reader is introduced.

Only task history is immutable. Other sources show their current saved edition with their declared day; edits, deletions and lost project links cannot reconstruct earlier states. Day-only records have no invented timestamp. Baseline timestamps remain migration snapshots, and source information does not prove authorship or truth. Undated files, unavailable sources and projects without a loaded index are disclosed separately. Optional removed files disappear from the projection; this is not a complete historical archive.

SQL selects a bounded page ordered by day, known timestamp and unique source key; a cursor avoids offset shifts when newer results arrive. Source edits/deletions can still change the live selection. Previews are bounded and link to the source; canonical file bodies remain behind the existing explicit reader. Project filters use retained identities where the original source still records them; unlinked records remain distinguishable by their saved name. Calendar zones and manual reviews are defined by D-0012. Revisit for a historical snapshot across mutable sources.

## D-0011 — Store observations as local editable records

Observations have a body, declared calendar date and optional project. `server/observations.ts` owns CRUD; `shared/observations.ts` validates create, explicit PATCH fields and revision-guarded deletion. `src/features/observations/` owns drafts; the common history is their bounded reader. No separate note catalog, event copy, repository export or automatic AI input is introduced. Only the current text is stored; prior editions require a backup.

Schema 6 adds `observations` after a verified pre-upgrade backup and rechecks supported versions under the write lock before DDL. Existing IDs, raw record JSON and task snapshots are preserved. Live `project_id` detaches on removal; `scope_project_id` and `project_name` preserve the original identity/name. Editing only the body retains that identity; explicit reassignment or choosing a general record changes it. Project removal advances observation revisions; rebind checks occupied targets under the same write lock.

Updates and deletion require the saved revision and reject stale input without replacing drafts. An optional creation request key follows the existing task convention: identical retries return the saved observation while that record exists; a changed payload conflicts. HTTP writes retain loopback/JSON guards and have no automatic retry. Stop all old HTTP/MCP writers before upgrade; returning to an older build requires restoring its pre-upgrade backup. Revisit for text-version history, retention or independent observation tools. [Recovery](docs/data.md).

## D-0012 — Keep manual period reviews and their calendar boundaries

`server/reviews.ts` owns one local document per stable scope, period kind and calendar start. `shared/reviews.ts` validates creation and text-only revision-guarded updates/deletion; `src/features/reviews/` opens a week or month from History or a project. Creating the same calendar key reopens the existing document without changing its text. Period identity, timezone and boundaries cannot be edited. Removing a project detaches the live link and advances the revision while retaining its scope/name; rebind rejects occupied targets under the write lock.

`shared/periods.ts` uses date-fns and `@date-fns/tz` for Monday–Sunday weeks and calendar months in a validated IANA timezone. Settings default explicitly to Asia/Yekaterinburg. The document freezes both calendar dates and the half-open instant interval [start, nextStart) at creation; changing settings neither moves it nor creates another document for that named period. Incomplete/future periods are identified in the UI. Timeline timestamps use its selected zone; date-only sources do not move. `/api/history` defaults to UTC when the optional timezone is omitted, and the old task-history HTTP/MCP contract stays UTC.

The timeline projects the current review once. General reviews link project documents; monthly reviews link overlapping weeks in full, label boundary crossings and do not copy their text. Related links and source events are paginated current reads, not frozen evidence or reconstructed end-of-period states. `/api/reviews/:id/history` accepts only cursor/limit; scope and instant boundaries come from the saved document, while date-only events retain its calendar range. Reviews themselves are excluded from events and remain separate links. User text persists independently of source edits/deletion; prior text editions require a backup. AI generation, scheduling and external context are separate capabilities.

Schema 7 adds reviews and persists a missing timezone setting after a verified pre-upgrade backup, rechecking compatibility under the write lock. Existing records and IDs remain intact. Stop all old HTTP/MCP writers before upgrade; downgrade requires restoring the pre-upgrade backup with every process stopped. Revisit for persisted AI analyses, versioned text or frozen source evidence. [Recovery](docs/data.md).
