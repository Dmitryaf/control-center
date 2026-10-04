import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { fileDecisionSchema, type FileDecision } from '../../shared/decisions.js';
import { calendarDate } from '../../shared/time.js';
import { readSmallFile, assertProjectAccess } from '../filesystem/access.js';
import type { Store } from '../db.js';

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
  constructor(private store: Store) {}
  list() {
    return [...this.records.values()]
      .flat()
      .map((record) => ({ ...record, signals: decisionSignals(record) }));
  }
  forget(id: string) {
    this.records.delete(id);
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
        for (const file of files.slice(0, 200)) await read(path.join(root, file.name), source);
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
    for (const source of JSON.parse(project.decision_sources) as string[])
      await directory(source, 'private');
    const ids = found.map((r) => r.metadata?.id).filter(Boolean);
    for (const record of found)
      if (record.metadata && ids.filter((id) => id === record.metadata!.id).length > 1)
        record.error = `ID ${record.metadata.id} повторяется в источниках. Выберите каноническую запись вне Control Center.`;
    this.records.set(projectId, found);
  }
  async refreshAll() {
    for (const project of this.store.projects()) await this.refresh(project.id);
  }
}
