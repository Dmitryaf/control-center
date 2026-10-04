import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { metadataSchema, type Metadata, type Snapshot } from '../../shared/contracts.js';
import { readSmallFile } from '../filesystem/access.js';
import { HttpError } from '../errors.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function readMetadata(directory: string): Promise<Snapshot['yaml']> {
  let content: string | null = null;
  try {
    content = await readSmallFile(path.join(directory, 'PROJECT.yaml'));
    if (content === null) return { exists: false, hash: null, metadata: null, error: null };
    const doc = parseDocument(content);
    if (doc.errors.length) throw new Error('Некорректный YAML.');
    const data = doc.toJS({ maxAliasCount: 20 });
    const parsed = metadataSchema.safeParse(
      data && typeof data === 'object' && !Array.isArray(data)
        ? { name: path.basename(directory), ...data }
        : data,
    );
    if (!parsed.success)
      throw new Error(
        'Проверьте поля PROJECT.yaml: ' +
          parsed.error.issues.map((i) => i.path.join('.')).join(', '),
      );
    return { exists: true, hash: hash(content), metadata: parsed.data, error: null };
  } catch (error) {
    return {
      exists: true,
      hash: content === null ? null : hash(content),
      metadata: null,
      error: (error as Error).message,
    };
  }
}
export async function exportMetadata(
  directory: string,
  metadata: Metadata,
  expectedHash: string | null,
) {
  const file = path.join(directory, 'PROJECT.yaml');
  const content = await readSmallFile(file);
  if ((content === null ? null : hash(content)) !== expectedHash)
    throw new HttpError(409, 'PROJECT.yaml изменился. Обновите страницу перед экспортом.');
  const doc = parseDocument(content ?? '{}');
  if (
    doc.errors.length ||
    !doc.toJS({ maxAliasCount: 20 }) ||
    typeof doc.toJS() !== 'object' ||
    Array.isArray(doc.toJS())
  ) {
    throw new HttpError(409, 'Исправьте PROJECT.yaml перед экспортом.');
  }
  for (const [key, value] of Object.entries(metadata)) doc.set(key, value);
  const temporary = path.join(directory, `.PROJECT.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, doc.toString(), { encoding: 'utf8', flag: 'wx' });
    const latest = await readSmallFile(file);
    if (latest !== content)
      throw new HttpError(
        409,
        'PROJECT.yaml изменился во время экспорта. Повторите после обновления.',
      );
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
