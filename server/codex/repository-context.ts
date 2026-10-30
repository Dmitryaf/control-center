import path from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Store } from '../db.js';
import { HttpError } from '../errors.js';
import { assertProjectAccess, within } from '../filesystem/access.js';
import { trackedFiles } from '../git/tracked.js';
import { digest, sensitiveText } from '../analysis/privacy.js';
import type { PeriodSource } from '../../shared/period-analysis.js';
import type { CodexFileList } from '../../shared/codex-analysis.js';

const extensions = new Set([
  '.md',
  '.txt',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.vue',
  '.css',
  '.html',
  '.yml',
  '.yaml',
]);
export function permittedFile(file: string) {
  return (
    !/[\\:]/.test(file) &&
    !Array.from(file).some((char) => char.charCodeAt(0) < 32) &&
    file.length <= 240 &&
    !file.includes('\\') &&
    !path.posix.isAbsolute(file) &&
    file.split('/').every((p) => p && p !== '..' && !p.startsWith('.')) &&
    !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage|package-lock\.json|.*(?:secret|credential|password|\.key|\.pem).*)$/i.test(
      file,
    ) &&
    extensions.has(path.posix.extname(file).toLowerCase())
  );
}
async function projectDirectory(store: Store, id: string) {
  const row = store.project(id);
  if (!row) throw new HttpError(410, 'Выбранный проект удалён.');
  await assertProjectAccess(row.path, store.settings().roots);
  return row;
}
export async function codexFileList(store: Store, ids: string[]): Promise<CodexFileList> {
  const projects: CodexFileList['projects'] = [];
  for (const id of [...new Set(ids)]) {
    const row = await projectDirectory(store, id);
    const files = (await trackedFiles(row.path)).filter(permittedFile).sort();
    const metadata = row.metadata ? JSON.parse(row.metadata) : null;
    projects.push({
      id,
      name: metadata?.name || JSON.parse(row.snapshot).directoryName,
      files: files.slice(0, 200),
      truncated: files.length > 200,
    });
  }
  return { projects };
}
export async function repositorySources(
  store: Store,
  projectIds: string[],
  files: { projectId: string; path: string }[],
) {
  const sources: PeriodSource[] = [];
  const stamps: { projectId: string; path: string; stamp: string }[] = [];
  for (const file of files) {
    if (!projectIds.includes(file.projectId) || !permittedFile(file.path))
      throw new HttpError(403, 'Файл вне выбранных проектов или имеет запрещённый путь/тип.');
    const row = await projectDirectory(store, file.projectId);
    if (!(await trackedFiles(row.path)).includes(file.path))
      throw new HttpError(403, 'Можно включать только явно выбранные tracked-файлы проекта.');
    const target = path.resolve(row.path, file.path);
    await assertProjectAccess(target, [row.path]);
    const canonical = await realpath(target);
    if (!within(await realpath(row.path), canonical) || (await lstat(target)).isSymbolicLink())
      throw new HttpError(403, 'Ссылки и файлы вне проекта не читаются.');
    const handle = await open(target, 'r');
    let text: string;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 8192)
        throw new HttpError(400, 'Выберите текстовый файл до 8 КБ. Большие файлы не обрезаются.');
      const bytes = Buffer.alloc(8193);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 8192)
        throw new HttpError(400, 'Файл вырос во время чтения. Подготовьте пакет заново.');
      if (read.bytesRead !== before.size)
        throw new HttpError(
          409,
          'Файл изменился или прочитан не полностью. Подготовьте пакет заново.',
        );
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
      } catch {
        throw new HttpError(400, 'Выберите текстовый UTF-8 файл без двоичных данных.');
      }
      const after = await lstat(target);
      if (
        after.isSymbolicLink() ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new HttpError(409, 'Файл изменился во время чтения. Подготовьте пакет заново.');
    } finally {
      await handle.close();
    }
    if (text.includes('\0') || sensitiveText.test(text))
      throw new HttpError(
        400,
        'В выбранном файле возможный секрет, локальный путь или двоичные данные. Исключите его из пакета.',
      );
    const sourceId = `repository:${file.projectId}:${digest(file.path).slice(0, 16)}`;
    if (sources.some((s) => s.id === sourceId)) throw new HttpError(400, 'Файл выбран повторно.');
    sources.push({
      id: sourceId,
      kind: 'repository_file',
      projectId: file.projectId,
      title: file.path,
      text,
      day: null,
      recordedAt: new Date().toISOString(),
      dateQuality: 'current_file',
      partial: false,
    });
    stamps.push({ ...file, stamp: digest({ root: row.path, visibility: row.visibility, text }) });
  }
  return { sources, stamps };
}
