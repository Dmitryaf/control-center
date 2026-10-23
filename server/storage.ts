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
  const check = new DatabaseSync(destination);
  try {
    // Backups carry business data, never a silently reusable dispatch approval.
    if (
      check
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_runs'")
        .get()
    ) {
      check.exec(`UPDATE analysis_runs SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,
        error='Восстановленная копия не возобновляет отправку. Подготовьте новый пакет; прежний запрос мог быть оплачен.',
        owner_id=NULL,lease_until=NULL WHERE status IN ('pending','running');`);
    }
    check.exec('PRAGMA journal_mode=DELETE;');
    const result = check.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (result.quick_check !== 'ok') throw new Error('Проверка резервной копии не пройдена.');
  } finally {
    check.close();
  }
}
