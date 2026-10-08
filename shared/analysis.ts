import { z } from 'zod';
import { prioritySchema } from './contracts.js';

const detail = z.string().trim().max(10000);
export const analysisSelectionSchema = z
  .object({
    projectIds: z.array(z.string().uuid()).min(1).max(10),
  })
  .strict();
export const analysisRunSchema = z
  .object({
    previewId: z.string().uuid(),
    consent: z.literal(true),
  })
  .strict();
export const analysisReportSchema = z
  .object({
    summary: detail.min(1),
    proposals: z
      .array(
        z
          .object({
            projectId: z.string().nullable(),
            title: z.string().trim().min(1).max(240),
            description: detail,
            expectedResult: detail,
            acceptance: detail,
            priority: prioritySchema,
            reason: detail.min(1),
            sources: z.array(z.string().min(1).max(100)).min(1).max(10),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type AnalysisReport = z.infer<typeof analysisReportSchema>;
export interface AnalysisPayload {
  preparedAt: string;
  projects: {
    source: string;
    id: string;
    name: string;
    status: string;
    priority: string;
    goal: string;
    blockedBy: string[];
    available: boolean;
    snapshotAt: string;
    tasks: {
      source: string;
      code: string;
      title: string;
      state: string;
      priority: string;
      description: string;
      expectedResult: string;
      acceptance: string;
      updatedAt: string;
    }[];
    recentWork: {
      source: string;
      taskCode: string;
      kind: string;
      recordedAt: string;
      result: { summary: string; verified: string; unverified: string; remaining: string } | null;
    }[];
    historyTotal: number;
  }[];
}
export interface AnalysisStatus {
  ready: boolean;
  model: string | null;
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
}
export interface AnalysisPreview {
  id: string;
  expiresAt: string;
  payload: AnalysisPayload;
  config: AnalysisStatus;
}
export interface AnalysisResult {
  previewId: string;
  generatedAt: string;
  model: string;
  report: AnalysisReport;
  usage: { inputTokens: number; outputTokens: number } | null;
}
