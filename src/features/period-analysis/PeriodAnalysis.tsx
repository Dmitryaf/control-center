import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Review } from '../../../shared/reviews';
import type { AnalysisStatus } from '../../../shared/analysis';
import type {
  PeriodRun,
  PeriodRunPage,
  PeriodRunState,
  PeriodSelection,
} from '../../../shared/period-analysis';
import { useWorkspace, useActions } from '../../shared/workspace';
import { api } from '../../shared/http';
import { date } from '../../shared/labels';
import { CodexChoices } from '../codex-context/CodexChoices';
import { ScheduleForm } from './Schedules';
import { SourceSelection, emptySelection } from './SourceSelection';

const stateLabel: Record<PeriodRunState, string> = {
  pending: 'Ожидает подтверждения',
  running: 'Запрос отправлен',
  succeeded: 'Результат сохранён',
  failed: 'Получен отказ или ответ отклонён',
  unknown: 'Результат неизвестен',
  cancelled: 'Пакет отменён',
};
function RunDetail({
  run,
  status,
  onDeleted,
}: {
  run: PeriodRun;
  status: AnalysisStatus | undefined;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const { act, busy } = useActions();
  const [approved, setApproved] = useState(false);
  const manual = run.origin === 'codex_manual';
  useEffect(() => setApproved(false), [run.id, run.packetHash]);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['period-runs', run.reviewKey] });
  };
  const execute = useMutation({
    retry: false,
    mutationFn: () =>
      api<PeriodRun>(`/period-analysis/${run.id}/run`, 'POST', {
        packetHash: run.packetHash,
        consent: true,
      }),
    onSuccess: async (saved) => {
      client.setQueryData(['period-run', saved.id], saved);
      await refresh();
    },
  });
  return (
    <section className="panel section-space period-analysis" aria-label="Сохранённый анализ">
      <div className="section-heading">
        <h2>Вариант {run.generation}</h2>
        <span className="signal-label">{stateLabel[run.status]}</span>
      </div>
      <p className="help">
        {manual
          ? 'Источник: Codex · внесён вручную; API-запрос не выполнялся'
          : `Модель: ${run.model || 'Не настроена'}`}{' '}
        · {date(run.payload.period.from)} — {date(run.payload.period.to)} ·{' '}
        {run.payload.period.timezone}
      </p>
      <p className="help">
        Пакет сохранён: {new Date(run.createdAt).toLocaleString('ru')}. Источников:{' '}
        {run.payload.sources.length}.{' '}
        {manual ? (
          'Модель и использование tokens внешнего сеанса не зафиксированы.'
        ) : (
          <>
            Лимит: {status?.maxInputBytes ?? 80000} байт / {status?.maxOutputTokens ?? 3000}{' '}
            выходных tokens.
          </>
        )}
      </p>
      {run.payload.period.incomplete && (
        <p className="message warning">Период на момент подготовки был неполным.</p>
      )}
      {run.error && <p role="alert">{run.error}</p>}
      {execute.error && <p role="alert">{execute.error.message}</p>}
      {run.cancelRequested && (
        <p className="help">
          Отмена запрошена. Она не возвращает уже отправленные данные и не гарантирует отсутствие
          оплаты.
        </p>
      )}
      <details open={run.status === 'pending'}>
        <summary>
          {manual ? 'Сохранённые основания и ограничения' : 'Точный пакет и ограничения'}
        </summary>
        <p className="help">
          Проверьте личные сведения и секреты: автоматический фильтр не гарантирует их отсутствия.
          Пакет и ответ сохраняются в локальной базе и резервных копиях.
        </p>
        <pre className="analysis-packet">{JSON.stringify(run.payload, null, 2)}</pre>
        <p className="source-path">Hash: {run.packetHash}</p>
      </details>
      {run.status === 'pending' && (
        <div className="form section-space">
          <label className="check">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            Я просмотрел точный пакет и разрешаю однократную отправку этих данных в OpenAI с
            возможной оплатой
          </label>
          {!status?.ready && (
            <p className="help">
              Для отправки настройте ключ и модель в окружении сервера, затем подготовьте новый
              пакет. Ключ в браузер не передаётся.
            </p>
          )}
          <div>
            <button
              className="primary"
              disabled={!approved || !status?.ready || busy || execute.isPending}
              onClick={() => execute.mutate()}
            >
              Отправить пакет в OpenAI
            </button>
          </div>
          <p className="help">
            Разрешение действует до {new Date(run.expiresAt).toLocaleString('ru')}. Изменённый
            источник требует нового просмотра. Автоматического повтора нет.
          </p>
        </div>
      )}
      {run.status === 'running' && (
        <p role="status">
          Ожидаем ответ. При закрытии страницы запрос может продолжаться. Повторная отправка этого
          запуска не выполняется.
        </p>
      )}
      {(run.status === 'pending' || run.status === 'running') && (
        <button
          className="section-space"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const saved = await api<PeriodRun>(`/period-analysis/${run.id}/cancel`, 'POST', {});
              client.setQueryData(['period-run', saved.id], saved);
              await refresh();
            }, 'Состояние отмены сохранено')
          }
        >
          Отменить этот запуск
        </button>
      )}
      {run.report && (
        <div className="section-space prose">
          <h3>{manual ? 'Анализ Codex' : 'AI-обзор'}</h3>
          <p className="preserve">{run.report.narrative}</p>
          {run.report.findings.length > 0 && (
            <>
              <h3>Выводы и основания</h3>
              {run.report.findings.map((finding, index) => (
                <article key={index}>
                  <p>{finding.statement}</p>
                  <ul>
                    {finding.sources.map((id) => (
                      <li key={id}>
                        {run.payload.sources.find((source) => source.id === id)?.title}{' '}
                        <small>({id})</small>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </>
          )}
          {run.report.uncertainties.length > 0 && (
            <>
              <h3>Что остаётся неизвестным</h3>
              <ul>
                {run.report.uncertainties.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {run.report.proposals.length > 0 && (
            <>
              <h3>Возможные следующие шаги</h3>
              {run.report.proposals.map((proposal, index) => (
                <article key={index}>
                  <h4>{proposal.title}</h4>
                  <p>{proposal.description}</p>
                  <p>{proposal.reason}</p>
                  <p>
                    Основания:{' '}
                    {proposal.sources
                      .map((id) => run.payload.sources.find((s) => s.id === id)?.title ?? id)
                      .join('; ')}
                  </p>
                  <Link to={`/period-proposal?run=${run.id}&index=${index}`}>
                    Проверить и принять предложение →
                  </Link>
                  <p className="help">
                    Неизвестное: {proposal.uncertainty || 'Не указано'}. Дешёвая проверка:{' '}
                    {proposal.cheapCheck}
                  </p>
                </article>
              ))}
            </>
          )}
          <p className="help">
            {manual
              ? 'Это готовый анализ, внесённый из Codex вместе с основаниями; приложение не проверяло исходный сеанс.'
              : 'Это вывод модели по сохранённому пакету.'}{' '}
            Он не доказывает правильность текста и не заменяет ваш итог. Задачи и идеи автоматически
            не создаются.
          </p>
        </div>
      )}
      {run.usage && (
        <p className="help section-space">
          Фактические tokens: вход {run.usage.inputTokens}, выход {run.usage.outputTokens}. Денежная
          стоимость не рассчитывается.
        </p>
      )}
      {run.responseId && <p className="source-path">Response ID: {run.responseId}</p>}
      {run.rawOutput && (
        <details className="section-space">
          <summary>Исходный текст ответа</summary>
          <pre className="analysis-packet">{run.rawOutput}</pre>
        </details>
      )}
      {run.status !== 'running' && (
        <button
          className="section-space"
          disabled={busy || execute.isPending}
          onClick={() => {
            if (
              !confirm(
                'Удалить локальные пакет и результат анализа? Ваш обзор, исходные события и уже принятые задачи/идеи с их основаниями сохранятся.',
              )
            )
              return;
            void act(async () => {
              await api(`/period-analysis/${run.id}`, 'DELETE', { confirm: true });
              onDeleted();
              client.removeQueries({ queryKey: ['period-run', run.id], exact: true });
              await refresh();
            }, 'Анализ удалён');
          }}
        >
          Удалить локальный анализ
        </button>
      )}
    </section>
  );
}
function AnalysisPage({ reviewId }: { reviewId: string }) {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const client = useQueryClient();
  const review = useQuery({
    queryKey: ['review', reviewId],
    queryFn: ({ signal }) =>
      api<Review>(`/reviews/${encodeURIComponent(reviewId)}`, 'GET', undefined, signal),
    retry: false,
  });
  const status = useQuery({
    queryKey: ['period-analysis-status'],
    queryFn: ({ signal }) =>
      api<AnalysisStatus>('/period-analysis/status', 'GET', undefined, signal),
    retry: false,
  });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const runs = useQuery({
    queryKey: ['period-runs', reviewId, cursor],
    queryFn: ({ signal }) =>
      api<PeriodRunPage>(
        `/reviews/${encodeURIComponent(reviewId)}/analyses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: cursor ? false : 5000,
    retry: false,
  });
  const selected = useQuery({
    queryKey: ['period-run', runId],
    enabled: !!runId && !deletedIds.includes(runId),
    queryFn: ({ signal }) =>
      api<PeriodRun>(`/period-analysis/${encodeURIComponent(runId!)}`, 'GET', undefined, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const [selection, setSelection] = useState<PeriodSelection | null>(null);
  const [readConsent, setReadConsent] = useState(false);
  const [repeatConsent, setRepeatConsent] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [retryingPrepare, setRetryingPrepare] = useState(false);
  const projectId =
    review.data && review.data.scopeKey !== 'general' ? review.data.scopeKey.slice(8) : null;
  const chosen = selection ?? emptySelection(projectId);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Сохранённые варианты</p>
          <h1>
            {selected.data?.origin === 'codex_manual' ? 'Анализ проекта' : 'AI-анализ периода'}
          </h1>
          {review.data && (
            <p className="subtitle">
              {review.data.projectName ?? 'Общий обзор'} · {date(review.data.periodStart)} —{' '}
              {date(review.data.periodEnd)}
            </p>
          )}
        </div>
        {selected.data?.reviewId !== null && (
          <Link to={`/reviews?id=${reviewId}`}>Вернуться к своему обзору →</Link>
        )}
      </div>
      <p className="help">
        {selected.data?.origin === 'codex_manual'
          ? 'Готовый анализ Codex сохранён локально. Его чтение не требует API-ключа.'
          : 'Сначала выберите источники и подготовьте пакет. Отправка требует отдельного подтверждения.'}
      </p>
      <p>
        <Link to="/analysis">Анализы проектов →</Link> ·{' '}
        <Link to="/proposal-acceptances">Принятые предложения →</Link> ·{' '}
        <Link to="/analysis-schedules">Все расписания →</Link> ·{' '}
        <Link to="/timeline?kind=ai_analysis">Все AI-запуски →</Link>
      </p>
      {selected.data?.reviewId === null && (
        <p>Обзор удалён; сохранённый анализ остаётся доступен.</p>
      )}
      {[
        selected.data?.reviewId === null ? null : review.error,
        status.error,
        runs.error,
        selected.error,
      ]
        .filter(Boolean)
        .map((error, index) => (
          <p role="alert" key={index}>
            {error!.message}
          </p>
        ))}
      {(review.isPending || runs.isPending) && <p role="status">Загружаем обзор и варианты…</p>}
      {runId && !deletedIds.includes(runId) && selected.isPending && (
        <p role="status">Загружаем сохранённый анализ…</p>
      )}
      {runId && deletedIds.includes(runId) && (
        <p role="status">Локальная запись анализа удалена.</p>
      )}
      {selected.data &&
        !deletedIds.includes(selected.data.id) &&
        selected.data.reviewKey === reviewId && (
          <RunDetail
            key={selected.data.id}
            run={selected.data}
            status={status.data}
            onDeleted={() => setDeletedIds([...deletedIds, selected.data!.id])}
          />
        )}
      {review.data && (
        <form
          aria-label="Подготовка ручного анализа"
          className="panel form section-space period-source-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!readConsent) return;
            setRetryingPrepare(true);
            await act(async () => {
              const saved = await api<PeriodRun>('/period-analysis/prepare', 'POST', {
                reviewId,
                requestKey,
                selection: chosen,
                readConsent: true,
                repeatConsent,
              });
              client.setQueryData(['period-run', saved.id], saved);
              setRequestKey(crypto.randomUUID());
              setRetryingPrepare(false);
              setReadConsent(false);
              setRepeatConsent(false);
              setCursors([null]);
              await client.invalidateQueries({ queryKey: ['period-runs', reviewId] });
              const next = new URLSearchParams(params);
              next.set('run', saved.id);
              setParams(next);
            }, 'Точный пакет подготовлен. Отправка ещё не разрешена');
          }}
        >
          <h2>Подготовить новый пакет</h2>
          <SourceSelection
            value={chosen}
            onChange={setSelection}
            projects={w!.projects}
            projectId={projectId}
            disabled={busy}
          />
          <CodexChoices reviewId={reviewId} value={chosen} onChange={setSelection} />
          <label className="check">
            <input
              type="checkbox"
              checked={readConsent}
              onChange={(e) => setReadConsent(e.target.checked)}
            />
            Разрешаю прочитать выбранные источники и сохранить пакет локально
          </label>
          {!!runs.data?.items.length && (
            <label className="check">
              <input
                type="checkbox"
                checked={repeatConsent}
                onChange={(e) => setRepeatConsent(e.target.checked)}
              />
              Понимаю, что новый вариант — отдельный запрос; предыдущий мог быть оплачен даже при
              неизвестном результате
            </label>
          )}
          <div>
            <button
              className="primary"
              disabled={
                busy ||
                !readConsent ||
                (!!runs.data?.items.length && !repeatConsent && !retryingPrepare)
              }
            >
              Подготовить точный пакет
            </button>
          </div>
        </form>
      )}
      {review.data && <ScheduleForm review={review.data} status={status.data} />}
      {runs.data && (
        <section className="panel section-space" aria-label="История AI-анализов">
          <h2>История вариантов</h2>
          {runs.data.items.length === 0 && <p className="empty">Сохранённых запусков пока нет.</p>}
          {runs.data.items.map((run) => (
            <p key={run.id}>
              <Link to={`/period-analysis?review=${reviewId}&run=${run.id}`}>
                Вариант {run.generation} · {stateLabel[run.status]}
              </Link>{' '}
              <small>{new Date(run.createdAt).toLocaleString('ru')}</small>
            </p>
          ))}
          <div className="row">
            <button
              disabled={cursors.length === 1 || runs.isFetching}
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              Предыдущие варианты
            </button>
            <button
              disabled={!runs.data.nextCursor || runs.isFetching}
              onClick={() => setCursors([...cursors, runs.data!.nextCursor])}
            >
              Следующие варианты
            </button>
          </div>
        </section>
      )}
    </>
  );
}
export default function PeriodAnalysis() {
  const [params] = useSearchParams();
  const reviewId = params.get('review');
  if (!reviewId)
    return (
      <div className="panel">
        <p>Сначала откройте обзор недели или месяца.</p>
        <Link to="/reviews">Выбрать период →</Link>
      </div>
    );
  return <AnalysisPage key={reviewId} reviewId={reviewId} />;
}
