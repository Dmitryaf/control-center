import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';

export async function readSmallFile(file: string): Promise<string | null> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Ожидался обычный файл, не ссылка.');
    if (stat.size > 256 * 1024) throw new Error('Файл больше 256 КБ.');
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export async function assertProjectAccess(target: string, roots: string[]) {
  const root = roots.find((candidate) => within(path.resolve(candidate), target));
  if (!root)
    throw new HttpError(403, 'Проект вне настроенных каталогов. Добавьте каталог в настройках.');
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (!within(canonicalRoot, canonicalTarget))
    throw new HttpError(403, 'Путь проекта ведёт за пределы каталога.');
  let current = path.resolve(root);
  if ((await lstat(current)).isSymbolicLink())
    throw new HttpError(403, 'Корень не должен быть символической ссылкой.');
  for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new HttpError(403, 'Символические ссылки не поддерживаются.');
  }
}
