import { randomUUID } from 'node:crypto';
import {
  analysisSelectionSchema,
  analysisRunSchema,
  type AnalysisPreview,
  type AnalysisResult,
} from '../../shared/analysis.js';
import { metadataSchema, type Snapshot } from '../../shared/contracts.js';
import { Store } from '../db.js';
import { Tasks } from '../tasks.js';
import { TaskHistory } from '../task-history.js';
import { HttpError } from '../errors.js';
import {
  environmentConfig,
  maxInputBytes,
  maxOutputTokens,
  timeoutSeconds,
  requestAnalysis,
  type AnalysisConfig,
} from './openai.js';

// This is a coarse guard, not proof that a user-entered text contains no private information.
export const sensitiveText =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:home|Users|etc|var|opt|tmp|mnt)\/|(?:\.local|\.codex|\.ai-rules)[\\/]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{15,}|BEGIN [A-Z ]*PRIVATE KEY|\b(?:password|api[_ -]?key|token)\s*[:=]\s*\S+)/i;
interface Prepared {
  preview: AnalysisPreview;
  attempted: boolean;
  result?: AnalysisResult;
  failure?: HttpError;
}
export class ProjectAnalysis {
  private prepared = new Map<string, Prepared>();
  private active: AbortController | null = null;
  constructor(
    private store: Store,
    private config: AnalysisConfig = environmentConfig(),
    private transport: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}
  status() {
    const model = /^[\w.:-]{1,100}$/.test(this.config.model) ? this.config.model : null;
    return {
      ready: !!this.config.key && !!model,
      model,
      maxInputBytes,
      maxOutputTokens,
      timeoutSeconds,
    };
  }
  prepare(input: unknown): AnalysisPreview {
    const { projectIds } = analysisSelectionSchema.parse(input);
    this.expire();
    if (this.prepared.size >= 10)
      throw new HttpError(
        429,
        'Слишком много подготовленных пакетов. Дождитесь их истечения через 15 минут.',
      );
    const allTasks = new Tasks(this.store).list();
    const preparedAt = new Date(this.now()).toISOString();
    const payload = {
      preparedAt,
      projects: [...new Set(projectIds)].map((id) => {
        const row = this.store.project(id);
        if (!row)
          throw new HttpError(404, 'Выбранный проект больше не существует. Обновите список.');
        const snapshot = JSON.parse(row.snapshot) as Snapshot;
        const metadata = row.metadata
          ? metadataSchema.parse(JSON.parse(row.metadata))
          : (snapshot.yaml.metadata ?? metadataSchema.parse({ name: snapshot.directoryName }));
        const tasks = allTasks.filter((task) => task.projectId === id && !task.completedAt);
        if (tasks.length > 200)
          throw new HttpError(
            400,
            'В проекте больше 200 открытых задач. Сократите список перед анализом.',
          );
        const history = new TaskHistory(this.store).list({ projectId: id, limit: 5 });
        return {
          source: `project:${id}`,
          id,
          name: metadata.name,
          status: metadata.status,
          priority: metadata.priority,
          goal: metadata.goal,
          blockedBy: metadata.blocked_by,
          available: !!row.available,
          snapshotAt: snapshot.scannedAt,
          tasks: tasks.map((task) => ({
            source: `task:${task.code}`,
            code: task.code,
            title: task.title,
            state: task.state,
            priority: task.priority,
            description: task.description,
            expectedResult: task.expectedResult,
            acceptance: task.acceptance,
            updatedAt: task.updatedAt,
          })),
          recentWork: history.items.map((item) => ({
            source: `history:${item.id}`,
            taskCode: item.task.code,
            kind: item.kind,
            recordedAt: item.recordedAt,
            result: item.task.result,
          })),
          historyTotal: history.total,
        };
      }),
    };
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > maxInputBytes)
      throw new HttpError(
        400,
        'Данные больше 80 000 байт. Выберите меньше проектов; пакет не обрезается.',
      );
    if (sensitiveText.test(json))
      throw new HttpError(
        400,
        'В выбранных текстах обнаружен локальный путь или возможный секрет. Уберите его из сводки/задач либо исключите проект.',
      );
    const preview = {
      id: randomUUID(),
      payload,
      config: this.status(),
      expiresAt: new Date(this.now() + 15 * 60000).toISOString(),
    };
    this.prepared.set(preview.id, { preview, attempted: false });
    // In-process callers must not be able to mutate the approved packet.
    return structuredClone(preview);
  }
  async run(input: unknown): Promise<AnalysisResult> {
    const { previewId } = analysisRunSchema.parse(input);
    this.expire();
    const entry = this.prepared.get(previewId);
    if (!entry)
      throw new HttpError(
        410,
        'Пакет истёк или сервер перезапущен. Подготовьте и просмотрите данные заново.',
      );
    if (entry.result) return structuredClone(entry.result);
    if (entry.failure) throw entry.failure;
    if (this.active || entry.attempted)
      throw new HttpError(409, 'Анализ уже выполняется. Повторный запрос не отправлен.');
    if (entry.preview.payload.projects.some((project) => !this.store.project(project.id)))
      throw new HttpError(
        410,
        'Выбранный проект удалён. Подготовьте данные заново; запрос не отправлен.',
      );
    if (!this.status().ready)
      throw new HttpError(
        503,
        'Задайте OPENAI_API_KEY и CONTROL_CENTER_OPENAI_MODEL в окружении сервера и перезапустите его.',
      );
    const controller = new AbortController();
    this.active = controller;
    entry.attempted = true;
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const response = await requestAnalysis(
        entry.preview.payload,
        this.config,
        controller.signal,
        this.transport,
      );
      if (sensitiveText.test(response.report.summary))
        throw new HttpError(
          502,
          'Ответ содержит возможный секрет или локальный путь. Ответ отклонён.',
        );
      const projects = entry.preview.payload.projects;
      for (const proposal of response.report.proposals) {
        const project = projects.find((item) => item.id === proposal.projectId);
        const sources = project
          ? new Set([
              project.source,
              ...project.tasks.map((item) => item.source),
              ...project.recentWork.map((item) => item.source),
            ])
          : null;
        if (
          !sources ||
          proposal.sources.some((source) => !sources.has(source)) ||
          sensitiveText.test(JSON.stringify(proposal))
        )
          throw new HttpError(
            502,
            'Предложение ссылается на чужой источник или содержит возможный секрет/локальный путь. Ответ отклонён.',
          );
      }
      entry.result = {
        previewId,
        generatedAt: new Date(this.now()).toISOString(),
        model: this.config.model,
        ...response,
      };
      return structuredClone(entry.result);
    } catch (cause) {
      entry.failure =
        cause instanceof HttpError
          ? cause
          : new HttpError(
              502,
              'Анализ не завершён. Запрос мог быть оплачен; автоматического повтора нет.',
            );
      throw entry.failure;
    } finally {
      clearTimeout(timer);
      this.active = null;
    }
  }
  stop() {
    this.active?.abort();
  }
  private expire() {
    for (const [id, entry] of this.prepared)
      if (
        Date.parse(entry.preview.expiresAt) <= this.now() &&
        !(entry.attempted && !entry.result && !entry.failure)
      )
        this.prepared.delete(id);
  }
}
