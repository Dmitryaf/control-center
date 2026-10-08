import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { settingsSchema } from '../shared/contracts.js';
import { snapshotDatabase } from './storage.js';
import {
  defaultSettings,
  type Metadata,
  type Settings,
  type Snapshot,
} from '../shared/contracts.js';

export interface ProjectRow {
  id: string;
  path: string;
  snapshot: string;
  metadata: string | null;
  notes: string;
  available: number;
  yaml_base_hash: string | null;
  decision_sources: string;
  visibility: 'unknown' | 'private' | 'public';
  private_context_path: string | null;
  private_context_had_records: number;
  publication_allowlist: string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    const existing = path !== ':memory:' && existsSync(path) && statSync(path).size > 0;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`,
    );
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (![0, 2, 3, 4].includes(version.user_version)) {
      this.db.close();
      throw new Error('Версия базы не поддерживается этой сборкой Control Center.');
    }
    try {
      if (existing && version.user_version < 4) {
        const directory = join(dirname(path), 'backups');
        mkdirSync(directory, { recursive: true });
        snapshotDatabase(this.db, join(directory, `before-tasks-v4-${randomUUID()}.sqlite`));
      }
      this.transaction(() => {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL,
        metadata TEXT, notes TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1,
        yaml_base_hash TEXT, decision_sources TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('tasks','ideas','decisions')),
        project_id TEXT REFERENCES projects(id), data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES projects(id),
        targetId TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL,
        UNIQUE(sourceId,targetId,type), CHECK(sourceId != targetId)
      );
          CREATE TABLE IF NOT EXISTS checks (
            id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
            idea_id TEXT REFERENCES records(id) ON DELETE SET NULL, data TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS check_entries (
            id TEXT PRIMARY KEY, check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
            data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS checks_project ON checks(project_id);
          CREATE INDEX IF NOT EXISTS entries_check ON check_entries(check_id);
        `);
        const columns = this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
        for (const [name, definition] of Object.entries({
          visibility:
            "TEXT NOT NULL DEFAULT 'unknown' CHECK(visibility IN ('unknown','private','public'))",
          private_context_path: 'TEXT',
          private_context_had_records: 'INTEGER NOT NULL DEFAULT 0',
          publication_allowlist: "TEXT NOT NULL DEFAULT '[]'",
        })) {
          if (!columns.some((column) => column.name === name))
            this.db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS task_identity (
            number INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL DEFAULT 1,
            request_key TEXT UNIQUE, request_hash TEXT
          );
          INSERT INTO task_identity(record_id)
            SELECT id FROM records WHERE kind='tasks' AND id NOT IN (SELECT record_id FROM task_identity)
            ORDER BY created_at, id;
          PRAGMA user_version = 4;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as
      { data: string } | undefined;
    return row ? settingsSchema.parse(JSON.parse(row.data)) : structuredClone(defaultSettings);
  }
  saveSettings(settings: Settings) {
    this.db
      .prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(JSON.stringify(settings));
  }
  projects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY path').all() as unknown as ProjectRow[];
  }
  project(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as
      ProjectRow | undefined;
  }
  saveSnapshot(id: string, snapshot: Snapshot) {
    this.db
      .prepare(
        `INSERT INTO projects(id,path,snapshot) VALUES(?,?,?) ON CONFLICT(path)
      DO UPDATE SET snapshot=excluded.snapshot, available=1`,
      )
      .run(id, snapshot.path, JSON.stringify(snapshot));
  }
  saveMetadata(id: string, metadata: Metadata | null, notes: string, baseHash?: string | null) {
    const row = this.project(id)!;
    const snapshot: Snapshot = JSON.parse(row.snapshot);
    const firstEdit = !row.metadata;
    this.db
      .prepare('UPDATE projects SET metadata=?, notes=?, yaml_base_hash=? WHERE id=?')
      .run(
        metadata ? JSON.stringify(metadata) : null,
        notes,
        baseHash !== undefined ? baseHash : firstEdit ? snapshot.yaml.hash : row.yaml_base_hash,
        id,
      );
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  backup(destination: string) {
    snapshotDatabase(this.db, destination);
  }
  close() {
    this.db.close();
  }
}
