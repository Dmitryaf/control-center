import { z } from 'zod';
import { periodSelectionSchema, type PeriodSelection } from './period-analysis.js';
import type { PeriodKind } from './periods.js';

export const analysisProviderSchema = z.enum(['openai', 'codex']);
export type AnalysisProvider = z.infer<typeof analysisProviderSchema>;

export const scheduleEnableSchema = z
  .object({
    provider: analysisProviderSchema.default('openai'),
    expectedPolicy: z.string().min(1).max(100).optional(),
    reviewId: z.string().uuid(),
    revision: z.number().int().positive().nullable(),
    selection: periodSelectionSchema,
    expectedModel: z.string().min(1).max(100),
    readConsent: z.literal(true),
    sendConsent: z.literal(true),
    codexProjectIds: z.array(z.string().uuid()).max(10).default([]),
    codexReadConsent: z.literal(true).optional(),
    codexSendConsent: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => value.provider !== 'codex' || !!value.expectedPolicy,
    'Подтвердите актуальный промпт Codex.',
  );
export const scheduleRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export interface AnalysisSchedule {
  provider?: AnalysisProvider;
  id: string;
  scopeKey: string;
  projectName: string | null;
  kind: PeriodKind;
  timezone: string;
  model: string;
  selection: PeriodSelection;
  codexProjectIds?: string[];
  revision: number;
  enabled: boolean;
  nextPeriodStart: string;
  lastRunId: string | null;
  lastRunReviewKey: string | null;
  note: string | null;
  updatedAt: string;
}
