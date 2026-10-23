import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Review, RelatedReviews } from '../../../shared/reviews';
import { reviewCreateSchema, reviewPatchSchema } from '../../../shared/reviews';
import type { HistoryPage } from '../../../shared/history';
import { dateInZone, periodBounds, type PeriodKind } from '../../../shared/periods';
import { useWorkspace, useActions } from '../../shared/workspace';
import { api } from '../../shared/http';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { date } from '../../shared/labels';

const periodName = (kind: PeriodKind) => (kind === 'week' ? 'Обзор недели' : 'Обзор месяца');
const scopeName = (review: Pick<Review, 'scopeKey' | 'projectName'>) =>
  review.scopeKey === 'general' ? 'Общий обзор' : (review.projectName ?? 'Прежний проект');
function OpenReview({ project, day }: { project: string | null; day: string | null }) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<PeriodKind>(params.get('kind') === 'month' ? 'month' : 'week');
  const [anchorDate, setAnchor] = useState(day ?? dateInZone(new Date(), w!.settings.timezone));
  const [projectId, setProject] = useState(project ?? '');
  const [validation, setValidation] = useState('');
  const parsed = reviewCreateSchema.safeParse({ kind, anchorDate, projectId: projectId || null });
  const bounds = parsed.success ? periodBounds(kind, anchorDate, w!.settings.timezone) : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Проекты во времени</p>
          <h1>Открыть обзор периода</h1>
        </div>
        <Link to="/timeline?kind=review">Обзоры в истории →</Link>
      </div>
      <form
        className="panel form review-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!parsed.success) {
            setValidation('Выберите проект и дату от 1900 до 9998 года.');
            return;
          }
          setValidation('');
          await act(async () => {
            const saved = await api<Review>('/reviews', 'POST', parsed.data);
            await client.invalidateQueries({ queryKey: ['history'] });
            const next = new URLSearchParams(params);
            next.set('id', saved.id);
            setParams(next);
          }, 'Обзор открыт');
        }}
      >
        <label>
          Период обзора
          <select value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)}>
            <option value="week">Неделя</option>
            <option value="month">Месяц</option>
          </select>
        </label>
        <label>
          Дата внутри периода
          <input
            type="date"
            min="1900-01-01"
            max="9998-12-31"
            required
            value={anchorDate}
            onChange={(e) => setAnchor(e.target.value)}
          />
        </label>
        <label>
          Проект обзора
          <select value={projectId} onChange={(e) => setProject(e.target.value)}>
            <option value="">Общий обзор</option>
            {projectId && !w!.projects.some((p) => p.id === projectId) && (
              <option value={projectId}>Выбранный проект недоступен</option>
            )}
            {w!.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.metadata.name}
              </option>
            ))}
          </select>
        </label>
        {bounds && (
          <p className="help">
            {date(bounds.periodStart)} — {date(bounds.periodEnd)} · {bounds.timezone}
          </p>
        )}
        <p className="help">
          Откроется существующий обзор или новый пустой документ. Часовой пояс берётся из настроек
          при создании; границы сохранённого обзора не меняются.
        </p>
        {validation && <p role="alert">{validation}</p>}
        <div>
          <button className="primary" disabled={busy}>
            Открыть обзор
          </button>
        </div>
      </form>
    </>
  );
}

