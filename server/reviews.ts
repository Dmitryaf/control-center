import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  reviewCreateSchema,
  reviewPatchSchema,
  reviewDeleteSchema,
  reviewPageSchema,
  reviewRelatedCursorSchema,
  type Review,
  type RelatedReviews,
  type RelatedReview,
  type LatestProjectReview,
} from '../shared/reviews.js';
import { periodBounds } from '../shared/periods.js';
import type { Store } from './db.js';
import { HttpError } from './errors.js';

const columns = `id,project_id AS projectId,scope_key AS scopeKey,project_name AS projectName,
  period_kind AS kind,period_start AS periodStart,period_end AS periodEnd,timezone,
  start_at AS startAt,next_start_at AS nextStartAt,user_text AS userText,revision,
  created_at AS createdAt,updated_at AS updatedAt`;
export class Reviews {
  constructor(private store: Store) {}
  latestProject(projectId: string): LatestProjectReview | null {
    z.string().uuid().parse(projectId);
    return (
      (this.store.db
        .prepare(
          `
      SELECT r.id,r.period_kind AS kind,r.period_start AS periodStart,r.period_end AS periodEnd,
        substr(CASE WHEN trim(r.user_text)<>'' THEN r.user_text ELSE json_extract(a.report_json,'$.narrative') END,1,600) AS excerpt,
        CASE WHEN trim(r.user_text)<>'' THEN NULL ELSE a.id END AS analysisId
      FROM reviews r LEFT JOIN analysis_runs a ON a.id=(
        SELECT id FROM analysis_runs WHERE review_id=r.id AND status='succeeded'
          AND trim(COALESCE(json_extract(report_json,'$.narrative'),''))<>''
        ORDER BY created_at DESC,id DESC LIMIT 1)
      WHERE r.scope_key=? AND (trim(r.user_text)<>'' OR a.id IS NOT NULL)
      ORDER BY r.period_end DESC,r.period_start DESC,r.updated_at DESC,r.id DESC LIMIT 1
    `,
        )
        .get('project:' + projectId) as unknown as LatestProjectReview | undefined) ?? null
    );
  }
  read(id: string): Review {
    z.string().uuid().parse(id);
    const row = this.store.db
      .prepare(`SELECT ${columns} FROM reviews WHERE id=?`)
      .get(id) as unknown as Review | undefined;
    if (!row) throw new HttpError(404, 'Обзор не найден.');
    return row;
  }
  // Creation only opens a document. Text is saved separately with its revision.
  // The unique calendar key also makes a lost create response safe to retry.
  create(input: unknown, timezone = this.store.settings().timezone): Review {
    const data = reviewCreateSchema.parse(input);
    return this.store.transaction(() => {
      const bounds = periodBounds(data.kind, data.anchorDate, timezone);
      const scope = data.projectId ? `project:${data.projectId}` : 'general';
      const existing = this.store.db
        .prepare('SELECT id FROM reviews WHERE scope_key=? AND period_kind=? AND period_start=?')
        .get(scope, data.kind, bounds.periodStart) as { id: string } | undefined;
      if (existing) return this.read(existing.id);
      const project = data.projectId ? this.store.project(data.projectId) : undefined;
      if (data.projectId && !project)
        throw new HttpError(400, 'Проект не найден. Выберите существующий проект или общий обзор.');
      const snapshot = project ? JSON.parse(project.snapshot) : null;
      const name = project
        ? ((project.metadata ? JSON.parse(project.metadata).name : snapshot.yaml.metadata?.name) ??
          snapshot.directoryName)
        : null;
      const id = randomUUID();
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          `INSERT INTO reviews(id,project_id,scope_key,project_name,period_kind,period_start,period_end,timezone,start_at,next_start_at,user_text,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'',1,?,?)`,
        )
        .run(
          id,
          data.projectId,
          scope,
          name,
          data.kind,
          bounds.periodStart,
          bounds.periodEnd,
          bounds.timezone,
          bounds.startAt,
          bounds.nextStartAt,
          now,
          now,
        );
      return this.read(id);
    });
  }
  patch(id: string, input: unknown): Review {
    const data = reviewPatchSchema.parse(input);
    return this.store.transaction(() => {
      this.checkRevision(this.read(id), data.revision);
      this.store.db
        .prepare('UPDATE reviews SET user_text=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(data.userText, new Date().toISOString(), id);
      return this.read(id);
    });
  }
  delete(id: string, input: unknown) {
    const { revision } = reviewDeleteSchema.parse(input);
    this.store.transaction(() => {
      this.checkRevision(this.read(id), revision);
      this.store.db
        .prepare(
          "UPDATE analysis_runs SET status='cancelled',error=?,finished_at=? WHERE review_id=? AND status='pending'",
        )
        .run('Обзор удалён до отправки.', new Date().toISOString(), id);
      this.store.db.prepare('DELETE FROM reviews WHERE id=?').run(id);
    });
  }
  related(id: string, input: unknown = {}): RelatedReviews {
    const current = this.read(id);
    const query = reviewPageSchema.parse(input);
    const cursor = query.cursor ? reviewRelatedCursorSchema.parse(JSON.parse(query.cursor)) : null;
    const where = ['id<>?', 'period_start<=?', 'period_end>=?'];
    const args: (string | number)[] = [id, current.periodEnd, current.periodStart];
    if (current.scopeKey !== 'general') {
      where.push('scope_key=?', "period_kind='week'");
      args.push(current.scopeKey);
    } else if (current.kind === 'week') where.push("scope_key<>'general'", "period_kind='week'");
    else where.push("(period_kind='week' OR (period_kind='month' AND scope_key<>'general'))");
    if (cursor) {
      where.push('(period_start,id)<(?,?)');
      args.push(cursor.day, cursor.id);
    }
    const rows = this.store.db
      .prepare(
        `SELECT id,project_id AS projectId,scope_key AS scopeKey,project_name AS projectName,
      period_kind AS kind,period_start AS periodStart,period_end AS periodEnd,timezone FROM reviews
      WHERE ${where.join(' AND ')} ORDER BY period_start DESC,id DESC LIMIT ?`,
      )
      .all(...args, query.limit + 1) as unknown as Omit<RelatedReview, 'overlapsBoundary'>[];
    const items = rows.slice(0, query.limit).map((row) => ({
      ...row,
      overlapsBoundary: row.periodStart < current.periodStart || row.periodEnd > current.periodEnd,
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? JSON.stringify({ day: last.periodStart, id: last.id })
          : null,
    };
  }
  private checkRevision(current: Review, revision: number) {
    if (current.revision !== revision)
      throw new HttpError(
        409,
        'Обзор уже изменён. Сравните сохранённый текст с черновиком; текущий ввод не записан.',
      );
  }
}
