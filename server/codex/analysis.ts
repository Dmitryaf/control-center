import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { History } from '../history.js';
import { Reviews } from '../reviews.js';
import { HttpError } from '../errors.js';
import {
  PeriodAnalysis,
  periodAnalysisPrompt,
  validatePeriodReport,
} from '../analysis/period-analysis.js';
import {
  buildPeriodContext,
  normalizeSelection,
  verifyContextGuards,
  type ContextGuard,
} from '../analysis/period-context.js';
import { digest, projectStamp, sensitiveText } from '../analysis/privacy.js';
import {
  codexPrepareSchema,
  codexFilesQuerySchema,
  codexConversationQuerySchema,
  type CodexConversation,
} from '../../shared/codex-analysis.js';
import {
  periodRunSchema,
  periodReportSchema,
  type PeriodRun,
  type PeriodPayload,
  type CodexRunOrigin,
} from '../../shared/period-analysis.js';
import { codexFileList, repositorySources } from './repository-context.js';
import { LocalCodexExecutor, CodexExecutionError, type CodexExecutor } from './execution.js';

export const codexAnalysisPolicy = 'codex-project-review-v1';
type Guards = {
  context: ContextGuard[];
  files: { projectId: string; path: string; stamp: string }[];
};
type Row = {
  id: string;
  guards_json: string;
  packet_hash: string;
  request_hash: string;
  owner_id: string | null;
  cancel_requested: number;
  policy_version: string;
};
type Job = { controller: AbortController; promise: Promise<void>; progress: string };
export class CodexAnalysis {
  private owner = randomUUID();
  private active = new Map<string, Job>();
  constructor(
    private store: Store,
    private history: History,
    private analyses: PeriodAnalysis,
    private executor: CodexExecutor = new LocalCodexExecutor(),
    private now: () => number = Date.now,
  ) {}
  status() {
    return this.executor.probe();
  }
  async login() {
    if (!this.executor.login) throw new HttpError(503, 'Вход Codex недоступен.');
    if (this.active.size) throw new HttpError(409, 'Дождитесь завершения анализа.');
    return this.executor.login();
  }
  async cancelLogin() {
    await this.executor.cancelLogin?.();
    return this.status();
  }
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private row(id: string): Row {
    z.string().uuid().parse(id);
    const row = this.store.db
      .prepare(
        'SELECT id,guards_json,packet_hash,request_hash,owner_id,cancel_requested,policy_version FROM analysis_runs WHERE id=?',
      )
      .get(id);
    if (!row) throw new HttpError(404, 'Анализ не найден.');
    return row as unknown as Row;
  }
  read(id: string) {
    const run = this.analyses.read(id);
    if (run.payload.origin?.kind !== 'codex_runtime')
      throw new HttpError(403, 'Это не встроенный анализ Codex.');
    return { run, progress: this.active.get(id)?.progress ?? null };
  }
  private origin(run: PeriodRun): CodexRunOrigin {
    const value = run.payload.origin;
    if (value?.kind !== 'codex_runtime')
      throw new HttpError(403, 'Выберите встроенный анализ Codex.');
    return value;
  }
  conversation(input: unknown): CodexConversation {
    const { sessionId } = codexConversationQuerySchema.parse(input);
    this.analyses.recover();
    const rows = this.store.db
      .prepare(
        "SELECT id FROM analysis_runs WHERE json_extract(payload_json,'$.origin.kind')='codex_runtime' AND json_extract(payload_json,'$.origin.sessionId')=? ORDER BY generation LIMIT 20",
      )
      .all(sessionId);
    return { sessionId, turns: rows.map((r) => this.read(String(r.id)).run) };
  }
  files(input: unknown) {
    const data = codexFilesQuerySchema.parse(input);
    return codexFileList(this.store, data.projectIds);
  }
  private previous(key: string, requestHash: string) {
    const row = this.store.db
      .prepare('SELECT id,request_hash FROM analysis_runs WHERE request_key=?')
      .get(key);
    if (!row) return null;
    if (row.request_hash !== requestHash)
      throw new HttpError(
        409,
        'Этот ключ уже использован для другого запроса. Откройте сохранённый вариант.',
      );
    return this.read(String(row.id)).run;
  }
  async prepare(input: unknown): Promise<PeriodRun> {
    const data = codexPrepareSchema.parse(input);
    const selection = normalizeSelection(data.selection);
    if (!selection.projectIds.length) throw new HttpError(400, 'Выберите хотя бы один проект.');
    if (sensitiveText.test(data.question))
      throw new HttpError(
        400,
        'В вопросе возможный секрет или локальный путь. Уберите его перед отправкой.',
      );
    const files = [...data.files].sort((a, b) =>
      `${a.projectId}/${a.path}`.localeCompare(`${b.projectId}/${b.path}`),
    );
    const requestHash = digest({ ...data, selection, files });
    const previous = this.previous(data.requestKey, requestHash);
    if (previous) return previous;
    const review = new Reviews(this.store).read(data.reviewId);
    if (
      review.scopeKey !== 'general' &&
      (selection.projectIds.length !== 1 || review.projectId !== selection.projectIds[0])
    )
      throw new HttpError(400, 'Обзор должен относиться к выбранному проекту либо быть общим.');
    let payload: PeriodPayload, guards: Guards;
    let parent: PeriodRun | null = null;
    if (data.parentRunId) {
      parent = this.read(data.parentRunId).run;
      const origin = this.origin(parent);
      if (
        parent.status !== 'succeeded' ||
        parent.reviewId !== review.id ||
        origin.policy !== codexAnalysisPolicy
      )
        throw new HttpError(
          409,
          'Уточнять можно завершённый анализ действующей версии. Для неизвестного результата создайте новый анализ.',
        );
      if (
        digest(parent.selection) !== digest(selection) ||
        digest(origin.files) !== digest(files) ||
        parent.model !== (data.model || 'codex-default')
      )
        throw new HttpError(
          409,
          'Для изменения проектов, файлов, источников или модели начните новое обсуждение.',
        );
      payload = structuredClone(parent.payload);
      guards = JSON.parse(this.row(parent.id).guards_json) as Guards;
    } else {
      const context = buildPeriodContext(this.store, this.history, review, selection, this.now());
      const repositories = await repositorySources(this.store, selection.projectIds, files);
      payload = context.payload;
      payload.sources.push(...repositories.sources);
      if (files.length)
        payload.limitations = payload.limitations.filter((text) => !text.startsWith('Git, пути,'));
      payload.limitations.push(
        'Встроенный Codex получает только просмотренный пакет. Инструменты, команды, внешние приложения и самостоятельное чтение файлов отключены. Полного аудита репозитория и полной истории переписок нет.',
      );
      if (files.length)
        payload.limitations.push(
          'Файлы включены явным выбором: только tracked UTF-8 файлы до 8 КБ каждый. Это текущие тексты, а не восстановление состояния на конец периода.',
        );
      guards = { context: context.guards, files: repositories.stamps };
    }
    const origin: CodexRunOrigin = {
      kind: 'codex_runtime',
      purpose: 'project_review',
      sessionId: parent ? this.origin(parent).sessionId : randomUUID(),
      parentRunId: parent?.id ?? null,
      question: data.question,
      policy: codexAnalysisPolicy,
      files,
    };
    payload.origin = origin;
    const model = data.model || 'codex-default';
    if (
      Buffer.byteLength(JSON.stringify(payload)) > 80000 ||
      sensitiveText.test(JSON.stringify(payload))
    )
      throw new HttpError(
        400,
        'Пакет больше 80 КБ либо содержит возможный секрет/локальный путь. Уменьшите выбор источников.',
      );
    this.prompt(payload, parent);
    return this.store.transaction(() => {
      const repeated = this.previous(data.requestKey, requestHash);
      if (repeated) return repeated;
      this.analyses.recover();
      verifyContextGuards(this.store, guards.context, this.history);
      this.checkParent(origin);
      const generation = Number(
        this.store.db
          .prepare('SELECT COALESCE(MAX(generation),0)+1 n FROM analysis_runs WHERE review_key=?')
          .get(review.id)?.n,
      );
      const id = randomUUID(),
        now = this.timestamp();
      const packetHash = digest({ payload, model, policy: codexAnalysisPolicy });
      this.store.db
        .prepare(
          `INSERT INTO analysis_runs
        (id,review_id,review_key,scope_key,generation,status,model,policy_version,selection_json,payload_json,guards_json,packet_hash,request_key,request_hash,created_at,expires_at,trigger)
        VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,'manual')`,
        )
        .run(
          id,
          review.id,
          review.id,
          review.scopeKey,
          generation,
          model,
          codexAnalysisPolicy,
          JSON.stringify(selection),
          JSON.stringify(payload),
          JSON.stringify(guards),
          packetHash,
          data.requestKey,
          requestHash,
          now,
          new Date(this.now() + 15 * 60000).toISOString(),
        );
      return this.read(id).run;
    });
  }
  private checkParent(origin: CodexRunOrigin, ownId?: string) {
    const latest = this.store.db
      .prepare(
        "SELECT id,status FROM analysis_runs WHERE json_extract(payload_json,'$.origin.sessionId')=? AND id!=? ORDER BY generation DESC LIMIT 1",
      )
      .get(origin.sessionId, ownId ?? '');
    if (origin.parentRunId && (latest?.id !== origin.parentRunId || latest.status !== 'succeeded'))
      throw new HttpError(
        409,
        'Обсуждение уже изменилось. Откройте последний ответ; повторного запуска нет.',
      );
    if (!origin.parentRunId && latest) throw new HttpError(409, 'Обсуждение уже существует.');
  }
  private chain(parent: PeriodRun | null) {
    const chain: { question: string; report: NonNullable<PeriodRun['report']> }[] = [];
    const seen = new Set<string>();
    while (parent) {
      if (
        seen.has(parent.id) ||
        chain.length >= 5 ||
        parent.status !== 'succeeded' ||
        !parent.report
      )
        throw new HttpError(
          409,
          'История обсуждения неполна или достигнут лимит шести ответов. Начните новый анализ.',
        );
      seen.add(parent.id);
      const origin = this.origin(parent);
      chain.unshift({ question: origin.question, report: parent.report });
      parent = origin.parentRunId ? this.read(origin.parentRunId).run : null;
    }
    return chain;
  }
  private prompt(payload: PeriodPayload, parent: PeriodRun | null) {
    const origin = payload.origin as CodexRunOrigin;
    const context = { ...payload, origin: undefined };
    const prompt = `${periodAnalysisPrompt}\nОтветь на вопрос владельца. Верни только отчёт по заданной JSON Schema. Предыдущие ответы — история обсуждения, а не новые факты; перепроверь выводы по источникам пакета. Не используй инструменты.\n${JSON.stringify({ question: origin.question, context, conversation: this.chain(parent) })}`;
    if (Buffer.byteLength(prompt) > 100000)
      throw new HttpError(
        400,
        'Обсуждение вместе с контекстом больше 100 КБ. Начните новый анализ с меньшим набором источников.',
      );
    return prompt;
  }
  private async verify(run: PeriodRun, files = true) {
    if (!run.reviewId) throw new HttpError(410, 'Обзор удалён. Запрос не отправлен.');
    new Reviews(this.store).read(run.reviewId);
    const row = this.row(run.id),
      origin = this.origin(run);
    if (
      origin.policy !== codexAnalysisPolicy ||
      row.policy_version !== codexAnalysisPolicy ||
      digest({ payload: run.payload, model: run.model, policy: row.policy_version }) !==
        row.packet_hash
    )
      throw new HttpError(
        409,
        'Политика или сохранённый пакет изменились. Подготовьте новый анализ.',
      );
    const guards = JSON.parse(row.guards_json) as Guards;
    verifyContextGuards(this.store, guards.context, this.history);
    if (files) {
      const current = await repositorySources(this.store, run.selection.projectIds, origin.files);
      if (digest(current.stamps) !== digest(guards.files))
        throw new HttpError(410, 'Выбранные файлы или доступ изменились. Просмотрите новый пакет.');
    }
  }
  async start(id: string, input: unknown) {
    const data = periodRunSchema.parse(input);
    const run = this.read(id).run;
    if (run.packetHash !== data.packetHash)
      throw new HttpError(409, 'Пакет не совпадает с просмотренным.');
    if (run.status !== 'pending') return this.read(id);
    if (this.active.size >= 2)
      throw new HttpError(
        409,
        'Codex уже выполняет два анализа. Дождитесь окончания или остановите один.',
      );
    const status = await this.executor.probe();
    if (!status.available)
      throw new HttpError(
        503,
        'Codex CLI недоступен. Проверьте установку и вход через codex login.',
      );
    if (status.authenticated === false)
      throw new HttpError(503, 'Войдите в отдельный профиль Codex в Control Center.');
    await this.verify(run);
    const parent = this.origin(run).parentRunId
      ? this.read(this.origin(run).parentRunId!).run
      : null;
    const prompt = this.prompt(run.payload, parent);
    const claimed = this.store.transaction(() => {
      const current = this.read(id).run;
      if (current.status !== 'pending') return false;
      const running = Number(
        this.store.db
          .prepare(
            "SELECT COUNT(*) n FROM analysis_runs WHERE status='running' AND json_extract(payload_json,'$.origin.kind')='codex_runtime'",
          )
          .get()?.n,
      );
      if (running >= 2)
        throw new HttpError(
          409,
          'Уже выполняются два анализа Codex. Дождитесь окончания или остановите один.',
        );
      verifyContextGuards(
        this.store,
        (JSON.parse(this.row(id).guards_json) as Guards).context,
        this.history,
      );
      this.checkParent(this.origin(current), id);
      const now = this.timestamp();
      return !!this.store.db
        .prepare(
          "UPDATE analysis_runs SET status='running',approved_at=?,started_at=?,lease_until=?,owner_id=? WHERE id=? AND status='pending'",
        )
        .run(now, now, new Date(this.now() + 30000).toISOString(), this.owner, id).changes;
    });
    if (!claimed) return this.read(id);
    const controller = new AbortController();
    const promise = this.execute(run, prompt, controller);
    this.active.set(id, { controller, promise, progress: 'Подготовка запуска' });
    void promise.then(
      () => this.active.delete(id),
      () => this.active.delete(id),
    );
    return this.read(id);
  }
  private async execute(run: PeriodRun, prompt: string, controller: AbortController) {
    const heartbeat = setInterval(() => {
      try {
        const row = this.row(run.id);
        if (row.cancel_requested || row.owner_id !== this.owner) controller.abort();
        else
          this.store.db
            .prepare(
              "UPDATE analysis_runs SET lease_until=? WHERE id=? AND owner_id=? AND status='running'",
            )
            .run(new Date(this.now() + 30000).toISOString(), run.id, this.owner);
      } catch {
        controller.abort();
      }
    }, 1000);
    try {
      await this.verify(run);
      if (this.row(run.id).cancel_requested || controller.signal.aborted)
        throw new CodexExecutionError('Запуск остановлен до отправки.', 'failed');
      const result = await this.executor.execute({
        prompt,
        model: run.model === 'codex-default' ? null : run.model,
        signal: controller.signal,
        onProgress: (stage) => {
          const active = this.active.get(run.id);
          if (active) active.progress = stage;
        },
      });
      if (Buffer.byteLength(result.output) > 64 * 1024)
        throw new CodexExecutionError('Ответ Codex превышает допустимый размер.', 'failed');
      const report = periodReportSchema.parse(JSON.parse(result.output));
      validatePeriodReport(run.payload, report);
      this.store.transaction(() => {
        const current = this.row(run.id);
        if (
          current.owner_id !== this.owner ||
          current.cancel_requested ||
          controller.signal.aborted
        )
          throw new CodexExecutionError(
            'Выполнение остановлено. Полученный после остановки ответ не принят.',
            'unknown',
          );
        const guards = (JSON.parse(current.guards_json) as Guards).context;
        for (const guard of guards.filter((g) => g.kind === 'project')) {
          const project = this.store.project(guard.id);
          if (!project || projectStamp(project) !== guard.stamp)
            throw new CodexExecutionError(
              'Доступ к проекту изменился во время анализа. Ответ не принят.',
              'failed',
            );
        }
        this.store.db
          .prepare(
            "UPDATE analysis_runs SET status='succeeded',finished_at=?,report_json=?,raw_output=?,usage_json=?,response_id=?,owner_id=NULL,lease_until=NULL,error=NULL WHERE id=? AND owner_id=? AND status='running'",
          )
          .run(
            this.timestamp(),
            JSON.stringify(report),
            result.output,
            result.usage ? JSON.stringify(result.usage) : null,
            result.threadId,
            run.id,
            this.owner,
          );
      });
    } catch (cause) {
      const error =
        cause instanceof CodexExecutionError
          ? cause
          : new CodexExecutionError(
              cause instanceof HttpError
                ? cause.message
                : 'Ответ Codex не прошёл проверку формата, источников или приватности.',
              'failed',
            );
      this.store.db
        .prepare(
          "UPDATE analysis_runs SET status=?,finished_at=?,error=?,owner_id=NULL,lease_until=NULL WHERE id=? AND owner_id=? AND status='running'",
        )
        .run(error.state, this.timestamp(), error.message, run.id, this.owner);
    } finally {
      clearInterval(heartbeat);
    }
  }
  abort(id: string) {
    this.active.get(id)?.controller.abort();
  }
  async stop() {
    await this.executor.cancelLogin?.();
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map((j) => j.promise));
  }
}
