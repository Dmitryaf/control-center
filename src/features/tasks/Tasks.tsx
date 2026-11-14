import { taskInProject, taskProjectIds } from '../../../shared/task-projects';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import type { Task, TaskInput, TaskHistoryPage } from '../../../shared/contracts';
import { priorityLabels } from '../../shared/labels';
import { api } from '../../shared/http';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { useQuery } from '@tanstack/react-query';
import { isTaskOpen, taskOutcome } from '../../../shared/task-status';

import { CornerDownLeft, ListFilter, Plus, SlidersHorizontal } from 'lucide-react';
import { NotebookHeading } from '../../shared/NotebookHeading';
import { TaskRow } from './TaskRow';
import { TaskDetails } from './TaskDetails';
import './tasks.css';

type Draft = Pick<TaskInput, 'title' | 'projectId' | 'projectIds' | 'priority' | 'description'>;
const taskDraft = (t: Task): Draft => ({
  title: t.title,
  projectId: t.projectId,
  projectIds: taskProjectIds(t).filter((id) => id !== t.projectId),
  priority: t.priority,
  description: t.description,
});
function ResultEditor({
  task,
  onClose,
  onDirty,
}: {
  task: Task;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { act, busy } = useActions();
  const {
    register,
    handleSubmit,
    getValues,
    formState: { isDirty },
  } = useForm({
    defaultValues: { summary: task.result?.summary ?? '' },
  });
  useEffect(() => {
    onDirty(isDirty);
    return () => onDirty(false);
  }, [isDirty, onDirty]);
  return (
    <form
      className="panel form section-space"
      aria-label={`Итог ${task.code}`}
      onSubmit={handleSubmit(async ({ summary }) => {
        const ok = await act(
          () =>
            api(`/tasks/${task.id}`, 'PUT', {
              ...task,
              result: { ...task.result, summary: summary.trim() },
            }),
          'Итог сохранён',
        );
        if (ok && getValues('summary') === summary) onClose();
      })}
    >
      <UnsavedChanges dirty={isDirty} />
      <h2>
        Итог {task.code} · {task.title}
      </h2>
      <label>
        Итог работы
        <textarea autoFocus required maxLength={10000} rows={3} {...register('summary')} />
      </label>
      <div className="row">
        <button className="primary" disabled={busy}>
          Сохранить итог
        </button>
        <button
          type="button"
          onClick={() => {
            if (!isDirty || confirm('Закрыть без сохранения итога?')) onClose();
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
export default function Tasks() {
  const [params] = useSearchParams();
  return <TaskWorkspace key={params.toString()} params={params} />;
}
function TaskWorkspace({ params }: { params: URLSearchParams }) {
  const { data: w, refetch } = useWorkspace();
  const { act, busy } = useActions();
  const [details, setDetails] = useState(false);
  const [filter, setFilter] = useState(params.get('project') || '');
  const [outcome, setOutcome] = useState<'open' | 'done' | 'cancelled'>('open');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Task | null>(null);
  const [resultTask, setResultTask] = useState<Task | null>(null);
  const [resultDirty, setResultDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const selected = w!.tasks.find((task) => task.id === selectedId);
  const panelTask = selected ?? editing ?? resultTask;
  useEffect(() => {
    if (selectedId && !resultTask) panelHeading.current?.focus();
  }, [selectedId, resultTask]);
  const requestKey = useRef(crypto.randomUUID());
  const empty = (project = filter): Draft => ({
    title: '',
    description: '',
    projectIds: [],
    projectId: project === '__general__' ? null : project || null,
    priority: 'normal',
  });
  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    setValue,
    watch,
    getValues,
    formState: { isDirty },
  } = useForm<Draft>({ defaultValues: empty() });
  const loadedIdentifier = useRef<string | null>(null);
  const currentTask = editing && w!.tasks.find((task) => task.id === editing.id);
  useEffect(() => {
    if (!isDirty && currentTask && currentTask.revision !== editing?.revision) {
      setEditing(currentTask);
      reset(taskDraft(currentTask));
    }
  }, [currentTask, editing?.revision, isDirty, reset]);
  function edit(t: Task) {
    setEditing(t);
    setDetails(true);
    reset(taskDraft(t));
    requestAnimationFrame(() => setFocus('title'));
  }
  function canDiscard() {
    return !(isDirty || resultDirty) || confirm('Отбросить несохранённые изменения?');
  }
  function openTask(t: Task, result = false) {
    if (!canDiscard()) return;
    clear();
    setResultTask(result ? t : null);
    setSelectedId(t.id);
  }
  function closePanel() {
    if (!canDiscard()) return;
    const id = selectedId;
    clear();
    setResultTask(null);
    setSelectedId(null);
    requestAnimationFrame(() =>
      (
        document.getElementById(`task-open-${id}`) ?? document.getElementById('task-list-heading')
      )?.focus(),
    );
  }
  useEffect(() => {
    const identifier = params.get('task');
    if (identifier === loadedIdentifier.current) return;
    const t = w!.tasks.find((t) => t.code === identifier || t.id === identifier);
    if (t) {
      setOutcome(taskOutcome(t));
      setSelectedId(t.id);
      loadedIdentifier.current = identifier;
    }
  });
  function clear(project = filter) {
    reset(empty(project));
    setEditing(null);
    setDetails(false);
    requestKey.current = crypto.randomUUID();
  }
  async function save(v: Draft) {
    const ok = await act(async () => {
      const input = {
        ...editing,
        ...v,
        projectId: v.projectId || null,
        projectIds: w!.storage.taskProjects
          ? [...new Set([...(v.projectId ? [v.projectId] : []), ...(v.projectIds ?? [])])]
          : undefined,
      };
      if (!editing) return api('/tasks', 'POST', { ...input, requestKey: requestKey.current });
      try {
        return await api(`/tasks/${editing.id}`, 'PUT', input);
      } catch (error) {
        await refetch();
        throw error;
      }
    }, 'Задача сохранена');
    if (!ok) return;
    if (!editing) requestKey.current = crypto.randomUUID();
    if (JSON.stringify(getValues()) !== JSON.stringify(v)) return;
    if (editing) {
      clear();
      requestAnimationFrame(() => panelHeading.current?.focus());
      return;
    }
    const nextFilter = v.projectId || v.projectIds?.[0] || '__general__';
    setSelectedId(null);
    setFilter(nextFilter);
    setOutcome('open');
    setSearch('');
    clear(nextFilter);
  }
  function update(t: Task, change: Partial<TaskInput>) {
    return act(() => api(`/tasks/${t.id}`, 'PUT', { ...t, ...change }), 'Задача обновлена');
  }
  async function removeTask(t: Task) {
    if (!canDiscard() || !confirm(`Удалить «${t.title}»?`)) return;
    const ok = await act(() => api(`/tasks/${t.id}`, 'DELETE'), 'Запись удалена');
    if (ok && selectedId === t.id) {
      clear();
      setResultTask(null);
      setSelectedId(null);
      requestAnimationFrame(() => document.getElementById('task-list-heading')?.focus());
    }
  }
  function finish(t: Task) {
    if (
      isTaskOpen(t) &&
      t.result?.remaining &&
      !confirm(
        `В последнем итоге оставалось:\n\n${t.result.remaining}\n\nВы выполнили эту работу и хотите завершить задачу? Прежний итог останется в истории.`,
      )
    )
      return;
    return !isTaskOpen(t)
      ? update(t, { completedAt: null, cancellation: null })
      : act(
          () =>
            api(`/tasks/${t.id}/complete`, 'POST', {
              revision: t.revision,
              result: t.result
                ? { ...t.result, remaining: '' }
                : {
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
        (!filter || taskInProject(t, filter === '__general__' ? null : filter)) &&
        taskOutcome(t) === outcome &&
        `${t.code} ${t.title} ${t.description}`
          .toLocaleLowerCase('ru')
          .includes(search.trim().toLocaleLowerCase('ru')),
    )
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        b.number - a.number,
    );
  const projects = w!.projects;
  const names = new Map(projects.map((p) => [p.id, p.metadata.name]));
  const groups = new Map<string | null, Task[]>();
  for (const task of items) {
    const groupId = filter && filter !== '__general__' ? filter : task.projectId;
    const group = groups.get(groupId);
    if (group) group.push(task);
    else groups.set(groupId, [task]);
  }
  const sortedGroups = [...groups].sort(([a], [b]) => {
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    return (names.get(a) ?? '').localeCompare(names.get(b) ?? '', 'ru');
  });
  function changeFilter(value: string) {
    setFilter(value);
    if (!editing && !isDirty) reset(empty(value));
  }
  const options = projects.map((p) => (
    <option key={p.id} value={p.id}>
      {p.metadata.name}
    </option>
  ));
  const draftProjectId = watch('projectId');
  const additionalProjectIds = watch('projectIds') ?? [];
  const composer = (
    <form
      className="task-composer"
      aria-label={editing ? 'Изменить задачу' : 'Новая задача'}
      onSubmit={handleSubmit(save)}
    >
      {editing && <h2>Изменить {editing.code}</h2>}
      <div className="task-entry">
        <Plus size={17} aria-hidden="true" />
        <input
          aria-label="Название задачи"
          required
          maxLength={240}
          autoFocus={params.get('new') === '1'}
          placeholder="Что нужно сделать?"
          {...register('title')}
        />
        {!editing && (
          <button
            type="button"
            className="task-icon"
            aria-label="Параметры задачи"
            title="Проект, приоритет и описание"
            aria-expanded={details}
            aria-controls="task-fields"
            onClick={() => setDetails(!details)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
        )}
        <button
          className="task-submit"
          disabled={busy}
          aria-label={editing ? 'Сохранить задачу' : 'Создать задачу'}
          title={editing ? 'Сохранить задачу' : 'Создать задачу'}
        >
          <CornerDownLeft size={15} aria-hidden="true" />
        </button>
      </div>
      {details ? (
        <div className="form-grid task-fields" id="task-fields">
          <label>
            Проект
            <select {...register('projectId')}>
              <option value="">Без проекта</option>
              {options}
            </select>
          </label>
          {w!.storage.taskProjects && (
            <fieldset className="task-project-options wide">
              <legend>Ещё проекты для этой задачи</legend>
              <p className="help">Один номер и результат для всех выбранных проектов.</p>
              {projects
                .filter((project) => project.id !== draftProjectId)
                .map((project) => (
                  <label className="checkbox" key={project.id}>
                    <input
                      type="checkbox"
                      checked={additionalProjectIds.includes(project.id)}
                      onChange={(event) =>
                        setValue(
                          'projectIds',
                          event.target.checked
                            ? [...additionalProjectIds, project.id]
                            : additionalProjectIds.filter((id) => id !== project.id),
                          { shouldDirty: true },
                        )
                      }
                    />
                    {project.metadata.name}
                  </label>
                ))}
            </fieldset>
          )}
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
          <label className="wide">
            Описание
            <textarea rows={3} maxLength={10000} {...register('description')} />
          </label>
          {editing && (
            <button
              type="button"
              onClick={() => {
                if (canDiscard()) {
                  clear();
                  requestAnimationFrame(() => panelHeading.current?.focus());
                }
              }}
            >
              Отмена
            </button>
          )}
        </div>
      ) : (
        (isDirty || (filter && filter !== '__general__')) && (
          <small className="task-destination">
            Новая задача · {draftProjectId ? names.get(draftProjectId) : 'Без проекта'}
          </small>
        )
      )}
    </form>
  );
  return (
    <div className="task-desk">
      <UnsavedChanges dirty={isDirty} />
      <NotebookHeading title="Задачи" />
      {!editing && !resultTask && <div className="task-create">{composer}</div>}
      <div className="task-filters">
        <select
          aria-label="Состояние задач"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
        >
          <option value="open">Открытые</option>
          <option value="done">Завершённые</option>
          <option value="cancelled">Отменённые</option>
        </select>
        <div>
          <label className="task-project-filter">
            <ListFilter size={16} aria-hidden="true" />
            <select
              aria-label="Показать проект"
              value={filter}
              onChange={(e) => changeFilter(e.target.value)}
            >
              <option value="">Все проекты</option>
              <option value="__general__">Без проекта</option>
              {options}
            </select>
          </label>
        </div>
      </div>
      <input
        className="task-search-input"
        type="search"
        aria-label="Поиск задач"
        placeholder="Номер, название или описание"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={`task-workspace${selectedId ? ' has-detail' : ''}`}>
        <section className="task-list-pane" aria-label="Список задач">
          <h2 id="task-list-heading" className="task-list-heading" tabIndex={-1}>
            Задачи <span className="count">{items.length}</span>
          </h2>
          {!items.length && (
            <p className="empty">
              {search
                ? 'По запросу задач не найдено.'
                : {
                    open: 'Открытых задач нет.',
                    done: 'Завершённых задач пока нет.',
                    cancelled: 'Отменённых задач пока нет.',
                  }[outcome]}
            </p>
          )}
          {sortedGroups.map(([projectId, tasks]) => (
            <div className="task-group" key={projectId ?? 'general'}>
              <div className="task-group-heading">
                <h2>
                  {projectId ? (
                    <Link to={`/projects/${projectId}`}>{names.get(projectId) ?? 'Проект'}</Link>
                  ) : (
                    'Без проекта'
                  )}
                </h2>
                <span className="count">{tasks.length}</span>
                <button
                  type="button"
                  className="task-icon"
                  aria-label={`Добавить задачу: ${projectId ? (names.get(projectId) ?? 'Проект') : 'Без проекта'}`}
                  onClick={() => {
                    if (!canDiscard()) return;
                    const next = projectId ?? '__general__';
                    setSelectedId(null);
                    setResultTask(null);
                    setFilter(next);
                    clear(next);
                    requestAnimationFrame(() => setFocus('title'));
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
              </div>
              {tasks.slice(0, filter || search.trim() ? undefined : 4).map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  projectNames={
                    taskProjectIds(t).length > 1
                      ? taskProjectIds(t)
                          .map((id) => names.get(id) ?? 'Проект')
                          .join(' · ')
                      : undefined
                  }
                  selected={selectedId === t.id}
                  busy={busy}
                  resultOpen={!!resultTask}
                  onEdit={() => openTask(t)}
                  onResult={() => openTask(t, true)}
                  onFinish={() => void finish(t)}
                  onDelete={() => void removeTask(t)}
                />
              ))}
              {!filter && !search.trim() && tasks.length > 4 && (
                <button
                  className="task-show-all"
                  type="button"
                  onClick={() => changeFilter(projectId ?? '__general__')}
                >
                  Все задачи проекта ({tasks.length}) →
                </button>
              )}
            </div>
          ))}
        </section>
        {selectedId && (
          <aside
            id="task-detail-panel"
            className="task-detail-panel"
            aria-label="Подробности задачи"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                closePanel();
              }
            }}
          >
            <button type="button" className="task-panel-back" onClick={closePanel}>
              ← К списку задач
            </button>
            {panelTask ? (
              <>
                <p className="task-panel-meta">
                  {panelTask.code} ·{' '}
                  {taskProjectIds(panelTask)
                    .map((id) => names.get(id) ?? 'Проект')
                    .join(' · ') || 'Без проекта'}
                </p>
                <h2 ref={panelHeading} tabIndex={-1}>
                  {panelTask.title}
                </h2>
                {taskProjectIds(panelTask).length > 1 && (
                  <p className="help">
                    Это одна задача. Изменения, итог и завершение действуют во всех связанных
                    проектах.
                  </p>
                )}
                {!selected && (
                  <p role="status">Задача удалена другим клиентом. Показан открытый черновик.</p>
                )}
                {editing ? (
                  composer
                ) : resultTask ? (
                  <ResultEditor
                    key={resultTask.id}
                    task={resultTask}
                    onDirty={setResultDirty}
                    onClose={() => {
                      setResultTask(null);
                      requestAnimationFrame(() => panelHeading.current?.focus());
                    }}
                  />
                ) : (
                  <>
                    <div className="row task-panel-actions">
                      <button
                        type="button"
                        onClick={() => {
                          if (canDiscard()) {
                            clear();
                            edit(panelTask);
                          }
                        }}
                      >
                        Изменить задачу
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (canDiscard()) {
                            clear();
                            setResultTask(panelTask);
                          }
                        }}
                      >
                        {panelTask.result ? 'Изменить итог' : 'Добавить итог'}
                      </button>
                      <button type="button" disabled={busy} onClick={() => void finish(panelTask)}>
                        {isTaskOpen(panelTask) ? 'Завершить' : 'Вернуть'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeTask(panelTask)}
                      >
                        Удалить
                      </button>
                    </div>
                    <TaskDetails task={panelTask} proposalId={w!.proposalLinks?.[panelTask.id]} />
                  </>
                )}
              </>
            ) : (
              <h2 ref={panelHeading} tabIndex={-1}>
                Задача больше недоступна
              </h2>
            )}
          </aside>
        )}
      </div>
      <Link className="task-history-link" to={filter ? `/history?project=${filter}` : '/history'}>
        История работы →
      </Link>
    </div>
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
    cancelled: 'Задача отменена',
    reopened: 'Возвращена в работу',
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>История работы</h1>
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
              {e.projects?.length
                ? e.projects
                    .map(
                      (project) =>
                        project.name + (project.exists ? '' : ' · Проект удалён из списка'),
                    )
                    .join('; ')
                : (e.projectName ?? 'Общая задача')}
              {!e.projects && e.projectName && !e.projectId ? ' · Проект удалён из списка' : ''}
            </p>
            {e.kind === 'baseline' && (
              <p className="help">
                Это известное состояние при переходе. Более ранняя история недоступна; время записи
                взято из последнего сохранения задачи.
              </p>
            )}
            {e.task.cancellation && (
              <p>
                Отменена при закрытии проекта.{' '}
                <Link to={`/project-lifecycle/${e.task.cancellation.projectEventId}`}>
                  Причина закрытия →
                </Link>
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
      {query.data?.total === 0 && <p className="empty">За этот период записей нет.</p>}
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
