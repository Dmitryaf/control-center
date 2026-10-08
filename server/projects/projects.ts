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
  private refreshing = new Map<string, Promise<Project>>();
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
    this.pending = Promise.allSettled([...this.refreshing.values()])
      .then(() => this.performScan())
      .finally(() => {
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
      const found = new Set(snapshots.map((snapshot) => snapshot.path));
      for (const row of this.store.projects()) {
        if (!found.has(row.path))
          this.store.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(row.id);
      }
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
    if (this.pending) await this.pending;
    const existing = this.refreshing.get(id);
    if (existing) return existing;
    const pending = this.performRefresh(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, pending);
    return pending;
  }
  async refreshKnown(signal?: AbortSignal): Promise<string[]> {
    const errors: string[] = [];
    for (const row of this.store.projects()) {
      if (signal?.aborted || this.scanInfo.running) break;
      if (!this.store.project(row.id)) continue;
      const settings = this.store.settings();
      if (
        !settings.roots.some((root) => within(root, row.path)) ||
        settings.excludedProjectPaths.some(
          (excluded) => within(excluded, row.path) && within(row.path, excluded),
        )
      ) {
        this.store.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(row.id);
        continue;
      }
      try {
        const project = await this.refresh(row.id);
        if (
          !project.available ||
          project.snapshot.git.error ||
          project.snapshot.yaml.error ||
          project.snapshot.errors.length
        )
          errors.push(
            `${project.metadata.name}: не все данные удалось прочитать. Показаны доступные данные.`,
          );
      } catch {
        // Removal during a read must not restore the removed project or stop the remaining pass.
        if (this.store.project(row.id))
          errors.push(
            `${this.view(this.require(row.id)).metadata.name}: не удалось обновить состояние.`,
          );
      }
    }
    return errors;
  }
  private async performRefresh(id: string): Promise<Project> {
    const row = this.require(id);
    try {
      await assertProjectAccess(row.path, this.store.settings().roots);
      const snapshot = await inspectProject(row.path);
      const roots = this.store.settings().roots;
      await assertProjectAccess(row.path, roots);
      if (JSON.stringify(roots) !== JSON.stringify(this.store.settings().roots))
        throw new HttpError(409, 'Настройки каталогов изменились. Повторите обновление.');
      if (this.require(id).path !== row.path)
        throw new HttpError(409, 'Каталог проекта изменился. Повторите обновление.');
      this.store.saveSnapshot(id, snapshot);
    } catch (error) {
      const current = this.require(id);
      if (current.path !== row.path) throw error;
      // Preserve the last snapshot and all user data when access is lost.
      this.store.db
        .prepare('UPDATE projects SET available=0 WHERE id=? AND snapshot=?')
        .run(id, row.snapshot);
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
      (SELECT count(*) FROM relations WHERE sourceId=? OR targetId=?) +
      (SELECT count(*) FROM task_history WHERE project_id=?)
    ) AS total`,
      )
      .get(targetId, targetId, targetId, targetId, targetId) as { total: number };
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
    const row = this.require(id);
    this.store.transaction(() => {
      const settings = this.store.settings();
      settings.excludedProjectPaths = [...new Set([...settings.excludedProjectPaths, row.path])];
      this.store.saveSettings(settings);
      this.store.db
        .prepare(
          'UPDATE task_identity SET revision=revision+1 WHERE record_id IN (SELECT id FROM records WHERE project_id=?)',
        )
        .run(id);
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
