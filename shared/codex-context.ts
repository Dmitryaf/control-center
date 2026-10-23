import { z } from 'zod';

export const codexGrantSchema = z.discriminatedUnion('enabled', [
  z
    .object({
      revision: z.number().int().positive().nullable(),
      enabled: z.literal(true),
      readConsent: z.literal(true),
    })
    .strict(),
  z
    .object({ revision: z.number().int().positive().nullable(), enabled: z.literal(false) })
    .strict(),
]);
export const codexThreadsSchema = z
  .object({
    revision: z.number().int().positive(),
    cursor: z.string().max(4096).optional(),
    archived: z.boolean().default(false),
  })
  .strict();
export const codexPreviewSchema = z
  .object({
    revision: z.number().int().positive(),
    reviewId: z.string().uuid(),
    threadId: z.string().min(1).max(100),
  })
  .strict();
export const codexSaveSchema = z
  .object({
    previewId: z.string().uuid(),
    revision: z.number().int().positive().nullable(),
    summary: z.string().trim().min(1).max(6000),
    excerptIds: z.array(z.string().min(1).max(220)).max(8),
    confirm: z.literal(true),
  })
  .strict();
export interface CodexGrant {
  projectId: string;
  approved: boolean;
  enabled: boolean;
  revision: number | null;
}
export interface CodexThread {
  id: string;
  name: string;
  updatedAt: number;
}
export interface CodexExcerpt {
  id: string;
  turnId: string;
  itemId: string;
  role: 'user' | 'assistant';
  timeBasis: 'turn_start';
  turnStatus: string;
  at: string;
  text: string;
  partial: boolean;
}
export interface CodexPreview {
  id: string;
  reviewId: string;
  projectId: string;
  thread: CodexThread;
  expiresAt: string;
  sourceHash: string;
  excerpts: CodexExcerpt[];
  limitations: string[];
}
export interface CodexDigest {
  id: string;
  reviewKey: string;
  projectId: string | null;
  scopeProjectId: string;
  projectName: string;
  period: { from: string; to: string; timezone: string };
  thread: CodexThread;
  summary: string;
  excerpts: CodexExcerpt[];
  sourceHash: string;
  policyVersion: string;
  capturedAt: string;
  checkedAt: string;
  stale: boolean;
  revision: number;
  eligible: boolean;
}
