import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { observationFieldsSchema, type Observation } from '../../../shared/observations';
import { calendarDate } from '../../../shared/time';
import { useWorkspace, useActions } from '../../shared/workspace';
import { api } from '../../shared/http';
import { UnsavedChanges } from '../../shared/UnsavedChanges';

type Fields = { body: string; occurredOn: string; project: string };
const fields = (initial?: Observation, project?: string | null): Fields => ({
  body: initial?.body ?? '',
  occurredOn: initial?.occurredOn ?? calendarDate(),
  project: initial
    ? (initial.projectId ?? (initial.scopeProjectId ? '__retained__' : ''))
    : (project ?? ''),
});
function Editor({
  initial,
  project,
  onDeleted,
}: {
  initial?: Observation;
  project: string | null;
  onDeleted: () => void;
}) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const client = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { isDirty, isSubmitting },
  } = useForm<Fields>({ defaultValues: fields(initial, project) });
  const [revision, setRevision] = useState(initial?.revision);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [lastSaved, setLastSaved] = useState('');
  const [validation, setValidation] = useState('');
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (initial && !isDirty) {
      reset(fields(initial));
      setRevision(initial.revision);
    }
  }, [initial, isDirty, reset]);
  async function save(values: Fields) {
    const parsed = observationFieldsSchema.safeParse({
      body: values.body,
      occurredOn: values.occurredOn,
      projectId: values.project === '__retained__' ? null : values.project || null,
    });
    if (!parsed.success) {
      setValidation('Заполните текст, корректную дату и выберите проект из списка.');
      return;
    }
    setValidation('');
    let saved: Observation | undefined;
    const payload = {
      body: parsed.data.body,
      occurredOn: parsed.data.occurredOn,
      ...(values.project === '__retained__' && initial ? {} : { projectId: parsed.data.projectId }),
    };
    const ok = await act(async () => {
      saved = initial
        ? await api<Observation>(`/observations/${initial.id}`, 'PATCH', { ...payload, revision })
        : await api<Observation>('/observations', 'POST', { ...payload, requestKey });
      await client.invalidateQueries({ queryKey: ['observation', saved.id] });
      await client.invalidateQueries({ queryKey: ['history'] });
    }, 'Наблюдение сохранено');
    if (!ok || !saved) return;
    setLastSaved(saved.id);
    setRevision(saved.revision);
    if (!initial) setRequestKey(crypto.randomUUID());
    if (JSON.stringify(getValues()) === JSON.stringify(values))
      reset(initial ? fields(saved) : fields(undefined, project));
    else
      setValidation('Запись сохранена. Изменённый во время сохранения текст остаётся в черновике.');
  }
  async function reload() {
    if (!initial || (isDirty && !confirm('Заменить черновик сохранённой записью?'))) return;
    await act(async () => {
      await client.cancelQueries({ queryKey: ['observation', initial.id], exact: true });
      const saved = await client.fetchQuery({
        queryKey: ['observation', initial.id],
        queryFn: ({ signal }) =>
          api<Observation>(`/observations/${initial.id}`, 'GET', undefined, signal),
        staleTime: 0,
      });
      reset(fields(saved));
      setRevision(saved.revision);
      setValidation('');
    }, 'Сохранённая запись загружена');
  }
  async function remove() {
    if (
      !initial ||
      !confirm('Удалить наблюдение? Его текст и несохранённый черновик будут удалены.')
    )
      return;
    setDeleting(true);
    const ok = await act(async () => {
      await api(`/observations/${initial.id}`, 'DELETE', { revision });
      await client.invalidateQueries({ queryKey: ['history'] });
    }, 'Наблюдение удалено');
    setDeleting(false);
    if (ok) {
      onDeleted();
      client.removeQueries({ queryKey: ['observation', initial.id], exact: true });
    }
  }
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <form className="form observation-editor" onSubmit={handleSubmit(save)}>
        <fieldset disabled={deleting}>
          <div className="form-grid">
            <label>
              Дата наблюдения
              <input type="date" required {...register('occurredOn')} />
            </label>
            <label>
              Проект наблюдения
              <select {...register('project')}>
                <option value="">Общее наблюдение</option>
                {initial?.scopeProjectId && !initial.projectId && (
                  <option value="__retained__">
                    Прежний проект: {initial.projectName ?? 'название не сохранено'}
                  </option>
                )}
                {project && !initial && !w!.projects.some((p) => p.id === project) && (
                  <option value={project}>Выбранный проект недоступен</option>
                )}
                {w!.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.metadata.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Текст наблюдения
            <textarea required rows={8} maxLength={20000} {...register('body')} />
          </label>
          <p className="help">
            Мысль, факт или препятствие. Запись остаётся в локальной базе и её резервных копиях; в
            файлы проекта не переносится. Предыдущие редакции текста не сохраняются.
          </p>
          {initial?.scopeProjectId && !initial.projectId && (
            <p className="help">
              Живая связь с проектом снята; прежнее название и принадлежность сохранятся, пока вы
              явно не выберете другой проект или общую запись.
            </p>
          )}
          {validation && <p role="status">{validation}</p>}
          <div className="row section-space">
            <button className="primary" disabled={busy || isSubmitting}>
              {initial ? 'Сохранить изменения' : 'Сохранить наблюдение'}
            </button>
            {initial && (
              <>
                <button type="button" disabled={busy} onClick={reload}>
                  Загрузить сохранённую запись
                </button>
                <button type="button" disabled={busy} onClick={remove}>
                  Удалить наблюдение
                </button>
              </>
            )}
          </div>
        </fieldset>
      </form>
      {lastSaved && (
        <p className="section-space">
          <Link to={`/observations?id=${lastSaved}`}>Открыть сохранённую запись →</Link>
        </p>
      )}
    </>
  );
}
export default function Observations() {
  const [params] = useSearchParams();
  const id = params.get('id');
  const project = params.get('project');
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['observation', id],
    enabled: !!id && id !== deletedId,
    retry: false,
    refetchInterval: id && id !== deletedId ? 5000 : false,
    queryFn: ({ signal }) =>
      api<Observation>(`/observations/${encodeURIComponent(id!)}`, 'GET', undefined, signal),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Мысли и факты</p>
          <h1>{id ? 'Наблюдение' : 'Записать наблюдение'}</h1>
        </div>
        <Link to={`/timeline?kind=observation${project ? `&project=${project}` : ''}`}>
          Наблюдения в истории →
        </Link>
      </div>
      {id === deletedId && id ? (
        <div className="panel">
          <p>Наблюдение удалено.</p>
          <Link to="/observations">Записать новое →</Link>
        </div>
      ) : (
        <>
          {id && query.isPending && <p role="status">Загружаем наблюдение…</p>}
          {query.error && (
            <div className="message error" role="alert" aria-label="Чтение наблюдения">
              {query.error.message}
              <button onClick={() => query.refetch()} disabled={query.isFetching}>
                Повторить
              </button>
            </div>
          )}
          {(!id || query.data) && (
            <Editor
              key={id ?? 'new'}
              initial={id ? query.data : undefined}
              project={project}
              onDeleted={() => setDeletedId(id)}
            />
          )}
        </>
      )}
    </>
  );
}