function Related({ review }: { review: Review }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: ['related-reviews', review.id, cursor],
    retry: false,
    refetchInterval: cursor ? false : 5000,
    queryFn: ({ signal }) =>
      api<RelatedReviews>(
        `/reviews/${review.id}/related${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
  });
  return (
    <section className="panel section-space" aria-label="Связанные обзоры">
      <h2>Связанные обзоры</h2>
      <p className="help">
        {review.kind === 'month'
          ? 'Недельные итоги входят целиком, даже если неделя пересекает границу месяца.'
          : 'Проектные итоги того же периода доступны из общего обзора.'}{' '}
        Это ссылки на текущие документы, их текст не копируется.
      </p>
      {query.isPending && <p role="status">Загружаем обзоры…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}{' '}
          <button disabled={query.isFetching} onClick={() => query.refetch()}>
            Повторить загрузку обзоров
          </button>
        </p>
      )}
      {query.data?.items.length === 0 && (
        <p className="empty">Связанных обзоров пока нет. Можно написать итог без них.</p>
      )}
      {query.data?.items.map((item) => (
        <p key={item.id}>
          <Link to={`/reviews?id=${item.id}`}>
            {scopeName(item)} · {periodName(item.kind)} · {date(item.periodStart)} —{' '}
            {date(item.periodEnd)}
          </Link>{' '}
          <small>
            {item.timezone}
            {item.overlapsBoundary ? ' · Пересекает границу периода' : ''}
          </small>
        </p>
      ))}
      <div className="row">
        <button
          disabled={cursors.length === 1 || query.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Предыдущие обзоры
        </button>
        <button
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => setCursors([...cursors, query.data!.nextCursor])}
        >
          Следующие обзоры
        </button>
      </div>
    </section>
  );
}

function Sources({ review }: { review: Review }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  const query = useQuery({
    queryKey: ['review-sources', review.id, cursor],
    retry: false,
    refetchInterval: cursor ? false : 5000,
    queryFn: ({ signal }) =>
      api<HistoryPage>(`/reviews/${review.id}/history?${params}`, 'GET', undefined, signal),
  });
  const historyParams = new URLSearchParams({
    from: review.periodStart,
    to: review.periodEnd,
    timezone: review.timezone,
  });
  if (review.scopeKey !== 'general') historyParams.set('project', review.scopeKey.slice(8));
  const entries = query.data?.items.filter((item) => item.kind !== 'review');
  return (
    <section className="panel section-space" aria-label="События периода">
      <h2>События периода</h2>
      <p className="help">
        Временные отметки отбираются по сохранённым границам. Изменяемые источники могут отличаться
        от состояния в конце периода; полного архива целей и незавершённых задач нет. Тексты обзоров
        в список событий не копируются.
      </p>
      <Link to={`/timeline?${historyParams}`}>Открыть историю периода →</Link>
      {query.isPending && <p role="status">Загружаем события…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}{' '}
          <button disabled={query.isFetching} onClick={() => query.refetch()}>
            Повторить загрузку событий
          </button>
        </p>
      )}
      {entries?.length === 0 && <p className="empty">На этой странице исходных событий нет.</p>}
      {entries?.map((item) => (
        <article className="history-item section-space" key={item.key}>
          <small>
            {date(item.day)} · {item.projectName ?? 'Без живой связи с проектом'}
          </small>
          <p>
            <Link to={item.href}>{item.title}</Link>
          </p>
          {item.excerpt && (
            <p className="prewrap">
              {item.excerpt}
              {item.truncated ? '…' : ''}
            </p>
          )}
        </article>
      ))}
      {query.data &&
        query.data.files.undated +
          query.data.files.unavailable +
          query.data.files.notLoadedProjects >
          0 && (
          <p className="help">
            Есть недатированные, недоступные или непрочитанные файловые источники. Подробности — в
            истории периода.
          </p>
        )}
      <div className="row">
        <button
          disabled={cursors.length === 1 || query.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Предыдущие события
        </button>
        <button
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => setCursors([...cursors, query.data!.nextCursor])}
        >
          Следующие события
        </button>
      </div>
    </section>
  );
}

function Editor({ initial, onDeleted }: { initial: Review; onDeleted: () => void }) {
  const { act, busy } = useActions();
  const client = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { isDirty, isSubmitting },
  } = useForm<{ userText: string }>({ defaultValues: { userText: initial.userText } });
  const [revision, setRevision] = useState(initial.revision);
  const [deleting, setDeleting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [validation, setValidation] = useState('');
  useEffect(() => {
    if (!isDirty) {
      reset({ userText: initial.userText });
      setRevision(initial.revision);
    }
  }, [initial, isDirty, reset]);
  const now = new Date().toISOString();
  async function save(values: { userText: string }) {
    const parsed = reviewPatchSchema.safeParse({ ...values, revision });
    if (!parsed.success) {
      setValidation('Текст обзора не должен превышать 60 000 символов.');
      return;
    }
    let saved: Review | undefined;
    const ok = await act(async () => {
      saved = await api<Review>(`/reviews/${initial.id}`, 'PATCH', parsed.data);
      await client.invalidateQueries({ queryKey: ['review', initial.id] });
      await client.invalidateQueries({ queryKey: ['history'] });
    }, 'Обзор сохранён');
    if (!ok || !saved) return;
    setRevision(saved.revision);
    if (getValues('userText') === values.userText) {
      reset({ userText: saved.userText });
      setValidation('');
    } else setValidation('Обзор сохранён. Более новый ввод остаётся в черновике.');
  }
  async function reload() {
    if (isDirty && !confirm('Заменить черновик сохранённым обзором?')) return;
    setReloading(true);
    await act(async () => {
      await client.cancelQueries({ queryKey: ['review', initial.id], exact: true });
      const saved = await client.fetchQuery({
        queryKey: ['review', initial.id],
        staleTime: 0,
        queryFn: ({ signal }) => api<Review>(`/reviews/${initial.id}`, 'GET', undefined, signal),
      });
      reset({ userText: saved.userText });
      setRevision(saved.revision);
      setValidation('');
    }, 'Сохранённый обзор загружен');
    setReloading(false);
  }
  async function remove() {
    if (!confirm('Удалить обзор и его несохранённый черновик? Исходные события сохранятся.'))
      return;
    setDeleting(true);
    const ok = await act(async () => {
      await api(`/reviews/${initial.id}`, 'DELETE', { revision });
      await client.invalidateQueries({ queryKey: ['history'] });
      await client.invalidateQueries({ queryKey: ['related-reviews'] });
    }, 'Обзор удалён');
    setDeleting(false);
    if (ok) {
      onDeleted();
      client.removeQueries({ queryKey: ['review', initial.id], exact: true });
    }
  }
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <div className="page-heading">
        <div>
          <p className="section-label">{scopeName(initial)}</p>
          <h1>{periodName(initial.kind)}</h1>
          <p className="subtitle">
            {date(initial.periodStart)} — {date(initial.periodEnd)} · {initial.timezone}
          </p>
        </div>
        <div className="row">
          <Link to={`/period-analysis?review=${initial.id}`}>AI-анализ периода →</Link>
          <Link to="/timeline?kind=review">Обзоры в истории →</Link>
        </div>
      </div>
      {now < initial.nextStartAt && (
        <p role="status" className="message warning">
          {now < initial.startAt
            ? 'Период ещё не начался.'
            : 'Период ещё не закончился. Итог пока неполный.'}
        </p>
      )}
      {initial.scopeKey !== 'general' && !initial.projectId && (
        <p className="help">
          Живая связь с проектом снята. Прежняя принадлежность и название обзора сохранены.
        </p>
      )}
      <form className="form review-editor section-space" onSubmit={handleSubmit(save)}>
        <fieldset disabled={deleting || reloading}>
          <label>
            Текст обзора
            <textarea rows={14} maxLength={60000} {...register('userText')} />
          </label>
          <p className="help">
            Свободный итог: что изменилось, что мешало, какие решения приняты и что делать дальше.
            Сохраняется ваш текст; автоматического анализа нет. Предыдущие редакции текста не
            архивируются.
          </p>
          {validation && <p role="status">{validation}</p>}
          <div className="row section-space">
            <button className="primary" disabled={busy || isSubmitting}>
              Сохранить обзор
            </button>
            <button type="button" disabled={busy} onClick={reload}>
              Загрузить сохранённый обзор
            </button>
            <button type="button" disabled={busy} onClick={remove}>
              Удалить обзор
            </button>
          </div>
        </fieldset>
      </form>
      <Related key={`related-${initial.id}`} review={initial} />
      <Sources key={`sources-${initial.id}`} review={initial} />
    </>
  );
}

export default function Reviews() {
  const [params] = useSearchParams();
  const id = params.get('id');
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['review', id],
    enabled: !!id && id !== deletedId,
    retry: false,
    refetchInterval: id && id !== deletedId ? 5000 : false,
    queryFn: ({ signal }) =>
      api<Review>(`/reviews/${encodeURIComponent(id!)}`, 'GET', undefined, signal),
  });
  if (!id) return <OpenReview project={params.get('project')} day={params.get('day')} />;
  if (id === deletedId)
    return (
      <div className="panel">
        <p>Обзор удалён.</p>
        <Link to="/reviews">Открыть другой период →</Link>
      </div>
    );
  return (
    <>
      {query.isPending && <p role="status">Загружаем обзор…</p>}
      {query.error && (
        <div className="message error" role="alert">
          {query.error.message}
          <button disabled={query.isFetching} onClick={() => query.refetch()}>
            Повторить
          </button>
        </div>
      )}
      {query.data && <Editor key={id} initial={query.data} onDeleted={() => setDeletedId(id)} />}
    </>
  );
}
