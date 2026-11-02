import { createHash, randomUUID } from 'node:crypto';
import { metadataSchema, type Metadata, type Snapshot } from '../../shared/contracts.js';
import {
  projectCloseSchema,
  projectReopenSchema,
  isClosedProject,
  type ProjectLifecycleEvent,
  type ProjectLifecycleState,
} from '../../shared/project-lifecycle.js';
import { Store, type ProjectRow } from '../db.js';
import { HttpError } from '../errors.js';
import { z } from 'zod';
import type { ProjectLifecycleRecord } from '../../shared/project-lifecycle.js';
import { Tasks } from '../tasks.js';

type MetadataEdit = Omit<Metadata, 'current_focus' | 'next'> &
  Partial<Pick<Metadata, 'current_focus' | 'next'>>;

function metadata(row: ProjectRow): Metadata {
  const snapshot: Snapshot = JSON.parse(row.snapshot);
  return row.metadata
    ? metadataSchema.parse(JSON.parse(row.metadata))
    : (snapshot.yaml.metadata ?? metadataSchema.parse({ name: snapshot.directoryName }));
}
export class ProjectLifecycle {
  constructor(
    private store: Store,
    private now: () => Date = () => new Date(),
  ) {}
  private require(id: string) {
    const row = this.store.project(id);
    if (!row) throw new HttpError(404, 'Проект не найден.');
    return row;
  }
  state(id: string, status?: Metadata['status']): ProjectLifecycleState {
    const row = this.store.db
      .prepare(
        'SELECT * FROM project_lifecycle_events WHERE scope_project_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(id);
    const event: ProjectLifecycleEvent | null = row
      ? {
          id: String(row.id),
          revision: Number(row.revision),
          action: row.action as ProjectLifecycleEvent['action'],
          outcome: row.outcome as ProjectLifecycleEvent['outcome'],
          reason: String(row.reason),
          recordedAt: String(row.recorded_at),
        }
      : null;
    const current = status ?? metadata(this.require(id)).status;
    return {
      revision: event?.revision ?? 0,
      currentClosure:
        isClosedProject(current) && event?.action === 'closed' && event.outcome === current
          ? event
          : null,
    };
  }
  event(id: string): ProjectLifecycleRecord {
    z.string().uuid().parse(id);
    const row = this.store.db.prepare('SELECT * FROM project_lifecycle_events WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'Событие проекта не найдено.');
    return {
      id: String(row.id),
      revision: Number(row.revision),
      action: row.action as ProjectLifecycleRecord['action'],
      outcome: row.outcome as ProjectLifecycleRecord['outcome'],
      reason: String(row.reason),
      recordedAt: String(row.recorded_at),
      projectId: row.project_id as string | null,
      scopeProjectId: String(row.scope_project_id),
      projectName: String(row.project_name),
    };
  }
  private checkRevision(id: string, expected?: number) {
    const revision = this.state(id).revision;
    if (expected !== undefined && expected !== revision)
      throw new HttpError(
        409,
        'Состояние проекта изменилось. Обновите проект и подтвердите действие заново.',
      );
    return revision;
  }
  private append(
    id: string,
    project: Metadata,
    action: ProjectLifecycleEvent['action'],
    revision: number,
    reason: string,
    key: string | null = null,
    hash: string | null = null,
  ) {
    const eventId = randomUUID();
    const recordedAt = this.now().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO project_lifecycle_events
      (id,project_id,scope_project_id,project_name,revision,action,outcome,reason,recorded_at,request_key,request_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        id,
        id,
        project.name,
        revision + 1,
        action,
        action === 'closed' ? project.status : null,
        reason,
        recordedAt,
        key,
        hash,
      );
    if (action === 'closed')
      new Tasks(this.store).cancelProjectInTransaction(id, eventId, recordedAt);
  }
  close(id: string, input: unknown) {
    const data = projectCloseSchema.parse(input);
    this.transition(id, 'closed', data.revision, data.requestKey, data.outcome, data.reason);
  }
  reopen(id: string, input: unknown) {
    const data = projectReopenSchema.parse(input);
    this.transition(id, 'reopened', data.revision, data.requestKey, 'active', '');
  }
  private transition(
    id: string,
    action: ProjectLifecycleEvent['action'],
    revision: number,
    key: string,
    status: Metadata['status'],
    reason: string,
  ) {
    const hash = createHash('sha256')
      .update(JSON.stringify({ id, action, revision, status, reason }))
      .digest('hex');
    this.store.transaction(() => {
      const previous = this.store.db
        .prepare('SELECT request_hash FROM project_lifecycle_events WHERE request_key=?')
        .get(key);
      if (previous) {
        if (previous.request_hash !== hash)
          throw new HttpError(409, 'Ключ уже использован для другого действия.');
        this.require(id);
        return;
      }
      const row = this.require(id),
        current = metadata(row);
      this.checkRevision(id, revision);
      if (action === 'closed' && isClosedProject(current.status))
        throw new HttpError(409, 'Проект уже закрыт.');
      if (action === 'reopened' && !isClosedProject(current.status))
        throw new HttpError(409, 'Проект уже открыт.');
      const updated = { ...current, status };
      this.store.saveMetadata(id, updated, row.notes);
      this.append(id, updated, action, revision, reason, key, hash);
    });
  }
  saveMetadata(
    id: string,
    value: MetadataEdit | null,
    notes: string,
    baseHash?: string | null,
    expectedRevision?: number,
  ) {
    this.store.transaction(() => {
      const row = this.require(id),
        current = metadata(row);
      const revision = this.checkRevision(id, expectedRevision);
      const snapshot: Snapshot = JSON.parse(row.snapshot);
      const next = value
        ? {
            ...value,
            current_focus: value.current_focus ?? current.current_focus,
            next: value.next ?? current.next,
          }
        : (snapshot.yaml.metadata ?? metadataSchema.parse({ name: snapshot.directoryName }));
      this.store.saveMetadata(id, value ? next : null, notes, baseHash);
      if (
        current.status !== next.status &&
        (isClosedProject(current.status) || isClosedProject(next.status))
      )
        this.append(id, next, isClosedProject(next.status) ? 'closed' : 'reopened', revision, '');
    });
  }
}
