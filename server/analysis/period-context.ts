import { createHash } from 'node:crypto';
import {
  periodSelectionSchema,
  type PeriodSelection,
  type PeriodPayload,
  type PeriodSource,
} from '../../shared/period-analysis.js';
import { metadataSchema } from '../../shared/contracts.js';
import type { Review } from '../../shared/reviews.js';
import type { Store } from '../db.js';
import type { History } from '../history.js';
import { Reviews } from '../reviews.js';
import { Tasks } from '../tasks.js';
import { Observations } from '../observations.js';
import { HttpError } from '../errors.js';
import { sensitiveText } from './privacy.js';
import { maxInputBytes } from './openai.js';

export const periodPolicyVersion = 'period-review-v2';
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export interface ContextGuard {
  kind:
    | 'project'
    | 'project_metadata'
    | 'task'
    | 'observation'
    | 'review'
    | 'check'
    | 'check_entry'
    | 'decision'
    | 'file_decision'
    | 'analysis';
  id: string;
  stamp: string;
}
export const projectStamp = (row: NonNullable<ReturnType<Store['project']>>) =>
  digest({
    visibility: row.visibility,
    privateContext: row.private_context_path,
    decisionSources: row.decision_sources,
    allowlist: row.publication_allowlist,
  });
function projectFields(row: NonNullable<ReturnType<Store['project']>>) {
  const snapshot = JSON.parse(row.snapshot);
  const metadata = row.metadata
    ? metadataSchema.parse(JSON.parse(row.metadata))
    : (snapshot.yaml.metadata ?? metadataSchema.parse({ name: snapshot.directoryName }));
  return {
    name: metadata.name,
    goal: metadata.goal,
    status: metadata.status,
    stage: metadata.stage,
    blockedBy: metadata.blocked_by,
    available: !!row.available,
  };
}
function mutableStamp(
  store: Store,
  kind: 'check' | 'check_entry' | 'decision',
  id: string,
): string | null {
  const sql = {
    check: 'SELECT project_id,data,updated_at FROM checks WHERE id=?',
    check_entry:
      'SELECT c.project_id,e.data,e.updated_at,c.updated_at AS parent_updated_at FROM check_entries e JOIN checks c ON c.id=e.check_id WHERE e.id=?',
    decision: "SELECT project_id,data,updated_at FROM records WHERE kind='decisions' AND id=?",
  };
  const row = store.db.prepare(sql[kind]).get(id);
  return row ? digest(row) : null;
}
export function normalizeSelection(input: PeriodSelection): PeriodSelection {
  const value = periodSelectionSchema.parse(input);
  return {
    ...value,
    projectIds: [...new Set(value.projectIds)].sort(),
    sourceKinds: [...new Set(value.sourceKinds)].sort(),
  };
}
export function buildPeriodContext(
  store: Store,
  history: History,
  review: Review,
  selection: PeriodSelection,
  now: number,
  allowEmpty = false,
) {
  if (
    review.scopeKey !== 'general' &&
    (selection.includeGeneral ||
      selection.projectIds.length !== 1 ||
      selection.projectIds[0] !== review.scopeKey.slice(8))
  )
    throw new HttpError(
      400,
      'Проектный обзор использует только свой проект. Для сравнения проектов откройте общий обзор.',
    );
  if (!selection.projectIds.length && !selection.includeGeneral)
    throw new HttpError(400, 'Выберите проекты или явно разрешите общие записи.');
  const guards: ContextGuard[] = [];
  const sources: PeriodSource[] = [];
  const coverage = { undated: 0, unavailable: 0, notLoadedProjects: 0 };
  const add = (source: PeriodSource) => {
    if (!sources.some((s) => s.id === source.id)) sources.push(source);
  };
  const reviews = new Reviews(store);
  const scopeSet = new Set(selection.projectIds);
  for (const id of selection.projectIds) {
    const row = store.project(id);
    if (!row) throw new HttpError(410, 'Выбранный проект удалён. Запрос не подготовлен.');
    guards.push({ kind: 'project', id, stamp: projectStamp(row) });
    if (selection.includeMetadata) {
      const snapshot = JSON.parse(row.snapshot);
      const metadata = projectFields(row);
      guards.push({ kind: 'project_metadata', id, stamp: digest(metadata) });
      add({
        id: `project:${id}`,
        kind: 'project',
        projectId: id,
        title: metadata.name,
        text: JSON.stringify(metadata),
        day: null,
        recordedAt: snapshot.scannedAt,
        dateQuality: 'current',
        partial: false,
      });
    }
  }
  if (selection.includeOpenTasks) {
    const tasks = new Tasks(store)
      .list()
      .filter(
        (task) =>
          !task.completedAt &&
          (task.projectId ? scopeSet.has(task.projectId) : selection.includeGeneral),
      );
    if (tasks.length > 100)
      throw new HttpError(
        400,
        'Больше 100 открытых задач. Выберите меньше проектов или исключите текущие задачи.',
      );
    for (const task of tasks) {
      add({
        id: `open-task:${task.id}`,
        kind: 'open_task',
        projectId: task.projectId,
        title: task.title,
        text: JSON.stringify({
          code: task.code,
          state: task.state,
          description: task.description,
          expectedResult: task.expectedResult,
          acceptance: task.acceptance,
        }),
        day: null,
        recordedAt: task.updatedAt,
        dateQuality: 'current',
        partial: false,
      });
      guards.push({ kind: 'task', id: task.id, stamp: String(task.revision) });
    }
  }
  if (selection.sourceKinds.length) {
    const scopes = [...selection.projectIds, ...(selection.includeGeneral ? [null] : [])];
    let total = 0;
    for (const id of scopes) {
      const kinds = id
        ? selection.sourceKinds
        : selection.sourceKinds.filter((kind) => kind !== 'file_decision');
      if (!kinds.length) continue;
      let cursor: string | undefined;
      do {
        const page = history.forReview(
          { ...review, scopeKey: id ? `project:${id}` : 'general' },
          { limit: 50, ...(cursor ? { cursor } : {}) },
          { kinds, generalOnly: !id },
        );
        if (id && !cursor && selection.sourceKinds.includes('file_decision')) {
          coverage.undated += page.files.undated;
          coverage.unavailable += page.files.unavailable;
          coverage.notLoadedProjects += page.files.notLoadedProjects;
        }
        for (const entry of page.items) {
          if (++total > 200)
            throw new HttpError(
              400,
              'Больше 200 исходных событий. Выберите меньше проектов или источников; пакет не обрезается.',
            );
          add({
            id: entry.key,
            kind: entry.kind,
            projectId: entry.scopeProjectId,
            title: entry.title,
            text: entry.excerpt,
            day: entry.day,
            recordedAt: entry.recordedAt,
            dateQuality: entry.dateQuality,
            partial: entry.truncated,
          });
          if (entry.kind === 'observation')
            guards.push({
              kind: 'observation',
              id: entry.sourceId,
              stamp: String(new Observations(store).read(entry.sourceId).revision),
            });
          if (entry.kind === 'check' || entry.kind === 'decision') {
            const kind =
              entry.kind === 'check'
                ? entry.key.startsWith('check:entry:')
                  ? 'check_entry'
                  : 'check'
                : 'decision';
            guards.push({
              kind,
              id: entry.sourceId,
              stamp: mutableStamp(store, kind, entry.sourceId)!,
            });
          }
          if (entry.kind === 'file_decision')
            guards.push({
              kind: 'file_decision',
              id: entry.key,
              stamp: history.fileMetadataStamp(entry.key)!,
            });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
  }
  const addReview = (row: Review) => {
    add({
      id: `review:${row.id}`,
      kind: 'review_text',
      projectId: row.scopeKey === 'general' ? null : row.scopeKey.slice(8),
      title: `${row.kind}: ${row.periodStart} — ${row.periodEnd}`,
      text: row.userText,
      day: row.periodStart,
      recordedAt: row.updatedAt,
      dateQuality: 'current',
      partial: false,
    });
    guards.push({ kind: 'review', id: row.id, stamp: String(row.revision) });
  };
  if (selection.includeUserText) addReview(review);
  if (selection.includeRelatedReviews || selection.includeRelatedAnalyses) {
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = reviews.related(review.id, { limit: 50, ...(cursor ? { cursor } : {}) });
      for (const item of page.items) {
        if (
          !(item.scopeKey === 'general'
            ? selection.includeGeneral
            : scopeSet.has(item.scopeKey.slice(8)))
        )
          continue;
        if (++count > 20)
          throw new HttpError(
            400,
            'Больше 20 связанных обзоров. Исключите их или выберите меньше проектов.',
          );
        if (selection.includeRelatedReviews) addReview(reviews.read(item.id));
        if (selection.includeRelatedAnalyses) {
          const run = store.db
            .prepare(
              "SELECT id,report_json,packet_hash,review_id,finished_at FROM analysis_runs WHERE review_key=? AND status='succeeded' ORDER BY generation DESC LIMIT 1",
            )
            .get(item.id);
          if (run) {
            add({
              id: `analysis:${run.id}`,
              kind: 'ai_analysis',
              projectId: item.scopeKey === 'general' ? null : item.scopeKey.slice(8),
              title: `AI: ${item.periodStart} — ${item.periodEnd}`,
              text: String(run.report_json),
              day: item.periodStart,
              recordedAt: String(run.finished_at),
              dateQuality: 'model',
              partial: false,
            });
            guards.push({
              kind: 'analysis',
              id: String(run.id),
              stamp: digest({
                report_json: run.report_json,
                packet_hash: run.packet_hash,
                review_id: run.review_id,
              }),
            });
          }
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  if (!sources.length && !allowEmpty)
    throw new HttpError(
      400,
      'В выбранных источниках нет данных. Выберите другие источники или сохраните собственный итог.',
    );
  const payload: PeriodPayload = {
    policyVersion: periodPolicyVersion,
    preparedAt: new Date(now).toISOString(),
    period: {
      kind: review.kind,
      from: review.periodStart,
      to: review.periodEnd,
      timezone: review.timezone,
      startAt: review.startAt,
      nextStartAt: review.nextStartAt,
      incomplete: new Date(now).toISOString() < review.nextStartAt,
    },
    scope: {
      name: review.projectName,
      reviewId: review.id,
      key: review.scopeKey,
      projectIds: selection.projectIds,
      includesGeneral: selection.includeGeneral,
    },
    sources,
    limitations: [
      'Прежние AI-итоги — производные предположения, не независимые факты; вложенные старые ссылки не входят в этот пакет.',
      'Источники выбраны пользователем; отсутствие записи не доказывает отсутствие работы.',
      'Сохранённые результаты — сообщения авторов, не независимая проверка.',
      'Текущие цели, открытые задачи и тексты не восстанавливают состояние на конец периода.',
      'События передаются выдержками до 600 символов с отметкой partial; файловые решения — только датированные метаданные последнего прочитанного индекса, без нового чтения файлов.',
      'Git, пути, заметки проекта, тела файлов, приватные каталоги и переписки не включены.',
    ],
  };
  if (selection.sourceKinds.includes('file_decision'))
    payload.limitations.push(
      `Файловый индекс выбранных проектов: без дат ${coverage.undated}, недоступных источников ${coverage.unavailable}, без прочитанного индекса ${coverage.notLoadedProjects}.`,
    );
  if (selection.includeGeneral)
    payload.limitations.push(
      'Общие записи включают отвязанные. Прежняя принадлежность некоторых локальных решений и текущих задач не восстанавливается.',
    );
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > maxInputBytes)
    throw new HttpError(
      400,
      'Пакет больше 80 000 байт. Выберите меньше источников; пакет не обрезается.',
    );
  if (sensitiveText.test(json))
    throw new HttpError(
      400,
      'В выбранных текстах найден возможный секрет или локальный путь. Исключите источник либо исправьте текст.',
    );
  return { payload, guards };
}
export function verifyContextGuards(store: Store, guards: ContextGuard[], history: History) {
  for (const guard of guards) {
    let actual: string | null = null;
    if (guard.kind === 'project') {
      const row = store.project(guard.id);
      actual = row ? projectStamp(row) : null;
    } else if (guard.kind === 'project_metadata') {
      const row = store.project(guard.id);
      actual = row ? digest(projectFields(row)) : null;
    } else if (guard.kind === 'analysis') {
      const run = store.db
        .prepare(
          "SELECT report_json,packet_hash,review_id FROM analysis_runs WHERE id=? AND status='succeeded'",
        )
        .get(guard.id);
      actual = run ? digest(run) : null;
    } else if (guard.kind === 'file_decision') actual = history.fileMetadataStamp(guard.id);
    else if (guard.kind === 'check' || guard.kind === 'check_entry' || guard.kind === 'decision')
      actual = mutableStamp(store, guard.kind, guard.id);
    else
      try {
        actual = String(
          guard.kind === 'task'
            ? new Tasks(store).read(guard.id).revision
            : guard.kind === 'observation'
              ? new Observations(store).read(guard.id).revision
              : new Reviews(store).read(guard.id).revision,
        );
      } catch {
        actual = null;
      }
    if (actual !== guard.stamp)
      throw new HttpError(
        410,
        'Источник изменён, удалён или доступ отозван после подготовки. Просмотрите новый пакет; запрос не отправлен.',
      );
  }
}
