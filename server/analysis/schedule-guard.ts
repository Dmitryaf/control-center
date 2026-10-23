import type { Store } from '../db.js';
import { HttpError } from '../errors.js';
import { projectStamp, periodPolicyVersion } from './period-context.js';
import { CodexContext } from '../codex/context.js';

export type ScheduleAccess = { id: string; stamp: string; codexRevision?: number };
export function verifyScheduleAccess(
  store: Store,
  projectIds: string[],
  approved: ScheduleAccess[],
) {
  if (
    projectIds.length !== approved.length ||
    approved.some(({ id, stamp, codexRevision }) => {
      const project = store.project(id);
      if (!projectIds.includes(id) || !project || projectStamp(project) !== stamp) return true;
      if (codexRevision !== undefined) {
        const grant = new CodexContext(store).grant(id);
        return !grant.enabled || grant.revision !== codexRevision;
      }
      return false;
    })
  )
    throw new HttpError(
      410,
      'Доступ к выбранным проектам или Codex изменился. Подтвердите источники заново.',
    );
}

export function verifySchedule(store: Store, id: string, revision: number, model: string) {
  const row = store.db.prepare('SELECT * FROM analysis_schedules WHERE id=?').get(id);
  if (
    !row ||
    !row.enabled ||
    row.revision !== revision ||
    row.model !== model ||
    row.policy_version !== periodPolicyVersion
  )
    throw new HttpError(410, 'Разрешение расписания отключено или изменилось.');
  const selection = JSON.parse(String(row.selection_json));
  const approved = JSON.parse(String(row.access_json)) as ScheduleAccess[];
  verifyScheduleAccess(store, selection.projectIds, approved);
}
