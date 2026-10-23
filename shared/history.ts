import { z } from 'zod';

export const historyKindSchema = z.enum([
  'task',
  'check',
  'decision',
  'file_decision',
  'observation',
]);
export type HistoryKind = z.infer<typeof historyKindSchema>;
export const historyQuerySchema = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    kind: historyKindSchema.optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Начало периода должно быть не позже окончания.',
    path: ['to'],
  });
export const historyCursorSchema = z
  .object({
    day: z.string().date(),
    time: z.union([z.string().datetime(), z.literal('')]),
    key: z.string().min(1).max(150),
  })
  .strict();
export type HistoryEvent =
  | 'task_baseline'
  | 'task_result'
  | 'task_completed'
  | 'task_reopened'
  | 'check_started'
  | 'check_completed'
  | 'check_action'
  | 'check_evidence'
  | 'decision'
  | 'file_decision'
  | 'observation';
export interface HistoryEntry {
  key: string;
  kind: HistoryKind;
  event: HistoryEvent;
  sourceId: string;
  day: string;
  recordedAt: string | null;
  dateQuality: 'recorded' | 'baseline' | 'declared';
  projectId: string | null;
  scopeProjectId: string | null;
  projectName: string | null;
  title: string;
  excerpt: string;
  truncated: boolean;
  href: string;
}
export interface HistoryPage {
  items: HistoryEntry[];
  nextCursor: string | null;
  files: { undated: number; unavailable: number; notLoadedProjects: number };
}
