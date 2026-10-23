import { z } from 'zod';
import { periodDateSchema, periodKindSchema, type PeriodKind } from './periods.js';

export const reviewCreateSchema = z
  .object({
    projectId: z.string().uuid().nullable().default(null),
    kind: periodKindSchema,
    anchorDate: periodDateSchema,
  })
  .strict();
export const reviewPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    userText: z.string().max(60000),
  })
  .strict();
export const reviewDeleteSchema = z.object({ revision: z.number().int().positive() }).strict();
export const reviewPageSchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const reviewRelatedCursorSchema = z
  .object({ day: z.string().date(), id: z.string().uuid() })
  .strict();
export interface Review {
  id: string;
  projectId: string | null;
  scopeKey: string;
  projectName: string | null;
  kind: PeriodKind;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  startAt: string;
  nextStartAt: string;
  userText: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface RelatedReview {
  id: string;
  projectId: string | null;
  scopeKey: string;
  projectName: string | null;
  kind: PeriodKind;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  overlapsBoundary: boolean;
}
export interface RelatedReviews {
  items: RelatedReview[];
  nextCursor: string | null;
}
