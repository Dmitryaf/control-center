import { createHash } from 'node:crypto';
import {
  historyQuerySchema,
  historyCursorSchema,
  type HistoryEntry,
  type HistoryPage,
} from '../shared/history.js';
import type { Store } from './db.js';
import type { DecisionIndex } from './decisions/index.js';

// A read projection over existing owners, never an event journal or a copy of their bodies.
const entriesSql = `WITH entries(key,kind,event,sourceId,day,recordedAt,dateQuality,projectId,scopeProjectId,projectName,title,body,href) AS (
  SELECT 'task:'||h.id,'task','task_'||h.kind,CAST(h.id AS TEXT),substr(h.recorded_at,1,10),h.recorded_at,
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
)
`;

export class History {
  constructor(
    private store: Store,
    private decisions: DecisionIndex,
  ) {}

  list(input: unknown = {}): HistoryPage {
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
    const values: (string | number)[] = [JSON.stringify(fileRows)];
    if (query.projectId === null) where.push('projectId IS NULL');
    else if (query.projectId) {
      where.push('scopeProjectId=?');
      values.push(query.projectId);
    }
    if (query.kind) {
      where.push('kind=?');
      values.push(query.kind);
    }
    if (query.from) {
      where.push('day>=?');
      values.push(query.from);
    }
    if (query.to) {
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
