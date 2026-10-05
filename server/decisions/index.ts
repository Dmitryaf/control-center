import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { fileDecisionSchema, type FileDecision } from '../../shared/decisions.js';
import { calendarDate } from '../../shared/time.js';
import { readSmallFile, assertProjectAccess } from '../filesystem/access.js';
import type { Store } from '../db.js';
import { HttpError } from '../errors.js';
import type { ProjectContext } from '../../shared/context.js';

export function decisionSignals(
  record: FileDecision,
  today = calendarDate(),
): FileDecision['signals'] {
  const data = record.metadata;
  if (record.error || !data || ['superseded', 'rejected'].includes(data.status)) return [];
  const signals: FileDecision['signals'] = [];
  if (data.review_after && data.review_after <= today)
    signals.push({
      code: 'decision-review',
      level: 'attention',
      message: `Пора пересмотреть решение ${data.id}`,
    });
  if (data.status === 'accepted' && data.implementation === 'not_implemented')
    signals.push({
      code: 'not-implemented',
      level: 'info',
      message: `${data.id}: принято, но не реализовано`,
    });
  return signals;
}
export function parseDecision(
  content: string,
  projectId: string,
  sourcePath: string,
  source: FileDecision['source'],
): FileDecision {
  const record: FileDecision = {
    key: `${projectId}:${sourcePath}`,
    projectId,
    sourcePath,
    source,
    metadata: null,
    title: content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(sourcePath),
    body: content,
    hasContent: true,
    error: null,
    signals: [],
  };
  if (!content.replace(/^\uFEFF/, '').startsWith('---')) return record;
  try {
    const match = content
      .replace(/^\uFEFF/, '')
      .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) throw new Error('Некорректный front matter.');
    const document = parseDocument(match[1]);
    if (document.errors.length) throw new Error('Некорректный YAML.');
    const parsed = fileDecisionSchema.safeParse(document.toJS({ maxAliasCount: 20 }));
    if (!parsed.success)
      throw new Error(
        'Проверьте поля: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '),
      );
    record.metadata = parsed.data;
    record.title = parsed.data.title;
    record.body = match[2].trim();
    record.signals = decisionSignals(record);
  } catch (error) {
    record.error = (error as Error).message;
  }
  return record;
}
export class DecisionIndex {
  private records = new Map<string, FileDecision[]>();
  private contexts = new Map<string, Pick<ProjectContext, 'privateStatus' | 'hasPrivateMap'>>();
  constructor(private store: Store) {}
  list() {
    return [...this.records.values()]
      .flat()
      .map((record) => ({ ...record, signals: decisionSignals(record) }));
  }
  forget(id: string) {
    this.records.delete(id);
    this.contexts.delete(id);
  }
  context(id: string) {
    return (
      this.contexts.get(id) ?? { privateStatus: 'disconnected' as const, hasPrivateMap: false }
    );
  }
  async content(projectId: string, key: string) {
    await this.refresh(projectId);
    const record = this.records.get(projectId)?.find((entry) => entry.key === key);
    if (!record || !record.hasContent)
      throw new HttpError(404, 'Исходный файл решения недоступен.');
    const text = await readSmallFile(record.sourcePath);
    if (text === null) throw new HttpError(404, 'Исходный файл решения недоступен.');
    return { body: parseDecision(text, projectId, record.sourcePath, record.source).body };
  }
  async refresh(projectId: string) {
    const project = this.store.project(projectId);
    if (!project) return;
    const found: FileDecision[] = [];
    const addError = (sourcePath: string, source: FileDecision['source'], message: string) =>
      found.push({
        key: `${projectId}:${sourcePath}`,
        projectId,
        sourcePath,
        source,
        title: path.basename(sourcePath),
        body: '',
        metadata: null,
        error: message,
        signals: [],
      });
    const read = async (file: string, source: FileDecision['source']) => {
      try {
        const content = await readSmallFile(file);
        if (content !== null) found.push(parseDecision(content, projectId, file, source));
      } catch {
        addError(
          file,
          source,
          'Не удалось прочитать решение: проверьте доступ, размер файла и ссылки.',
        );
      }
    };
    const directory = async (root: string, source: FileDecision['source'], optional = false) => {
      try {
        await assertProjectAccess(root, [root]);
        const stat = await lstat(root);
        if (!stat.isDirectory()) throw new Error('Not a directory');
        const files = (await readdir(root, { withFileTypes: true }))
          .filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.md'))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const file of files.slice(0, 200)) {
          const target = path.join(root, file.name);
          if (!found.some((record) => record.sourcePath === target)) await read(target, source);
        }
        if (files.length > 200)
          addError(root, source, 'Больше 200 файлов решений. Укажите более узкий источник.');
      } catch (error) {
        if (!optional || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          addError(root, source, 'Каталог решений недоступен или является ссылкой.');
      }
    };
    if (project.available) {
      try {
        await assertProjectAccess(project.path, this.store.settings().roots);
        await directory(path.join(project.path, 'decisions'), 'repository', true);
        const index = path.join(project.path, 'DECISIONS.md');
        const content = await readSmallFile(index);
        // A plain map with individual files is a navigation index, not another decision.
        if (content !== null && (!found.length || content.replace(/^\uFEFF/, '').startsWith('---')))
          await read(index, 'repository');
      } catch {
        addError(project.path, 'repository', 'Не удалось прочитать решения проекта.');
      }
    } else
      addError(project.path, 'repository', 'Проект недоступен: канонические решения не прочитаны.');
    const context: Pick<ProjectContext, 'privateStatus' | 'hasPrivateMap'> = {
      privateStatus: project.private_context_path ? 'unavailable' : 'disconnected',
      hasPrivateMap: false,
    };
    this.contexts.set(projectId, context);
    if (project.private_context_path) {
      const root = project.private_context_path;
      try {
        await assertProjectAccess(root, [path.parse(root).root]);
        if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory');
        await readdir(root);
        context.privateStatus = 'connected';
        const before = found.length;
        await directory(path.join(root, 'decisions'), 'private_context', true);
        const index = path.join(root, 'DECISIONS.md');
        const content = await readSmallFile(index);
        if (
          content !== null &&
          (found.length === before || content.replace(/^\uFEFF/, '').startsWith('---'))
        )
          await read(index, 'private_context');
        try {
          const map = await lstat(path.join(root, 'PROJECT_MAP.md'));
          context.hasPrivateMap = map.isFile() && !map.isSymbolicLink();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (found.slice(before).some((record) => !record.error) || context.hasPrivateMap)
          this.store.db
            .prepare('UPDATE projects SET private_context_had_records=1 WHERE id=?')
            .run(projectId);
      } catch {
        context.privateStatus = 'unavailable';
        context.hasPrivateMap = false;
        for (let i = found.length - 1; i >= 0; i--)
          if (found[i].source === 'private_context') found.splice(i, 1);
        // Status is shown on the project; attention depends on prior canonical records.
      }
    }
    for (const source of JSON.parse(project.decision_sources) as string[])
      await directory(source, 'private');
    const ids = found.map((r) => r.metadata?.id).filter(Boolean);
    for (const record of found)
      if (record.metadata && ids.filter((id) => id === record.metadata!.id).length > 1)
        record.error = `Конфликт ID решений: ${record.metadata.id}. ID повторяется в источниках. Выберите каноническую запись вне Control Center.`;
    this.records.set(
      projectId,
      found.map((record) => ({ ...record, body: '' })),
    );
  }
  async refreshAll() {
    for (const project of this.store.projects()) await this.refresh(project.id);
  }
}
