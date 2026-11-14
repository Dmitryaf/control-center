import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { flushSync } from 'react-dom';
import type { Idea, IdeaInput } from '../../../shared/contracts';
import { api } from '../../shared/http';
import { date, ideaLabels } from '../../shared/labels';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { ActionMenu, ActionMenuItem } from '../../shared/ActionMenu';
import './ideas.css';

function IdeaEditor({
  initial,
  projectId,
  onClose,
}: {
  initial?: Idea;
  projectId: string | null;
  onClose: (saved?: boolean) => void;
}) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { isDirty },
  } = useForm<IdeaInput>({
    defaultValues: initial ?? { title: '', description: '', projectId, state: 'new' },
  });
  return (
    <form
      className="panel form idea-editor"
      aria-label={initial ? 'Изменить идею' : 'Новая идея'}
      onSubmit={handleSubmit(async (v) => {
        const input = { ...v, projectId: v.projectId || null };
        const ok = await act(
          () => api(initial ? `/ideas/${initial.id}` : '/ideas', initial ? 'PUT' : 'POST', input),
          'Идея сохранена',
        );
        if (ok && JSON.stringify(getValues()) === JSON.stringify(v)) {
          reset(v);
          onClose(true);
        }
      })}
    >
      <UnsavedChanges dirty={isDirty} />
      <h2>{initial ? 'Изменить идею' : 'Новая идея'}</h2>
      <label>
        Название идеи
        <input autoFocus required maxLength={240} {...register('title')} />
      </label>
      <label>
        Описание
        <textarea rows={10} maxLength={10000} {...register('description')} />
      </label>
      <div className="form-grid">
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
          Состояние
          <select {...register('state')}>
            {Object.entries(ideaLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <button className="primary" disabled={busy}>
          {initial ? 'Сохранить идею' : 'Добавить идею'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!isDirty || confirm('Отбросить несохранённые изменения?')) onClose();
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

export default function Ideas() {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const project = params.get('project') ?? '';
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Idea | null>(null);
  const selected = w!.ideas.find((i) => i.id === id);
  const previousId = useRef(id);
  const returnPosition = useRef({ scroll: 0, id: '' });
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const query = params.toString();
  const listUrl = '/ideas' + (query ? '?' + query : '');
  const names = new Map(w!.projects.map((p) => [p.id, p.metadata.name]));
  const projectName = (projectId: string | null) =>
    projectId ? (names.get(projectId) ?? 'Проект') : 'Без проекта';
  useEffect(() => {
    if (!id && location.hash.startsWith('#idea-')) {
      navigate(`/ideas/${encodeURIComponent(location.hash.slice(6))}${location.search}`, {
        replace: true,
      });
    }
  }, [id, location.hash, location.search, navigate]);
  useLayoutEffect(() => {
    setEditing(null);
    setCreating(false);
    if (id) {
      heading.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } else if (previousId.current) {
      const target =
        document.getElementById(`idea-open-${returnPosition.current.id}`) ?? listHeading.current;
      target?.focus({ preventScroll: true });
      window.scrollTo(0, returnPosition.current.scroll);
    }
    previousId.current = id;
  }, [id]);
  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true, preventScrollReset: true });
  }
  const items = w!.ideas.filter(
    (i) =>
      (!project || (project === '__general__' ? !i.projectId : i.projectId === project)) &&
      `${i.title} ${i.description}`
        .toLocaleLowerCase('ru')
        .includes(search.trim().toLocaleLowerCase('ru')),
  );
  const detail = selected ?? editing;
  return (
    <div className="ideas-workspace">
      <div hidden={!!id}>
        <header className="page-heading">
          <div className="ideas-title">
            <h1 ref={listHeading} tabIndex={-1}>
              Идеи
            </h1>
            <span className="count">{items.length}</span>
          </div>
          {!creating && (
            <button className="primary" onClick={() => setCreating(true)}>
              Новая идея
            </button>
          )}
        </header>
        {creating && (
          <IdeaEditor
            projectId={project && project !== '__general__' ? project : null}
            onClose={(saved) => {
              flushSync(() => setCreating(false));
              if (saved) setParams({}, { replace: true });
              requestAnimationFrame(() => listHeading.current?.focus());
            }}
          />
        )}
        <div className="ideas-filters">
          <input
            type="search"
            aria-label="Поиск идей"
            placeholder="Найти идею…"
            value={search}
            disabled={creating}
            onChange={(e) => updateFilter('q', e.target.value)}
          />
          <select
            aria-label="Проект идей"
            value={project}
            disabled={creating}
            onChange={(e) => updateFilter('project', e.target.value)}
          >
            <option value="">Все проекты</option>
            <option value="__general__">Без проекта</option>
            {w!.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.metadata.name}
              </option>
            ))}
          </select>
        </div>
        <div className="idea-grid">
          {items.map((i) => (
            <article className="idea-card" id={`idea-${i.id}`} key={i.id}>
              <div className="idea-card-meta">
                <span>{projectName(i.projectId)}</span>
                <span className="idea-state">{ideaLabels[i.state]}</span>
              </div>
              <h2>
                <Link
                  id={`idea-open-${i.id}`}
                  to={`/ideas/${i.id}${query ? '?' + query : ''}`}
                  onClick={() => {
                    returnPosition.current = { scroll: window.scrollY, id: i.id };
                  }}
                >
                  {i.title}
                </Link>
              </h2>
              <p className="idea-preview">{i.description || 'Описание пока не добавлено.'}</p>
              <div className="idea-card-footer">
                <time dateTime={i.createdAt}>{date(i.createdAt)}</time>
                <span aria-hidden="true">Читать →</span>
              </div>
            </article>
          ))}
        </div>
        {!items.length && (
          <p className="empty">
            {search || project ? 'Идей по выбранным условиям не найдено.' : 'Идей пока нет.'}
          </p>
        )}
      </div>
      {id && (
        <article className="idea-reading">
          <Link className="idea-back" to={listUrl}>
            ← Все идеи
          </Link>
          {detail ? (
            <>
              <div className="idea-reading-meta">
                {detail.projectId ? (
                  <Link to={`/projects/${detail.projectId}`}>{projectName(detail.projectId)}</Link>
                ) : (
                  <span>Без проекта</span>
                )}
                <span className="idea-state">{ideaLabels[detail.state]}</span>
                <time dateTime={detail.createdAt}>{date(detail.createdAt)}</time>
              </div>
              <h1 ref={heading} tabIndex={-1}>
                {detail.title}
              </h1>
              {!selected && (
                <p role="status">Идея удалена другим клиентом. Показан открытый черновик.</p>
              )}
              {editing ? (
                <IdeaEditor
                  key={editing.id}
                  initial={editing}
                  projectId={editing.projectId}
                  onClose={() => {
                    setEditing(null);
                    requestAnimationFrame(() => heading.current?.focus());
                  }}
                />
              ) : (
                <>
                  <div className="idea-actions">
                    <button onClick={() => setEditing(detail)}>Изменить</button>
                    <Link className="button" to={`/checks?idea=${detail.id}`}>
                      Начать проверку
                    </Link>
                    <select
                      value={detail.state}
                      aria-label={`Состояние: ${detail.title}`}
                      disabled={busy}
                      onChange={(e) =>
                        void act(
                          () =>
                            api(`/ideas/${detail.id}`, 'PUT', {
                              ...detail,
                              state: e.target.value as Idea['state'],
                            }),
                          'Состояние идеи обновлено',
                        )
                      }
                    >
                      {Object.entries(ideaLabels).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <ActionMenu label="Действия идеи">
                      <ActionMenuItem
                        disabled={busy}
                        onSelect={() => {
                          if (confirm(`Удалить «${detail.title}»?`))
                            void act(
                              () => api(`/ideas/${detail.id}`, 'DELETE'),
                              'Запись удалена',
                            ).then((ok) => {
                              if (ok) navigate(listUrl, { replace: true });
                            });
                        }}
                      >
                        Удалить
                      </ActionMenuItem>
                    </ActionMenu>
                  </div>
                  {w!.proposalLinks?.[detail.id] && (
                    <p className="idea-source">
                      <Link to={`/proposal-acceptances?id=${w!.proposalLinks[detail.id]}`}>
                        Основания принятого предложения →
                      </Link>
                    </p>
                  )}
                  <p className="idea-full-text preserve">
                    {detail.description || 'Описание пока не добавлено.'}
                  </p>
                  {w!.checks.some((c) => c.ideaId === detail.id) && (
                    <section className="idea-checks">
                      <h2>Проверки идеи</h2>
                      {w!.checks
                        .filter((c) => c.ideaId === detail.id)
                        .map((c) => (
                          <p key={c.id}>
                            <Link to={`/checks/${c.id}`}>{c.title}</Link> ·{' '}
                            {c.status === 'completed'
                              ? 'В архиве'
                              : c.status === 'paused'
                                ? 'На паузе'
                                : 'Активна'}
                          </p>
                        ))}
                    </section>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <h1 ref={heading} tabIndex={-1}>
                Идея не найдена
              </h1>
              <p className="empty">Запись удалена или ссылка больше недействительна.</p>
            </>
          )}
        </article>
      )}
    </div>
  );
}
