import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { taskSchema, taskPatchSchema, taskResultSchema, type Task } from '../shared/contracts.js';
import { Store } from './db.js';
import { HttpError } from './errors.js';
import { TaskHistory } from './task-history.js';
import { isTaskOpen } from '../shared/task-status.js';
import { taskInProject, taskProjectIds } from '../shared/task-projects.js';
import { metadataSchema } from '../shared/contracts.js';
import { isClosedProject } from '../shared/project-lifecycle.js';

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
    return this.store.transaction(() => this.saveInTransaction(input, id, update));
  }

  // Keep a caller-owned local link atomic with the existing task creation invariants.
  // The callback may write its own table, never commit or start another transaction.
  createLinked(input: unknown, link: (task: Task) => void): Task {
    return this.store.transaction(() => {
      const task = this.saveInTransaction(input, randomUUID(), false);
      link(task);
      return task;
    });
  }

  // Caller owns the same write transaction as the project event/status.
  detachProjectInTransaction(projectId: string) {
    for (const task of this.list().filter((task) => taskInProject(task, projectId))) {
      this.saveInTransaction(
        { ...task, projectIds: taskProjectIds(task).filter((id) => id !== projectId) },
        task.id,
        true,
      );
    }
  }

  // Caller owns the same write transaction as the project event/status.
  cancelProjectInTransaction(projectId: string, projectEventId: string, at: string) {
    for (const task of this.list().filter(
      (task) =>
        taskInProject(task, projectId) &&
        isTaskOpen(task) &&
        !taskProjectIds(task).some((id) => {
          if (id === projectId) return false;
          const row = this.store.project(id);
          if (!row) return false;
          const metadata = row.metadata
            ? JSON.parse(row.metadata)
            : JSON.parse(row.snapshot).yaml.metadata;
          return !isClosedProject(metadataSchema.parse(metadata ?? {}).status);
        }),
    ))
      this.saveInTransaction({ ...task, revision: task.revision }, task.id, true, {
        at,
        projectEventId,
      });
  }

  private saveInTransaction(
    input: unknown,
    id: string,
    update: boolean,
    cancellation?: Task['cancellation'],
  ): Task {
    rejectRemovedState(input);
    const options = taskWriteOptions.parse(input);
    const data = taskSchema.parse(input);
    const existing = update ? this.read(id) : null;
    if (data.projectIds === undefined) {
      if (existing && taskProjectIds(existing).length > 1 && data.projectId !== existing.projectId)
        throw new HttpError(409, 'У задачи несколько проектов. Измените projectIds явно.');
      data.projectIds =
        existing && data.projectId === existing.projectId
          ? taskProjectIds(existing)
          : taskProjectIds(data);
    }
    data.projectIds = [...new Set(data.projectIds)].sort();
    data.projectId = data.projectIds[0] ?? null;
    if (existing && !Object.hasOwn(input as object, 'cancellation'))
      data.cancellation = existing.cancellation;
    if (cancellation) data.cancellation = cancellation;
    else if (
      data.cancellation &&
      JSON.stringify(data.cancellation) !== JSON.stringify(existing?.cancellation)
    )
      throw new HttpError(
        400,
        'Отмена записывается при закрытии проекта; для возврата очистите cancellation.',
      );
    if (data.completedAt && data.cancellation)
      throw new HttpError(
        400,
        'Отменённую задачу нельзя одновременно считать выполненной. Сначала верните её в работу.',
      );
    if (data.completedAt && data.result?.remaining)
      throw new HttpError(400, 'Осталась работа: сохраните результат без завершения задачи.');
    // Preserve durable create keys recorded before cancellation was introduced.
    const { cancellation: cancellationValue, projectIds, ...originalFields } = data;
    const hashFields = {
      ...originalFields,
      ...(cancellationValue ? { cancellation: cancellationValue } : {}),
      ...(projectIds.length > 1 ? { projectIds } : {}),
    };
    const hash = createHash('sha256').update(JSON.stringify(hashFields)).digest('hex');
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
    if (data.projectIds.some((id) => !this.store.project(id)))
      throw new HttpError(400, 'Связанный проект не найден.');
    if (!update && !options.allowDuplicate) {
      const duplicate = this.list().find(
        (task) =>
          isTaskOpen(task) &&
          JSON.stringify([...taskProjectIds(task)].sort()) === JSON.stringify(data.projectIds) &&
          normalizeTitle(task.title) === normalizeTitle(data.title),
      );
      if (duplicate)
        throw new HttpError(
          409,
          `Похожая задача уже есть: ${duplicate.code}. Прочитайте её; для отдельной задачи подтвердите allowDuplicate.`,
        );
    }
    const now = cancellation?.at ?? new Date().toISOString();
    if (existing) {
      this.store.db
        .prepare(
          "UPDATE records SET project_id=?, data=?, updated_at=? WHERE id=? AND kind='tasks'",
        )
        .run(data.projectId, JSON.stringify(data), now, existing.id);
      this.store.db
        .prepare('UPDATE task_identity SET revision=revision+1 WHERE record_id=?')
        .run(existing.id);
      const saved = this.read(existing.id);
      const kind =
        saved.cancellation && !existing.cancellation
          ? 'cancelled'
          : (existing.cancellation && !saved.cancellation) ||
              (existing.completedAt && !saved.completedAt)
            ? 'reopened'
            : saved.completedAt && saved.completedAt !== existing.completedAt
              ? 'completed'
              : JSON.stringify(saved.result) !== JSON.stringify(existing.result)
                ? 'result'
                : null;
      if (kind) new TaskHistory(this.store).append(saved, kind);
      return saved;
    }
    this.store.db
      .prepare(
        "INSERT INTO records(id,kind,project_id,data,created_at,updated_at) VALUES(?,'tasks',?,?,?,?)",
      )
      .run(id, data.projectId, JSON.stringify(data), now, now);
    this.store.db
      .prepare('INSERT INTO task_identity(record_id,request_key,request_hash) VALUES(?,?,?)')
      .run(id, options.requestKey ?? null, options.requestKey ? hash : null);
    const saved = this.read(id);
    if (saved.completedAt || saved.result)
      new TaskHistory(this.store).append(saved, saved.completedAt ? 'completed' : 'result');
    return saved;
  }

  patch(identifier: string, revision: number, change: unknown): Task {
    rejectRemovedState(change);
    const patch = taskPatchSchema.parse(change);
    const current = this.read(identifier);
    if (patch.projectId !== undefined && patch.projectIds === undefined) {
      if (taskProjectIds(current).length > 1 && patch.projectId !== current.projectId)
        throw new HttpError(409, 'У задачи несколько проектов. Измените projectIds явно.');
      patch.projectIds =
        patch.projectId === current.projectId
          ? taskProjectIds(current)
          : patch.projectId
            ? [patch.projectId]
            : [];
    }
    return this.save({ ...current, ...patch, revision }, current.id, true);
  }

  complete(identifier: string, revision: number, input: unknown): Task {
    if (this.read(identifier).cancellation)
      throw new HttpError(409, 'Сначала верните отменённую задачу в работу.');
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
          taskInProject(task, projectId) && normalizeTitle(task.title) === normalizeTitle(title),
      );
      if (existing) return existing;
      const requestKey =
        'legacy-plan:' +
        createHash('sha256')
          .update(`${projectId}\n${normalizeTitle(title)}`)
          .digest('hex');
      return this.save({ title, projectId, requestKey });
    });
  }
}

function rejectRemovedState(input: unknown) {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'state'))
    throw new HttpError(
      400,
      'Поле state больше не поддерживается. Используйте completedAt для завершения; отмена при закрытии проекта хранится отдельно в cancellation.',
    );
}
