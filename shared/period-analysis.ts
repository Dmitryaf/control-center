import { z } from 'zod';
import type { PeriodKind } from './periods.js';
import { historyKindSchema } from './history.js';

export const periodSelectionSchema = z
  .object({
    projectIds: z.array(z.string().uuid()).max(10),
    includeGeneral: z.boolean(),
    sourceKinds: z.array(historyKindSchema.exclude(['review', 'ai_analysis'])).max(5),
    includeMetadata: z.boolean(),
    includeOpenTasks: z.boolean(),
    includeUserText: z.boolean(),
    includeRelatedReviews: z.boolean(),
    includeRelatedAnalyses: z.boolean().default(false),
  })
  .strict()
  .refine(
    (s) =>
      s.sourceKinds.length > 0 ||
      s.includeMetadata ||
      s.includeOpenTasks ||
      s.includeUserText ||
      s.includeRelatedReviews ||
      s.includeRelatedAnalyses,
    'Выберите хотя бы один источник.',
  );
export type PeriodSelection = z.infer<typeof periodSelectionSchema>;
export const periodPrepareSchema = z
  .object({
    reviewId: z.string().uuid(),
    requestKey: z.string().uuid(),
    selection: periodSelectionSchema,
    readConsent: z.literal(true),
    repeatConsent: z.boolean().default(false),
  })
  .strict();
export const periodRunSchema = z
  .object({ packetHash: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) })
  .strict();
export const periodReportSchema = z
  .object({
    narrative: z.string().min(1).max(20000),
    findings: z
      .array(
        z
          .object({
            statement: z.string().min(1).max(2000),
            sources: z.array(z.string().min(1).max(150)).min(1).max(10),
          })
          .strict(),
      )
      .max(20),
    uncertainties: z.array(z.string().min(1).max(2000)).max(12),
    proposals: z
      .array(
        z
          .object({
            kind: z.enum(['improvement', 'connection', 'idea']),
            projectIds: z.array(z.string().uuid()).max(2),
            title: z.string().min(1).max(240),
            description: z.string().max(5000),
            reason: z.string().min(1).max(3000),
            uncertainty: z.string().max(3000),
            cheapCheck: z.string().min(1).max(3000),
            sources: z.array(z.string().min(1).max(150)).min(1).max(10),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type PeriodReport = z.infer<typeof periodReportSchema>;
export interface PeriodSource {
  id: string;
  kind: string;
  projectId: string | null;
  title: string;
  text: string;
  day: string | null;
  recordedAt: string | null;
  dateQuality: string;
  partial: boolean;
}
export interface PeriodPayload {
  policyVersion: string;
  preparedAt: string;
  period: {
    kind: PeriodKind;
    from: string;
    to: string;
    timezone: string;
    startAt: string;
    nextStartAt: string;
    incomplete: boolean;
  };
  scope: {
    name?: string | null;
    reviewId: string;
    key: string;
    projectIds: string[];
    includesGeneral: boolean;
  };
  sources: PeriodSource[];
  limitations: string[];
}
export type PeriodRunState =
  'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export interface PeriodRunSummary {
  id: string;
  reviewId: string | null;
  reviewKey: string;
  scopeKey: string;
  generation: number;
  trigger: 'manual' | 'scheduled';
  approvedAt: string | null;
  status: PeriodRunState;
  model: string;
  packetHash: string;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  responseId: string | null;
}
export interface PeriodRun extends PeriodRunSummary {
  selection: PeriodSelection;
  payload: PeriodPayload;
  report: PeriodReport | null;
  rawOutput: string | null;
}
export interface PeriodRunPage {
  items: PeriodRunSummary[];
  nextCursor: string | null;
}
export const periodRunPageSchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(30).default(10),
  })
  .strict();
export const periodRunCursorSchema = z.object({ generation: z.number().int().positive() }).strict();
