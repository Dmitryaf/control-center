import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import type { Task, TaskInput, TaskHistoryPage } from '../../../shared/contracts';
import { priorityLabels, lines, date } from '../../shared/labels';
import { api } from '../../shared/http';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { useQuery } from '@tanstack/react-query';

type Draft = TaskInput & {
  linksText: string;
  summary: string;
  verified: string;
  unverified: string;
  remaining: string;
};
export default function Tasks() {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(params.get('project') || '');
  const [done, setDone] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ id: string; revision: number } | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const empty = (): Draft => ({
    title: '',
    description: '',
    expectedResult: '',
    acceptance: '',
    links: [],
    result: null,
    projectId: filter === '__general__' ? null : filter || null,
    priority: 'normal',
    completedAt: null,
    linksText: '',
    summary: '',
    verified: '',
    unverified: '',
    remaining: '',
  });
  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    getValues,
    formState: { isDirty },
  } = useForm<Draft>({ defaultValues: empty() });
  const loadedIdentifier = useRef<string | null>(null);
  function edit(t: Task) {
    setEditing({ id: t.id, revision: t.revision });
    reset({
      ...t,
      linksText: t.links.join('\n'),
      summary: t.result?.summary ?? '',
      verified: t.result?.verified ?? '',
      unverified: t.result?.unverified ?? '',
      remaining: t.result?.remaining ?? '',
    });
    requestAnimationFrame(() => setFocus('title'));
    window.scrollTo({ top: 0 });
  }
  useEffect(() => {
    const identifier = params.get('task');
    if (identifier === loadedIdentifier.current) return;
    const t = w!.tasks.find((t) => t.code === identifier || t.id === identifier);
    if (t) {
      setDone(!!t.completedAt);
      edit(t);
      loadedIdentifier.current = identifier;
    }
  });
  function clear() {
    reset(empty());
    setEditing(null);
    requestKey.current = crypto.randomUUID();
  }
  async function save(v: Draft) {
    const { linksText, summary, verified, unverified, remaining, ...task } = v;
    const ok = await act(
      () =>
        api(editing ? `/tasks/${editing.id}` : '/tasks', editing ? 'PUT' : 'POST', {
          ...task,
          projectId: task.projectId || null,
          links: lines(linksText),
          result: summary.trim() ? { summary, verified, unverified, remaining } : null,
          ...(editing ? { revision: editing.revision } : { requestKey: requestKey.current }),
        }),
      'Задача сохранена',
    );
    if (ok && JSON.stringify(getValues()) === JSON.stringify(v)) clear();
  }
  function update(t: Task, change: Partial<TaskInput>) {
    return act(() => api(`/tasks/${t.id}`, 'PUT', { ...t, ...change }), 'Задача обновлена');
  }
  function finish(t: Task) {
    return t.completedAt
      ? update(t, { completedAt: null })
      : act(
          () =>
            api(`/tasks/${t.id}/complete`, 'POST', {
              revision: t.revision,
              result: t.result ?? {
                summary: 'Владелец отметил задачу выполненной.',
                verified: '',
                unverified: 'Сведения о проверках не указаны.',
                remaining: '',
              },
            }),
          'Задача обновлена',
        );
  }
  const items = w!.tasks
    .filter(
      (t) =>
        (!filter || (filter === '__general__' ? !t.projectId : t.projectId === filter)) &&
        !!t.completedAt === done &&
        `${t.code} ${t.title} ${t.description}`
          .toLocaleLowerCase('ru')
          .includes(search.toLocaleLowerCase('ru')),
    )
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        b.number - a.number,
    );
  const textarea = (key: keyof Draft, label: string) => (
    <label className="wide" key={key}>
      {label}
      <textarea rows={2} maxLength={10000} {...register(key)} />
    </label>
  );
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <div className="page-heading">
        <div>
          <p className="section-label">План работы</p>
          <h1>Задачи</h1>
          <p className="subtitle">
            Все задачи в одном месте. Передайте Codex номер CC-N, чтобы начать работу.
          </p>
        </div>
        <Link className="button" to={filter ? `/history?project=${filter}` : '/history'}>
          История работы →
        </Link>
      </div>
      <form className="panel form" onSubmit={handleSubmit(save)}>
        <h2>{editing ? 'Изменить задачу' : 'Новая задача'}</h2>
        <div className="form-grid">
          <label className="wide">
            Название задачи
            <input
              required
              maxLength={240}
              placeholder="Что нужно сделать?"
              {...register('title')}
            />
          </label>
          <label>
            Проект
            <select {...register('projectId')}>
              <option value="">Без проекта</option>
              {w!.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.metadata.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Приоритет
            <select {...register('priority')}>
              {Object.entries(priorityLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {textarea('description', 'Описание')}
        </div>
        <details className="task-details">
          <summary>Условия и результат работы</summary>
          <div className="form-grid">
            {textarea('expectedResult', 'Ожидаемый результат')}
            {textarea('acceptance', 'Условия завершения')}
            {textarea('linksText', 'Ссылки и номера решений, по одной в строке')}
            {textarea('summary', 'Что сделано')}
            {textarea('verified', 'Что проверено')}
            {textarea('unverified', 'Что не удалось проверить')}
            {textarea('remaining', 'Что осталось')}
          </div>
        </details>
        <div className="row">
          <button className="primary" disabled={busy}>
            {editing ? 'Сохранить задачу' : 'Создать задачу'}
          </button>
          {editing && (
            <button type="button" onClick={clear}>
              Отмена
            </button>
          )}
        </div>
      </form>
      <div className="toolbar section-space">
        <label>
          Показать проект
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Все проекты и общие задачи</option>
            <option value="__general__">Только общие задачи</option>
            {w!.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.metadata.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Поиск задач
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />{' '}
          Завершённые
        </label>
      </div>
      <section className="task-list section-space" aria-label="Список задач">
        <h2>
          {done ? 'Завершённые задачи' : 'Открытые задачи'}{' '}
          <span className="count">{items.length}</span>
        </h2>
        {!items.length && (
          <p className="empty">
            {search
              ? 'По запросу задач не найдено.'
              : done
                ? 'Завершённых задач пока нет.'
                : 'Открытых задач нет.'}
          </p>
        )}
        {items.map((t) => (
          <article className="panel task-card" key={t.id}>
            <div className="row between">
              <code>{t.code}</code>
              {t.projectId ? (
                <Link to={`/projects/${t.projectId}`}>
                  {w!.projects.find((p) => p.id === t.projectId)?.metadata.name}
                </Link>
              ) : (
                <span>Вся экосистема</span>
              )}
              <span className="priority">{priorityLabels[t.priority]}</span>
            </div>
            <h3>{t.title}</h3>
            {w!.proposalLinks?.[t.id] && (
              <p>
                <Link to={`/proposal-acceptances?id=${w!.proposalLinks[t.id]}`}>
                  Основания принятого предложения →
                </Link>
              </p>
            )}
            <p className="preserve">{t.description}</p>
            {(t.expectedResult || t.acceptance || t.links.length > 0 || t.result) && (
              <details className="task-details">
                <summary>Условия и результат</summary>
                {t.expectedResult && (
                  <p className="preserve">
                    <strong>Ожидаемый результат:</strong> {t.expectedResult}
                  </p>
                )}
                {t.acceptance && (
                  <p className="preserve">
                    <strong>Условия завершения:</strong> {t.acceptance}
                  </p>
                )}
                {t.links.map((v, i) => (
                  <p key={i} className="preserve">
                    {v}
                  </p>
                ))}
                {t.result && (
                  <>
                    <p className="preserve">
                      <strong>Что сделано:</strong> {t.result.summary}
                    </p>
                    <p className="preserve">
                      <strong>Проверено:</strong> {t.result.verified || 'Не указано'}
                    </p>
                    <p className="preserve">
                      <strong>Не проверено:</strong> {t.result.unverified || 'Не указано'}
                    </p>
                    {t.result.remaining && (
                      <p className="preserve">
                        <strong>Осталось:</strong> {t.result.remaining}
                      </p>
                    )}
                  </>
                )}
              </details>
            )}
            {t.completedAt && <small>Завершена: {date(t.completedAt)}</small>}
            <div className="row">
              <button disabled={busy} onClick={() => finish(t)}>
                {t.completedAt ? 'Вернуть' : 'Завершить'}
              </button>
              <button onClick={() => edit(t)}>Изменить</button>
              <Link to={`/history?task=${t.code}`}>История</Link>
              <button
                disabled={busy}
                onClick={() => {
                  if (confirm(`Удалить «${t.title}»?`))
                    void act(() => api(`/tasks/${t.id}`, 'DELETE'), 'Запись удалена');
                }}
              >
                Удалить
              </button>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

export function TaskHistory() {
  const [params] = useSearchParams();
  const { data: w } = useWorkspace();
  const [project, setProject] = useState(params.get('project') ?? '');
  const [identifier, setIdentifier] = useState(params.get('task') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [offset, setOffset] = useState(0);
  const [applied, setApplied] = useState({ projectId: project, identifier, from, to });
  const query = useQuery({
    queryKey: ['task-history', applied, offset],
    refetchInterval: 5000,
    queryFn: ({ signal }) => {
      const q = new URLSearchParams(Object.entries(applied).filter(([, v]) => !!v));
      q.set('offset', String(offset));
      q.set('limit', '50');
      return api<TaskHistoryPage>('/task-history?' + q, 'GET', undefined, signal);
    },
    retry: false,
  });
  const labels = {
    baseline: 'Сохранённая запись при переходе',
    result: 'Результат сохранён',
    completed: 'Задача завершена',
    reopened: 'Возвращена в работу',
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Результаты работы</p>
          <h1>История работы</h1>
          <p className="subtitle">
            Прежние результаты сохраняются при изменении, возврате и удалении задачи.
          </p>
        </div>
        <Link className="button" to="/tasks">
          К задачам →
        </Link>
      </div>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setApplied({ projectId: project, identifier: identifier.trim(), from, to });
        }}
      >
        <label>
          История проекта
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Все проекты и общие задачи</option>
            <option value="__general__">Только общие задачи</option>
            {w!.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.metadata.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Номер задачи
          <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <label>
          С даты (UTC)
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          По дату (UTC)
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button disabled={query.isFetching}>Показать</button>
      </form>
      <p className="help section-space">
        Даты фильтра включают весь день по UTC. Время записей показано по местному времени. Сведения
        о проверках сохранены со слов пользователя или агента.
      </p>
      {query.error && (
        <div role="alert" className="message error" aria-label="История работы">
          {query.error.message}
          <button onClick={() => query.refetch()}>Повторить</button>
        </div>
      )}
      <p role="status">
        {query.isFetching ? 'Загружаем историю…' : `Записей: ${query.data?.total ?? 0}`}
      </p>
      <ol className="history-list">
        {query.data?.items.map((e) => (
          <li key={e.id} className="panel history-entry">
            <div className="row between">
              <strong>{labels[e.kind]}</strong>
              <time dateTime={e.recordedAt}>{new Date(e.recordedAt).toLocaleString('ru')}</time>
            </div>
            <h2>
              {e.task.code} · {e.task.title}
            </h2>
            <p className="muted">
              {e.projectName ?? 'Общая задача'}
              {e.projectName && !e.projectId ? ' · Проект удалён из списка' : ''}
            </p>
            {e.kind === 'baseline' && (
              <p className="help">
                Это известное состояние при переходе. Более ранняя история недоступна; время записи
                взято из последнего сохранения задачи.
              </p>
            )}
            {e.task.result ? (
              <>
                <p className="preserve">
                  <strong>Что сделано:</strong> {e.task.result.summary}
                </p>
                <p className="preserve">
                  <strong>Проверено:</strong> {e.task.result.verified || 'Не указано'}
                </p>
                <p className="preserve">
                  <strong>Не проверено:</strong> {e.task.result.unverified || 'Не указано'}
                </p>
                {e.task.result.remaining && <p>Осталось: {e.task.result.remaining}</p>}
              </>
            ) : (
              <p>Результат не указан.</p>
            )}
            {e.taskExists ? (
              <Link to={`/tasks?task=${e.task.code}`}>Открыть текущую задачу →</Link>
            ) : (
              <p>Задача удалена. Сохранённый результат доступен в истории.</p>
            )}
          </li>
        ))}
      </ol>
      {query.data?.total === 0 && (
        <p className="empty">
          За этот период записей нет. Результаты появятся после сохранения или завершения задачи.
        </p>
      )}
      <div className="row section-space">
        <button disabled={!offset || query.isFetching} onClick={() => setOffset(offset - 50)}>
          Назад
        </button>
        <button
          disabled={!query.data || offset + 50 >= query.data.total || query.isFetching}
          onClick={() => setOffset(offset + 50)}
        >
          Далее
        </button>
      </div>
    </>
  );
}
