# Analysis and Codex

Optional analysis and Codex integrations. Start with the [setup guide](../SETUP.md) if you have not installed Control Center.

## Reviews and analysis

Open project analysis, select one or more projects and a week or month, then prepare a period review. You can also open reviews from a project page. Your own text is saved independently of AI results. A period retains its original timezone and calendar boundaries.

In period AI analysis, choosing the basic source set selects summaries, tasks/results, observations, local decisions with their reasons, checks and earlier reviews for the chosen projects, plus your saved text of the current review, including a general review. Empty review text is not counted as a source. Source settings let you adjust each category. This selection makes no external call and does not enable file or dialog access. Project summaries explain the goal, type, stage and saved focus. Including earlier history adds up to three earlier nonempty reviews and five earlier observations per selected project, separately marked as background. Other general records and earlier AI reports require their own selection. Nothing is chosen because a repository happens to be open in Codex.

Prepare a local packet, inspect its complete contents, then separately approve sending it to OpenAI. The central result is a connected account of what changed and what it means for those projects. Supporting sources and uncertainties are expandable; proposals appear only when there is a reason for them. Review and accept each proposal explicitly to create a task or idea. Existing goals or summaries can be outdated: update them or record an observation rather than expecting the model to reconstruct missing history.

Saved period analyses survive restart. Project analysis also offers a short current-state analysis using summaries, open tasks and five recent task events per project. That older workflow keeps its preview/result in memory for 15 minutes; use a period review for persistent analysis with broader history.

### OpenAI setup

Set `OPENAI_API_KEY` and `CONTROL_CENTER_OPENAI_MODEL` in the HTTP server environment using a trusted local secret mechanism, then restart it. No default model is assumed. The key does not belong in browser inputs, repository files, SQLite or logs. A configured status does not prove provider access or sufficient balance. Local work and saved reports remain available without OpenAI.

The server sends only the reviewed packet to the Responses API, with structured output and no tools. Input is limited to 80,000 UTF-8 bytes and 200 period events across up to 10 projects; output to 3,000 tokens, and requests to 60 seconds. An active month with several projects can exceed these limits. Preparation then stops without saving or sending a partial packet: choose a week, fewer projects or fewer sources. These limits are not a monetary budget. A timeout can mean a charged request with an unknown result; it is never automatically retried. New period packets require renewed approval after relevant source, model or policy changes. A secret/path filter supplements human inspection and cannot guarantee that free text is safe to send.

Optional schedules require separate permission to read future periods and send paid requests. They run only in the HTTP process, for completed periods. Missed backlogs are skipped; known failures skip that period. Unknown dispatched outcomes pause sending. Explicit continuation skips uncertain periods rather than repeating them. Changed access, models or policy require renewed approval. Reading or accepting a saved result makes no API call.

### Integrated Codex analysis

Select projects and a review period, then start a Codex analysis. Ask a question, prepare and inspect the context, and confirm sending the request. The report and follow-up questions remain in Control Center after restart. Saved proposals use the same explicit acceptance flow as other analyses; a report never creates tasks automatically.

This uses the installed Codex CLI with a separate profile in `codex-analysis/` under the Control Center data directory. Sign in once, open the official OpenAI link and enter the displayed device code. Device code login must be enabled in your ChatGPT security settings or workspace permissions. Cancelling sign-in stops the local login attempt; attempts also expire after 15 minutes. Control Center never copies credentials from your main Codex profile or into SQLite. The CLI manages this profile's credentials; protect its directory like a password. Database backups do not include it: sign in again after moving to another computer. The HTTP server's API-key environment variables are not forwarded. `CONTROL_CENTER_CODEX_PATH` can select the executable. CLI/login checks do not prove model entitlement or remaining usage. Each question is a separate invocation and uses the signed-in account's limits. The optional model field selects a model; leaving it empty uses the CLI's built-in default, rather than importing the user's model configuration.

The application supplies a frozen context packet. It invokes `codex exec` with an isolated temporary working directory, the dedicated profile, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, a read-only sandbox and a report schema. Command execution, apps, plugins, hooks, browser/computer tools, code mode and memories are disabled; personal skills are not discovered or injected. An `AGENTS.md` or `AGENTS.override.md` added to the dedicated profile blocks analysis. The existing read-only dialog reader remains separate and uses the main Codex profile only after its own explicit access consent. The CLI controls model authentication/network access; this is not offline inference.

Repository text is optional. Explicitly load the tracked-file names for the selected projects, then choose up to 12 UTF-8 text files of at most 8 KiB each. The picker shows at most 200 eligible names per project. Hidden paths, credentials, symlinks, untracked files, files outside registered roots and possible secrets are rejected. Files are included only in the inspected packet; Codex does not independently explore repositories. This is a bounded source selection, not a complete code audit. Existing project notes/private-context directories and full chat archives are not included automatically.

