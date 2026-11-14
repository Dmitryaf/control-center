import type { TaskInput } from './contracts.js';

// projectId remains a compatibility alias; arrays are authoritative when present.
export function taskProjectIds(task: Pick<TaskInput, 'projectId' | 'projectIds'>): string[] {
  return task.projectIds ?? (task.projectId ? [task.projectId] : []);
}
export function taskInProject(
  task: Pick<TaskInput, 'projectId' | 'projectIds'>,
  id: string | null,
) {
  const ids = taskProjectIds(task);
  return id === null ? ids.length === 0 : ids.includes(id);
}
