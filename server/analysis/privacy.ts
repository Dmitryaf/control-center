import { createHash } from 'node:crypto';
import type { Store } from '../db.js';
// Additional guard only: explicit source selection and packet review remain necessary.
export const sensitiveText =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:home|Users|etc|var|opt|tmp|mnt)\/|(?:\.local|\.codex|\.ai-rules)[\\/]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{15,}|BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|api[_ -]?key|token)\s*[:=]\s*\S+)/i;

export const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const projectStamp = (row: NonNullable<ReturnType<Store['project']>>) =>
  digest({
    visibility: row.visibility,
    privateContext: row.private_context_path,
    decisionSources: row.decision_sources,
    allowlist: row.publication_allowlist,
  });
