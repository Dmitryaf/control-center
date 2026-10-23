import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  observationCreateSchema,
  observationPatchSchema,
  observationDeleteSchema,
  type Observation,
} from '../shared/observations.js';
import type { Store } from './db.js';
import { HttpError } from './errors.js';

const select = `SELECT id,body,occurred_on AS occurredOn,project_id AS projectId,scope_project_id AS scopeProjectId,
  project_name AS projectName,revision,created_at AS createdAt,updated_at AS updatedAt FROM observations`;
export class Observations {
  constructor(private store: Store) {}
  read(id: string): Observation {
    z.string().uuid().parse(id);
    const row = this.store.db.prepare(select + ' WHERE id=?').get(id) as unknown as
      Observation | undefined;
    if (!row) throw new HttpError(404, 'Наблюдение не найдено.');
    return row;
  }
  private projectName(id: string | null) {
    if (!id) return null;
    const project = this.store.project(id);
    if (!project)
      throw new HttpError(
        400,
        'Проект не найден. Выберите существующий проект или сохраните общую запись.',
      );
    const snapshot = JSON.parse(project.snapshot);
    return (
      (project.metadata ? JSON.parse(project.metadata).name : snapshot.yaml.metadata?.name) ??
      snapshot.directoryName
    );
  }
  create(input: unknown): Observation {
    const { requestKey, ...data } = observationCreateSchema.parse(input);
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.store.transaction(() => {
      if (requestKey) {
        const repeated = this.store.db
          .prepare('SELECT id,request_hash FROM observations WHERE request_key=?')
          .get(requestKey) as { id: string; request_hash: string } | undefined;
        if (repeated) {
          if (repeated.request_hash !== hash)
            throw new HttpError(
              409,
              'Этот ключ создания уже использован с другими полями. Найдите сохранённое наблюдение в истории; текущий ввод не записан.',
            );
          return this.read(repeated.id);
        }
      }
      const projectName = this.projectName(data.projectId);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          `INSERT INTO observations(id,project_id,scope_project_id,project_name,occurred_on,body,revision,created_at,updated_at,request_key,request_hash) VALUES(?,?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(
          id,
          data.projectId,
          data.projectId,
          projectName,
          data.occurredOn,
          data.body,
          now,
          now,
          requestKey ?? null,
          hash,
        );
      return this.read(id);
    });
  }
  patch(id: string, input: unknown): Observation {
    const { revision, ...patch } = observationPatchSchema.parse(input);
    return this.store.transaction(() => {
      const current = this.read(id);
      this.checkRevision(current, revision);
      const reassigned = patch.projectId !== undefined && patch.projectId !== current.projectId;
      // Explicit null also clears the retained identity of a removed project.
      const general = patch.projectId === null;
      const projectId = patch.projectId === undefined ? current.projectId : patch.projectId;
      const scopeProjectId = reassigned || general ? projectId : current.scopeProjectId;
      const projectName = reassigned || general ? this.projectName(projectId) : current.projectName;
      this.store.db
        .prepare(
          `UPDATE observations SET body=?,occurred_on=?,project_id=?,scope_project_id=?,project_name=?,revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(
          patch.body ?? current.body,
          patch.occurredOn ?? current.occurredOn,
          projectId,
          scopeProjectId,
          projectName,
          new Date().toISOString(),
          id,
        );
      return this.read(id);
    });
  }
  delete(id: string, input: unknown) {
    const { revision } = observationDeleteSchema.parse(input);
    return this.store.transaction(() => {
      this.checkRevision(this.read(id), revision);
      this.store.db.prepare('DELETE FROM observations WHERE id=?').run(id);
    });
  }
  private checkRevision(current: Observation, revision: number) {
    if (current.revision !== revision)
      throw new HttpError(
        409,
        'Наблюдение уже изменено. Прочитайте сохранённую запись и сравните её с черновиком; текущий ввод не записан.',
      );
  }
}
