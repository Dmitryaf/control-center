import { randomUUID } from 'node:crypto';
import {
  checkSchema,
  conclusionSchema,
  entrySchema,
  type Check,
  type CheckEntry,
} from '../../shared/checks.js';
import { calendarDate } from '../../shared/time.js';
import type { Snapshot } from '../../shared/contracts.js';
import { Store } from '../db.js';
import { HttpError } from '../errors.js';
import { checkView } from './signals.js';

interface Row {
  id: string;
  data: string;
  project_id: string | null;
  idea_id: string | null;
  created_at: string;
  updated_at: string;
}
export class Checks {
  constructor(private store: Store) {}
  list(): Check[] {
    return (
      this.store.db
        .prepare('SELECT * FROM checks ORDER BY created_at DESC')
        .all() as unknown as Row[]
    ).map((r) => ({
      ...JSON.parse(r.data),
      id: r.id,
      projectId: r.project_id,
      ideaId: r.idea_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
  require(id: string) {
    const check = this.list().find((c) => c.id === id);
    if (!check) throw new HttpError(404, 'Проверка не найдена.');
    return check;
  }
  entries(): CheckEntry[] {
    return (
      this.store.db
        .prepare('SELECT * FROM check_entries ORDER BY created_at DESC')
        .all() as unknown as (Row & { check_id: string })[]
    ).map((r) => ({
      ...JSON.parse(r.data),
      id: r.id,
      checkId: r.check_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
  views() {
    const entries = this.entries();
    return this.list().map((check) => {
      const row = check.projectId ? this.store.project(check.projectId) : null;
      const snapshot: Snapshot | undefined = row?.available ? JSON.parse(row.snapshot) : undefined;
      return checkView(check, entries, this.store.settings(), snapshot);
    });
  }
  save(input: unknown, id?: string, allowParallel = false) {
    const data = checkSchema.parse(input);
    const existing = id ? this.require(id) : null;
    if (existing?.status === 'completed')
      throw new HttpError(409, 'Завершённая проверка остаётся в архиве. Создайте следующую.');
    if (data.startedAt > calendarDate())
      throw new HttpError(400, 'Дата запуска не может быть в будущем.');
    if (data.reviewAt && data.reviewAt < data.startedAt)
      throw new HttpError(400, 'Дата пересмотра раньше запуска.');
    if (this.entries().some((e) => e.checkId === id && e.occurredAt < data.startedAt))
      throw new HttpError(400, 'Дата запуска позже записанной хронологии.');
    if (data.projectId && !this.store.project(data.projectId))
      throw new HttpError(400, 'Проект не найден.');
    if (
      data.ideaId &&
      !this.store.db.prepare("SELECT id FROM records WHERE id=? AND kind='ideas'").get(data.ideaId)
    )
      throw new HttpError(400, 'Идея не найдена.');
    const activating =
      data.status === 'active' &&
      (!existing || existing.status !== 'active' || existing.ideaId !== data.ideaId);
    if (
      activating &&
      data.ideaId &&
      !allowParallel &&
      this.list().some((c) => c.id !== id && c.ideaId === data.ideaId && c.status === 'active')
    ) {
      throw new HttpError(
        409,
        'Для этой идеи уже есть активная проверка. Подтвердите создание параллельной.',
      );
    }
    const now = new Date().toISOString();
    const checkId = id ?? randomUUID();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO checks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id, idea_id=excluded.idea_id, data=excluded.data, updated_at=excluded.updated_at`,
        )
        .run(
          checkId,
          data.projectId,
          data.ideaId,
          JSON.stringify({ ...data, conclusion: null, completedAt: null }),
          existing?.createdAt ?? now,
          now,
        );
      if (!existing && data.ideaId)
        this.store.db
          .prepare(
            "UPDATE records SET data=json_set(data,'$.state','testing'),updated_at=? WHERE id=?",
          )
          .run(now, data.ideaId);
    });
    return this.require(checkId);
  }
  complete(id: string, input: unknown) {
    const check = this.require(id);
    if (check.status === 'completed') throw new HttpError(409, 'Проверка уже завершена.');
    const conclusion = conclusionSchema.parse(input);
    const last =
      this.entries()
        .filter((e) => e.checkId === id)
        .map((e) => e.occurredAt)
        .sort()
        .at(-1) ?? check.startedAt;
    if (
      conclusion.completedAt > calendarDate() ||
      conclusion.completedAt < last ||
      conclusion.completedAt < check.startedAt
    )
      throw new HttpError(
        400,
        'Дата завершения должна быть между последней записью и сегодняшним днём.',
      );
    this.store.db.prepare('UPDATE checks SET data=?,updated_at=? WHERE id=?').run(
      JSON.stringify({
        ...check,
        status: 'completed',
        conclusion,
        completedAt: conclusion.completedAt,
      }),
      new Date().toISOString(),
      id,
    );
    return this.require(id);
  }
  saveEntry(checkId: string, input: unknown, id?: string) {
    const check = this.require(checkId);
    const data = entrySchema.parse(input);
    if (
      data.occurredAt < check.startedAt ||
      data.occurredAt > (check.completedAt ?? calendarDate())
    )
      throw new HttpError(400, 'Дата записи вне периода проверки.');
    if (data.kind === 'action') {
      data.type = null;
      data.numericValue = null;
    }
    const existing = id ? this.entries().find((e) => e.id === id && e.checkId === checkId) : null;
    if (id && !existing) throw new HttpError(404, 'Запись хронологии не найдена.');
    const now = new Date().toISOString();
    const entryId = id ?? randomUUID();
    this.store.db
      .prepare(
        `INSERT INTO check_entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      )
      .run(entryId, checkId, JSON.stringify(data), existing?.createdAt ?? now, now);
    return this.entries().find((e) => e.id === entryId)!;
  }
  deleteEntry(checkId: string, id: string) {
    this.require(checkId);
    if (
      !this.store.db.prepare('DELETE FROM check_entries WHERE id=? AND check_id=?').run(id, checkId)
        .changes
    )
      throw new HttpError(404, 'Запись не найдена.');
  }
}
