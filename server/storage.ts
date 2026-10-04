import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';

export function dataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env.CONTROL_CENTER_DATA_DIR) return path.resolve(env.CONTROL_CENTER_DATA_DIR);
  if (platform === 'win32')
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ControlCenter');
  if (platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'ControlCenter');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'control-center');
}
export function snapshotDatabase(db: DatabaseSync, destination: string) {
  // SQLite's VACUUM snapshot includes committed WAL pages, unlike copying the main file.
  db.prepare('VACUUM INTO ?').run(destination);
  const check = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (result.quick_check !== 'ok') throw new Error('Проверка резервной копии не пройдена.');
  } finally {
    check.close();
  }
}
