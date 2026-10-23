import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalysisSchedule } from '../../../shared/analysis-schedules';
import type { AnalysisStatus } from '../../../shared/analysis';
import type { Review } from '../../../shared/reviews';
import type { CodexGrant } from '../../../shared/codex-context';
import { useActions, useWorkspace } from '../../shared/workspace';
import { api } from '../../shared/http';
import { SourceSelection, emptySelection } from './SourceSelection';

function ScheduleCard({ value }: { value: AnalysisSchedule }) {
  const { act, busy } = useActions();
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['analysis-schedules'] });
  return (
    <section className="panel section-space">
      <h3>
        {value.projectName ?? (value.scopeKey === 'general' ? 'Общий обзор' : 'Удалённый проект')} ·{' '}
        {value.kind === 'week' ? 'Неделя' : 'Месяц'}
      </h3>
      <p>
        {value.enabled ? 'Включено' : 'Отключено'} · {value.model} · {value.timezone}
      </p>
      <p>
        Следующий период начинается {value.nextPeriodStart}. {value.note}
      </p>
      <details>
        <summary>Разрешённые источники</summary>
        <pre className="analysis-packet">{JSON.stringify(value.selection, null, 2)}</pre>
        <p>
          Новые диалоги Codex:{' '}
          {value.codexProjectIds?.length
            ? `${value.codexProjectIds.length} выбранных проектов, до двух диалогов каждого за период`
            : 'не разрешены'}
          .
        </p>
      </details>
      {value.lastRunId && value.lastRunReviewKey && (
        <p>
          <Link to={`/period-analysis?review=${value.lastRunReviewKey}&run=${value.lastRunId}`}>
            Последний сохранённый запуск →
          </Link>
        </p>
      )}
      <div className="row">
        {!value.enabled && (
          <button
            disabled={busy}
            onClick={() => {
              if (
                !confirm(
                  'Продолжить с текущего периода, сохранив выбранные источники, разрешённые категории Codex, модель и лимиты оплаты? Пропуски и запросы с неизвестным исходом повторяться не будут.',
                )
              )
                return;
              void act(async () => {
                await api(`/analysis-schedules/${value.id}/resume`, 'POST', {
                  revision: value.revision,
                  confirm: true,
                });
                await refresh();
              }, 'Расписание продолжено с текущего периода');
            }}
          >
            Продолжить без повторов
          </button>
        )}
        <button
          disabled={busy || !value.enabled}
          onClick={() =>
            void act(async () => {
              await api(`/analysis-schedules/${value.id}/disable`, 'POST', {
                revision: value.revision,
              });
              await refresh();
            }, 'Расписание отключено')
          }
        >
          Отключить
        </button>
        <button
          disabled={busy}
          onClick={() => {
            if (
              !confirm(
                'Удалить расписание? Сохранённые анализы останутся. Уже отправленный запрос нельзя отозвать гарантированно.',
              )
            )
              return;
            void act(async () => {
              await api(`/analysis-schedules/${value.id}`, 'DELETE', { revision: value.revision });
              await refresh();
            }, 'Расписание удалено');
          }}
        >
          Удалить расписание
        </button>
      </div>
    </section>
  );
}
export function ScheduleForm({
  review,
  status,
}: {
  review: Review;
  status: AnalysisStatus | undefined;
}) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const client = useQueryClient();
  const [selection, setSelection] = useState(
    emptySelection(review.scopeKey === 'general' ? null : review.scopeKey.slice(8)),
  );
  const [read, setRead] = useState(false),
    [send, setSend] = useState(false);
  const [codexProjects, setCodexProjects] = useState<string[]>([]);
  const [codexRead, setCodexRead] = useState(false),
    [codexSend, setCodexSend] = useState(false);
  const grants = useQuery({
    queryKey: ['codex-grants', [...selection.projectIds].sort().join(',')],
    queryFn: ({ signal }) =>
      Promise.all(
        selection.projectIds.map((id) =>
          api<CodexGrant>(`/projects/${id}/codex-context`, 'GET', undefined, signal),
        ),
      ),
    enabled: selection.projectIds.length > 0,
    retry: false,
    refetchInterval: 5000,
  });
  const current = useQuery({
    queryKey: ['analysis-schedules', review.id],
    queryFn: ({ signal }) =>
      api<AnalysisSchedule | null>(`/reviews/${review.id}/schedule`, 'GET', undefined, signal),
    refetchInterval: 5000,
  });
  return (
    <details className="section-space period-source-form">
      <summary>Автоматический анализ завершённых периодов</summary>
      <p>
        По умолчанию выключено. После включения первый запрос возможен только по завершении текущей{' '}
        {review.kind === 'week' ? 'недели' : 'месяца'} в зоне {review.timezone}. Весь этот период
        может включать записи до включения.
      </p>
      <p>
        Выбранные сведения будут отправляться в OpenAI без просмотра каждого пакета, с возможной
        оплатой: модель {status?.model ?? 'не настроена'}, до {status?.maxInputBytes ?? 80000} байт
        входа и {status?.maxOutputTokens ?? 3000} выходных tokens. Пропуски не догоняются,
        техническая ошибка не отменяет будущие выпуски. Неизвестный исход запроса или изменение
        доступа останавливают отправки до подтверждения. Сервер должен работать.
      </p>
      {current.error && <p role="alert">{current.error.message}</p>}
      {current.data && <ScheduleCard value={current.data} />}
      <form
        className="panel form"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !read ||
            !send ||
            !status?.model ||
            (codexProjects.length && (!codexRead || !codexSend))
          )
            return;
          void act(async () => {
            await api('/analysis-schedules', 'POST', {
              reviewId: review.id,
              revision: current.data?.revision ?? null,
              selection,
              expectedModel: status.model,
              readConsent: true,
              sendConsent: true,
              codexProjectIds: codexProjects,
              ...(codexProjects.length ? { codexReadConsent: true, codexSendConsent: true } : {}),
            });
            setRead(false);
            setSend(false);
            setCodexRead(false);
            setCodexSend(false);
            await client.invalidateQueries({ queryKey: ['analysis-schedules'] });
          }, 'Расписание включено с текущего периода');
        }}
      >
        <SourceSelection
          value={selection}
          onChange={(value) => {
            setSelection(value);
            setRead(false);
            setSend(false);
            setCodexProjects(codexProjects.filter((id) => value.projectIds.includes(id)));
            setCodexRead(false);
            setCodexSend(false);
          }}
          projects={w!.projects}
          projectId={review.scopeKey === 'general' ? null : review.scopeKey.slice(8)}
        />
        <fieldset>
          <legend>Новые диалоги Codex в регулярных обзорах</legend>
          <p>
            По умолчанию выключено. До двух содержательных диалогов каждого отмеченного проекта:
            короткие сообщения пользователя и заявления ассистента за период, без инструментов.
            Недоступный Codex будет указан как ограничение. Отзыв разрешения остановит следующие
            отправки.
          </p>
          {w!.projects
            .filter((project) => selection.projectIds.includes(project.id))
            .map((project) => {
              const enabled = grants.data?.find((grant) => grant.projectId === project.id)?.enabled;
              return (
                <div key={project.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      disabled={!enabled}
                      checked={codexProjects.includes(project.id)}
                      onChange={(event) => {
                        setCodexProjects(
                          event.target.checked
                            ? [...codexProjects, project.id]
                            : codexProjects.filter((id) => id !== project.id),
                        );
                        setCodexRead(false);
                        setCodexSend(false);
                        setRead(false);
                        setSend(false);
                      }}
                    />
                    {project.metadata.name}
                  </label>
                  {!enabled && (
                    <Link to={`/codex-context?review=${review.id}&project=${project.id}`}>
                      Разрешить чтение этого проекта →
                    </Link>
                  )}
                </div>
              );
            })}
          {grants.error && <p role="alert">Не удалось проверить разрешения Codex.</p>}
          {codexProjects.length > 0 && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={codexRead}
                  onChange={(event) => setCodexRead(event.target.checked)}
                />
                Разрешаю автоматически читать и сохранять ограниченные выдержки новых диалогов
                отмеченных проектов для будущих периодов
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={codexSend}
                  onChange={(event) => setCodexSend(event.target.checked)}
                />
                Разрешаю отправлять эти новые выдержки пользователя и ассистента в OpenAI без
                просмотра каждого пакета, в указанных лимитах оплаты
              </label>
            </>
          )}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
          Разрешаю читать и сохранять выбранные источники для каждого нового периода
        </label>
        <label className="check">
          <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
          Разрешаю автоматическую отправку выбранных сведений в OpenAI с указанной моделью и
          лимитами, с возможной оплатой
        </label>
        <div>
          <button
            className="primary"
            disabled={
              busy ||
              current.isPending ||
              !!current.error ||
              !read ||
              !send ||
              !status?.ready ||
              (codexProjects.length > 0 && (!codexRead || !codexSend || !!grants.error))
            }
          >
            Включить с текущего периода
          </button>
        </div>
      </form>
    </details>
  );
}
export default function Schedules() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: ['analysis-schedules', 'list', cursor],
    queryFn: ({ signal }) =>
      api<{ items: AnalysisSchedule[]; nextCursor: string | null }>(
        `/analysis-schedules${cursor ? `?cursor=${cursor}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 5000,
  });
  return (
    <>
      <h1>Расписания AI-анализа</h1>
      <p>
        Создайте или включите расписание внутри <Link to="/reviews">обзора недели или месяца</Link>.
        Новые проекты и виды источников требуют нового выбора.
      </p>
      <Link to="/timeline?kind=ai_analysis">Все сохранённые запуски →</Link>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isPending && <p role="status">Загружаем расписания…</p>}
      {query.data?.items.length === 0 && <p>Расписаний нет. Автоматическая отправка выключена.</p>}
      {query.data?.items.map((value) => (
        <ScheduleCard key={value.id} value={value} />
      ))}
      <div className="row">
        <button
          disabled={cursors.length === 1 || query.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Предыдущие
        </button>
        <button
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => setCursors([...cursors, query.data!.nextCursor])}
        >
          Следующие
        </button>
      </div>
    </>
  );
}
