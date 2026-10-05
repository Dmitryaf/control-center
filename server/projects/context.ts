import path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { ProjectContext, PublicationFinding } from '../../shared/context.js';
import { contextSettingsSchema } from '../../shared/context.js';
import type { ProjectRow, Store } from '../db.js';
import { assertProjectAccess, within } from '../filesystem/access.js';
import { trackedFiles } from '../git/tracked.js';
import { HttpError } from '../errors.js';

export function publicationCandidate(file: string): PublicationFinding['kind'] | null {
  if (file === 'AGENTS.md' || file.startsWith('.ai-rules/') || file.startsWith('.local/'))
    return 'infrastructure';
  if (
    ['DECISIONS.md', 'PROJECT_MAP.md', 'PROJECT-MAP.md', 'docs/PROJECT_MAP.md'].includes(file) ||
    file.startsWith('decisions/')
  )
    return 'document';
  return null;
}
export class ContextIndex {
  private audits = new Map<string, ProjectContext['audit']>();
  constructor(private store: Store) {}
  audit(id: string): ProjectContext['audit'] {
    return this.audits.get(id) ?? { status: 'unchecked', findings: [], kit: 'unknown' };
  }
  forget(id: string) {
    this.audits.delete(id);
  }
  async refresh(row: ProjectRow) {
    const audit: ProjectContext['audit'] = { status: 'unchecked', findings: [], kit: 'unknown' };
    this.audits.set(row.id, audit);
    if (row.visibility !== 'public') return;
    try {
      if (!row.available || !JSON.parse(row.snapshot).git.present) throw new Error('Unavailable');
      await assertProjectAccess(row.path, this.store.settings().roots);
      const files = await trackedFiles(row.path);
      const allowlist = JSON.parse(row.publication_allowlist) as string[];
      audit.findings = files.flatMap((file) => {
        const kind = publicationCandidate(file);
        return kind && !allowlist.includes(file) ? [{ path: file, kind }] : [];
      });
      const exists = async (name: string, directory: boolean) => {
        try {
          const stat = await lstat(path.join(row.path, name));
          return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
        } catch {
          return false;
        }
      };
      const agents = await exists('AGENTS.md', false);
      const rules = await exists('.ai-rules', true);
      audit.kit = files.some((file) => file === 'AGENTS.md' || file.startsWith('.ai-rules/'))
        ? 'tracked'
        : agents && rules
          ? 'local'
          : agents || rules
            ? 'partial'
            : 'missing';
      audit.status = 'ok';
    } catch {
      audit.status = 'unavailable';
    }
  }
  async save(id: string, input: unknown) {
    const data = contextSettingsSchema.parse(input);
    const row = this.store.project(id)!;
    if (data.privateContextPath) {
      if (!path.isAbsolute(data.privateContextPath))
        throw new HttpError(400, 'Нужен абсолютный путь приватного контекста.');
      data.privateContextPath = path.resolve(data.privateContextPath);
      if (within(row.path, data.privateContextPath) || within(data.privateContextPath, row.path))
        throw new HttpError(
          400,
          'Приватный контекст должен находиться отдельно от репозитория проекта.',
        );
      // Keep an already linked, temporarily unavailable source editable; validate new links.
      if (data.privateContextPath !== row.private_context_path) {
        await assertProjectAccess(data.privateContextPath, [
          path.parse(data.privateContextPath).root,
        ]);
        if (!(await lstat(data.privateContextPath)).isDirectory())
          throw new HttpError(400, 'Укажите каталог приватного контекста.');
      }
    }
    this.store.db
      .prepare(
        `UPDATE projects SET visibility=?, private_context_path=?,
      private_context_had_records=CASE WHEN private_context_path IS ? THEN private_context_had_records ELSE 0 END WHERE id=?`,
      )
      .run(data.visibility, data.privateContextPath, data.privateContextPath, id);
  }
  async allow(id: string, file: string, allowed: boolean) {
    const row = this.store.project(id)!;
    const entries = new Set<string>(JSON.parse(row.publication_allowlist));
    if (allowed) {
      await this.refresh(row);
      if (!this.audit(id).findings.some((finding) => finding.path === file) && !entries.has(file))
        throw new HttpError(409, 'Путь отсутствует в текущем аудите публикации. Обновите проект.');
      entries.add(file);
    } else entries.delete(file);
    this.store.db
      .prepare('UPDATE projects SET publication_allowlist=? WHERE id=?')
      .run(JSON.stringify([...entries].sort()), id);
  }
}
