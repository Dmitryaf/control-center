import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Review } from '../../../shared/reviews';
import type { PeriodRun, PeriodSelection } from '../../../shared/period-analysis';
import type {
  CodexConversation,
  CodexExecutionStatus,
  CodexFileList,
} from '../../../shared/codex-analysis';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { SourceSelection, coreSelection, emptySelection } from '../period-analysis/SourceSelection';
import { RunDetail } from '../period-analysis/PeriodAnalysis';

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
  const [question, setQuestion] = useState(() =>
    runId
      ? ''
      : 'Помоги осмыслить развитие выбранных проектов: что изменилось, что это значит и на чём стоит сосредоточиться?',
  );
  const [model, setModel] = useState('');
  const [selection, setSelection] = useState<PeriodSelection>(() => ({
    ...coreSelection(emptySelection(null)),
    projectIds: (params.get('projects') || '').split(',').filter(Boolean),
  }));
  const [files, setFiles] = useState<{ projectId: string; path: string }[]>([]);
  const [inventory, setInventory] = useState<CodexFileList | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [failure, setFailure] = useState('');
  const [dirty, setDirty] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => setApproved(false), [pending?.id, pending?.packetHash]);
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
  const canCompose = !latest || followup;
  return (
    <div className="analysis-page codex-analysis-page">
      <UnsavedChanges dirty={dirty} />
      <div className="page-heading">
        <div>
          <p className="section-label">Осмысление проектов</p>
          <h1>Обсуждение с Codex</h1>
        </div>
        <Link to="/analysis">К анализу проектов →</Link>
      </div>
      <p>
        Задайте вопрос о выбранных проектах. Пакет, ответы и уточнения сохраняются здесь. Каждый
        запуск использует доступ и лимиты установленного Codex CLI.
      </p>
      {status.isPending && <p role="status">Проверка подключения Codex…</p>}
      {(status.error || (status.data && !status.data.available)) && (
        <div className="message warning" role="alert">
          {status.error?.message || status.data?.reason}
          <button onClick={() => void status.refetch()}>Проверить подключение</button>
        </div>
      )}
      {status.data?.available && status.data.authenticated !== false && (
        <p className="help">Codex установлен. Вход и доступный лимит проверяются при запуске.</p>
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
      {(failure || view.error || conversation.error || (review.error && !runId)) && (
        <div className="message error" role="alert">
          {failure || view.error?.message || conversation.error?.message || review.error?.message}
        </div>
      )}
      {view.isPending && runId && <p role="status">Загрузка обсуждения…</p>}
      {turns.length > 0 && (
        <section aria-label="Обсуждение анализа" className="section-space">
          {turns.map((turn) => (
            <article key={turn.id} className="section-space">
              <div className="panel">
                <h2>Ваш вопрос</h2>
                <p className="preserve">
                  {turn.payload.origin?.kind === 'codex_runtime'
                    ? turn.payload.origin.question
                    : ''}
                </p>
                <p className="help">{stateLabel[turn.status]}</p>
              </div>
              {turn.report ? (
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
                turn.error && (
                  <p className="message warning" role="alert">
                    {turn.error}
                  </p>
                )
              )}
            </article>
          ))}
        </section>
      )}
      {pending && (
        <section className="panel section-space" aria-label="Просмотр запроса Codex">
          <h2>Что получит Codex</h2>
          <p>
            Источников: {pending.payload.sources.length}.{' '}
            {pending.payload.origin?.kind === 'codex_runtime' && pending.payload.origin.parentRunId
              ? 'Также будут переданы предыдущие успешные вопросы и ответы этого обсуждения.'
              : 'Предыдущие диалоги не подключаются автоматически.'}
          </p>
          <ul>
            {pending.payload.sources.map((source) => (
              <li key={source.id}>{source.title}</li>
            ))}
          </ul>
          <details>
            <summary>Точный контекст и ограничения</summary>
            <pre className="analysis-packet">{JSON.stringify(pending.payload, null, 2)}</pre>
            {turns
              .filter((t) => t.status === 'succeeded')
              .map((t) => (
                <div key={t.id}>
                  <p>
                    {t.payload.origin?.kind === 'codex_runtime' ? t.payload.origin.question : ''}
                  </p>
                  <pre className="analysis-packet">{JSON.stringify(t.report, null, 2)}</pre>
                </div>
              ))}
          </details>
          <label className="checkbox section-space">
            <input
              type="checkbox"
              checked={approved}
              onChange={(event) => setApproved(event.target.checked)}
            />
            Я просмотрел контекст и разрешаю отправить этот запрос через Codex с использованием
            моего лимита или оплатой API при таком способе входа
          </label>
          <div className="row section-space">
            <button
              className="primary"
              disabled={
                busy || !approved || !status.data?.available || status.data?.authenticated === false
              }
              onClick={() =>
                void action(async () => {
                  const saved = await api<View>(`/codex-analysis/${pending.id}/start`, 'POST', {
                    packetHash: pending.packetHash,
                    consent: true,
                  });
                  client.setQueryData(['codex-run', pending.id], saved);
                  await refresh();
                })
              }
            >
              Запустить Codex
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api(`/period-analysis/${pending.id}/cancel`, 'POST', {});
                  await refresh();
                })
              }
            >
              Отменить запрос
            </button>
          </div>
          <p className="help">
            Пакет действует до {new Date(pending.expiresAt).toLocaleString('ru')}. Автоматической
            повторной отправки нет.
          </p>
        </section>
      )}
      {running && (
        <section className="panel section-space" aria-label="Ход анализа">
          <h2>Codex работает</h2>
          <p role="status">{view.data?.progress || 'Codex анализирует утверждённый контекст'}</p>
          <p>
            Страницу можно закрыть и вернуться к обсуждению. После остановки сервера запрос сам не
            запускается повторно.
          </p>
          <button
            disabled={busy || latest?.cancelRequested}
            onClick={() =>
              void action(async () => {
                await api(`/period-analysis/${latest!.id}/cancel`, 'POST', {});
                await refresh();
              })
            }
          >
            {latest?.cancelRequested ? 'Остановка запрошена' : 'Остановить анализ'}
          </button>
        </section>
      )}
      {canCompose && review.data && (
        <form
          className="panel form section-space"
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
          <h2>{followup ? 'Уточнить выводы' : 'Новый анализ'}</h2>
          <label>
            <span id="codex-question-label">{followup ? 'Уточняющий вопрос' : 'Вопрос Codex'}</span>
            <textarea
              aria-labelledby="codex-question-label"
              required
              rows={3}
              maxLength={4000}
              disabled={busy}
              value={question}
              onChange={(e) => {
                changed();
                setQuestion(e.target.value);
              }}
            />
          </label>
          {followup ? (
            <p className="help">
              Используется тот же сохранённый пакет и успешные ответы этого обсуждения. Для другого
              состава источников начните новый анализ.
            </p>
          ) : (
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
                  Только выбранные файлы, добавленные в Git: до 12 файлов, каждый до 8 КБ. Сначала
                  загрузится список имён; содержимое читается при подготовке контекста.
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
          <p className="help">
            Подготовка читает выбранные локальные источники и сохраняет пакет. Отправка Codex
            подтверждается отдельно на следующем шаге.
          </p>
          <button
            className="primary"
            disabled={busy || !question.trim() || (!followup && !selection.projectIds.length)}
          >
            Подготовить контекст
          </button>
        </form>
      )}
      {latest && !running && (
        <p className="section-space">
          <Link
            to={`/codex-analysis?review=${latest.reviewKey}&projects=${latest.selection.projectIds.join(',')}`}
            onClick={(event) => {
              if (dirty && !confirm('Отбросить несохранённый вопрос и начать новое обсуждение?')) {
                event.preventDefault();
                return;
              }
              setQuestion('Помоги осмыслить развитие выбранных проектов.');
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
