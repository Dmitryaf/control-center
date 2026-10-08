import { randomUUID } from 'node:crypto';
import {
  taskSchema,
  ideaSchema,
  decisionSchema,
  type RecordKind,
  type RecordItem,
  type Relation,
} from '../shared/contracts.js';
import { Store } from './db.js';
import { HttpError } from './errors.js';
import { Tasks } from './tasks.js';

export class Records {
  constructor(private store: Store) {}
  list(kind: RecordKind): RecordItem[] {
    if (kind === 'tasks') return new Tasks(this.store).list();
    const rows = this.store.db
      .prepare('SELECT * FROM records WHERE kind=? ORDER BY created_at DESC')
      .all(kind) as { id: string; data: string; created_at: string; updated_at: string }[];
    return rows.map((row) => ({
      ...JSON.parse(row.data),
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  save(kind: RecordKind, input: unknown, id: string = randomUUID(), update = false): RecordItem {
    if (kind === 'tasks') return new Tasks(this.store).save(input, id, update);
    const schema = { tasks: taskSchema, ideas: ideaSchema, decisions: decisionSchema }[kind];
    const data = schema.parse(input);
    if (data.projectId && !this.store.project(data.projectId))
      throw new HttpError(400, 'Связанный проект не найден.');
    const existing = this.store.db
      .prepare('SELECT created_at FROM records WHERE id=? AND kind=?')
      .get(id, kind) as { created_at: string } | undefined;
    if (update && !existing) throw new HttpError(404, 'Запись не найдена.');
    const now = new Date().toISOString();
    const created = existing?.created_at ?? now;
    this.store.db
      .prepare(
        `INSERT INTO records VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      project_id=excluded.project_id, data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(id, kind, data.projectId, JSON.stringify(data), created, now);
    return { ...data, id, createdAt: created, updatedAt: now };
  }
  delete(kind: RecordKind, id: string) {
    const result = this.store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
    if (!result.changes) throw new HttpError(404, 'Запись не найдена.');
  }
  relations(): Relation[] {
    return this.store.db.prepare('SELECT * FROM relations').all() as unknown as Relation[];
  }
  relate(data: Omit<Relation, 'id'>): Relation {
    if (data.sourceId === data.targetId) throw new HttpError(400, 'Выберите другой проект.');
    if (!this.store.project(data.sourceId) || !this.store.project(data.targetId))
      throw new HttpError(400, 'Проект связи не найден.');
    const existing = this.relations().find(
      (item) =>
        item.sourceId === data.sourceId &&
        item.targetId === data.targetId &&
        item.type === data.type,
    );
    if (existing) return existing;
    const relation = { ...data, id: randomUUID() };
    this.store.db
      .prepare('INSERT INTO relations VALUES(?,?,?,?)')
      .run(relation.id, data.sourceId, data.targetId, data.type);
    return relation;
  }
}
