import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Review } from '../../../shared/reviews';
import type { PeriodRun, PeriodSelection } from '../../../shared/period-analysis';
import type {
  CodexConversation,
  CodexExecutionStatus,
  CodexFileList,
} from '../../../shared/codex-analysis';
import { NotebookHeading } from '../../shared/NotebookHeading';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { SourceSelection, coreSelection, emptySelection } from '../period-analysis/SourceSelection';
import { RunDetail } from '../period-analysis/PeriodAnalysis';
import { codexDefaultQuestion as defaultQuestion } from '../../../shared/codex-analysis';
import { RequestPreview } from './RequestPreview';
import { AnalysisProgress } from './AnalysisProgress';
type View = { run: PeriodRun; progress: string | null };
const stateLabel = {
  pending: 'Пакет готов к просмотру',
  running: 'Codex работает',
  succeeded: 'Ответ сохранён',
  failed: 'Анализ не выполнен',
  unknown: 'Результат неизвестен',
  cancelled: 'Запрос отменён',
};
export default function CodexAnalysis() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const { data: workspace } = useWorkspace();
  const runId = params.get('run');
  const reviewId = params.get('review');
  const review = useQuery({
    queryKey: ['review', reviewId],
    enabled: !!reviewId,
    queryFn: ({ signal }) =>
      api<Review>(`/reviews/${encodeURIComponent(reviewId!)}`, 'GET', undefined, signal),
  });
  const view = useQuery({
    queryKey: ['codex-run', runId],
    enabled: !!runId,
    queryFn: ({ signal }) =>
      api<View>(`/codex-analysis/${encodeURIComponent(runId!)}`, 'GET', undefined, signal),
    refetchInterval: (query) =>
      ['pending', 'running'].includes(query.state.data?.run.status ?? '') ? 1000 : false,
  });
  const origin = view.data?.run.payload.origin;
  const sessionId = origin?.kind === 'codex_runtime' ? origin.sessionId : null;
  const conversation = useQuery({
    queryKey: ['codex-conversation', sessionId],
    enabled: !!sessionId,
    queryFn: ({ signal }) =>
      api<CodexConversation>(
        `/codex-analysis/conversation?sessionId=${encodeURIComponent(sessionId!)}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: (query) =>
      query.state.data?.turns.some((t) => ['pending', 'running'].includes(t.status)) ? 1000 : false,
  });
  const status = useQuery({
    queryKey: ['codex-execution-status'],
    queryFn: ({ signal }) =>
      api<CodexExecutionStatus>('/codex-analysis/status', 'GET', undefined, signal),
    staleTime: 60000,
    refetchInterval: (query) =>
      query.state.data?.login && query.state.data.login.state !== 'failed' ? 1500 : false,
  });
  const turns = conversation.data?.turns ?? (view.data ? [view.data.run] : []);
  const latest = turns.at(-1);
  const pending = latest?.status === 'pending' ? latest : null;
  const running = latest?.status === 'running';
  const executionProgress = useQuery({
    queryKey: ['codex-run', latest?.id],
    enabled: !!running,
    queryFn: ({ signal }) =>
      api<View>(`/codex-analysis/${encodeURIComponent(latest!.id)}`, 'GET', undefined, signal),
    refetchInterval: running ? 1000 : false,
  });
  const { hash, state } = useLocation();
  const incomingQuestion = !runId && typeof state?.question === 'string' ? state.question : '';
  const [question, setQuestion] = useState(runId ? '' : incomingQuestion || defaultQuestion);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const [model, setModel] = useState('');
  const [selection, setSelection] = useState<PeriodSelection>(() => ({
    ...coreSelection(emptySelection(null)),
    projectIds: (params.get('projects') || '').split(',').filter(Boolean),
  }));
  const [files, setFiles] = useState<{ projectId: string; path: string }[]>([]);
  const [inventory, setInventory] = useState<CodexFileList | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [failure, setFailure] = useState('');
  const [dirty, setDirty] = useState(!!incomingQuestion);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (['running', 'succeeded'].includes(view.data?.run.status ?? '')) setFailure('');
  }, [view.data?.run.status, runId]);
  useEffect(() => {
    if (!runId && review.data?.projectId && !selection.projectIds.length)
      setSelection((value) => ({ ...value, projectIds: [review.data!.projectId!] }));
  }, [review.data, runId, selection.projectIds.length]);
  function changed() {
    key.current = crypto.randomUUID();
    setDirty(true);
    setFailure('');
  }
  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure('');
    try {
      await work();
    } catch (cause) {
      setFailure((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    await client.invalidateQueries({ queryKey: ['codex-run'] });
    await client.invalidateQueries({ queryKey: ['codex-conversation'] });
    await client.invalidateQueries({ queryKey: ['recent-project-analyses'] });
  }
  const followup =
    latest?.status === 'succeeded' && latest.payload.origin?.kind === 'codex_runtime';
  const canCompose = !runId || (followup && conversation.isSuccess);
  const focusQuestion = hash === '#question' && !!followup && !!review.data && canCompose;
  useEffect(() => {
    if (focusQuestion) questionRef.current?.focus();
  }, [focusQuestion, runId]);
  return (
    <div className="analysis-page codex-analysis-page">
      <UnsavedChanges dirty={dirty} />
      <NotebookHeading
        date={view.data ? new Date(view.data.run.createdAt) : undefined}
        title={runId ? 'Анализ проектов' : 'Обсуждение с Codex'}
      />
      <Link className="analysis-back" to="/analysis">
        Все анализы
      </Link>
      {(failure || view.error || conversation.error || (review.error && !runId)) && (
        <div className="message error" role="alert">
          {failure || view.error?.message || conversation.error?.message || review.error?.message}
        </div>
      )}
      {view.isPending && runId && <p role="status">Загрузка обсуждения…</p>}
      {turns.length > 0 && (
        <section aria-label="Обсуждение анализа" className="section-space">
          {turns.map((turn) => {
            if (turn.id === latest?.id && ['pending', 'running'].includes(turn.status)) return null;
            const questionText =
              turn.payload.origin?.kind === 'codex_runtime' ? turn.payload.origin.question : '';
            const content = turn.report ? (
              <RunDetail
                embedded
                run={turn}
                status={undefined}
                onDeleted={() => {
                  client.removeQueries({ queryKey: ['codex-run', turn.id] });
                  const remaining = turns.filter((t) => t.id !== turn.id);
                  if (remaining.length)
                    setParams({ review: reviewId || turn.reviewKey, run: remaining.at(-1)!.id });
                  else
                    setParams({
                      review: reviewId || turn.reviewKey,
                      projects: turn.selection.projectIds.join(','),
                    });
                  void refresh();
                }}
              />
            ) : (
              <div className="section-space">
                <h2>
                  {questionText === defaultQuestion ? 'Разбор проектов за период' : questionText}
                </h2>
                <p className="help">{stateLabel[turn.status]}</p>
                {turn.error && <p role="alert">{turn.error}</p>}
              </div>
            );
            return turn.id === latest?.id ? (
              <div key={turn.id}>{content}</div>
            ) : (
              <details
                className="analysis-earlier"
                key={turn.id}
                open={turn.id === runId || !!turn.report}
              >
                <summary>
                  {questionText === defaultQuestion ? 'Разбор проектов за период' : questionText}
                </summary>
                {content}
              </details>
            );
          })}
        </section>
      )}
      {status.isPending && <p role="status">Проверка подключения Codex…</p>}
      {(status.error || (status.data && !status.data.available)) && (
        <div className="message warning" role="alert">
          {status.error?.message || status.data?.reason}
          <button onClick={() => void status.refetch()}>Проверить подключение</button>
        </div>
      )}
      {status.data?.available && status.data.authenticated === false && (
        <section className="panel" aria-label="Вход в Codex">
          <h2>Подключить Codex</h2>
          <p>
            Войдите один раз в отдельный профиль Control Center. Личные диалоги, инструкции и память
            основного Codex сюда не переносятся.
          </p>
          {status.data.login?.state === 'starting' && <p role="status">Получение кода входа…</p>}
          {status.data.login?.state === 'waiting' && (
            <>
              <p>
                Откройте{' '}
                <a href={status.data.login.url!} target="_blank" rel="noreferrer">
                  страницу входа OpenAI
                </a>{' '}
                и введите код:
              </p>
              <p>
                <strong>{status.data.login.code}</strong>
              </p>
              <p className="help">
                Не передавайте этот код другим людям. Разрешите вход по коду устройства в настройках
                безопасности ChatGPT, если он недоступен.
              </p>
            </>
          )}
          {status.data.login?.error && <p role="alert">{status.data.login.error}</p>}
          {!status.data.login || status.data.login.state === 'failed' ? (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await api<CodexExecutionStatus>('/codex-analysis/login', 'POST', {
                    confirm: true,
                  });
                  client.setQueryData(['codex-execution-status'], result);
                })
              }
            >
              Войти в Codex
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await api<CodexExecutionStatus>(
                    '/codex-analysis/login/cancel',
                    'POST',
                    { confirm: true },
                  );
                  client.setQueryData(['codex-execution-status'], result);
                })
              }
            >
              Отменить вход
            </button>
          )}
          <button disabled={busy} onClick={() => void status.refetch()}>
            Проверить вход
          </button>
        </section>
      )}
      {pending && (
        <RequestPreview
          key={pending.id}
          run={pending}
          turns={turns}
          busy={busy}
          canStart={!!status.data?.available && status.data?.authenticated !== false}
          onStart={() =>
            void action(async () => {
              const saved = await api<View>(`/codex-analysis/${pending.id}/start`, 'POST', {
                packetHash: pending.packetHash,
                consent: true,
              });
              client.setQueryData(['codex-run', pending.id], saved);
              await refresh();
            })
          }
          onCancel={() =>
            void action(async () => {
              await api(`/period-analysis/${pending.id}/cancel`, 'POST', {});
              await refresh();
            })
          }
          onReprepare={(nextSelection) =>
            void action(async () => {
              const origin = pending.payload.origin;
              if (origin?.kind !== 'codex_runtime' || origin.parentRunId) return;
              const prepared = await api<PeriodRun>('/codex-analysis/prepare', 'POST', {
                reviewId: pending.reviewKey,
                requestKey: crypto.randomUUID(),
                question: origin.question,
                selection: nextSelection,
                files: origin.files,
                ...(pending.model === 'codex-default' ? {} : { model: pending.model }),
                readConsent: true,
              });
              await api(`/period-analysis/${pending.id}/cancel`, 'POST', {});
              client.setQueryData(['codex-run', prepared.id], { run: prepared, progress: null });
              setParams({ review: prepared.reviewKey, run: prepared.id });
              await refresh();
            })
          }
        />
      )}
      {running && latest && (
        <AnalysisProgress
          scope={`${latest.payload.period.from.split('-').reverse().join('.')} — ${latest.payload.period.to.split('-').reverse().join('.')} · ${latest.payload.sources
            .filter((source) => source.kind === 'project')
            .map((source) => source.title)
            .join(', ')}`}
          startedAt={latest.startedAt}
          stage={executionProgress.data?.progress ?? null}
          stopping={latest.cancelRequested}
          busy={busy}
          onStop={() =>
            void action(async () => {
              await api(`/period-analysis/${latest.id}/cancel`, 'POST', {});
              await refresh();
            })
          }
        />
      )}
      {canCompose && review.data && (
        <form
          className={followup ? 'analysis-follow-form' : 'form analysis-new-form'}
          aria-label={followup ? 'Уточнение анализа' : 'Новый анализ Codex'}
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const parent = followup ? latest : null;
              const parentOrigin = parent?.payload.origin;
              const prepared = await api<PeriodRun>('/codex-analysis/prepare', 'POST', {
                reviewId: review.data.id,
                requestKey: key.current,
                question,
                selection: parent?.selection ?? selection,
                ...(parent
                  ? parent.model === 'codex-default'
                    ? {}
                    : { model: parent.model }
                  : model.trim()
                    ? { model: model.trim() }
                    : {}),
                files: parentOrigin?.kind === 'codex_runtime' ? parentOrigin.files : files,
                ...(parent ? { parentRunId: parent.id } : {}),
                readConsent: true,
              });
              flushSync(() => setDirty(false));
              setQuestion('');
              key.current = crypto.randomUUID();
              client.setQueryData(['codex-run', prepared.id], { run: prepared, progress: null });
              setParams({ review: review.data.id, run: prepared.id });
              await refresh();
            });
          }}
        >
          {!followup && <h2>Новый анализ</h2>}
          <label>
            <span className={followup ? 'visually-hidden' : undefined} id="codex-question-label">
              {followup ? 'Уточняющий вопрос' : 'Вопрос Codex'}
            </span>
            <textarea
              aria-labelledby="codex-question-label"
              required={!!followup}
              id="question"
              ref={questionRef}
              placeholder={followup ? 'Уточнить у Codex…' : undefined}
              rows={followup ? 1 : 3}
              maxLength={4000}
              disabled={busy}
              value={question}
              onChange={(e) => {
                changed();
                setQuestion(e.target.value);
              }}
            />
          </label>
          {!followup && (
            <>
              <details>
                <summary>Источники анализа</summary>
                <SourceSelection
                  value={selection}
                  onChange={(value) => {
                    changed();
                    setSelection(value);
                    setFiles([]);
                    setInventory(null);
                  }}
                  projects={workspace!.projects}
                  projectId={review.data.projectId}
                  disabled={busy}
                />
              </details>
              <details>
                <summary>Добавить файлы проектов — по необходимости</summary>
                <p className="help">
                  До 12 файлов из Git, каждый до 8 КБ. Список содержит только имена. Содержимое
                  выбранных файлов читается при подготовке контекста.
                </p>
                <button
                  type="button"
                  disabled={busy || !selection.projectIds.length}
                  onClick={() =>
                    void action(async () =>
                      setInventory(
                        await api<CodexFileList>('/codex-analysis/files', 'POST', {
                          projectIds: selection.projectIds,
                          readConsent: true,
                        }),
                      ),
                    )
                  }
                >
                  Показать файлы выбранных проектов
                </button>
                {inventory?.projects.map((project) => (
                  <fieldset key={project.id} disabled={busy}>
                    <legend>{project.name}</legend>
                    <div className="codex-file-picker">
                      {project.files.map((file) => (
                        <label className="checkbox" key={file}>
                          <input
                            type="checkbox"
                            checked={files.some(
                              (f) => f.projectId === project.id && f.path === file,
                            )}
                            onChange={(e) => {
                              changed();
                              setFiles((value) =>
                                e.target.checked
                                  ? [...value, { projectId: project.id, path: file }]
                                  : value.filter(
                                      (f) => f.projectId !== project.id || f.path !== file,
                                    ),
                              );
                            }}
                          />
                          {file}
                        </label>
                      ))}
                    </div>
                    {project.truncated && <p>Показаны первые 200 допустимых файлов.</p>}
                  </fieldset>
                ))}
              </details>
              <details>
                <summary>Модель</summary>
                <label>
                  Модель Codex
                  <input
                    maxLength={100}
                    disabled={busy}
                    placeholder="По умолчанию Codex CLI"
                    value={model}
                    onChange={(e) => {
                      changed();
                      setModel(e.target.value);
                    }}
                  />
                </label>
              </details>
            </>
          )}
          {!followup && (
            <p className="help">На следующем шаге вы увидите, какие данные получит Codex.</p>
          )}
          <button
            className="primary"
            disabled={
              busy || (followup && !question.trim()) || (!followup && !selection.projectIds.length)
            }
          >
            {busy ? (
              'Готовим запрос…'
            ) : followup ? (
              <>
                <span aria-hidden="true">↑</span>
                <span className="visually-hidden">Подготовить уточнение</span>
              </>
            ) : (
              'Подготовить контекст'
            )}
          </button>
        </form>
      )}
      {latest && !running && (
        <p className="analysis-restart-links section-space">
          <Link
            to={`/analysis?${new URLSearchParams({ projects: latest.selection.projectIds.join(','), kind: latest.payload.period.kind, date: latest.payload.period.from })}`}
            state={{
              question:
                question.trim() ||
                (latest.payload.origin?.kind === 'codex_runtime'
                  ? latest.payload.origin.question
                  : ''),
            }}
          >
            Изменить период или проекты
          </Link>
          <Link
            to={`/codex-analysis?review=${latest.reviewKey}&projects=${latest.selection.projectIds.join(',')}`}
            onClick={(event) => {
              if (dirty && !confirm('Отбросить несохранённый вопрос и начать новое обсуждение?')) {
                event.preventDefault();
                return;
              }
              setQuestion(defaultQuestion);
              setSelection(latest.selection);
              setFiles([]);
              flushSync(() => setDirty(false));
              key.current = crypto.randomUUID();
            }}
          >
            Начать новое обсуждение →
          </Link>
        </p>
      )}
    </div>
  );
}
