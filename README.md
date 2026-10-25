# Control Center

A local workspace for understanding your projects: their purpose, progress, decisions and possible directions. Keep tasks, observations and weekly or monthly reviews together. The interface is in Russian. Works with repositories and ordinary project folders.

## Get started

Install **Node.js 22.17+** and **Git**:

```sh
git clone https://github.com/Dmitryaf/control-center.git
cd control-center
npm ci
npm run dev
```

In PowerShell use `npm.cmd`. Open [Control Center](http://127.0.0.1:4310), add project folders in **Настройки**, and scan. On each project, describe what you are creating and why in **Зачем существует**, then set its status and stage. No mandatory questionnaire is needed.

The main sections are **Обзор**, **Проекты**, **Задачи** and **История**. Checks, ideas, decisions and settings are under **Ещё**. Project pages link to tasks, observations, history, reviews and saved analyses. History combines task results, checks, decisions, observations, reviews and AI analyses; dates use your chosen timezone. Earlier task results survive later task edits and deletion. Other texts show their current saved edition, not an archive of every edit.

Tasks use one list of open items, with a separate view for completed work. Project pages have four sections: about the project, up to five open tasks ordered by priority and task number, recent history, and reviews. The latest nonempty review or saved analysis is shown with a link to its full text. Name, purpose, status and stage are editable directly; additional fields remain optional. File connections, project relations, export and removal are under **Настройки проекта**.

Known projects refresh while the HTTP server runs, with a one-minute pause between passes by default. Settings allow 0–60 minutes; 0 disables refresh. Startup or an explicit scan discovers new projects. Failed reads retain saved data. Scanning never runs project code or changes repository files.

## Reviews and analysis

Open **Анализ проектов**, select one or more projects and a week or month, then choose **Подготовить обзор периода**. You can also open reviews from a project page. Your own text is saved independently of AI results. A period retains its original timezone and calendar boundaries.

In **AI-анализ периода**, **Выбрать основной набор** explicitly selects summaries, tasks/results, observations, local decisions with their reasons, checks and earlier reviews for the chosen projects, plus your saved text of the current review, including a general review. Empty review text is not counted as a source. **Настроить источники** keeps each category adjustable. This selection makes no external call and does not enable file or dialog access. Project summaries explain the goal, type, stage and saved focus. **Предыстория** adds up to three earlier nonempty reviews and five earlier observations per selected project, separately marked as background. Other general records and earlier AI reports require their own selection. Nothing is chosen because a repository happens to be open in Codex.

Prepare a local packet, inspect its complete contents, then separately approve sending it to OpenAI. The central result is a connected account of what changed and what it means for those projects. Supporting sources and uncertainties are expandable; proposals appear only when there is a reason for them. Review and accept each proposal explicitly to create a task or idea. Existing goals or summaries can be outdated: update them or record an observation rather than expecting the model to reconstruct missing history.

Saved period analyses survive restart. **Анализ проектов** also offers a short current-state analysis using summaries, open tasks and five recent task events per project. That older workflow keeps its preview/result in memory for 15 minutes; use a period review for persistent analysis with broader history.

### OpenAI setup

Set `OPENAI_API_KEY` and `CONTROL_CENTER_OPENAI_MODEL` in the HTTP server environment using a trusted local secret mechanism, then restart it. No default model is assumed. The key does not belong in browser inputs, repository files, SQLite or logs. A configured status does not prove provider access or sufficient balance. Local work and saved reports remain available without OpenAI.

The server sends only the reviewed packet to the Responses API, with structured output and no tools. Input is limited to 80,000 UTF-8 bytes and 200 period events across up to 10 projects; output to 3,000 tokens, and requests to 60 seconds. An active month with several projects can exceed these limits. Preparation then stops without saving or sending a partial packet: choose a week, fewer projects or fewer sources. These limits are not a monetary budget. A timeout can mean a charged request with an unknown result; it is never automatically retried. New period packets require renewed approval after relevant source, model or policy changes. A secret/path filter supplements human inspection and cannot guarantee that free text is safe to send.

Optional schedules require separate permission to read future periods and send paid requests. They run only in the HTTP process, for completed periods. Missed backlogs are skipped; known failures skip that period. Unknown dispatched outcomes pause sending. Explicit continuation skips uncertain periods rather than repeating them. Changed access, models or policy require renewed approval. Reading or accepting a saved result makes no API call.

### Codex context and manual results

Codex dialog access is off by default. Inside a period analysis, select projects and explicitly permit local reading/saving of bounded excerpts. The installed Codex CLI must support the required read-only protocol; `CONTROL_CENTER_CODEX_PATH` can select its executable. Exact registered project/worktree paths define access. The app does not open arbitrary sessions, execute dialog commands or copy a complete archive.

Automatic preparation examines up to four recent candidates and selects up to two usable dialogs per project. Stale summaries do not use these two slots; up to four summaries, including stale ones, can be retained per project and review. At that storage limit, explicitly review or remove an unneeded summary before adding another; nothing is automatically deleted. Each selection contains the two latest substantive user messages and the completed reply to the latest one, at most 500 UTF-8 bytes each, in chronological order. Long excerpts retain their beginning and ending with a marked gap. This is a mechanical selection, not a semantic summary; intermediate reasoning or decisions can still be missing. Manual selection/editing remains available.

If a checked source changes, its saved summary and excerpts stay intact and require explicit review before reuse, including manually edited summaries. A content hash detects changes even when the source timestamp stays the same. Repeating preparation of an unchanged eligible source preserves manual choices. There is no background monitoring after the last check. Intentions and assistant claims are not verified results. Sending these excerpts requires separate packet approval; schedules need additional explicit permission to read and send future dialogs. Revoking access blocks new use, while previously saved reports retain their approved evidence.

A ready-made Codex analysis can be saved through the guarded local `POST /api/period-analysis/import-codex` API. It requires `purpose: "project_review"`, either one `projectId` or explicit `projectIds` (up to ten), a matching `reviewId` (general for several projects), UUID `requestKey`, declared `context`, structured `report`, and `confirm: true`. References use `project:<id>` or `codex_context:<requestKey>`. See the exact [import and report schemas](shared/period-analysis.ts). Identical retries reuse the result; conflicting input is rejected. This records a human-selected review, not proof of the external model/session. Existing imports without a declared purpose remain readable with a notice to check their grounds.

Synthetic evaluation belongs only in the offline developer workflow below. Do not import its answers as real project reviews. The import validates purpose, scope, structure and references; it cannot determine whether arbitrary prose is truthful. To remove a mistakenly imported report, inspect its saved grounds, then explicitly use **Удалить локальный анализ**. Source records and your own review remain; accepted tasks/ideas retain their evidence.

## Tasks in Codex

Tasks have stable `CC-N` identifiers, revisions and saved results. A local stdio MCP server uses the same database without requiring the browser. Build the application, register projects in Settings, then configure an MCP client to launch Node with the absolute path to `dist/server/server/mcp/index.js`.

For Codex CLI, replace the example installation path:

```sh
npm run build
codex mcp add control-center -- node "C:/tools/control-center/dist/server/server/mcp/index.js"
codex mcp list
```

If you use `CONTROL_CENTER_DATA_DIR`, pass the same value to HTTP and MCP processes. Rebuild and restart MCP after source changes. Ask Codex to resolve the session's working directory with `project_context`, check the task's project and record the actual result. The server cannot guarantee that an interrupted agent records its work. A partial result leaves the task open; stale revisions require rereading and reconciling rather than overwriting.

Current tasks own planning. Legacy focus/next fields remain readable, and importing old next steps is explicit. Editing project details or exporting YAML does not replace that plan with task contents.

## Checks and project files

Checks record a question, external actions, evidence and an explicit outcome. Git activity does not reset their external-action clock. Default in-app reminders are 3/7/14 days; settings can change them. Paused checks suppress reminders. No activity alone proves neither failure nor success.

`PROJECT.yaml` is an optional starting summary. Saved local edits take priority; a changed source hash requires explicit reconciliation. Export is explicit and preserves unknown YAML fields.

Control Center still reads decisions from connected projects' `DECISIONS.md` and `decisions/*.md`, including structured and older Markdown records. It never edits them. Bodies remain in their source files; a disposable metadata index is refreshed. Conflicting IDs remain visible separately, and unavailable sources do not serve cached bodies.

Repository visibility, private-context links and exact-path publication confirmations are local settings. Private-context roots must be outside the repository. These paths never enter YAML. The publication check examines the Git index, including staged files; it does not audit remote visibility, Git history or secrets. It never commits or publishes. Keep private sources backed up separately.

## Storage, backup and restore

SQLite stores settings, project snapshots, manual data, history, reviews, analysis packets/results, permissions and accepted proposals. The default `control-center.sqlite` location is:

- Windows: `%LOCALAPPDATA%/ControlCenter`
- macOS: `~/Library/Application Support/ControlCenter`
- Linux: `$XDG_DATA_HOME/control-center` or `~/.local/share/control-center`

`CONTROL_CENTER_DATA_DIR` overrides the directory. **Настройки → Создать резервную копию** captures committed WAL data and verifies the copy. Backups contain private data; store them privately. Repository files, dialog archives and private-context documents are not included.

Verified backups disable schedule/Codex grants and cancel pending analysis approvals in the copy; running attempts become unknown. Completed reports and accepted evidence remain intact. Ordinary restart retains current permissions and is not restoration.

To restore:

1. Note the active database path and stop **all** HTTP and MCP processes.
2. Move the current database and matching `-wal`/`-shm` files together to a recovery location. Keep them until recovery is confirmed.
3. Copy the verified backup to the active directory as `control-center.sqlite`. Do not reuse the old WAL/SHM files.
4. For a raw copy made outside the verified backup flow, first run `npm start -- --restore-recovery` (or `npm run dev -- --restore-recovery`) before starting other processes. Raw replacement is not automatically detectable.
5. Inspect records/settings, restore external files separately if needed, refresh projects and explicitly renew permissions where desired.

Supported older databases upgrade with a verified pre-upgrade backup and transactional compatibility checks. Stop older HTTP and MCP writers before upgrade. Schema 12 removes task `state` from current records and drops additional decision-directory settings. Task numbers, priorities, project links, results, completion dates and historical snapshots are preserved; external files are never deleted or imported. Old HTTP/MCP requests containing task `state` are rejected; update clients to use completion and priority. Existing pending AI packets and schedules must pass the current access guards again. Current schema is 12; the unused schema-1 prototype is unsupported. Downgrade requires restoring a compatible pre-upgrade copy, never opening a newer database with an older build. Restore replaces state; it does not merge databases.

For a moved project, scan the new location and use **Перепривязать** to preserve its ID/history. Removing a project excludes its path from discovery and detaches records; it removes local metadata, project notes and relations, but never repository/private-source files. Clearing the exclusion creates a new project identity. Recover removed local state from an earlier backup.

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
