import { z } from 'zod';
import type { Signal } from './contracts.js';
export const fileDecisionSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^D-\d{4,}$/),
  title: z.string().trim().min(1).max(240),
  date: z.string().date(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  area: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  implementation: z.enum(['unknown', 'not_implemented', 'partial', 'implemented']),
  review_after: z.string().date().optional(),
  supersedes: z.array(z.string()).default([]),
  superseded_by: z.string().nullable().default(null),
  visibility: z.enum(['repository', 'private']),
});
export type FileDecisionMetadata = z.infer<typeof fileDecisionSchema>;
export interface FileDecision {
  key: string;
  projectId: string;
  sourcePath: string;
  source: 'repository' | 'private_context' | 'private';
  metadata: FileDecisionMetadata | null;
  title: string;
  body: string;
  hasContent?: boolean;
  error: string | null;
  signals: Signal[];
}
