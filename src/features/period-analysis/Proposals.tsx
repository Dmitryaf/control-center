import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { PeriodRun } from '../../../shared/period-analysis';
import type { ProposalApproval, ProposalAcceptance } from '../../../shared/proposal-acceptances';
import { api } from '../../shared/http';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';

function Provenance({ value }: { value: ProposalAcceptance['original'] }) {
  const p = value.proposal;
  return (
    <details>
      <summary>Исходное предложение AI и сохранённые источники</summary>
      <h3>{p.title}</h3>
      <p>{p.description}</p>
      <p>Основание: {p.reason}</p>
      <p>Неизвестное: {p.uncertainty || 'Не указано'}</p>
      <p>Дешёвая проверка: {p.cheapCheck}</p>
      <p className="help">
        {value.origin === 'codex_manual' ? 'Codex · внесён вручную' : `Модель ${value.model}`} ·{' '}
        {value.period.from} — {value.period.to}. Это вывод модели, а не независимая проверка.
      </p>
      {value.sources.map((source) => (
        <details key={source.id}>
          <summary>
            {source.title} · {source.id}
          </summary>
          <p className="prose">{source.text}</p>
          <small>
            {source.partial ? 'Сокращённая выдержка. ' : ''}
            {source.dateQuality} · {source.recordedAt ?? source.day}
          </small>
        </details>
      ))}
    </details>
  );
}
function AcceptedCard({ value }: { value: ProposalAcceptance }) {
  const a = value.approved;
  return (
    <section className="panel section-space" aria-label="Принятое предложение">
      <h2>{a.title}</h2>
      <p>
        {value.kind === 'task' ? 'Задача' : 'Идея'} принята{' '}
        {new Date(value.createdAt).toLocaleString('ru')}.
      </p>
      {value.resultExists ? (
        <Link to={value.resultHref}>Открыть {value.kind === 'task' ? 'задачу' : 'идею'} →</Link>
      ) : (
        <p>Созданная запись удалена. Автоматического восстановления нет.</p>
      )}
      <h3>Принятая пользователем редакция</h3>
      <p className="prose">{a.description}</p>
      <p>Основание: {a.reason}</p>
      <p>Неизвестное: {a.uncertainty || 'Не указано'}</p>
      <p>Дешёвая проверка: {a.cheapCheck}</p>
      {value.kind === 'task' && (
        <>
          <p>Ожидаемый результат: {a.expectedResult || 'Не указан'}</p>
          <p>Критерий готовности: {a.acceptance || 'Не указан'}</p>
        </>
      )}
      <Provenance value={value.original} />
      {value.runId ? (
        <p>
          <Link to={`/period-analysis?run=${value.runKey}&review=${value.original.reviewKey}`}>
            Сохранённый анализ
          </Link>
        </p>
      ) : (
        <p className="help">Анализ удалён; редакция и основания принятого предложения сохранены.</p>
      )}
    </section>
  );
}
function ProposalEditor({ run, index }: { run: PeriodRun; index: number }) {
  const p = run.report!.proposals[index];
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const client = useQueryClient();
  const accepted = useQuery({
    queryKey: ['proposal-acceptances', 'run', run.id],
    queryFn: ({ signal }) =>
      api<ProposalAcceptance[]>(`/period-analysis/${run.id}/acceptances`, 'GET', undefined, signal),
    refetchInterval: 5000,
  });
  const {
    register,
    handleSubmit,
    watch,
    reset,
    getValues,
    formState: { isDirty },
  } = useForm<Omit<ProposalApproval, 'consent'> & { consent: boolean }>({
    defaultValues: {
      kind: p.kind === 'improvement' ? 'task' : 'idea',
      projectId: p.projectIds[0] ?? null,
      title: p.title,
      description: p.description,
      reason: p.reason,
      uncertainty: p.uncertainty,
      cheapCheck: p.cheapCheck,
      expectedResult: '',
      acceptance: '',
      priority: 'normal',
      allowDuplicate: false,
      consent: false,
    },
  });
  const current = accepted.data?.find((a) => a.proposalIndex === index);
  useEffect(() => {
    if (!current) return;
    const draft = getValues();
    if (
      Object.entries(current.approved).every(
        ([key, value]) => draft[key as keyof typeof draft] === value,
      )
    )
      reset(draft);
  }, [current, getValues, reset]);
  const original = {
    reviewKey: run.reviewKey,
    proposal: p,
    sources: run.payload.sources.filter((s) => p.sources.includes(s.id)),
    model: run.model,
    packetHash: run.packetHash,
    period: run.payload.period,
  };
  const kind = watch('kind');
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <h1>Принять предложение</h1>
      <p>
        <Link to={`/period-analysis?review=${run.reviewKey}&run=${run.id}`}>
          Вернуться к анализу →
        </Link>{' '}
        · <Link to="/proposal-acceptances">Все принятые предложения →</Link>
      </p>
      {accepted.error && <p role="alert">{accepted.error.message}</p>}
      {current && <AcceptedCard value={current} />}
      {current && isDirty && (
        <p role="alert">
          Предложение уже принято. Ваш черновик сохранён ниже; скопируйте нужные правки в созданную
          запись. <button onClick={() => reset()}>Отбросить черновик</button>
        </p>
      )}
      {(!current || isDirty) && (
        <>
          <Provenance value={original} />
          <p>
            Проверьте основания и исправьте формулировки. Для новой записи сократите описание до
            3000 символов, основание, неизвестное и дешёвую проверку — до 1500 символов каждое.
            Создание записи не выполняет работу, не меняет проекты и не подтверждает вывод AI.
            Предложенная связь принимается как идея или задача для проверки.
          </p>
          <form
            className="panel form section-space period-source-form"
            onSubmit={handleSubmit(
              (values) =>
                void act(async () => {
                  const saved = await api<ProposalAcceptance>(
                    `/period-analysis/${run.id}/proposals/${index}/accept`,
                    'POST',
                    values,
                  );
                  reset(values);
                  client.setQueryData<ProposalAcceptance[]>(
                    ['proposal-acceptances', 'run', run.id],
                    (old) => [...(old ?? []).filter((a) => a.proposalIndex !== index), saved],
                  );
                  await client.invalidateQueries({ queryKey: ['proposal-acceptances'] });
                }, 'Предложение принято'),
            )}
          >
            <label>
              Создать
              <select {...register('kind')}>
                <option value="task">Задачу</option>
                <option value="idea">Идею</option>
              </select>
            </label>
            <label>
              Проект
              <select {...register('projectId', { setValueAs: (value) => value || null })}>
                {p.projectIds.length === 0 && <option value="">Общая запись</option>}
                {p.projectIds.map((id) => (
                  <option key={id} value={id}>
                    {w!.projects.find((project) => project.id === id)?.metadata.name ??
                      'Удалённый проект'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Название
              <input {...register('title', { required: true })} maxLength={240} />
            </label>
            <label>
              Описание
              <textarea {...register('description')} maxLength={3000} rows={5} />
            </label>
            <label>
              Основание
              <textarea {...register('reason', { required: true })} maxLength={1500} rows={3} />
            </label>
            <label>
              Что остаётся неизвестным
              <textarea {...register('uncertainty')} maxLength={1500} rows={3} />
            </label>
            <label>
              Дешёвая проверка
              <textarea {...register('cheapCheck', { required: true })} maxLength={1500} rows={3} />
            </label>
            {kind === 'task' && (
              <>
                <label>
                  Ожидаемый результат
                  <textarea {...register('expectedResult')} maxLength={1500} />
                </label>
                <label>
                  Критерий готовности
                  <textarea {...register('acceptance')} maxLength={1500} />
                </label>
                <label>
                  Приоритет
                  <select {...register('priority')}>
                    <option value="normal">Обычный</option>
                    <option value="high">Высокий</option>
                    <option value="low">Низкий</option>
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" {...register('allowDuplicate')} />
                  Разрешаю отдельную задачу, даже если есть похожее название
                </label>
              </>
            )}
            <label className="check">
              <input type="checkbox" {...register('consent', { required: true })} />Я проверил
              редакцию и разрешаю создать выбранную запись
            </label>
            <div>
              <button
                className="primary"
                disabled={
                  !!current || busy || accepted.isPending || !!accepted.error || !watch('consent')
                }
              >
                Создать {kind === 'task' ? 'задачу' : 'идею'}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
export function Proposal() {
  const [params] = useSearchParams();
  const id = params.get('run') ?? '';
  const index = Number(params.get('index'));
  const run = useQuery({
    queryKey: ['period-run', id],
    queryFn: ({ signal }) =>
      api<PeriodRun>(`/period-analysis/${encodeURIComponent(id)}`, 'GET', undefined, signal),
    retry: false,
  });
  if (run.error && !run.data) return <p role="alert">{run.error.message}</p>;
  if (!run.data) return <p role="status">Загружаем предложение…</p>;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !run.data.report?.proposals[index] ||
    run.data.status !== 'succeeded'
  )
    return <p role="alert">Предложение не найдено в успешном анализе.</p>;
  return (
    <>
      {run.error && (
        <p role="alert">{run.error.message}. Показан сохранённый вариант; ваш черновик сохранён.</p>
      )}
      <ProposalEditor key={`${id}:${index}`} run={run.data} index={index} />
    </>
  );
}
export default function Acceptances() {
  const [params] = useSearchParams();
  const id = params.get('id');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const query = useQuery<
    ProposalAcceptance | { items: ProposalAcceptance[]; nextCursor: string | null }
  >({
    queryKey: ['proposal-acceptances', id, cursor],
    queryFn: ({ signal }) =>
      id
        ? api<ProposalAcceptance>(
            `/proposal-acceptances/${encodeURIComponent(id)}`,
            'GET',
            undefined,
            signal,
          )
        : api<{ items: ProposalAcceptance[]; nextCursor: string | null }>(
            `/proposal-acceptances${cursor ? `?cursor=${cursor}` : ''}`,
            'GET',
            undefined,
            signal,
          ),
    refetchInterval: 5000,
  });
  const page = query.data && 'items' in query.data ? query.data : null;
  const item = query.data && 'approved' in query.data ? query.data : null;
  return (
    <>
      <h1>Принятые предложения</h1>
      <p>
        Здесь отдельно сохранены исходный вариант AI, пользовательская редакция и источники.
        Последующие изменения задач и идей не переписывают эту запись.
      </p>
      <Link to="/timeline?kind=ai_analysis">К истории AI-анализов →</Link>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isPending && <p role="status">Загружаем принятые предложения…</p>}
      {item && <AcceptedCard value={item} />}{' '}
      {page?.items.map((value) => (
        <AcceptedCard key={value.id} value={value} />
      ))}
      {page?.items.length === 0 && <p>Принятых предложений пока нет.</p>}
      {page && (
        <div className="row">
          <button
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Предыдущие
          </button>
          <button
            disabled={!page.nextCursor || query.isFetching}
            onClick={() => setCursors([...cursors, page.nextCursor])}
          >
            Следующие
          </button>
        </div>
      )}
    </>
  );
}
