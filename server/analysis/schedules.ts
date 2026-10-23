import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  scheduleEnableSchema,
  scheduleRevisionSchema,
  type AnalysisSchedule,
} from '../../shared/analysis-schedules.js';
import { dateInZone, periodBounds, type PeriodKind } from '../../shared/periods.js';
import type { Store } from '../db.js';
import { Reviews } from '../reviews.js';
import { HttpError } from '../errors.js';
import { normalizeSelection, periodPolicyVersion, projectStamp } from './period-context.js';
import { verifySchedule, verifyScheduleAccess, type ScheduleAccess } from './schedule-guard.js';
import type { PeriodAnalysis } from './period-analysis.js';
import { CodexContext } from '../codex/context.js';

type Row = {
  id: string;
  scope_key: string;
  project_name: string | null;
  period_kind: PeriodKind;
  timezone: string;
  model: string;
  selection_json: string;
  access_json: string;
  revision: number;
  enabled: number;
  next_period_start: string;
  last_run_id: string | null;
  note: string | null;
  updated_at: string;
};
export class AnalysisSchedules {
  private owner = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  constructor(
    private store: Store,
    private analysis: PeriodAnalysis,
    private now: () => number = Date.now,
    private codex = new CodexContext(store),
  ) {}
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private dto(row: Row): AnalysisSchedule {
    return {
      id: row.id,
      scopeKey: row.scope_key,
      projectName: row.project_name,
      kind: row.period_kind,
      timezone: row.timezone,
      model: row.model,
      selection: JSON.parse(row.selection_json),
      codexProjectIds: (JSON.parse(row.access_json) as ScheduleAccess[])
        .filter((item) => item.codexRevision !== undefined)
        .map((item) => item.id),
      revision: row.revision,
      enabled: !!row.enabled,
      nextPeriodStart: row.next_period_start,
      lastRunId: row.last_run_id,
      lastRunReviewKey: row.last_run_id
        ? String(
            this.store.db
              .prepare('SELECT review_key FROM analysis_runs WHERE id=?')
              .get(row.last_run_id)?.review_key ?? '',
          ) || null
        : null,
      note: row.note,
      updatedAt: row.updated_at,
    };
  }
  list(input: unknown = {}) {
    const { cursor, limit } = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(30).default(20),
      })
      .strict()
      .parse(input);
    const rows = this.store.db
      .prepare(`SELECT * FROM analysis_schedules ${cursor ? 'WHERE id>?' : ''} ORDER BY id LIMIT ?`)
      .all(...(cursor ? [cursor] : []), limit + 1) as unknown as Row[];
    return {
      items: rows.slice(0, limit).map((row) => this.dto(row)),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  forReview(id: string): AnalysisSchedule | null {
    const review = new Reviews(this.store).read(id);
    const row = this.store.db
      .prepare('SELECT * FROM analysis_schedules WHERE scope_key=? AND period_kind=?')
      .get(review.scopeKey, review.kind) as unknown as Row | undefined;
    return row ? this.dto(row) : null;
  }
  enable(input: unknown) {
    const data = scheduleEnableSchema.parse(input);
    const status = this.analysis.status();
    if (!status.ready || data.expectedModel !== status.model)
      throw new HttpError(409, 'Проверьте настроенную модель перед включением.');
    const result = this.store.transaction(() => {
      const review = new Reviews(this.store).read(data.reviewId);
      const selection = normalizeSelection(data.selection);
      if (selection.codexDigestIds.length)
        throw new HttpError(
          400,
          'Итоги Codex разрешены только для ручного анализа с просмотром пакета.',
        );
      if (
        new Set(data.codexProjectIds).size !== data.codexProjectIds.length ||
        data.codexProjectIds.some((id) => !selection.projectIds.includes(id))
      )
        throw new HttpError(400, 'Codex разрешается только для выбранных проектов.');
      if (data.codexProjectIds.length && (!data.codexReadConsent || !data.codexSendConsent))
        throw new HttpError(
          400,
          'Для новых диалогов нужны отдельные согласия на чтение и отправку.',
        );
      if (
        review.scopeKey !== 'general' &&
        (selection.includeGeneral ||
          selection.projectIds.length !== 1 ||
          selection.projectIds[0] !== review.scopeKey.slice(8))
      )
        throw new HttpError(400, 'Проектное расписание использует только свой проект.');
      if (!selection.projectIds.length && !selection.includeGeneral)
        throw new HttpError(400, 'Выберите проекты или общие записи.');
      const access = selection.projectIds.map((id) => {
        const project = this.store.project(id);
        if (!project) throw new HttpError(410, 'Выбранный проект удалён.');
        const grant = data.codexProjectIds.includes(id) ? this.codex.grant(id) : null;
        if (grant && !grant.enabled)
          throw new HttpError(410, 'Сначала явно разрешите чтение Codex выбранного проекта.');
        return {
          id,
          stamp: projectStamp(project),
          ...(grant ? { codexRevision: grant.revision! } : {}),
        };
      });
      const old = this.store.db
        .prepare('SELECT * FROM analysis_schedules WHERE scope_key=? AND period_kind=?')
        .get(review.scopeKey, review.kind) as unknown as Row | undefined;
      if ((old?.revision ?? null) !== data.revision)
        throw new HttpError(409, 'Расписание изменено. Обновите страницу.');
      const id = old?.id ?? randomUUID();
      const start = periodBounds(
        review.kind,
        dateInZone(new Date(this.now()), review.timezone),
        review.timezone,
      ).periodStart;
      this.store.db
        .prepare(
          `INSERT INTO analysis_schedules(id,scope_key,project_name,period_kind,timezone,model,policy_version,selection_json,access_json,revision,enabled,enabled_at,next_period_start,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET timezone=excluded.timezone,model=excluded.model,policy_version=excluded.policy_version,selection_json=excluded.selection_json,access_json=excluded.access_json,revision=excluded.revision,enabled=1,enabled_at=excluded.enabled_at,next_period_start=excluded.next_period_start,lease_owner=NULL,lease_until=NULL,note=NULL,updated_at=excluded.updated_at`,
        )
        .run(
          id,
          review.scopeKey,
          review.projectName,
          review.kind,
          review.timezone,
          status.model!,
          periodPolicyVersion,
          JSON.stringify(selection),
          JSON.stringify(access),
          (old?.revision ?? 0) + 1,
          this.timestamp(),
          start,
          this.timestamp(),
        );
      return id;
    });
    this.cancelRuns(result);
    return this.read(result);
  }
  private read(id: string) {
    z.string().uuid().parse(id);
    const row = this.store.db
      .prepare('SELECT * FROM analysis_schedules WHERE id=?')
      .get(id) as unknown as Row | undefined;
    if (!row) throw new HttpError(404, 'Расписание не найдено.');
    return this.dto(row);
  }
  disable(id: string, input: unknown) {
    const { revision } = scheduleRevisionSchema.parse(input);
    this.store.transaction(() => {
      if (this.read(id).revision !== revision)
        throw new HttpError(409, 'Расписание изменено. Обновите страницу.');
      this.store.db
        .prepare(
          'UPDATE analysis_schedules SET enabled=0,revision=revision+1,lease_owner=NULL,lease_until=NULL,note=?,updated_at=? WHERE id=?',
        )
        .run('Отключено пользователем.', this.timestamp(), id);
    });
    this.cancelRuns(id);
    return this.read(id);
  }
  resume(id: string, input: unknown) {
    const data = z
      .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
      .strict()
      .parse(input);
    const value = this.read(id);
    if (value.revision !== data.revision)
      throw new HttpError(409, 'Расписание изменено. Обновите страницу.');
    const row = this.store.db.prepare('SELECT * FROM analysis_schedules WHERE id=?').get(id)!;
    const approved = JSON.parse(String(row.access_json)) as ScheduleAccess[];
    verifyScheduleAccess(this.store, value.selection.projectIds, approved);
    if (row.policy_version !== periodPolicyVersion)
      throw new HttpError(410, 'Источники или доступ изменились. Подтвердите их заново в обзоре.');
    const review = new Reviews(this.store).create(
      {
        projectId: value.scopeKey === 'general' ? null : value.scopeKey.slice(8),
        kind: value.kind,
        anchorDate: dateInZone(new Date(this.now()), value.timezone),
      },
      value.timezone,
    );
    return this.enable({
      reviewId: review.id,
      revision: value.revision,
      selection: value.selection,
      expectedModel: value.model,
      readConsent: true,
      sendConsent: true,
      codexProjectIds: value.codexProjectIds ?? [],
      ...(value.codexProjectIds?.length ? { codexReadConsent: true, codexSendConsent: true } : {}),
    });
  }
  delete(id: string, input: unknown) {
    const disabled = this.disable(id, input);
    const result = this.store.db
      .prepare('DELETE FROM analysis_schedules WHERE id=? AND revision=? AND enabled=0')
      .run(id, disabled.revision);
    if (!result.changes) throw new HttpError(409, 'Расписание изменено. Обновите страницу.');
  }
  private cancelRuns(id: string) {
    const rows = this.store.db
      .prepare(
        "SELECT id FROM analysis_runs WHERE schedule_id=? AND status IN ('pending','running')",
      )
      .all(id);
    for (const row of rows) this.analysis.cancel(String(row.id));
  }
  private pause(row: Row, note: string) {
    this.store.db
      .prepare(
        'UPDATE analysis_schedules SET enabled=0,revision=revision+1,note=?,updated_at=? WHERE id=? AND revision=?',
      )
      .run(note, this.timestamp(), row.id, row.revision);
  }
  private pauseUncertain(row: Row, runId: string) {
    this.pause(
      row,
      'Не удалось подтвердить исход отправленного запроса. Возможна оплата; продолжение требует подтверждения без повтора этого периода.',
    );
    this.store.db
      .prepare(
        'UPDATE analysis_schedules SET last_run_id=? WHERE id=? AND revision=? AND enabled=0',
      )
      .run(runId, row.id, row.revision + 1);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.process()
      .catch(() => {
        /* A DB failure leaves the lease; no blind retry of a dispatched run. */
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }
  private async process() {
    const row = this.store.transaction(() => {
      const candidate = this.store.db
        .prepare(
          'SELECT * FROM analysis_schedules WHERE enabled=1 AND (lease_until IS NULL OR lease_until<=?) ORDER BY updated_at,id LIMIT 1',
        )
        .get(this.timestamp()) as unknown as Row | undefined;
      if (!candidate) return null;
      this.store.db
        .prepare(
          'UPDATE analysis_schedules SET lease_owner=?,lease_until=?,updated_at=? WHERE id=?',
        )
        .run(
          this.owner,
          new Date(this.now() + 120000).toISOString(),
          this.timestamp(),
          candidate.id,
        );
      return candidate;
    });
    if (!row) return;
    try {
      const status = this.analysis.status();
      if (status.model && status.model !== row.model)
        throw new HttpError(410, 'Модель изменилась. Подтвердите расписание заново.');
      verifySchedule(this.store, row.id, row.revision, row.model);
      const key = `schedule:${row.id}:${row.period_kind}:${row.next_period_start}`;
      const unfinished = this.store.db
        .prepare(
          "SELECT id FROM analysis_runs WHERE schedule_id=? AND automatic_key=? AND status IN ('running','unknown')",
        )
        .get(row.id, key);
      if (unfinished) {
        // Recover expired provider leases before backlog/configuration shortcuts.
        // Downtime must never turn an uncertain send into an implicitly renewed grant.
        const prior = this.analysis.read(String(unfinished.id));
        if (prior.status === 'running') return;
        if (prior.status === 'unknown') {
          this.pauseUncertain(row, prior.id);
          return;
        }
      }
      const bounds = periodBounds(row.period_kind, row.next_period_start, row.timezone);
      if (bounds.nextStartAt > this.timestamp()) return;
      const next = periodBounds(
        row.period_kind,
        dateInZone(new Date(bounds.nextStartAt), row.timezone),
        row.timezone,
      );
      if (next.nextStartAt <= this.timestamp()) {
        const current = periodBounds(
          row.period_kind,
          dateInZone(new Date(this.now()), row.timezone),
          row.timezone,
        );
        this.advance(
          row,
          current.periodStart,
          null,
          `Пропущено несколько периодов во время простоя. Они не отправлены; следующий выпуск после завершения периода с ${current.periodStart}.`,
        );
        return;
      }
      if (!status.ready) {
        this.advance(
          row,
          next.periodStart,
          null,
          'AI временно недоступен. Этот период пропущен без отправки; следующие выпуски остаются включены.',
        );
        return;
      }
      const review = new Reviews(this.store).create(
        {
          projectId: row.scope_key === 'general' ? null : row.scope_key.slice(8),
          kind: row.period_kind,
          anchorDate: row.next_period_start,
        },
        row.timezone,
      );
      if (review.nextStartAt > this.timestamp()) return;
      const existing = this.store.db
        .prepare(
          'SELECT id,automatic_key FROM analysis_runs WHERE review_key=? ORDER BY generation LIMIT 1',
        )
        .get(review.id);
      if (existing && existing.automatic_key !== key) {
        this.advance(
          row,
          next.periodStart,
          null,
          'За этот период уже есть анализ. Повтор не отправлен.',
        );
        return;
      }
      const selection = normalizeSelection(JSON.parse(row.selection_json));
      const approved = (JSON.parse(row.access_json) as ScheduleAccess[]).filter(
        (item) => item.codexRevision !== undefined,
      );
      const context =
        !existing && approved.length
          ? await this.codex.prepare({
              reviewId: review.id,
              projects: approved.map((item) => ({
                projectId: item.id,
                revision: item.codexRevision,
              })),
              readConsent: true,
              saveConsent: true,
            })
          : null;
      if (this.stopping) return;
      if (context) selection.codexDigestIds = context.items.map((item) => item.id);
      // Reading is asynchronous: check the standing consent again after it finishes.
      verifySchedule(this.store, row.id, row.revision, row.model);
      let run = existing
        ? this.analysis.read(String(existing.id))
        : this.analysis.prepareScheduled(
            {
              reviewId: review.id,
              requestKey: randomUUID(),
              selection,
              readConsent: true,
              repeatConsent: false,
            },
            { id: row.id, revision: row.revision, key, limitations: context?.limitations },
          );
      if (run.status === 'pending') {
        if (!run.payload.sources.some((s) => s.text.trim())) run = this.analysis.cancel(run.id);
        else run = await this.analysis.run(run.id, { packetHash: run.packetHash, consent: true });
      }
      if (run.status === 'running') return;
      if (run.status === 'unknown') {
        this.pauseUncertain(row, run.id);
        return;
      }
      this.advance(
        row,
        next.periodStart,
        run.id,
        run.status === 'succeeded'
          ? 'Результат сохранён.'
          : !run.payload.sources.some((s) => s.text.trim())
            ? 'В разрешённых источниках нет данных; запрос не отправлен.'
            : 'Этот выпуск завершился ошибкой или отменён. Повтор не отправлен; следующие периоды остаются включены.',
      );
    } catch (cause) {
      const uncertain = this.store.db
        .prepare(
          "SELECT id FROM analysis_runs WHERE schedule_id=? AND automatic_key=? AND status IN ('running','unknown')",
        )
        .get(row.id, `schedule:${row.id}:${row.period_kind}:${row.next_period_start}`);
      if (uncertain) {
        this.pauseUncertain(row, String(uncertain.id));
      } else if (cause instanceof HttpError && [403, 410].includes(cause.status))
        this.pause(row, cause.message);
      else {
        // Preparation failed before dispatch, or a durable run already records the attempt.
        // Never retry that period automatically; keep future publications available.
        const current = periodBounds(
          row.period_kind,
          dateInZone(new Date(this.now()), row.timezone),
          row.timezone,
        );
        this.advance(
          row,
          current.periodStart,
          null,
          'Техническая ошибка подготовки. Этот период пропущен без повтора; следующие выпуски остаются включены. Проверьте сохранённые запуски.',
        );
      }
    } finally {
      this.store.db
        .prepare(
          'UPDATE analysis_schedules SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?',
        )
        .run(row.id, this.owner);
    }
  }
  private advance(row: Row, next: string, runId: string | null, note: string) {
    this.store.db
      .prepare(
        'UPDATE analysis_schedules SET next_period_start=?,last_run_id=COALESCE(?,last_run_id),note=?,updated_at=? WHERE id=? AND revision=? AND enabled=1 AND lease_owner=?',
      )
      .run(next, runId, note, this.timestamp(), row.id, row.revision, this.owner);
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.analysis.stop();
    await this.active;
  }
}
