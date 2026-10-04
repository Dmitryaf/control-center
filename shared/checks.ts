import { z } from 'zod';
import type { RecordStamp, Signal } from './contracts.js';

const required = z.string().trim().min(1).max(10000);
export const checkSchema = z.object({
  title: required.max(240),
  projectId: z.string().uuid().nullable().default(null),
  ideaId: z.string().uuid().nullable().default(null),
  question: required,
  assumption: required,
  expectedExternalResult: required,
  startedAt: z.string().date(),
  reviewAt: z.string().date().nullable().default(null),
  reviewCondition: z.string().trim().max(10000).default(''),
  continueIf: required,
  stopIf: required,
  nextExternalAction: required,
  status: z.enum(['active', 'paused']).default('active'),
});
export const conclusionSchema = z.object({
  actualResult: required,
  whatWasConfirmedOrRejected: required,
  outcome: z.enum(['continue', 'change', 'stop']),
  basis: required,
  nextQuestion: z.string().trim().max(10000).default(''),
  completedAt: z.string().date(),
});
export const entrySchema = z.object({
  kind: z.enum(['action', 'evidence']),
  occurredAt: z.string().date(),
  text: required,
  type: z.enum(['fact', 'observation', 'problem', 'decision']).nullable().default(null),
  url: z
    .union([
      z.literal(''),
      z
        .string()
        .url()
        .max(2000)
        .refine((value) => /^https?:\/\//i.test(value)),
    ])
    .default(''),
  numericValue: z.number().finite().nullable().default(null),
});
export type CheckInput = z.infer<typeof checkSchema>;
export type Conclusion = z.infer<typeof conclusionSchema>;
export type CheckEntryInput = z.infer<typeof entrySchema>;
export type CheckEntry = CheckEntryInput & RecordStamp & { checkId: string };
export type Check = Omit<CheckInput, 'status'> &
  RecordStamp & {
    status: 'active' | 'paused' | 'completed';
    conclusion: Conclusion | null;
    completedAt: string | null;
  };
export interface CheckView extends Check {
  lastExternalActionAt: string | null;
  lastEvidenceAt: string | null;
  daysActive: number;
  daysWithoutMovement: number;
  signals: Signal[];
}
