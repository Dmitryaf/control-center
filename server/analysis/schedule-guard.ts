import type { Store } from '../db.js';
import { HttpError } from '../errors.js';
import { projectStamp, periodPolicyVersion } from './period-context.js';

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
  const approved = JSON.parse(String(row.access_json)) as { id: string; stamp: string }[];
  if (
    selection.projectIds.length !== approved.length ||
    approved.some(({ id, stamp }) => {
      const project = store.project(id);
      return !selection.projectIds.includes(id) || !project || projectStamp(project) !== stamp;
    })
  )
    throw new HttpError(410, 'Доступ к выбранным проектам изменился. Включите расписание заново.');
}
