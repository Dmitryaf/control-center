import { createHash } from 'node:crypto';
import type { Store } from '../db.js';
// Additional guard only: explicit source selection and packet review remain necessary.
export const sensitiveText =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:home|Users|etc|var|opt|tmp|mnt)\/|(?:\.local|\.codex|\.ai-rules)[\\/]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{15,}|BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|api[_ -]?key|token)\s*[:=]\s*\S+)/i;

export const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

// Inspect text values rather than escaped wire JSON: "\\n\\n" is not a UNC path.
export function containsSensitiveText(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      const trimmed = current.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          pending.push(JSON.parse(current));
          continue;
        } catch {
          /* Ordinary prose. */
        }
      }
      if (sensitiveText.test(current)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (sensitiveText.test(key)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}
export const projectStamp = (row: NonNullable<ReturnType<Store['project']>>) =>
  digest({
    visibility: row.visibility,
    privateContext: row.private_context_path,
    allowlist: row.publication_allowlist,
  });
