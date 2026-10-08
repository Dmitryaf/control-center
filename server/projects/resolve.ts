import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, type ProjectRow } from '../db.js';
import { HttpError } from '../errors.js';
import { assertProjectAccess, within } from '../filesystem/access.js';

const exec = promisify(execFile);

// Git is invoked only in registered repositories, never in a caller-provided directory.
export async function resolveProject(
  store: Store,
  selector: { projectId?: string; workingDirectory?: string },
): Promise<ProjectRow> {
  const rows = store.projects();
  if (selector.projectId && !store.project(selector.projectId))
    throw new HttpError(404, 'Проект не найден. Получите список проектов.');
  if (!selector.workingDirectory) {
    if (selector.projectId) return store.project(selector.projectId)!;
    throw new HttpError(
      400,
      'Передайте projectId или абсолютный workingDirectory текущего проекта.',
    );
  }
  if (!path.isAbsolute(selector.workingDirectory))
    throw new HttpError(400, 'workingDirectory должен быть абсолютным.');
  const directory = path.resolve(selector.workingDirectory);
  const direct = rows
    .filter((row) => within(row.path, directory))
    .sort((a, b) => b.path.length - a.path.length);
  const matches: { row: ProjectRow; root: string }[] = [];
  if (direct.length) {
    await assertProjectAccess(direct[0].path, store.settings().roots);
    matches.push({ row: direct[0], root: direct[0].path });
  } else {
    for (const row of rows) {
      try {
        await assertProjectAccess(row.path, store.settings().roots);
        const { stdout } = await exec(
          'git',
          ['-C', row.path, 'worktree', 'list', '--porcelain', '-z'],
          {
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 512 * 1024,
          },
        );
        for (const field of stdout.split('\0')) {
          if (!field.startsWith('worktree ')) continue;
          const root = path.resolve(field.slice('worktree '.length));
          if (within(root, directory)) matches.push({ row, root });
        }
      } catch {
        // Unavailable repositories cannot establish identity. Never fall back to a remote/name match.
      }
    }
  }
  const ids = new Set(matches.map((match) => match.row.id));
  if (ids.size !== 1)
    throw new HttpError(
      404,
      ids.size
        ? 'Каталог соответствует нескольким проектам. Уточните регистрацию проектов в Control Center.'
        : 'Проект для этого каталога не найден. Добавьте основной репозиторий в Control Center.',
    );
  const match = matches[0];
  await assertProjectAccess(directory, [match.root]);
  if (selector.projectId && selector.projectId !== match.row.id)
    throw new HttpError(409, 'projectId не соответствует рабочему каталогу. Задача не изменена.');
  return match.row;
}
