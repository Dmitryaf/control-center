import { z } from 'zod';
import { periodSelectionSchema, type PeriodSelection } from './period-analysis.js';
import type { PeriodKind } from './periods.js';

export const scheduleEnableSchema = z
  .object({
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
  .strict();
export const scheduleRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export interface AnalysisSchedule {
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
