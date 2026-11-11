# Analysis and Codex

Control Center prepares a bounded context for selected projects and a period, saves the resulting discussion, and lets the owner explicitly accept proposals. It does not execute project work from a model response.

## Manual discussion

Choose projects, dates and an optional question; leaving it empty uses the application default. Include the relevant categories of tasks/results, observations, checks, reviews and local decisions. Optional project history adds bounded background; it is not an event in the selected period. Inspect the prepared packet and exact prompt, then confirm dispatch. The interface shows execution stages and elapsed time and supports stopping an attempt.

Each successful follow-up is a new saved report linked to its discussion. Previous reports remain available. A task or other record is created only by explicitly accepting a proposal; the original proposal and evidence stay separate from human approval.

Opening a page does not read personal Codex chats or dispatch a question. A prepared packet is bound to the exact selection, source revisions, policy and provider/model. Changes can invalidate it; a pending manual packet expires after 15 minutes.

## Providers

**Codex** uses a separate CLI profile under the data directory. Device sign-in is explicit; credentials stay in CLI storage and are excluded from SQLite backup. Runtime execution is read-only, ephemeral and isolated from the main desktop profile. The application supplies the context; shell, browser, plugins and arbitrary file access are disabled for this path. Each question is bounded by input/output size and execution time. Default model means the CLI default, not a hardcoded model identity.

**OpenAI API** uses the server's Responses adapter. Set `OPENAI_API_KEY` and `CONTROL_CENTER_OPENAI_MODEL` in the HTTP server environment before starting it. Requests have bounded context/output, no tools and no automatic retry. See `server/analysis/openai.ts` for validation. The two providers do not share credentials or silently substitute for one another.

Model outputs and source excerpts require judgment. Structural validation and valid references do not establish the truth of a conclusion.

## Files and prior Codex chats

Repository context is optional and explicit: up to 12 selected tracked UTF-8 files, each up to 8 KB, within registered roots. Hidden/private/untracked files and symlinks are rejected; hash and revision guards detect changes before sending. Files are not automatically read from the README tree.

Reading a previous Codex chat is a separate grant tied to project/worktree and purpose. The bounded app-server reader selects short excerpts, allows manual editing and saves a partial digest. It does not start a chat or fall back to reading the whole session archive. Changed source marks a digest stale until reviewed; a summary edit cannot silently reuse an old approval.

Read permission and permission to send selected context are separate. Review the preview each time the selection or approval has changed.

## Schedules

Weekly and monthly schedules are independent opt-in settings. They identify scope, timezone, provider/model, sources and standing consent. Only closed periods are eligible; missed historical periods are not replayed. The HTTP process owns scheduling, so closing the browser keeps it alive but stopping the server stops dispatch.

Unique period markers prevent automatic duplicates. An unknown previous result stops future dispatch until explicit resolution; it is not retried automatically. Revoked access, changed policy or stale guards fail closed. Reading new chat excerpts needs the corresponding separate grants.

Verified restore disables grants in the backup copy. Renew them explicitly after recovery; an ordinary restart keeps current permissions.

## Tasks from an assistant

The optional stdio MCP server uses the same database and task/lifecycle owners as HTTP. Build, then launch `npm run mcp` from an explicitly authorized working directory, with the same `CONTROL_CENTER_DATA_DIR` where needed. Exposed tools do not grant arbitrary shell/filesystem access or deletion/settings control. The exact tools and contracts live in `server/mcp/` and `shared/`.

## Implementation map

`server/analysis/period-context.ts` builds period context; `period-analysis.ts` owns packets and dispatch; `acceptances.ts` persists proposal acceptance; `schedules.ts` and `schedule-guard.ts` own schedules. `server/codex/` owns bounded chat reading, repository context, CLI execution and discussion. `src/features/codex-analysis/` supplies the interface. All persistent discussion attempts use `analysis_runs` with immutable successful results, claims/leases and no automatic replay.
