import { useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import type { Idea, IdeaInput, Decision, DecisionInput } from '../../../shared/contracts';
import { api } from '../../shared/http';
import { today, date, ideaLabels, decisionLabels } from '../../shared/labels';
import { daysBetween } from '../../../shared/time';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { DecisionFiles } from '../projects/ProjectDetail';
export function Ideas() {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [id, setId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const empty: IdeaInput = { title: '', description: '', projectId: null, state: 'new' };
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm<IdeaInput>({ defaultValues: empty });
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <div className="page-heading">
        <div>
          <h1>Идеи</h1>
        </div>
        {!formOpen && (
          <button className="primary" onClick={() => setFormOpen(true)}>
            Новая идея
          </button>
        )}
      </div>
      {formOpen && (
        <form
          className="panel form"
          onSubmit={handleSubmit(async (v) => {
            if (
              await act(
                () =>
                  api(id ? `/ideas/${id}` : '/ideas', id ? 'PUT' : 'POST', {
                    ...v,
                    projectId: v.projectId || null,
                  }),
                'Идея сохранена',
              )
            ) {
              reset(empty);
              setId(null);
              setFormOpen(false);
            }
          })}
        >
          <h2>{id ? 'Изменить идею' : 'Новая идея'}</h2>
          <label>
            Название идеи
            <input autoFocus required maxLength={240} {...register('title')} />
          </label>
          <label>
            Описание
            <textarea rows={3} {...register('description')} />
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
              {id ? 'Сохранить идею' : 'Добавить идею'}
            </button>
            <button
              type="button"
              onClick={() => {
                reset(empty);
                setId(null);
                setFormOpen(false);
              }}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      <div className="section-heading section-space">
        <h2>
          Все идеи <span className="count">{w!.ideas.length}</span>
        </h2>
      </div>
      <div className="record-list">
        {w!.ideas.map((i) => (
          <article id={`idea-${i.id}`} className="panel" key={i.id}>
            <div className="row between">
              {i.projectId ? (
                <Link to={`/projects/${i.projectId}`}>
                  {w!.projects.find((p) => p.id === i.projectId)?.metadata.name}
                </Link>
              ) : (
                <span>Без проекта</span>
              )}
              <small>{date(i.createdAt)}</small>
            </div>
            <h3>{i.title}</h3>
            {w!.proposalLinks?.[i.id] && (
              <p>
                <Link to={`/proposal-acceptances?id=${w!.proposalLinks[i.id]}`}>
                  Основания принятого предложения →
                </Link>
              </p>
            )}
            <p className="idea-age">Идея существует: {daysBetween(i.createdAt, today())} дн.</p>
            <p className="preserve">{i.description}</p>
            <div className="row">
              <select
                value={i.state}
                aria-label={`Состояние: ${i.title}`}
                disabled={busy}
                onChange={(e) =>
                  act(
                    () =>
                      api(`/ideas/${i.id}`, 'PUT', {
                        ...i,
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
              <button
                onClick={() => {
                  if (isDirty && !confirm('Отбросить несохранённые изменения?')) return;
                  setFormOpen(true);
                  reset({ ...i });
                  setId(i.id);
                  window.scrollTo({ top: 0 });
                }}
              >
                Изменить
              </button>
              <Link className="button" to={`/checks?idea=${i.id}`}>
                Начать проверку
              </Link>
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    confirm(`Удалить «${i.title}»?`) &&
                    (await act(() => api(`/ideas/${i.id}`, 'DELETE'), 'Запись удалена'))
                  ) {
                    if (id === i.id) {
                      reset(empty);
                      setId(null);
                      setFormOpen(false);
                    }
                  }
                }}
              >
                Удалить
              </button>
            </div>
            {w!.checks
              .filter((c) => c.ideaId === i.id)
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
          </article>
        ))}
      </div>
      {!w!.ideas.length && <p className="panel empty section-space">Идей пока нет.</p>}
    </>
  );
}
export function Decisions() {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [id, setId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const empty: DecisionInput = {
    title: '',
    context: '',
    decision: '',
    reason: '',
    projectId: null,
    date: today(),
    status: 'active',
  };
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm<DecisionInput>({ defaultValues: empty });
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <div className="page-heading">
        <div>
          <h1>Решения</h1>
        </div>
        {!formOpen && (
          <button className="primary" onClick={() => setFormOpen(true)}>
            Новое решение
          </button>
        )}
      </div>
      {formOpen && (
        <form
          className="panel form"
          onSubmit={handleSubmit(async (v) => {
            if (
              await act(
                () =>
                  api(id ? `/decisions/${id}` : '/decisions', id ? 'PUT' : 'POST', {
                    ...v,
                    projectId: v.projectId || null,
                  }),
                'Решение сохранено',
              )
            ) {
              reset(empty);
              setId(null);
              setFormOpen(false);
            }
          })}
        >
          <h2>{id ? 'Изменить решение' : 'Записать решение'}</h2>
          <label>
            Название решения
            <input autoFocus maxLength={240} required {...register('title')} />
          </label>
          {(
            [
              ['context', 'Контекст'],
              ['decision', 'Решение'],
              ['reason', 'Почему'],
            ] as const
          ).map(([k, l]) => (
            <label key={k}>
              {l}
              <textarea rows={3} required={k === 'decision'} {...register(k)} />
            </label>
          ))}
          <div className="form-grid">
            {id && (
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
            )}
            <label>
              Статус
              <select {...register('status')}>
                {Object.entries(decisionLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Дата
              <input type="date" required {...register('date')} />
            </label>
          </div>
          <div className="row">
            <button className="primary" disabled={busy}>
              {id ? 'Сохранить решение' : 'Добавить решение'}
            </button>
            <button
              type="button"
              onClick={() => {
                reset(empty);
                setId(null);
                setFormOpen(false);
              }}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      <div className="section-heading section-space">
        <h2>
          Записанные решения <span className="count">{w!.decisions.length}</span>
        </h2>
      </div>
      <div className="record-list">
        {w!.decisions.map((d: Decision) => (
          <article id={`decision-${d.id}`} className="panel prose" key={d.id}>
            <div className="row between">
              {d.projectId ? (
                <Link to={`/projects/${d.projectId}`}>
                  {w!.projects.find((p) => p.id === d.projectId)?.metadata.name}
                </Link>
              ) : (
                <span>Без проекта</span>
              )}
              <span className="badge">{decisionLabels[d.status]}</span>
            </div>
            <h3>{d.title}</h3>
            <p className="section-label">
              {d.projectId ? 'Локальное решение Control Center' : 'Общее решение экосистемы'}
            </p>
            <p className="muted preserve">{d.context}</p>
            <p className="preserve">{d.decision}</p>
            {d.reason && (
              <>
                <h4>Почему</h4>
                <p className="preserve">{d.reason}</p>
              </>
            )}
            <div className="row between">
              <small>{date(d.date)}</small>
              <button
                onClick={() => {
                  if (isDirty && !confirm('Отбросить несохранённые изменения?')) return;
                  setFormOpen(true);
                  reset({ ...d });
                  setId(d.id);
                  window.scrollTo({ top: 0 });
                }}
              >
                Изменить
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  if (
                    confirm(`Удалить «${d.title}»?`) &&
                    (await act(() => api(`/decisions/${d.id}`, 'DELETE'), 'Запись удалена'))
                  ) {
                    if (id === d.id) {
                      reset(empty);
                      setId(null);
                      setFormOpen(false);
                    }
                  }
                }}
              >
                Удалить
              </button>
            </div>
          </article>
        ))}
      </div>
      {!w!.decisions.length && <p className="empty">Записанных решений пока нет.</p>}
      <DecisionFiles />
    </>
  );
}
