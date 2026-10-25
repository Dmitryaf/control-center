import { useEffect, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type {
  CodexGrant,
  CodexThread,
  CodexPreview,
  CodexDigest,
} from '../../../shared/codex-context';
import type { Review } from '../../../shared/reviews';
import { api } from '../../shared/http';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';

function Capture({
  preview,
  old,
  onDirty,
  onSaved,
  enabled,
}: {
  preview: CodexPreview;
  old: CodexDigest | undefined;
  onDirty: (dirty: boolean) => void;
  onSaved: () => Promise<unknown>;
  enabled: boolean;
}) {
  const { act, busy } = useActions();
  const [saved, setSaved] = useState(false);
  const baseRevision = useRef(old?.revision ?? null).current;
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { isDirty },
  } = useForm<{ summary: string; excerptIds: string[]; confirm: boolean }>({
    defaultValues: {
      summary: old?.summary ?? preview.suggested?.summary ?? '',
      excerptIds: preview.suggested?.excerptIds ?? [],
      confirm: false,
    },
  });
  useEffect(() => {
    onDirty(isDirty);
    return () => onDirty(false);
  }, [isDirty, onDirty]);
  const selected = watch('excerptIds');
  return (
    <section className="panel section-space period-source-form">
      <UnsavedChanges dirty={isDirty} />
      <h2>{preview.thread.name}</h2>
      {old && (old.stale || old.sourceHash !== preview.sourceHash) && (
        <p className="message warning">
          Диалог изменился. Ниже сохранён ваш прежний итог: сверьте его с новыми выдержками и
          подтвердите сохранение. До этого он не используется в новых анализах.
        </p>
      )}
      {preview.limitations.map((text) => (
        <p className="help" key={text}>
          {text}
        </p>
      ))}
      {saved ? (
        <p role="status">Краткий итог сохранён. Выберите его отдельно в пакете AI-анализа.</p>
      ) : (
        <form
          className="form"
          onSubmit={handleSubmit(
            (values) =>
              void act(async () => {
                await api(`/projects/${preview.projectId}/codex-context/digests`, 'POST', {
                  previewId: preview.id,
                  revision: baseRevision,
                  summary: values.summary,
                  excerptIds: values.excerptIds,
                  confirm: true,
                });
                reset(values);
                setSaved(true);
                await onSaved();
              }, 'Итог диалога сохранён'),
          )}
        >
          <label>
            Краткий итог — можно исправить
            <textarea {...register('summary', { required: true })} rows={5} maxLength={6000} />
          </label>
          <p>Выберите до восьми выдержек. Они сохранятся рядом с вашим пересказом.</p>
          {preview.excerpts.map((item) => (
            <label className="panel check" key={item.id}>
              <input
                type="checkbox"
                value={item.id}
                {...register('excerptIds')}
                disabled={!selected.includes(item.id) && selected.length >= 8}
              />
              <span>
                <strong>{item.role === 'user' ? 'Пользователь' : 'Ассистент'}</strong> · начало
                обращения {new Date(item.at).toLocaleString('ru')} ·{' '}
                {{
                  completed: 'завершено',
                  inProgress: 'выполняется',
                  interrupted: 'прервано',
                  failed: 'ошибка',
                }[item.turnStatus] ?? 'статус неизвестен'}
                <span className="preserve" style={{ display: 'block' }}>
                  {item.text}
                </span>
                {item.partial && <small>Выдержка сокращена до 1000 байт.</small>}
              </span>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" {...register('confirm', { required: true })} />Я просмотрел текст
            и разрешаю сохранить мой итог и выбранные выдержки локально
          </label>
          <div>
            <button className="primary" disabled={busy || !enabled || !watch('confirm')}>
              Сохранить итог диалога
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
function ProjectReader({
  projectId,
  reviewId,
  existing,
  refresh,
}: {
  projectId: string;
  reviewId: string;
  existing: CodexDigest[];
  refresh: () => Promise<unknown>;
}) {
  const { act, busy } = useActions();
  const client = useQueryClient();
  const [consent, setConsent] = useState(false);
  const [archived, setArchived] = useState(false);
  const [threads, setThreads] = useState<{
    items: CodexThread[];
    nextCursor: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<CodexPreview | null>(null);
  const [dirty, setDirty] = useState(false);
  const grant = useQuery({
    queryKey: ['codex-grant', projectId],
    queryFn: ({ signal }) =>
      api<CodexGrant>(`/projects/${projectId}/codex-context`, 'GET', undefined, signal),
    refetchInterval: 5000,
  });
  const probe = useMutation({
    retry: false,
    mutationFn: () =>
      api<{ version: string }>(`/projects/${projectId}/codex-context/probe`, 'POST', {
        revision: grant.data!.revision,
      }),
  });
  const list = useMutation({
    retry: false,
    mutationFn: (cursor: string | null) =>
      api<{ items: CodexThread[]; nextCursor: string | null }>(
        `/projects/${projectId}/codex-context/threads`,
        'POST',
        { revision: grant.data!.revision, archived, ...(cursor ? { cursor } : {}) },
      ),
    onSuccess: setThreads,
  });
  const read = useMutation({
    retry: false,
    mutationFn: (threadId: string) =>
      api<CodexPreview>(`/projects/${projectId}/codex-context/preview`, 'POST', {
        revision: grant.data!.revision,
        reviewId,
        threadId,
      }),
    onSuccess: setPreview,
  });
  const configure = (enabled: boolean) =>
    void act(
      async () => {
        const saved = await api<CodexGrant>(`/projects/${projectId}/codex-context`, 'PUT', {
          revision: grant.data?.revision ?? null,
          enabled,
          ...(enabled ? { readConsent: true } : {}),
        });
        client.setQueryData(['codex-grant', projectId], saved);
        setConsent(false);
        setThreads(null);
        await refresh();
      },
      enabled ? 'Чтение Codex разрешено для этого проекта' : 'Чтение Codex отключено',
    );
  return (
    <>
      <section className="panel section-space period-source-form">
        <h2>Доступ к диалогам выбранного проекта</h2>
        <p>
          По умолчанию выключен. Само включение не читает диалоги. По вашим действиям приложение
          запустит локальный Codex CLI для чтения списка и выбранного текста. Оно не возобновляет
          диалоги, не отправляет сообщения и не выполняет команды из них.
        </p>
        <p>
          Доступ ограничен точным каталогом проекта и подтверждёнными Git worktree. Переписки
          целиком, команды, вложения и reasoning не копируются в базу. Ваш итог и выбранные выдержки
          сохраняются локально и в резервных копиях. Отправка в OpenAI — отдельное действие.
        </p>
        <p className="help">
          Повторное разрешение потребует заново просмотреть сохранённые итоги перед включением в
          новый AI-пакет.
        </p>
        <p>
          {grant.data?.enabled
            ? 'Чтение разрешено'
            : grant.data?.approved
              ? 'Разрешение сохранено, но чтение сейчас недоступно. Его можно отключить или подтвердить заново.'
              : 'Чтение выключено'}
        </p>
        {grant.error && <p role="alert">{grant.error.message}</p>}
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          Разрешаю чтение списка и выбранных диалогов только этого проекта и его проверенных
          worktree
        </label>
        <div className="row">
          <button
            disabled={busy || !consent || grant.isPending || !!grant.error}
            onClick={() => configure(true)}
          >
            Разрешить чтение проекта
          </button>
          <button disabled={busy || !grant.data?.approved} onClick={() => configure(false)}>
            Отключить чтение
          </button>
        </div>
        <button
          disabled={!grant.data?.enabled || probe.isPending || busy}
          onClick={() => probe.mutate()}
        >
          Проверить CLI без чтения диалогов
        </button>
        {probe.data && (
          <p>
            Версия CLI: {probe.data.version}. Это ещё не подтверждает доступ к конкретной истории.
          </p>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              setThreads(null);
            }}
          />
          Архивные диалоги
        </label>
        <button
          disabled={!grant.data?.enabled || list.isPending || busy}
          onClick={() => list.mutate(null)}
        >
          Показать диалоги проекта
        </button>
        {(probe.isPending || list.isPending || read.isPending) && (
          <p role="status">Читаем выбранные сведения Codex…</p>
        )}
        {[probe.error, list.error, read.error].filter(Boolean).map((error, index) => (
          <p role="alert" key={index}>
            {error!.message}
          </p>
        ))}
        {threads?.items.length === 0 && (
          <p>
            Диалогов в выбранных каталогах не найдено. Чаты из других каталогов не подмешиваются.
          </p>
        )}
        {threads?.items.map((thread) => (
          <article key={thread.id} className="section-space">
            <h3>{thread.name}</h3>
            <p className="help">Изменён {new Date(thread.updatedAt * 1000).toLocaleString('ru')}</p>
            <button
              disabled={!grant.data?.enabled || read.isPending || busy}
              onClick={() => {
                if (dirty && !confirm('Отбросить несохранённый итог и просмотреть другой диалог?'))
                  return;
                read.mutate(thread.id);
              }}
            >
              Просмотреть текст за период
            </button>
          </article>
        ))}
        {threads?.nextCursor && (
          <button
            disabled={list.isPending || !grant.data?.enabled}
            onClick={() => list.mutate(threads.nextCursor)}
          >
            Следующая страница диалогов
          </button>
        )}
      </section>
      {preview && (
        <Capture
          key={preview.id}
          preview={preview}
          old={existing.find((item) => item.thread.id === preview.thread.id)}
          onDirty={setDirty}
          onSaved={refresh}
          enabled={!!grant.data?.enabled}
        />
      )}
      {existing.map((item) => (
        <SavedDigest
          key={item.id}
          item={item}
          grant={item.scopeProjectId === projectId ? grant.data : undefined}
          refresh={refresh}
        />
      ))}
    </>
  );
}
function SavedDigest({
  item,
  grant,
  refresh,
}: {
  item: CodexDigest;
  grant: CodexGrant | undefined;
  refresh: () => Promise<unknown>;
}) {
  const { act, busy } = useActions();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm({ defaultValues: { summary: item.summary } });
  const editRevision = useRef(item.revision);
  useEffect(() => {
    if (!isDirty) {
      editRevision.current = item.revision;
      reset({ summary: item.summary });
    }
  }, [item.revision, item.summary, isDirty, reset]);
  const check = useMutation({
    retry: false,
    mutationFn: () =>
      api<CodexDigest>(`/codex-context/digests/${item.id}/check`, 'POST', {
        revision: item.revision,
        grantRevision: grant!.revision,
      }),
    onSettled: refresh,
  });
  return (
    <section className="panel section-space" aria-label="Сохранённый итог диалога">
      <UnsavedChanges dirty={isDirty} />
      <h2>{item.thread.name}</h2>
      <p>
        {item.projectName} · {item.period.from} — {item.period.to}
      </p>
      <p className="preserve">{item.summary}</p>
      <p>
        <a href={`codex://threads/${encodeURIComponent(item.thread.id)}`}>
          Исходный диалог Codex →
        </a>
      </p>
      <details>
        <summary>Исправить краткий итог</summary>
        <form
          className="form"
          onSubmit={handleSubmit(
            (values) =>
              void act(async () => {
                await api(`/codex-context/digests/${item.id}`, 'PATCH', {
                  ...values,
                  revision: editRevision.current,
                  confirm: true,
                });
                reset(values);
                await refresh();
              }, 'Итог исправлен'),
          )}
        >
          <label>
            Краткий итог диалога
            <textarea rows={5} maxLength={6000} {...register('summary', { required: true })} />
          </label>
          <div>
            <button disabled={busy || !isDirty}>Сохранить исправление</button>
          </div>
        </form>
      </details>
      <p>
        {item.stale
          ? 'Диалог изменён или не удалось проверить источник. Просмотрите заново.'
          : `Последнее чтение: ${new Date(item.checkedAt).toLocaleString('ru')}. Автоматического наблюдения нет.`}
      </p>
      {!item.eligible && (
        <p className="help">
          Для нового AI-пакета нужны действующее разрешение и повторный просмотр при изменении
          источника или доступа.
        </p>
      )}
      <details>
        <summary>Сохранённые выдержки ({item.excerpts.length})</summary>
        {item.excerpts.map((excerpt) => (
          <p className="preserve" key={excerpt.id}>
            <strong>{excerpt.role === 'user' ? 'Пользователь' : 'Ассистент'}: </strong>
            {excerpt.text}
            {excerpt.partial ? ' (сокращено)' : ''}
          </p>
        ))}
      </details>
      {check.error && <p role="alert">{check.error.message}</p>}
      <div className="row">
        <button
          disabled={busy || check.isPending || !grant?.enabled}
          onClick={() => check.mutate()}
        >
          Проверить изменения диалога
        </button>
        <button
          disabled={busy || check.isPending}
          onClick={() => {
            if (
              !confirm(
                'Удалить локальный итог и его выдержки? Уже сохранённые AI-анализы и принятые предложения сохранят свои утверждённые основания.',
              )
            )
              return;
            void act(async () => {
              await api(`/codex-context/digests/${item.id}`, 'DELETE', {
                revision: item.revision,
                confirm: true,
              });
              await refresh();
            }, 'Итог диалога удалён');
          }}
        >
          Удалить итог диалога
        </button>
      </div>
    </section>
  );
}
export default function CodexContext() {
  const [params, setParams] = useSearchParams();
  const reviewId = params.get('review');
  const { data: w } = useWorkspace();
  const client = useQueryClient();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const review = useQuery({
    queryKey: ['review', reviewId],
    queryFn: ({ signal }) => api<Review>(`/reviews/${reviewId}`, 'GET', undefined, signal),
    enabled: !!reviewId,
    retry: false,
  });
  const choices = w!.projects.filter(
    (project) =>
      !review.data || review.data.scopeKey === 'general' || project.id === review.data.projectId,
  );
  const requested = params.get('project');
  const projectId = choices.some((project) => project.id === requested)
    ? requested!
    : (review.data?.projectId ?? choices[0]?.id ?? '');
  const digests = useQuery({
    queryKey: ['codex-digests', reviewId, cursor],
    queryFn: ({ signal }) =>
      api<{ items: CodexDigest[]; nextCursor: string | null }>(
        `/codex-context/digests?${new URLSearchParams({ ...(reviewId ? { reviewId } : {}), ...(cursor ? { cursor } : {}) })}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 5000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['codex-digests'] });
  return (
    <>
      <h1>Диалоги Codex для контекста</h1>
      <p>
        До двух содержательных диалогов на каждый проект. В анализе можно подготовить ограниченную
        выборку автоматически. Здесь доступны отдельный диалог, выдержки и редактирование итога.
        Сообщения ассистента не доказывают выполнения действий.
      </p>
      <p>
        <Link to="/reviews">Выбрать обзор периода →</Link>
        {reviewId && (
          <>
            {' '}
            · <Link to={`/period-analysis?review=${reviewId}`}>К ручному AI-анализу →</Link>
          </>
        )}
      </p>
      {reviewId && review.data && (
        <>
          <p>
            {review.data.periodStart} — {review.data.periodEnd} · {review.data.timezone}
          </p>
          <label>
            Проект для чтения
            <select
              value={projectId}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set('project', e.target.value);
                setParams(next);
              }}
            >
              {w!.projects
                .filter(
                  (p) => review.data!.scopeKey === 'general' || p.id === review.data!.projectId,
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.metadata.name}
                  </option>
                ))}
            </select>
          </label>
        </>
      )}
      {review.error && (
        <p role="alert">{review.error.message}. Сохранённые итоги остаются доступны.</p>
      )}
      {digests.error && <p role="alert">{digests.error.message}</p>}
      {reviewId && review.data && projectId ? (
        <ProjectReader
          key={`${reviewId}:${projectId}`}
          projectId={projectId}
          reviewId={reviewId}
          existing={digests.data?.items ?? []}
          refresh={refresh}
        />
      ) : (
        digests.data?.items.map((item) => (
          <SavedDigest key={item.id} item={item} grant={undefined} refresh={refresh} />
        ))
      )}
      {digests.data?.items.length === 0 && <p>Сохранённых итогов диалогов пока нет.</p>}
      {!reviewId && digests.data && (
        <div className="row">
          <button
            disabled={cursors.length === 1 || digests.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Предыдущие
          </button>
          <button
            disabled={!digests.data.nextCursor || digests.isFetching}
            onClick={() => setCursors([...cursors, digests.data!.nextCursor])}
          >
            Следующие
          </button>
        </div>
      )}
    </>
  );
}
