import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { taskSchema, taskPatchSchema, taskResultSchema, type Task } from '../shared/contracts.js';
import { Store } from './db.js';
import { HttpError } from './errors.js';

interface TaskRow {
  id: string;
  data: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  number: number;
  revision: number;
}
const select = `SELECT r.*, t.number, t.revision FROM records r
  JOIN task_identity t ON t.record_id=r.id WHERE r.kind='tasks'`;
const stamp = (row: TaskRow): Task => ({
  ...taskSchema.parse(JSON.parse(row.data)),
  projectId: row.project_id,
  id: row.id,
  number: row.number,
  code: `CC-${row.number}`,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
export const taskWriteOptions = z.object({
  revision: z.number().int().positive().optional(),
  requestKey: z.string().trim().min(1).max(200).optional(),
  allowDuplicate: z.boolean().default(false),
});

export class Tasks {
  constructor(private store: Store) {}

  list(): Task[] {
    return (
      this.store.db
        .prepare(`${select} ORDER BY r.created_at DESC, t.number DESC`)
        .all() as unknown as TaskRow[]
    ).map(stamp);
  }

  read(identifier: string): Task {
    const code = /^CC-([1-9]\d*)$/i.exec(identifier);
    const row = this.store.db
      .prepare(`${select} AND ${code ? 't.number' : 'r.id'}=?`)
      .get(code ? Number(code[1]) : identifier) as unknown as TaskRow | undefined;
    if (!row) throw new HttpError(404, 'Задача не найдена. Проверьте номер CC-N или UUID.');
    return stamp(row);
  }

  save(input: unknown, id: string = randomUUID(), update = false): Task {
    const options = taskWriteOptions.parse(input);
    const data = taskSchema.parse(input);
    if (data.completedAt && data.result?.remaining)
      throw new HttpError(400, 'Осталась работа: сохраните результат без завершения задачи.');
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.store.transaction(() => {
      if (!update && options.requestKey) {
        const repeated = this.store.db
          .prepare('SELECT record_id, request_hash FROM task_identity WHERE request_key=?')
          .get(options.requestKey) as { record_id: string; request_hash: string } | undefined;
        if (repeated) {
          if (repeated.request_hash !== hash)
            throw new HttpError(
              409,
              'Этот ключ создания уже использован с другими полями. Прочитайте исходную задачу.',
            );
          return this.read(repeated.record_id);
        }
      }
      const existing = update ? this.read(id) : null;
      if (existing && options.revision === undefined)
        throw new HttpError(
          409,
          'Для изменения нужна revision из актуальной задачи. Прочитайте задачу и повторите.',
        );
      if (existing && options.revision !== existing.revision)
        throw new HttpError(
          409,
          `${existing.code} уже изменена. Прочитайте задачу и согласуйте изменения; ваш ввод не записан.`,
        );
      if (data.projectId && !this.store.project(data.projectId))
        throw new HttpError(400, 'Связанный проект не найден.');
      if (!update && !options.allowDuplicate) {
        const duplicate = this.list().find(
          (task) =>
            !task.completedAt &&
            task.projectId === data.projectId &&
            normalizeTitle(task.title) === normalizeTitle(data.title),
        );
        if (duplicate)
          throw new HttpError(
            409,
            `Похожая задача уже есть: ${duplicate.code}. Прочитайте её; для отдельной задачи подтвердите allowDuplicate.`,
          );
      }
      const now = new Date().toISOString();
      if (existing) {
        this.store.db
          .prepare(
            "UPDATE records SET project_id=?, data=?, updated_at=? WHERE id=? AND kind='tasks'",
          )
          .run(data.projectId, JSON.stringify(data), now, existing.id);
        this.store.db
          .prepare('UPDATE task_identity SET revision=revision+1 WHERE record_id=?')
          .run(existing.id);
        return this.read(existing.id);
      }
      this.store.db
        .prepare(
          "INSERT INTO records(id,kind,project_id,data,created_at,updated_at) VALUES(?,'tasks',?,?,?,?)",
        )
        .run(id, data.projectId, JSON.stringify(data), now, now);
      this.store.db
        .prepare('INSERT INTO task_identity(record_id,request_key,request_hash) VALUES(?,?,?)')
        .run(id, options.requestKey ?? null, options.requestKey ? hash : null);
      return this.read(id);
    });
  }

  patch(identifier: string, revision: number, change: unknown): Task {
    const patch = taskPatchSchema.parse(change);
    const current = this.read(identifier);
    return this.save({ ...current, ...patch, revision }, current.id, true);
  }

  complete(identifier: string, revision: number, input: unknown): Task {
    const result = taskResultSchema.parse(input);
    if (result.remaining)
      throw new HttpError(
        400,
        'Осталась работа: используйте task_update и сохраните частичный результат.',
      );
    return this.patch(identifier, revision, { result, completedAt: new Date().toISOString() });
  }

  importPlan(projectId: string, steps: string[]): Task[] {
    return steps.map((title) => {
      const existing = this.list().find(
        (task) =>
          task.projectId === projectId && normalizeTitle(task.title) === normalizeTitle(title),
      );
      if (existing) return existing;
      const requestKey =
        'legacy-plan:' +
        createHash('sha256')
          .update(`${projectId}\n${normalizeTitle(title)}`)
          .digest('hex');
      return this.save({ title, projectId, state: 'next', requestKey });
    });
  }
}
