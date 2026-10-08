# Project analysis with OpenAI

From the overview, open **Анализ проектов**. Choose up to ten projects, click **Просмотреть данные**, inspect the complete packet and explicitly approve its transmission. **Отправить в OpenAI** makes one paid request. Suggestions are drafts: review or edit each one, then use **Создать задачу «Следом»**. Creation uses the same task storage, duplicate checks and request keys as the board; it does not complete work or change repository files.

## Server setup

Set `OPENAI_API_KEY` and `CONTROL_CENTER_OPENAI_MODEL` in the environment of the HTTP server before `npm run dev` or `npm start`, and restart that server after changing them. Use your chosen Responses API model with [Structured Outputs support](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) and access in your API project. There is no assumed default model. The settings check confirms that both values are configured; it does not contact OpenAI or validate model access, credentials or balance.

Keep the key out of browser inputs, SQLite, repository files, logs and shell history. Use a trusted mechanism to populate the process environment; do not paste the key into a committed configuration file. The MCP process does not use this capability. OpenAI access is optional; tasks and every existing local feature work without it. Creating or reviewing a packet is local and makes no OpenAI request.

## Data and limits

The packet contains saved project names, goals, status, priority, blockers and snapshot dates; open task titles, descriptions, expected results and acceptance conditions; and the five latest work events per project with their reported results. It shows how many history events exist. These saved observations can be stale, and a reported check is not independent evidence. Repository files, paths, Git, notes, private decisions/context, unselected projects and general tasks are excluded. The packet is frozen at preparation: later local edits do not change what an approved packet sends. Removing a selected project before dispatch invalidates the request.

Review free text for private information before sending. A coarse server guard rejects recognizable credentials and common local paths; it cannot recognize every secret or personal detail. Exclude a project or edit its source records when needed. Request data goes to `https://api.openai.com/v1/responses`; the model has no tools or write access. Output is validated and rendered as plain text, with references restricted to the selected proposal's project.

Input is limited to 80,000 UTF-8 bytes and 200 open tasks per project; oversized input fails without truncation. Output is limited to 3,000 tokens and eight proposals, with a 60-second timeout. These are volume limits, not a monetary cap: price depends on model and actual usage. There is one active request per HTTP process and no automatic retry. A timeout or lost answer may still have incurred a charge. Repeating a request with the same unexpired preview returns its cached success/failure; preparing and approving a new packet can incur another charge.

The adapter sets [`store: false`](https://developers.openai.com/api/docs/guides/migrate-to-responses). Other provider retention controls may still apply; consult [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data). Nothing here promises zero retention.

Preview packets and responses remain in server memory for 15 minutes, with up to ten entries. They are discarded on server restart; expired entries are reclaimed on subsequent analysis operations. The screen loses its draft suggestions when closed or reloaded. Only tasks you create persist in SQLite and database backups. Before leaving, create the tasks you want to keep. This feature does not inspect source code, perform proposed work, prove that checks passed, or maintain an autonomous background agent.
