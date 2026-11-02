import { z } from 'zod';

export const closedProjectStatuses = ['completed', 'stopped'] as const;
export const isClosedProject = (status: string) =>
  closedProjectStatuses.some((value) => value === status);
export const projectCloseSchema = z
  .object({
    outcome: z.enum(closedProjectStatuses),
    reason: z.string().trim().max(10000).default(''),
    revision: z.number().int().nonnegative(),
    requestKey: z.string().uuid(),
  })
  .strict();
export const projectReopenSchema = projectCloseSchema.pick({ revision: true, requestKey: true });
export interface ProjectLifecycleEvent {
  id: string;
  revision: number;
  action: 'closed' | 'reopened';
  outcome: 'completed' | 'stopped' | null;
  reason: string;
  recordedAt: string;
}
export interface ProjectLifecycleRecord extends ProjectLifecycleEvent {
  projectId: string | null;
  scopeProjectId: string;
  projectName: string;
}
export interface ProjectLifecycleState {
  revision: number;
  currentClosure: ProjectLifecycleEvent | null;
}
