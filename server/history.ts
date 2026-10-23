import { createHash } from 'node:crypto';
import {
  historyQuerySchema,
  historyCursorSchema,
  type HistoryEntry,
  type HistoryPage,
  type HistoryKind,
} from '../shared/history.js';
import type { Store } from './db.js';
import type { DecisionIndex } from './decisions/index.js';
import { dateInZone } from '../shared/periods.js';
import { reviewPageSchema, type Review } from '../shared/reviews.js';

// A read projection over existing owners, never an event journal or a copy of their bodies.
const entriesSql = `WITH options(zone) AS (VALUES(?)), entries(key,kind,event,sourceId,day,recordedAt,dateQuality,projectId,scopeProjectId,projectName,title,body,href) AS (
  SELECT 'task:'||h.id,'task','task_'||h.kind,CAST(h.id AS TEXT),history_day(h.recorded_at,(SELECT zone FROM options)),h.recorded_at,
    CASE WHEN h.kind='baseline' THEN 'baseline' ELSE 'recorded' END,h.project_id,COALESCE(h.project_id,json_extract(h.snapshot,'$.projectId')),h.project_name,
    json_extract(h.snapshot,'$.code')||' · '||json_extract(h.snapshot,'$.title'),
    CASE WHEN h.kind='reopened' THEN '' ELSE COALESCE(json_extract(h.snapshot,'$.result.summary'),'') END,
    '/history?task='||json_extract(h.snapshot,'$.code') FROM task_history h
  UNION ALL
  SELECT 'check:start:'||c.id,'check','check_started',c.id,json_extract(c.data,'$.startedAt'),NULL,'declared',c.project_id,COALESCE(c.project_id,json_extract(c.data,'$.projectId')),
    COALESCE(json_extract(p.metadata,'$.name'),json_extract(p.snapshot,'$.yaml.metadata.name'),json_extract(p.snapshot,'$.directoryName')),
    json_extract(c.data,'$.title'),json_extract(c.data,'$.question'),'/checks/'||c.id
    FROM checks c LEFT JOIN projects p ON p.id=c.project_id
  UNION ALL
  SELECT 'check:end:'||c.id,'check','check_completed',c.id,json_extract(c.data,'$.completedAt'),NULL,'declared',c.project_id,COALESCE(c.project_id,json_extract(c.data,'$.projectId')),
    COALESCE(json_extract(p.metadata,'$.name'),json_extract(p.snapshot,'$.yaml.metadata.name'),json_extract(p.snapshot,'$.directoryName')),
    json_extract(c.data,'$.title'),json_extract(c.data,'$.conclusion.actualResult'),'/checks/'||c.id
    FROM checks c LEFT JOIN projects p ON p.id=c.project_id WHERE json_extract(c.data,'$.status')='completed'
  UNION ALL
  SELECT 'check:entry:'||e.id,'check','check_'||json_extract(e.data,'$.kind'),e.id,json_extract(e.data,'$.occurredAt'),NULL,'declared',c.project_id,COALESCE(c.project_id,json_extract(c.data,'$.projectId')),
    COALESCE(json_extract(p.metadata,'$.name'),json_extract(p.snapshot,'$.yaml.metadata.name'),json_extract(p.snapshot,'$.directoryName')),
    json_extract(c.data,'$.title'),json_extract(e.data,'$.text'),'/checks/'||c.id||'#entry-'||e.id
    FROM check_entries e JOIN checks c ON c.id=e.check_id LEFT JOIN projects p ON p.id=c.project_id
  UNION ALL
  SELECT 'decision:'||r.id,'decision','decision',r.id,json_extract(r.data,'$.date'),NULL,'declared',r.project_id,r.project_id,
    COALESCE(json_extract(p.metadata,'$.name'),json_extract(p.snapshot,'$.yaml.metadata.name'),json_extract(p.snapshot,'$.directoryName')),
    json_extract(r.data,'$.title'),json_extract(r.data,'$.decision'),'/decisions#decision-'||r.id
    FROM records r LEFT JOIN projects p ON p.id=r.project_id WHERE r.kind='decisions'
  UNION ALL
  SELECT json_extract(value,'$.key'),'file_decision','file_decision',json_extract(value,'$.sourceId'),json_extract(value,'$.day'),NULL,'declared',
    json_extract(value,'$.projectId'),json_extract(value,'$.projectId'),json_extract(value,'$.projectName'),json_extract(value,'$.title'),'',json_extract(value,'$.href') FROM json_each(?)
  UNION ALL
  SELECT 'observation:'||o.id,'observation','observation',o.id,o.occurred_on,NULL,'declared',o.project_id,o.scope_project_id,o.project_name,
    substr(o.body,1,120),o.body,'/observations?id='||o.id FROM observations o
  UNION ALL
  SELECT 'review:'||r.id,'review','review',r.id,r.period_start,NULL,'declared',r.project_id,
    CASE WHEN r.scope_key='general' THEN NULL ELSE substr(r.scope_key,9) END,r.project_name,
    CASE WHEN r.period_kind='week' THEN 'Обзор недели · ' ELSE 'Обзор месяца · ' END||r.period_start||' — '||r.period_end,
    r.user_text,'/reviews?id='||r.id FROM reviews r
  UNION ALL
  SELECT 'analysis:'||a.id,'ai_analysis','ai_analysis',a.id,history_day(a.created_at,(SELECT zone FROM options)),a.created_at,'recorded',p.id,
    CASE WHEN a.scope_key='general' THEN NULL ELSE substr(a.scope_key,9) END,
    COALESCE(json_extract(a.payload_json,'$.scope.name'),json_extract(p.metadata,'$.name'),json_extract(p.snapshot,'$.directoryName')),
    CASE WHEN json_extract(a.payload_json,'$.origin.kind')='codex_manual' THEN 'Codex вручную · ' ELSE 'AI · ' END||json_extract(a.payload_json,'$.period.from')||' — '||json_extract(a.payload_json,'$.period.to')||' · '||a.generation||' · '||a.status,
    COALESCE(json_extract(a.report_json,'$.narrative'),a.error,''),'/period-analysis?review='||a.review_key||'&run='||a.id
    FROM analysis_runs a LEFT JOIN projects p ON p.id=substr(a.scope_key,9)
)
`;

