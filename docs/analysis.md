# Project analysis with OpenAI

This guide distinguishes the original project analysis from the saved period-analysis workflow below. Both require the same server environment; neither validates provider access merely by reporting configured settings.

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

## Saved analysis of a period review

Open a saved week/month review and choose **AI-анализ периода**. Select projects (for a general review) and sources, then approve reading them to prepare a local packet. The complete packet, its limitations, model, hash and bounds are shown before a separate **Отправить пакет в OpenAI** confirmation. Preparing a packet does not contact OpenAI. There is no assumed model or browser API-key input. Source changes, revoked access, deleted projects, a changed model or expiry require a fresh packet.

Each variant persists in SQLite with its approved packet, report, response ID/token usage when available, timestamps and status. The model's text never replaces your review. Current goals/open tasks do not reconstruct the end of a past period. Event excerpts are limited to 600 characters with a partial marker; dated file-decision metadata contains no file body. Packets above 80,000 bytes, 200 events, 100 open tasks or 20 related reviews are refused with guidance to select fewer sources. Inspect private information yourself; the additional path/secret filter is not a guarantee.

**Ожидает подтверждения** is a prepared packet awaiting separate send consent, for up to 15 minutes. **Запрос отправлен** records dispatch, not a completed report. **Результат неизвестен** means a request may already have been charged; it is never automatically repeated. A new variant requires acknowledgement of that risk and its own packet approval. Refusal, incomplete output and rejected references remain visible as failed attempts. Closing the browser does not undo dispatch; cancellation is best effort after sending.

Saved reports and minimal evidence survive restart and removal of the original review. Deleting the local analysis removes its packet/result while leaving the user review and source events intact. Database backups are private. A backup cancels pending dispatch approval and marks running attempts unknown **in the copy**, while preserving completed variants; restoring it does not silently resume a request. Stop all old HTTP/MCP processes before upgrading; see [recovery](data.md). Saved proposals can be accepted explicitly as described below.


## Optional period schedules

Inside a period analysis, expand **Автоматический анализ завершённых периодов**. Choose sources again, then separately approve recurring local reads and paid transmission to the displayed model. No schedule exists by default. The grant freezes the review timezone, model, source categories and selected project IDs. New projects or AI-derived related reports require an explicit choice. Each packet remains bounded by the same input/output limits and is saved before dispatch.

The HTTP process checks one schedule per minute and once at startup; MCP never starts a timer. Enabling starts with the currently open period, including any permitted records earlier in that period, and waits until it closes. It never catches up periods completed before activation. More than one missed period pauses the grant. A pre-existing manual analysis skips the automatic variant. Empty permitted sources skip sending. Failed, cancelled or unknown attempts pause rather than retry; inspect the saved run before explicitly enabling again, which starts with the then-current period. A deleted run leaves a minimal no-repeat marker. That marker contains only the automatic key and historical run UUID, not source text.

Use **Все расписания** to inspect, disable or delete grants. Disabling cancels pending attempts and requests best-effort cancellation of active ones; sent data and charges cannot be recalled reliably. Access changes, model/policy changes or a removed selected project stop dispatch. Project removal also pauses general-source grants because formerly linked records can become unlinked. Only an explicit re-enable changes a grant. Ordinary restart retains enabled grants; verified backups disable them in the copy. For raw externally restored databases use the recovery flag before any server startup, as described in [data recovery](data.md).

The common history has an **AI-анализы** filter with links to every saved variant, including variants whose parent review was deleted. Related user-written reviews and the latest successful related AI variants are separate source choices. Old AI text remains a model-derived claim, not independent evidence; nested old source IDs do not grant access to their original records.


## Accepting a saved proposal

Choose **Проверить и принять предложение** under a successful saved report. Inspect the original model wording and frozen source excerpts, then edit the title, description, reason, uncertainty and cheap check on a separate page. Choose a task **Следом** or a new idea and one of the proposal's projects. A general proposal can create a general record. A proposed connection creates a record for human investigation, never an automatic project relation or executed action. Task result/acceptance fields and priority are editable; task duplicate checks remain active unless separately overridden.

Creation requires explicit confirmation. The target record and acceptance provenance commit in one SQLite transaction, through the existing Tasks/Records owners. A repeated identical request returns the same acceptance, including after a lost response; different edits or changing task to idea return a conflict. One proposal can create one accepted record. A new model variant is a separate proposal and still uses normal task duplicate safeguards.

Created tasks and ideas link back to their accepted wording and sources through **Основания принятого предложения**. **Принятые предложения** retains the original model proposal, the selected frozen excerpts and the human-approved wording separately. It remains readable after the analysis is deleted. Later edits to the task/idea do not rewrite that approval snapshot. Deleting the target does not recreate it on retry. Deleting the analysis does not delete accepted records or their minimal retained evidence; the confirmation states this exception. No API call is made when accepting a proposal. Local drafts are protected on navigation and preserved after an error or competing acceptance.


## Optional summaries of selected Codex dialogs

Saved dialog summaries are a separate manual source choice, limited to two exact digest IDs for the same review and explicitly selected projects. See the [opt-in reader guide](codex.md#диалоги-codex-как-дополнительный-контекст). A digest contains the user's summary, selected short user/assistant excerpts, provenance and capture/check times. It does not prove a task was accepted or performed. AI preparation reads only the saved digest, never Codex automatically. Revoked access, stale/deleted digests and changed revisions block new dispatch; already saved reports retain their approved evidence. Reading permission does not approve transmission. Schedules reject digest IDs and never read dialog content. A privacy-policy upgrade requires new previews or explicit schedule re-enablement rather than inheriting a new source type.
