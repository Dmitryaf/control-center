import { z } from 'zod';

export const visibilitySchema = z.enum(['unknown', 'private', 'public']);
export const contextSettingsSchema = z.object({
  visibility: visibilitySchema,
  privateContextPath: z.string().trim().min(1).max(2000).nullable(),
});
export type ContextSettings = z.infer<typeof contextSettingsSchema>;
export interface PublicationFinding {
  path: string;
  kind: 'infrastructure' | 'document';
}
export interface ProjectContext extends ContextSettings {
  privateStatus: 'disconnected' | 'connected' | 'unavailable';
  hasPrivateMap: boolean;
  hadPrivateRecords: boolean;
  allowlist: string[];
  audit: {
    status: 'unchecked' | 'ok' | 'unavailable';
    findings: PublicationFinding[];
    kit: 'unknown' | 'local' | 'tracked' | 'missing' | 'partial';
  };
}