export class History {
  constructor(
    private store: Store,
    private decisions: DecisionIndex,
  ) {
    store.db.function('history_day', (instant, zone) =>
      dateInZone(new Date(String(instant)), String(zone)),
    );
  }

  list(input: unknown = {}): HistoryPage {
    return this.listEntries(input);
  }
  fileMetadataStamp(key: string): string | null {
    const file = this.decisions
      .list()
      .find((item) => 'file:' + createHash('sha256').update(item.key).digest('hex') === key);
    if (!file?.metadata || file.error || !file.hasContent) return null;
    return createHash('sha256')
      .update(
        JSON.stringify({ projectId: file.projectId, metadata: file.metadata, title: file.title }),
      )
      .digest('hex');
  }

  forReview(
    review: Review,
    input: unknown = {},
    options?: { kinds?: HistoryKind[]; generalOnly?: boolean },
  ): HistoryPage {
    const page = reviewPageSchema.parse(input);
    return this.listEntries(
      {
        ...page,
        ...(review.scopeKey !== 'general' ? { projectId: review.scopeKey.slice(8) } : {}),
        from: review.periodStart,
        to: review.periodEnd,
        timezone: review.timezone,
      },
      review,
      options,
    );
  }

  private listEntries(
    input: unknown,
    bounds?: Pick<Review, 'startAt' | 'nextStartAt'>,
    options?: { kinds?: HistoryKind[]; generalOnly?: boolean },
  ): HistoryPage {
    const query = historyQuerySchema.parse(input);
    const cursor = query.cursor ? historyCursorSchema.parse(JSON.parse(query.cursor)) : null;
    const projects = this.store.projects();
    const names = new Map(
      projects.map((project) => {
        const snapshot = JSON.parse(project.snapshot);
        const metadata = project.metadata ? JSON.parse(project.metadata) : snapshot.yaml.metadata;
        return [project.id, metadata?.name ?? snapshot.directoryName] as const;
      }),
    );
    const files = this.decisions
      .list()
      .filter((file) => query.projectId === undefined || file.projectId === query.projectId);
    const fileRows = files
      .filter((file) => file.metadata && !file.error && file.hasContent)
      .map((file) => ({
        key: 'file:' + createHash('sha256').update(file.key).digest('hex'),
        sourceId: file.metadata!.id,
        day: file.metadata!.date,
        projectId: file.projectId,
        projectName: names.get(file.projectId) ?? null,
        title: `${file.metadata!.id} · ${file.title}`,
        href: `/projects/${file.projectId}#file-decisions`,
      }));
    const where: string[] = [];
    const values: (string | number)[] = [query.timezone, JSON.stringify(fileRows)];
    if (options?.generalOnly) where.push('scopeProjectId IS NULL');
    if (options?.kinds) {
      where.push('kind IN (SELECT value FROM json_each(?))');
      values.push(JSON.stringify(options.kinds));
    }
    if (query.projectId === null) where.push('projectId IS NULL');
    else if (query.projectId) {
      where.push('scopeProjectId=?');
      values.push(query.projectId);
    }
    if (query.kind) {
      where.push('kind=?');
      values.push(query.kind);
    }
    if (bounds) {
      where.push(
        "kind NOT IN ('review','ai_analysis')",
        '((recordedAt IS NOT NULL AND recordedAt>=? AND recordedAt<?) OR (recordedAt IS NULL AND day>=? AND day<=?))',
      );
      values.push(bounds.startAt, bounds.nextStartAt, query.from!, query.to!);
    } else if (query.from) {
      where.push('day>=?');
      values.push(query.from);
    }
    if (!bounds && query.to) {
      where.push('day<=?');
      values.push(query.to);
    }
    if (cursor) {
      where.push("(day,COALESCE(recordedAt,''),key)<(?,?,?)");
      values.push(cursor.day, cursor.time, cursor.key);
    }
    const rows = this.store.db
      .prepare(
        entriesSql +
          `SELECT key,kind,event,sourceId,day,recordedAt,dateQuality,projectId,scopeProjectId,projectName,title,
      substr(COALESCE(body,''),1,600) AS excerpt,length(COALESCE(body,''))>600 AS truncated,href FROM entries
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY day DESC,COALESCE(recordedAt,'') DESC,key DESC LIMIT ?`,
      )
      .all(...values, query.limit + 1) as unknown as (Omit<HistoryEntry, 'truncated'> & {
      truncated: number;
    })[];
    const items = rows
      .slice(0, query.limit)
      .map((row) => ({ ...row, truncated: Boolean(row.truncated) }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? JSON.stringify({ day: last.day, time: last.recordedAt ?? '', key: last.key })
          : null,
      files: {
        undated: files.filter((file) => !file.error && !file.metadata).length,
        unavailable:
          files.filter((file) => !!file.error || !file.hasContent).length +
          projects.filter(
            (project) =>
              (query.projectId === undefined || query.projectId === project.id) &&
              this.decisions.context(project.id).privateStatus === 'unavailable',
          ).length,
        notLoadedProjects: projects.filter(
          (project) =>
            (query.projectId === undefined || project.id === query.projectId) &&
            !this.decisions.hasSnapshot(project.id),
        ).length,
      },
    };
  }
}
