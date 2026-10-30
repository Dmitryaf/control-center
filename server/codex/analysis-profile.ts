import path from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import { dataDirectory } from '../storage.js';

// Deliberately independent of CODEX_HOME and the desktop/CLI user's profile.
export function analysisProfile(env: NodeJS.ProcessEnv) {
  return path.join(dataDirectory(env), 'codex-analysis');
}
export async function ensureAnalysisProfile(env: NodeJS.ProcessEnv) {
  const home = analysisProfile(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (!(await lstat(home)).isDirectory() || (await lstat(home)).isSymbolicLink())
    throw new Error('Unsafe analysis profile');
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    try {
      await lstat(path.join(home, name));
      throw new Error('Analysis profile contains personal instructions');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return home;
}
