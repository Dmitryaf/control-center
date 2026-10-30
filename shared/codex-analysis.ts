import { z } from 'zod';
import { periodSelectionSchema, type PeriodRun } from './period-analysis.js';

export const codexFileSchema = z
  .object({
    projectId: z.string().uuid(),
    path: z.string().min(1).max(240),
  })
  .strict();
export const codexPrepareSchema = z
  .object({
    reviewId: z.string().uuid(),
    requestKey: z.string().uuid(),
    selection: periodSelectionSchema,
    question: z.string().trim().min(1).max(4000),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/)
      .optional(),
    files: z.array(codexFileSchema).max(12).default([]),
    parentRunId: z.string().uuid().optional(),
    readConsent: z.literal(true),
  })
  .strict();
export const codexFilesQuerySchema = z
  .object({
    projectIds: z.array(z.string().uuid()).min(1).max(10),
    readConsent: z.literal(true),
  })
  .strict();
export const codexConversationQuerySchema = z.object({ sessionId: z.string().uuid() }).strict();
export interface CodexExecutionStatus {
  available: boolean;
  version: string | null;
  reason: string | null;
  authenticated?: boolean;
  login?: {
    state: 'starting' | 'waiting' | 'failed';
    code: string | null;
    url: string | null;
    error: string | null;
  } | null;
}
export interface CodexFileList {
  projects: { id: string; name: string; files: string[]; truncated: boolean }[];
}
export interface CodexConversation {
  sessionId: string;
  turns: PeriodRun[];
}
