import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`,
    );
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1)
      throw new Error('База создана более новой версией Control Center.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL,
        metadata TEXT, notes TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1
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
      PRAGMA user_version = 1;
    `);
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : structuredClone(defaultSettings);
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
  saveMetadata(id: string, metadata: Metadata | null, notes: string) {
    this.db
      .prepare('UPDATE projects SET metadata=?, notes=? WHERE id=?')
      .run(metadata ? JSON.stringify(metadata) : null, notes, id);
  }
  close() {
    this.db.close();
  }
}
