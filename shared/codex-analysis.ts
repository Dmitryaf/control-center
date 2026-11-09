import { z } from 'zod';
import { periodSelectionSchema, type PeriodRun } from './period-analysis.js';

export const codexDefaultQuestion =
  'Помоги осмыслить развитие выбранных проектов за этот период. Что изменилось по сути, что это даёт и куда разумно двигаться дальше? Посмотри на каждый проект отдельно, а затем на общую картину: есть ли полезные связи, переносимые идеи или возможности, которые я мог упустить? Пиши коротко и простыми словами. Не придумывай прогресс и не добавляй советы только ради заполнения ответа.';
export interface CodexAnalysisInstructions {
  policy: string;
  question: string;
  instruction: string;
}

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
    question: z.string().trim().max(4000).default(''),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/)
      .optional(),
    files: z.array(codexFileSchema).max(12).default([]),
    parentRunId: z.string().uuid().optional(),
    readConsent: z.literal(true),
  })
  .strict()
  .refine((value) => !value.parentRunId || !!value.question, 'Напишите уточняющий вопрос.')
  .transform((value) => ({ ...value, question: value.question || codexDefaultQuestion }));
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
