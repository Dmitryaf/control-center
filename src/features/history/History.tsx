import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HistoryPage, HistoryEvent } from '../../../shared/history';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { date } from '../../shared/labels';
import { utcRange } from './period';

const kinds = {
  '': 'Все источники',
  task: 'Результаты задач',
  check: 'Проверки',
  decision: 'Локальные решения',
  file_decision: 'Решения из файлов',
  observation: 'Наблюдения',
};
const events: Record<HistoryEvent, string> = {
  task_baseline: 'Запись при переходе',
  task_result: 'Результат сохранён',
  task_completed: 'Задача завершена',
  task_reopened: 'Возвращена в работу',
  check_started: 'Проверка начата',
  check_completed: 'Проверка завершена',
  check_action: 'Внешнее действие',
  check_evidence: 'Свидетельство',
  decision: 'Локальное решение',
  file_decision: 'Решение из файла',
  observation: 'Наблюдение',
};
export default function History() {
  const [params, setParams] = useSearchParams();
  const { data: workspace } = useWorkspace();
  const client = useQueryClient();
  const filterKey = params.toString();
  const today = new Date().toISOString().slice(0, 10);
  const includesToday =
    (!params.get('from') || params.get('from')! <= today) &&
    (!params.get('to') || params.get('to')! >= today);
  const [draft, setDraft] = useState({
    project: params.get('project') ?? '',
    kind: params.get('kind') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  });
  const [period, setPeriod] = useState(params.has('from') || params.has('to') ? 'custom' : 'all');
  useEffect(() => {
    setDraft({
      project: params.get('project') ?? '',
      kind: params.get('kind') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
    });
    setPeriod(params.has('from') || params.has('to') ? 'custom' : 'all');
  }, [params]);
  const [page, setPage] = useState<{ key: string; cursors: (string | null)[] }>({
    key: filterKey,
    cursors: [null],
  });
  const cursors = page.key === filterKey ? page.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: ['history', filterKey, cursor],
    retry: false,
    refetchInterval: cursor ? false : 5000,
    queryFn: ({ signal }) => {
      const queryParams = new URLSearchParams();
      if (params.get('project')) queryParams.set('projectId', params.get('project')!);
      for (const key of ['kind', 'from', 'to'])
        if (params.get(key)) queryParams.set(key, params.get(key)!);
      if (cursor) queryParams.set('cursor', cursor);
      return api<HistoryPage>(`/history?${queryParams}`, 'GET', undefined, signal);
    },
  });
  const fileCoverage = query.data?.files;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Проекты во времени</p>
          <h1>История</h1>
          <p className="subtitle">Результаты, внешние шаги и основания решений рядом.</p>
        </div>
        <div className="row">
          <Link
            className="button"
            to={`/observations${params.get('project') && params.get('project') !== '__unlinked__' ? `?project=${params.get('project')}` : ''}`}
          >
            Записать наблюдение
          </Link>
          <Link to="/history">История задач →</Link>
        </div>
      </div>
      <form
        className="toolbar history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const next = new URLSearchParams();
          for (const [key, value] of Object.entries(draft)) if (value) next.set(key, value);
          setPage({ key: next.toString(), cursors: [null] });
          setParams(next);
        }}
      >
        <label>
          История проекта
          <select
            value={draft.project}
            onChange={(event) => setDraft({ ...draft, project: event.target.value })}
          >
            <option value="">Все проекты и записи без связи</option>
            <option value="__unlinked__">Общие и отвязанные записи</option>
            {draft.project &&
              draft.project !== '__unlinked__' &&
              !workspace!.projects.some((project) => project.id === draft.project) && (
                <option value={draft.project}>Прежний или недоступный проект</option>
              )}
            {workspace!.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.metadata.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Источник
          <select
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
          >
            {Object.entries(kinds).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Период
          <select
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value);
              if (event.target.value !== 'custom')
                setDraft({ ...draft, ...utcRange(event.target.value) });
            }}
          >
            <option value="all">Все время</option>
            <option value="week">Текущая неделя (UTC)</option>
            <option value="previous_week">Прошлая неделя (UTC)</option>
            <option value="month">Текущий месяц (UTC)</option>
            <option value="previous_month">Прошлый месяц (UTC)</option>
            <option value="custom">Свой диапазон</option>
          </select>
        </label>
        <label>
          С даты (UTC)
          <input
            type="date"
            value={draft.from}
            onChange={(event) => {
              setPeriod('custom');
              setDraft({ ...draft, from: event.target.value });
            }}
          />
        </label>
        <label>
          По дату (UTC)
          <input
            type="date"
            min={draft.from || undefined}
            value={draft.to}
            onChange={(event) => {
              setPeriod('custom');
              setDraft({ ...draft, to: event.target.value });
            }}
          />
        </label>
        <button>Показать</button>
      </form>
      <p className="help section-space">
        Даты фильтра включают весь день по UTC; точное время записей показано по местному времени.
        {includesToday && ' Текущий день ещё не завершён.'} Указанные даты проверок и решений не
        содержат времени.
      </p>
      <details className="section-space history-coverage">
        <summary>Что входит в историю и чего она не сохраняет</summary>
        <p>
          История задач хранит отдельные снимки результатов. Проверки и решения показаны в текущей
          сохранённой редакции с указанной датой; прошлые изменения не восстановлены. Удаление таких
          источников убирает их из ленты. Решения из файлов читаются из последнего индекса, их
          тексты не копируются. История целей и статусов и обзоры периодов пока сюда не входят.
          Наблюдения показаны в текущей редакции, без архива правок.
        </p>
        <p>
          Общие и отвязанные записи видны вместе. Прежняя связь локального решения с удалённым
          проектом не восстанавливается. Записи и свидетельства сообщают сохранённые сведения, а не
          доказывают их истинность или авторство.
        </p>
        <p>
          Порядок записей с одним днём: сначала записи с известным временем, затем записи без
          времени. Между ними не предполагается причинной связи. Пока вы просматриваете страницы,
          источники могут измениться; для свежей выборки начните сначала.
        </p>
      </details>
      {(!params.get('kind') || params.get('kind') === 'file_decision') &&
        fileCoverage &&
        fileCoverage.undated + fileCoverage.unavailable + fileCoverage.notLoadedProjects > 0 && (
          <div
            className="message warning section-space"
            role="status"
            aria-label="Ограничения файловых источников"
          >
            <p>
              Файлов без известной даты: {fileCoverage.undated}. Недоступных источников:{' '}
              {fileCoverage.unavailable}. Проектов без прочитанного индекса:{' '}
              {fileCoverage.notLoadedProjects}.
            </p>
            <p>
              Они не представлены как датированные события. Обновите проекты кнопкой «Обновить»
              вверху страницы; подробности — в проектных решениях.
            </p>
          </div>
        )}
      <div className="row section-space">
        <button
          onClick={() => {
            setPage({ key: filterKey, cursors: [null] });
            void client.invalidateQueries({ queryKey: ['history'] });
          }}
          disabled={query.isFetching}
        >
          Обновить с начала
        </button>
        <span className="help">Страница {cursors.length}</span>
        {query.isFetching && !query.isPending && <span role="status">Обновляем историю…</span>}
      </div>
      {query.isPending && <p role="status">Загружаем историю…</p>}
      {query.error && (
        <div role="alert" aria-label="Единая история" className="message error section-space">
          {query.error.message}
          <button onClick={() => query.refetch()} disabled={query.isFetching}>
            Повторить
          </button>
        </div>
      )}
      <ol className="unified-history section-space">
        {query.data?.items.map((entry) => (
          <li className="history-record" key={entry.key} data-source={entry.kind}>
            <div className="history-date">
              <time dateTime={entry.recordedAt ?? entry.day}>
                {entry.recordedAt
                  ? new Date(entry.recordedAt).toLocaleString('ru')
                  : date(entry.day)}
              </time>
              <p className="help">
                {
                  {
                    recorded: 'Время записи',
                    baseline: 'Известное состояние при переходе',
                    declared: 'Указана дата, время неизвестно',
                  }[entry.dateQuality]
                }
              </p>
            </div>
            <article>
              <p className="section-label">{events[entry.event]}</p>
              <h2>
                <Link to={entry.href}>{entry.title}</Link>
              </h2>
              <p className="help">
                {entry.projectName ??
                  (entry.scopeProjectId
                    ? 'Прежний проект (название не сохранено)'
                    : 'Без связи с проектом')}
                {!entry.projectId && entry.projectName ? ' · связь с проектом снята' : ''}
              </p>
              {entry.excerpt && <p className="preserve">{entry.excerpt}</p>}
              {entry.truncated && (
                <p className="help">Показан фрагмент; полный текст — в источнике.</p>
              )}
              {entry.kind !== 'task' && (
                <p className="help">Текущая редакция источника, без архива правок.</p>
              )}
              <Link to={entry.href}>Открыть источник →</Link>
            </article>
          </li>
        ))}
      </ol>
      {query.data && !query.data.items.length && (
        <p className="empty">В доступных источниках за выбранный период записей нет.</p>
      )}
      <div className="row section-space">
        <button
          disabled={cursors.length === 1 || query.isFetching}
          onClick={() => setPage({ key: filterKey, cursors: cursors.slice(0, -1) })}
        >
          Назад
        </button>
        <button
          disabled={!query.data?.nextCursor || query.isFetching || !!query.error}
          onClick={() => setPage({ key: filterKey, cursors: [...cursors, query.data!.nextCursor] })}
        >
          Далее
        </button>
      </div>
    </>
  );
}
