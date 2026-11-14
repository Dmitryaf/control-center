import {
  taskHistoryQuerySchema,
  taskSchema,
  type Task,
  type TaskHistoryEntry,
  type TaskHistoryPage,
} from '../shared/contracts.js';
import type { Store } from './db.js';
import { taskProjectsSql } from './task-scope.js';
import { taskProjectIds } from '../shared/task-projects.js';

export class TaskHistory {
  constructor(private store: Store) {}

  append(task: Task, kind: TaskHistoryEntry['kind']) {
    const names = taskProjectIds(task).map((id) => {
      const row = this.store.project(id)!;
      const snapshot = JSON.parse(row.snapshot);
      return (
        (row.metadata ? JSON.parse(row.metadata).name : snapshot.yaml.metadata?.name) ??
        snapshot.directoryName
      );
    });
    this.store.db
      .prepare(
        `INSERT INTO task_history(task_id,revision,kind,recorded_at,project_id,project_name,snapshot)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        task.id,
        task.revision,
        kind,
        task.updatedAt,
        task.projectId,
        names.join(' · ') || null,
        JSON.stringify({ ...task, projectNames: names }),
      );
  }

  list(input: unknown = {}): TaskHistoryPage {
    const query = taskHistoryQuerySchema.parse(input);
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (query.projectId !== undefined) {
      // A forgotten project is not a task that was originally general.
      conditions.push(
        query.projectId === null
          ? `json_array_length(${taskProjectsSql('h.snapshot')})=0`
          : `EXISTS(SELECT 1 FROM json_each(${taskProjectsSql('h.snapshot')}) WHERE value=?)`,
      );
      if (query.projectId !== null) values.push(query.projectId);
    }
    if (query.identifier) {
      const code = /^CC-([1-9]\d*)$/i.exec(query.identifier);
      conditions.push(code ? "json_extract(h.snapshot,'$.number')=?" : 'h.task_id=?');
      values.push(code ? Number(code[1]) : query.identifier);
    }
    if (query.from) {
      conditions.push('h.recorded_at>=?');
      values.push(query.from + 'T00:00:00.000Z');
    }
    if (query.to) {
      conditions.push('substr(h.recorded_at,1,10)<=?');
      values.push(query.to);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = this.store.db
      .prepare('SELECT count(*) AS total FROM task_history h' + where)
      .get(...values) as { total: number };
    const rows = this.store.db
      .prepare(
        `SELECT h.*, EXISTS(SELECT 1 FROM records r WHERE r.id=h.task_id AND r.kind='tasks') AS task_exists
      FROM task_history h${where} ORDER BY h.recorded_at DESC,h.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, query.offset) as unknown as {
      id: number;
      kind: TaskHistoryEntry['kind'];
      recorded_at: string;
      project_id: string | null;
      project_name: string | null;
      snapshot: string;
      task_exists: number;
    }[];
    return {
      total: total.total,
      items: rows.map((row) => {
        const snapshot = JSON.parse(row.snapshot) as Task & { projectNames?: string[] };
        return {
          id: row.id,
          kind: row.kind,
          recordedAt: row.recorded_at,
          projectId: row.project_id,
          projectName: row.project_name,
          projects: taskProjectIds(snapshot).map((id, index) => ({
            id,
            name: snapshot.projectNames?.[index] ?? row.project_name ?? 'Проект',
            exists: Boolean(this.store.project(id)),
          })),
          taskExists: Boolean(row.task_exists),
          task: { ...snapshot, ...taskSchema.parse(snapshot) },
        };
      }),
    };
  }
}
