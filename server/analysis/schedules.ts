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
import { verifySchedule } from './schedule-guard.js';
import type { PeriodAnalysis } from './period-analysis.js';

type Row = {
  id: string;
  scope_key: string;
  project_name: string | null;
  period_kind: PeriodKind;
  timezone: string;
  model: string;
  selection_json: string;
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
  constructor(
    private store: Store,
    private analysis: PeriodAnalysis,
    private now: () => number = Date.now,
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
        return { id, stamp: projectStamp(project) };
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
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
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
      if (!this.analysis.status().ready)
        throw new HttpError(409, 'Настройка AI недоступна; подтвердите расписание заново.');
      verifySchedule(this.store, row.id, row.revision, this.analysis.status().model!);
      const bounds = periodBounds(row.period_kind, row.next_period_start, row.timezone);
      if (bounds.nextStartAt > this.timestamp()) return;
      const next = periodBounds(
        row.period_kind,
        dateInZone(new Date(bounds.nextStartAt), row.timezone),
        row.timezone,
      );
      if (next.nextStartAt <= this.timestamp()) {
        this.pause(
          row,
          'Пропущено несколько периодов. Автоматической отправки пропусков нет; включите расписание заново.',
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
      const key = `schedule:${row.id}:${row.period_kind}:${row.next_period_start}`;
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
      let run = existing
        ? this.analysis.read(String(existing.id))
        : this.analysis.prepareScheduled(
            {
              reviewId: review.id,
              requestKey: randomUUID(),
              selection: JSON.parse(row.selection_json),
              readConsent: true,
              repeatConsent: false,
            },
            { id: row.id, revision: row.revision, key },
          );
      if (run.status === 'pending') {
        if (!run.payload.sources.some((s) => s.text.trim())) run = this.analysis.cancel(run.id);
        else run = await this.analysis.run(run.id, { packetHash: run.packetHash, consent: true });
      }
      if (run.status === 'running') return;
      if (
        run.status !== 'succeeded' &&
        !(run.status === 'cancelled' && !run.payload.sources.some((s) => s.text.trim()))
      ) {
        this.pause(
          row,
          'Запрос не завершился успешно. Возможна оплата; автоматического повтора нет. Проверьте сохранённый анализ.',
        );
        this.store.db
          .prepare(
            'UPDATE analysis_schedules SET last_run_id=? WHERE id=? AND revision=? AND enabled=0',
          )
          .run(run.id, row.id, row.revision + 1);
        return;
      }
      this.advance(
        row,
        next.periodStart,
        run.id,
        run.status === 'succeeded'
          ? 'Результат сохранён.'
          : 'В разрешённых источниках нет данных; запрос не отправлен.',
      );
    } catch (cause) {
      this.pause(
        row,
        cause instanceof HttpError
          ? cause.message
          : 'Не удалось подготовить анализ. Расписание остановлено; проверьте сохранённые запуски.',
      );
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.analysis.stop();
    await this.active;
  }
}
