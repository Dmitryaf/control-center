import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function dataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env.CONTROL_CENTER_DATA_DIR) return path.resolve(env.CONTROL_CENTER_DATA_DIR);
  if (platform === 'win32') {
    // Packaged Windows apps can virtualize LocalAppData for their child processes.
    // A profile directory is shared by desktop, terminal and packaged-app launches.
    const profile = env.USERPROFILE || home;
    const directory = path.join(profile, '.control-center');
    const legacy = path.join(
      env.LOCALAPPDATA || path.join(profile, 'AppData', 'Local'),
      'ControlCenter',
      'control-center.sqlite',
    );
    if (!existsSync(path.join(directory, 'control-center.sqlite')) && existsSync(legacy))
      throw new Error(
        'Найдена прежняя база Control Center в AppData. Перенесите её в %USERPROFILE%\\.control-center по инструкции Storage, backup and restore в SETUP.md. Пустая база не создана. Для явного выбора прежнего каталога используйте CONTROL_CENTER_DATA_DIR.',
      );
    return directory;
  }
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
    revokeRestoredApprovals(check);
    check.exec('PRAGMA journal_mode=DELETE;');
    const result = check.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (result.quick_check !== 'ok') throw new Error('Проверка резервной копии не пройдена.');
  } finally {
    check.close();
  }
}

// Also used explicitly before starting a server on a raw, externally restored database.
export function revokeRestoredApprovals(db: DatabaseSync) {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_grants'").get())
    db.exec('UPDATE codex_grants SET enabled=0,revision=revision+1;');
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_schedules'")
      .get()
  )
    db.exec(
      "UPDATE analysis_schedules SET enabled=0,revision=revision+1,lease_owner=NULL,lease_until=NULL,note='После восстановления требуется новое согласие.';",
    );
  if (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_runs'").get()
  )
    db.exec(
      "UPDATE analysis_runs SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,owner_id=NULL,lease_until=NULL,error='Восстановленная копия не возобновляет отправку; прежний запрос мог быть оплачен.' WHERE status IN ('pending','running');",
    );
}