A conversation has up to six successful answers. Follow-up requests send the same frozen packet together with its earlier successful questions/reports; they do not resume or import arbitrary Codex sessions. The packet limit is 80,000 bytes; the complete prompt with discussion is limited to 100,000 bytes, the final response to 64 KiB and execution to five minutes. These are technical bounds, not a monetary budget. A changed source/access policy requires a newly inspected packet. A new question or different selection starts a new discussion.

Closing the browser leaves a running request active. Stopping the analysis ends the owned CLI process; it cannot undo transmission or guarantee that no limit was used. Lost replies and repeated clicks do not start another invocation. Abandoned execution becomes unknown after its lease expires and is never automatically resumed. Existing backup rules also invalidate unsent Codex approvals and mark running copies unknown. Stored packets/reports are private business data; keep backups private.

See the official [non-interactive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [authentication documentation](https://learn.chatgpt.com/docs/auth). The optional `npm run test:codex` checks the installed CLI with an isolated HOME and a synthetic local Responses endpoint; it does not run a real model or read personal chats.

### Codex context and manual results

Codex dialog access is off by default. Inside a period analysis, select projects and explicitly permit local reading/saving of bounded excerpts. The installed Codex CLI must support the required read-only protocol; `CONTROL_CENTER_CODEX_PATH` can select its executable. Exact registered project/worktree paths define access. The app does not open arbitrary sessions, execute dialog commands or copy a complete archive.

Automatic preparation examines up to four recent candidates and selects up to two usable dialogs per project. Stale summaries do not use these two slots; up to four summaries, including stale ones, can be retained per project and review. At that storage limit, explicitly review or remove an unneeded summary before adding another; nothing is automatically deleted. Each selection contains the two latest substantive user messages and the completed reply to the latest one, at most 500 UTF-8 bytes each, in chronological order. Long excerpts retain their beginning and ending with a marked gap. This is a mechanical selection, not a semantic summary; intermediate reasoning or decisions can still be missing. Manual selection/editing remains available.

If a checked source changes, its saved summary and excerpts stay intact and require explicit review before reuse, including manually edited summaries. A content hash detects changes even when the source timestamp stays the same. Repeating preparation of an unchanged eligible source preserves manual choices. There is no background monitoring after the last check. Intentions and assistant claims are not verified results. Sending these excerpts requires separate packet approval; schedules need additional explicit permission to read and send future dialogs. Revoking access blocks new use, while previously saved reports retain their approved evidence.

A ready-made Codex analysis can be saved through the guarded local `POST /api/period-analysis/import-codex` API. It requires `purpose: "project_review"`, either one `projectId` or explicit `projectIds` (up to ten), a matching `reviewId` (general for several projects), UUID `requestKey`, declared `context`, structured `report`, and `confirm: true`. References use `project:<id>` or `codex_context:<requestKey>`. See the exact [import and report schemas](../shared/period-analysis.ts). Identical retries reuse the result; conflicting input is rejected. This records a human-selected review, not proof of the external model/session. Existing imports without a declared purpose remain readable with a notice to check their grounds.

Synthetic evaluation belongs only in the offline [developer workflow](MAINTENANCE.md#development). Do not import its answers as real project reviews. The import validates purpose, scope, structure and references; it cannot determine whether arbitrary prose is truthful. To remove a mistakenly imported report, inspect its saved grounds, then use the option to delete the local analysis. Source records and your own review remain; accepted tasks/ideas retain their evidence.

## Tasks in Codex

Tasks have stable `CC-N` identifiers, revisions and saved results. A local stdio MCP server uses the same database without requiring the browser. Build the application, register projects in Settings, then configure an MCP client to launch Node with the absolute path to `dist/server/server/mcp/index.js`.

The manual task form asks for a title; project, priority and description are optional. Put conditions and links in the description when needed. Add or edit a single work summary separately; completion does not require filling a report. Existing expected results, acceptance conditions, links and structured evidence from MCP remain readable and are preserved by title/description/result edits. MCP continues to store `summary`, `verified`, `unverified` and `remaining` separately. If earlier results contain remaining work, the UI shows it and asks for confirmation before completion; confirming clears the current remaining steps while preserving the earlier result in immutable history. The MCP completion contract still requires an empty `remaining` value.

For Codex CLI, replace the example installation path:

```sh
npm run build
codex mcp add control-center -- node "C:/tools/control-center/dist/server/server/mcp/index.js"
codex mcp list
```

If you use `CONTROL_CENTER_DATA_DIR`, pass the same value to HTTP and MCP processes. Rebuild and restart MCP after source changes. Ask Codex to resolve the session's working directory with `project_context`, check the task's project and record the actual result. The server cannot guarantee that an interrupted agent records its work. A partial result leaves the task open; stale revisions require rereading and reconciling rather than overwriting.

Current tasks own planning. Legacy focus/next fields remain readable, and importing old next steps is explicit. Editing project details or exporting YAML does not replace that plan with task contents.
