import { randomUUID } from 'node:crypto';
import {
  metadataSchema,
  type Project,
  type ScanInfo,
  type Snapshot,
} from '../../shared/contracts.js';
import { Store, type ProjectRow } from '../db.js';
import { HttpError } from '../errors.js';
import { assertProjectAccess, within } from '../filesystem/access.js';
import { attention } from './attention.js';
import { discover, inspectProject } from './scan.js';
import { DecisionIndex } from '../decisions/index.js';
import { ContextIndex } from './context.js';

export class Projects {
  scanInfo: ScanInfo = { scannedAt: null, errors: [], running: false };
  private pending: Promise<void> | null = null;
  readonly decisions: DecisionIndex;
  readonly context: ContextIndex;
  constructor(readonly store: Store) {
    this.decisions = new DecisionIndex(store);
    this.context = new ContextIndex(store);
  }
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
    const context = {
      visibility: row.visibility,
      privateContextPath: row.private_context_path,
      hadPrivateRecords: !!row.private_context_had_records,
      allowlist: JSON.parse(row.publication_allowlist) as string[],
      ...this.decisions.context(row.id),
      audit: this.context.audit(row.id),
    };
    if (row.visibility === 'public') {
      if (context.audit.status === 'unavailable')
        signals.push({
          code: 'publication-unavailable',
          level: 'attention',
          message: 'Не удалось проверить отслеживаемые Git файлы',
        });
      const infrastructure = context.audit.findings.filter(
        (finding) => finding.kind === 'infrastructure',
      );
      if (infrastructure.length)
        signals.push({
          code: 'publication-infrastructure',
          level: 'attention',
          message:
            'В публичном Git отслеживается внутренняя инфраструктура: ' +
            [
              ...new Set(
                infrastructure.map((finding) =>
                  finding.path.startsWith('.ai-rules/')
                    ? '.ai-rules/'
                    : finding.path.startsWith('.local/')
                      ? '.local/'
                      : finding.path,
                ),
              ),
            ].join(', '),
        });
      const documents = context.audit.findings.filter((finding) => finding.kind === 'document');
      if (documents.length)
        signals.push({
          code: 'publication-documents',
          level: 'attention',
          message: `Документы требуют проверки публикации: ${documents.length}`,
        });
      if (context.privateStatus === 'unavailable' && context.hadPrivateRecords)
        signals.push({
          code: 'private-context-unavailable',
          level: 'attention',
          message: 'Не найден ранее подключённый приватный контекст',
        });
    }
    const yamlConflict =
      !!row.metadata && (row.yaml_base_hash !== snapshot.yaml.hash || !!snapshot.yaml.error);
    if (yamlConflict)
      signals.push({
        code: 'yaml-conflict',
        level: 'attention',
        message: 'PROJECT.yaml изменился после локального редактирования',
      });
    for (const decision of this.decisions.list().filter((d) => d.projectId === row.id)) {
      if (decision.error)
        signals.push({
          code: `decision-file-${decision.key}`,
          level: 'attention',
          message: `Решения: ${decision.error}`,
        });
      else signals.push(...decision.signals);
    }
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
      yamlConflict,
      decisionSources: JSON.parse(row.decision_sources),
      context,
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
    await this.decisions.refreshAll();
    for (const row of this.store.projects()) await this.context.refresh(row);
  }
  async refresh(id: string): Promise<Project> {
    const row = this.require(id);
    try {
      await assertProjectAccess(row.path, this.store.settings().roots);
      this.store.saveSnapshot(id, await inspectProject(row.path));
    } catch {
      // Preserve the last snapshot and all user data when access is lost.
      this.store.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(id);
    }
    await this.decisions.refresh(id);
    await this.context.refresh(this.require(id));
    return this.view(this.require(id));
  }
  async rebind(id: string, targetId: string) {
    if (this.scanInfo.running) throw new HttpError(409, 'Дождитесь сканирования.');
    if (id === targetId) throw new HttpError(400, 'Выберите другой найденный каталог.');
    await this.refresh(id);
    const old = this.require(id);
    if (old.available)
      throw new HttpError(409, 'Перепривязка доступна только недоступному проекту.');
    const candidate = await this.refresh(targetId);
    if (!candidate.available) throw new HttpError(409, 'Новый каталог недоступен.');
    const target = this.require(targetId);
    if (
      old.private_context_path &&
      (within(target.path, old.private_context_path) ||
        within(old.private_context_path, target.path))
    )
      throw new HttpError(
        409,
        'Новый репозиторий пересекается с приватным контекстом. Сначала измените связь.',
      );
    const used = this.store.db
      .prepare(
        `SELECT (
      (SELECT count(*) FROM records WHERE project_id=?) +
      (SELECT count(*) FROM checks WHERE project_id=?) +
      (SELECT count(*) FROM relations WHERE sourceId=? OR targetId=?)
    ) AS total`,
      )
      .get(targetId, targetId, targetId, targetId) as { total: number };
    if (
      target.metadata ||
      target.notes ||
      JSON.parse(target.decision_sources).length ||
      target.visibility !== 'unknown' ||
      target.private_context_path ||
      JSON.parse(target.publication_allowlist).length ||
      used.total
    )
      throw new HttpError(
        409,
        'У выбранного проекта уже есть свои данные. Автоматическое слияние запрещено. Выберите новый, ещё не настроенный каталог.',
      );
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM projects WHERE id=?').run(targetId);
      this.store.db
        .prepare('UPDATE projects SET path=?,snapshot=?,available=1 WHERE id=?')
        .run(target.path, target.snapshot, id);
    });
    this.decisions.forget(targetId);
    this.context.forget(targetId);
    await this.decisions.refresh(id);
    await this.context.refresh(this.require(id));
    return this.view(this.require(id));
  }
  async forget(id: string) {
    if (this.scanInfo.running) throw new HttpError(409, 'Дождитесь сканирования.');
    await this.refresh(id);
    if (this.require(id).available)
      throw new HttpError(409, 'Можно забыть только недоступный проект.');
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE records SET project_id=NULL,data=json_set(data,'$.projectId',NULL),updated_at=? WHERE project_id=?",
        )
        .run(new Date().toISOString(), id);
      this.store.db.prepare('UPDATE checks SET project_id=NULL WHERE project_id=?').run(id);
      this.store.db.prepare('DELETE FROM relations WHERE sourceId=? OR targetId=?').run(id, id);
      this.store.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
    this.decisions.forget(id);
    this.context.forget(id);
  }
}
