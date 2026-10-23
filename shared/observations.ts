import { z } from 'zod';

export const observationFieldsSchema = z
  .object({
    body: z.string().trim().min(1).max(20000),
    occurredOn: z.string().date(),
    projectId: z.string().uuid().nullable().default(null),
  })
  .strict();
export const observationCreateSchema = observationFieldsSchema.extend({
  requestKey: z.string().uuid().optional(),
});
// No create defaults in PATCH: omission preserves the saved link and historical identity.
export const observationPatchSchema = z
  .object({
    revision: z.number().int().positive(),
    body: observationFieldsSchema.shape.body.optional(),
    occurredOn: observationFieldsSchema.shape.occurredOn.optional(),
    projectId: observationFieldsSchema.shape.projectId.unwrap().optional(),
  })
  .strict();
export const observationDeleteSchema = z.object({ revision: z.number().int().positive() }).strict();
export interface Observation {
  id: string;
  body: string;
  occurredOn: string;
  projectId: string | null;
  scopeProjectId: string | null;
  projectName: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
