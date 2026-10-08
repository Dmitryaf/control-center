import { readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Settings, Snapshot } from '../../shared/contracts.js';
import { readSmallFile } from '../filesystem/access.js';
import { getGitState } from '../git/status.js';
import { readMetadata } from './metadata.js';

const markers = [
  '.git',
  'PROJECT.yaml',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'AGENTS.md',
];
const alwaysExcluded = ['.git', 'node_modules', '.venv', '.data', '.ai-rules'];
export async function discover(settings: Settings): Promise<{ paths: string[]; errors: string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const pathKey = (directory: string) => {
    const resolved = path.resolve(directory);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const excludedProjects = new Set(settings.excludedProjectPaths.map(pathKey));
  const excluded = new Set(
    [...alwaysExcluded, ...settings.exclusions].map((value) => value.toLowerCase()),
  );
  let visited = 0;
  async function walk(directory: string, depth: number) {
    if (visited >= 20000 || depth > 30) {
      if (!errors.includes('Достигнут предел обхода. Укажите более узкие каталоги.'))
        errors.push('Достигнут предел обхода. Укажите более узкие каталоги.');
      return;
    }
    try {
      if ((await lstat(directory)).isSymbolicLink()) return;
      const canonical = await realpath(directory);
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (seen.has(key) || excludedProjects.has(key)) return;
      seen.add(key);
      visited++;
      const entries = await readdir(canonical, { withFileTypes: true });
      if (entries.some((entry) => markers.includes(entry.name) && !entry.isSymbolicLink())) {
        paths.push(canonical);
        return;
      }
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !excluded.has(entry.name.toLowerCase())
        ) {
          await walk(path.join(canonical, entry.name), depth + 1);
        }
      }
    } catch {
      errors.push(`Не удалось прочитать каталог: ${directory}`);
    }
  }
  for (const root of settings.roots) await walk(path.resolve(root), 0);
  return { paths: paths.sort(), errors };
}
export async function inspectProject(directory: string): Promise<Snapshot> {
  const scannedAt = new Date().toISOString();
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
  const errors: string[] = [];
  let packageInfo: Snapshot['package'] = null;
  if (files.includes('package.json')) {
    try {
      const data = JSON.parse((await readSmallFile(path.join(directory, 'package.json'))) ?? '{}');
      packageInfo = {
        name: typeof data.name === 'string' ? data.name : undefined,
        scripts: data.scripts && typeof data.scripts === 'object' ? Object.keys(data.scripts) : [],
      };
    } catch {
      errors.push('Не удалось прочитать package.json.');
    }
  }
  let mapFile =
    files.find((name) => /^(PROJECT_MAP|PROJECT-MAP)(\.local)?\.md$/i.test(name)) ?? null;
  for (const candidate of [
    'docs/PROJECT_MAP.md',
    '.local/PROJECT_MAP.md',
    '.local/project-study/README.md',
  ]) {
    if (mapFile) break;
    try {
      const segments = candidate.split('/');
      let current = directory;
      let safe = true;
      for (const segment of segments) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) {
          safe = false;
          break;
        }
      }
      if (safe && (await lstat(current)).isFile()) mapFile = candidate;
    } catch {
      /* An optional map may be absent. */
    }
  }
  const [git, yaml] = await Promise.all([
    getGitState(
      directory,
      entries.some((entry) => entry.name === '.git' && !entry.isSymbolicLink()),
    ),
    readMetadata(directory),
  ]);
  return {
    path: directory,
    directoryName: path.basename(directory),
    scannedAt,
    git,
    yaml,
    files: files
      .filter((name) =>
        /^(readme|agents|project|package|tsconfig|vite|docker|cargo|go\.|pyproject)/i.test(name),
      )
      .slice(0, 30),
    hasAgents: files.includes('AGENTS.md'),
    mapFile,
    package: packageInfo,
    errors,
  };
}
