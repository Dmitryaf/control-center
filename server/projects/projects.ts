import { randomUUID } from 'node:crypto';
import {
  metadataSchema,
  type Project,
  type ScanInfo,
  type Snapshot,
} from '../../shared/contracts.js';
import { Store, type ProjectRow } from '../db.js';
import { HttpError } from '../errors.js';
import { assertProjectAccess } from '../filesystem/access.js';
import { attention } from './attention.js';
import { discover, inspectProject } from './scan.js';

export class Projects {
  scanInfo: ScanInfo = { scannedAt: null, errors: [], running: false };
  private pending: Promise<void> | null = null;
  constructor(readonly store: Store) {}
  require(id: string): ProjectRow {
    const row = this.store.project(id);
    if (!row) throw new HttpError(404, 'Проект не найден.');
    return row;
  }
  view(row: ProjectRow): Project {
    const snapshot: Snapshot = JSON.parse(row.snapshot);
    const metadata = row.metadata
      ? metadataSchema.parse(JSON.parse(row.metadata))
      : (snapshot.yaml.metadata ?? metadataSchema.parse({ name: snapshot.directoryName }));
    const signals = attention(metadata, snapshot, this.store.settings());
    if (!row.available)
      signals.unshift({
        code: 'unavailable',
        message: 'Не найден при последнем сканировании. Показан сохранённый снимок.',
      });
    const pending = this.store.db
      .prepare(
        "SELECT count(*) AS total FROM records WHERE kind='decisions' AND project_id=? AND json_extract(data,'$.status')='pending'",
      )
      .get(row.id) as { total: number };
    if (pending.total)
      signals.push({ code: 'decision', message: `Ожидают решения: ${pending.total}` });
    return {
      id: row.id,
      path: row.path,
      snapshot,
      metadata,
      metadataSource: row.metadata ? 'local' : snapshot.yaml.metadata ? 'yaml' : 'defaults',
      notes: row.notes,
      available: !!row.available,
      signals,
    };
  }
  list() {
    return this.store.projects().map((row) => this.view(row));
  }
  scan(): Promise<void> {
    if (this.pending) return this.pending;
    this.scanInfo.running = true;
    this.pending = this.performScan().finally(() => {
      this.pending = null;
      this.scanInfo.running = false;
    });
    return this.pending;
  }
  private async performScan() {
    const settings = this.store.settings();
    const discovery = await discover(settings);
    const snapshots: Snapshot[] = [];
    for (const directory of discovery.paths) {
      try {
        snapshots.push(await inspectProject(directory));
      } catch {
        discovery.errors.push(`Не удалось обновить проект: ${directory}`);
      }
    }
    this.store.db.exec('BEGIN');
    try {
      this.store.db.exec('UPDATE projects SET available=0');
      for (const snapshot of snapshots) this.store.saveSnapshot(randomUUID(), snapshot);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    this.scanInfo = {
      running: true,
      scannedAt: new Date().toISOString(),
      errors: discovery.errors,
    };
  }
  async refresh(id: string): Promise<Project> {
    const row = this.require(id);
    try {
      await assertProjectAccess(row.path, this.store.settings().roots);
      this.store.saveSnapshot(id, await inspectProject(row.path));
    } catch (error) {
      this.store.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(id);
      if (error instanceof HttpError && error.status === 403) return this.view(this.require(id));
    }
    return this.view(this.require(id));
  }
}
