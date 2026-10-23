import { z } from 'zod';
import { prioritySchema } from './contracts.js';
import type { PeriodPayload, PeriodReport, PeriodSource } from './period-analysis.js';

const text = z.string().trim().max(1500);
export const proposalApprovalSchema = z
  .object({
    kind: z.enum(['task', 'idea']),
    projectId: z.string().uuid().nullable(),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().max(3000),
    reason: text.min(1),
    uncertainty: text,
    cheapCheck: text.min(1),
    expectedResult: text.default(''),
    acceptance: text.default(''),
    priority: prioritySchema.default('normal'),
    allowDuplicate: z.boolean().default(false),
    consent: z.literal(true),
  })
  .strict();
export type ProposalApproval = z.infer<typeof proposalApprovalSchema>;
export interface ProposalAcceptance {
  id: string;
  runId: string | null;
  runKey: string;
  proposalIndex: number;
  kind: 'task' | 'idea';
  resultId: string;
  resultExists: boolean;
  resultHref: string;
  createdAt: string;
  approved: ProposalApproval;
  original: {
    reviewKey: string;
    proposal: PeriodReport['proposals'][number];
    sources: PeriodSource[];
    model: string;
    packetHash: string;
    period: PeriodPayload['period'];
  };
}
