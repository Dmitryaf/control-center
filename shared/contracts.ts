import { z } from 'zod';
import type { CheckView, CheckEntry } from './checks.js';
import type { FileDecision } from './decisions.js';
import type { ProjectContext } from './context.js';

const text = z.string().trim().max(10000);
const title = z.string().trim().min(1).max(240);
const lines = z.array(title).max(100);
export const prioritySchema = z.enum(['low', 'normal', 'high']);
export const metadataSchema = z.object({
  name: title.default('Проект'),
  type: z.enum(['product', 'tool', 'experiment', 'other']).default('other'),
  status: z.enum(['active', 'paused', 'completed', 'unknown']).default('unknown'),
  stage: z.string().trim().max(120).default(''),
  priority: prioritySchema.default('normal'),
  goal: text.default(''),
  current_focus: text.default(''),
  next: lines.default([]),
  blocked_by: lines.default([]),
  related: lines.default([]),
  last_reviewed: z.string().date().nullable().default(null),
});
export type Metadata = z.infer<typeof metadataSchema>;
export const settingsSchema = z
  .object({
    roots: z.array(z.string().trim().min(1).max(2000)).max(30),
    exclusions: z.array(z.string().trim().min(1).max(100)).max(100),
    excludedProjectPaths: z.array(z.string().trim().min(1).max(2000)).default([]),
    inactivityDays: z.number().int().min(1).max(3650),
    reviewDays: z.number().int().min(1).max(3650),
    movementInfoDays: z.number().int().min(1).max(3650).default(3),
    movementAttentionDays: z.number().int().min(1).max(3650).default(7),
    movementDecisionDays: z.number().int().min(1).max(3650).default(14),
  })
  .refine(
    (s) =>
      s.movementInfoDays < s.movementAttentionDays &&
      s.movementAttentionDays < s.movementDecisionDays,
    { message: 'Интервалы должны возрастать', path: ['movementAttentionDays'] },
  );
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  roots: [],
  exclusions: ['node_modules', 'dist', 'build', 'archive', '.git', '.venv', 'vendor'],
  excludedProjectPaths: [],
  inactivityDays: 14,
  reviewDays: 30,
  movementInfoDays: 3,
  movementAttentionDays: 7,
  movementDecisionDays: 14,
};
const recordBase = { title, projectId: z.string().uuid().nullable().default(null) };
export const taskResultSchema = z.object({
  summary: text.min(1),
  verified: text.default(''),
  unverified: text.default(''),
  remaining: text.default(''),
});
export const taskSchema = z.object({
  ...recordBase,
  description: text.default(''),
  expectedResult: text.default(''),
  acceptance: text.default(''),
  links: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  result: taskResultSchema.nullable().default(null),
  state: z.enum(['now', 'next', 'later']).default('next'),
  priority: prioritySchema.default('normal'),
  completedAt: z.string().datetime().nullable().default(null),
});
// PATCH fields must not apply create defaults: omission means preserve current data.
export const taskPatchSchema = z
  .object({
    title: taskSchema.shape.title.optional(),
    projectId: taskSchema.shape.projectId.unwrap().optional(),
    description: taskSchema.shape.description.unwrap().optional(),
    expectedResult: taskSchema.shape.expectedResult.unwrap().optional(),
    acceptance: taskSchema.shape.acceptance.unwrap().optional(),
    links: taskSchema.shape.links.unwrap().optional(),
    result: taskSchema.shape.result.unwrap().optional(),
    state: taskSchema.shape.state.unwrap().optional(),
    priority: taskSchema.shape.priority.unwrap().optional(),
    completedAt: taskSchema.shape.completedAt.unwrap().optional(),
  })
  .strict();
export const ideaSchema = z.object({
  ...recordBase,
  description: text.default(''),
  state: z.enum(['new', 'consider', 'testing', 'accepted', 'rejected']).default('new'),
});
export const decisionSchema = z.object({
  ...recordBase,
  context: text.default(''),
  decision: text.min(1),
  reason: text.default(''),
  date: z.string().date(),
  status: z.enum(['pending', 'active', 'superseded']).default('active'),
});
export type TaskInput = z.infer<typeof taskSchema>;
export type IdeaInput = z.infer<typeof ideaSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
export interface RecordStamp {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export type Task = TaskInput & RecordStamp & { number: number; code: string; revision: number };
export type Idea = IdeaInput & RecordStamp;
export type Decision = DecisionInput & RecordStamp;
export type RecordKind = 'tasks' | 'ideas' | 'decisions';
export type RecordItem = Task | Idea | Decision;
export const relationSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  type: z.enum(['uses', 'depends_on', 'related_to', 'produces']),
});
export type Relation = z.infer<typeof relationSchema> & { id: string };
export interface Commit {
  hash: string;
  subject: string;
  date: string;
}
export interface GitState {
  present: boolean;
  branch: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
  remote: string | null;
  commits: Commit[];
  error: string | null;
}
export interface Snapshot {
  path: string;
  directoryName: string;
  scannedAt: string;
  git: GitState;
  files: string[];
  hasAgents: boolean;
  mapFile: string | null;
  package: { name?: string; scripts: string[] } | null;
  yaml: { exists: boolean; hash: string | null; metadata: Metadata | null; error: string | null };
  errors: string[];
}
export interface Signal {
  code: string;
  message: string;
  level?: 'info' | 'attention' | 'decision';
}
export interface Project {
  id: string;
  path: string;
  snapshot: Snapshot;
  metadata: Metadata;
  metadataSource: 'local' | 'yaml' | 'defaults';
  notes: string;
  available: boolean;
  signals: Signal[];
  yamlConflict: boolean;
  decisionSources: string[];
  context: ProjectContext;
}
export interface ScanInfo {
  scannedAt: string | null;
  errors: string[];
  running: boolean;
}
export interface Workspace {
  projects: Project[];
  tasks: Task[];
  ideas: Idea[];
  decisions: Decision[];
  relations: Relation[];
  settings: Settings;
  scan: ScanInfo;
  checks: CheckView[];
  checkEntries: CheckEntry[];
  fileDecisions: FileDecision[];
  storage: { databasePath: string };
}
