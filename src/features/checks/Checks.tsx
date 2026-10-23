import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import type {
  CheckInput,
  CheckView,
  CheckEntryInput,
  CheckEntry,
  Conclusion,
} from '../../../shared/checks';
import { api } from '../../shared/http';
import { date, today } from '../../shared/labels';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
const statuses = { active: 'Активна', paused: 'На паузе', completed: 'Завершена' };
const outcomes = { continue: 'Продолжить', change: 'Изменить', stop: 'Остановить' };
export function CheckCard({
  check: c,
  compact = false,
  detail = false,
}: {
  check: CheckView;
  compact?: boolean;
  detail?: boolean;
}) {
  const { data: w } = useWorkspace();
  const level = c.signals.some((s) => s.level === 'decision')
    ? 'decision'
    : c.signals.some((s) => s.level === 'attention')
      ? 'attention'
      : 'info';
  return (
    <article
      className={`check-card ${level} ${compact ? 'compact' : ''} ${detail ? 'check-summary' : ''}`}
    >
      <div className="movement-clock">
        <strong>
          {c.daysWithoutMovement}
          <small>дн.</small>
        </strong>
        <span>{c.status === 'completed' ? 'без шага к завершению' : 'без внешнего шага'}</span>
        <span className="clock-state">{statuses[c.status]}</span>
      </div>
      <div className="check-reading">
        <div className="row between">
          {c.projectId ? (
            <Link to={`/projects/${c.projectId}`}>
              {w!.projects.find((p) => p.id === c.projectId)?.metadata.name}
            </Link>
          ) : (
            <span>Без проекта</span>
          )}
          <span className="help">
            {date(c.startedAt)} · {c.daysActive} дн.
            {c.completedAt ? ' до завершения' : ' с запуска'}
          </span>
        </div>
        {!detail && (
          <h3>
            <Link to={`/checks/${c.id}`}>{c.title}</Link>
          </h3>
        )}
        {!compact ? (
          <>
            <p className="check-question preserve">{c.question}</p>
            <dl className="check-dates">
              <dt>Последний внешний шаг</dt>
              <dd>
                {c.lastExternalActionAt ? date(c.lastExternalActionAt) : 'Ещё не записано'}
                {c.lastExternalActionAt
                  ? ` · ${c.daysWithoutMovement} дн.${c.completedAt ? ' до завершения' : ' назад'}`
                  : ''}
              </dd>
              <dt>Последнее свидетельство</dt>
              <dd>{c.lastEvidenceAt ? date(c.lastEvidenceAt) : 'Ещё не записано'}</dd>
              <dt>Пересмотр</dt>
              <dd>{c.reviewAt ? date(c.reviewAt) : c.reviewCondition || 'Не задан'}</dd>
            </dl>
            {c.signals.map((s) => (
              <p className={`signal ${s.level}`} key={s.code}>
                <strong>
                  {s.level === 'decision'
                    ? 'Решение'
                    : s.level === 'attention'
                      ? 'Внимание'
                      : 'Информация'}
                  .
                </strong>{' '}
                {s.message}
              </p>
            ))}
          </>
        ) : (
          <p className="help">
            Шаг: {date(c.lastExternalActionAt)} · Свидетельство: {date(c.lastEvidenceAt)}
            {c.reviewAt ? ` · Пересмотр: ${date(c.reviewAt)}` : ''}
          </p>
        )}
        {c.status !== 'completed' ? (
          <div className="next-step">
            <span>Следующий внешний шаг</span>
            <p>{c.nextExternalAction}</p>
          </div>
        ) : (
          <p className="muted">Завершена: {date(c.completedAt)}</p>
        )}
      </div>
    </article>
  );
}
function CheckEditor({
  initial,
  id,
  onSaved,
  onCancel,
}: {
  initial: Partial<CheckInput>;
  id?: string;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [savedId, setSavedId] = useState('');
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm<CheckInput>({
    defaultValues: {
      title: '',
      projectId: null,
      ideaId: null,
      question: '',
      assumption: '',
      expectedExternalResult: '',
      startedAt: today(),
      reviewAt: null,
      reviewCondition: '',
      continueIf: '',
      stopIf: '',
      nextExternalAction: '',
      status: 'active',
      ...initial,
    },
  });
  useEffect(() => {
    if (savedId && !isDirty) onSaved(savedId);
  }, [savedId, isDirty, onSaved]);
  return (
    <form
      className="panel form"
      onSubmit={handleSubmit(async (v) => {
        const existing = w!.checks.find((c) => c.id === id);
        const duplicate =
          v.status === 'active' &&
          w!.checks.some(
            (c) => c.id !== id && c.ideaId && c.ideaId === v.ideaId && c.status === 'active',
          ) &&
          (!existing || existing.status !== 'active' || existing.ideaId !== v.ideaId);
        if (
          duplicate &&
          !confirm(
            'Для этой идеи уже есть активная проверка. Создать ещё одну параллельную проверку?',
          )
        )
          return;
        let saved = '';
        const ok = await act(async () => {
          saved = (
            await api<{ id: string }>(id ? `/checks/${id}` : '/checks', id ? 'PUT' : 'POST', {
              check: {
                ...v,
                projectId: v.projectId || null,
                ideaId: v.ideaId || null,
                reviewAt: v.reviewAt || null,
              },
              allowParallel: duplicate,
            })
          ).id;
        }, 'Проверка сохранена');
        if (ok) {
          reset(v);
          setSavedId(saved);
        }
      })}
    >
      <UnsavedChanges dirty={isDirty} />
      <h2>{id ? 'Изменить проверку' : 'Новая проверка'}</h2>
      <label>
        Название проверки
        <input required maxLength={240} {...register('title')} />
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
          Идея
          <select {...register('ideaId')}>
            <option value="">Без идеи</option>
            {w!.ideas.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(
        [
          ['question', 'Что хотим выяснить'],
          ['assumption', 'Предположение'],
          ['expectedExternalResult', 'Ожидаемый внешний результат'],
          ['continueIf', 'Продолжаем, если'],
          ['stopIf', 'Останавливаемся, если'],
          ['nextExternalAction', 'Следующий внешний шаг'],
        ] as const
      ).map(([k, l]) => (
        <label key={k}>
          {l}
          <textarea rows={2} required {...register(k)} />
        </label>
      ))}
      <div className="form-grid">
        <label>
          Дата запуска
          <input type="date" max={today()} required {...register('startedAt')} />
        </label>
        <label>
          Дата пересмотра
          <input type="date" {...register('reviewAt')} />
        </label>
      </div>
      <label>
        Условие пересмотра
        <textarea rows={2} {...register('reviewCondition')} />
      </label>
      <label>
        Состояние проверки
        <select {...register('status')}>
          <option value="active">Активна</option>
          <option value="paused">На паузе</option>
        </select>
      </label>
      <div className="row">
        <button className="primary" disabled={busy}>
          {id ? 'Сохранить проверку' : 'Запустить проверку'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!isDirty || confirm('Отбросить несохранённую проверку?')) onCancel();
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
export default function Checks() {
  const { data: w } = useWorkspace();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('active');
  const creating = !!(params.get('new') || params.get('idea') || params.get('next'));
  const idea = w!.ideas.find((i) => i.id === params.get('idea'));
  const previous = w!.checks.find((c) => c.id === params.get('next'));
  const initial: Partial<CheckInput> = idea
    ? {
        title: idea.title,
        question: idea.title,
        assumption: idea.description,
        ideaId: idea.id,
        projectId: idea.projectId,
      }
    : previous
      ? {
          title: previous.conclusion?.nextQuestion.slice(0, 240) || '',
          question: previous.conclusion?.nextQuestion || '',
          projectId: previous.projectId,
          ideaId: previous.ideaId,
        }
      : { projectId: params.get('project') || null };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">От предположения к свидетельствам</p>
          <h1>Проверки</h1>
          <p className="subtitle">Внешние шаги, результаты и время принять решение.</p>
        </div>
        {!creating && (
          <Link className="button primary" to="/checks?new=1">
            Новая проверка
          </Link>
        )}
      </div>
      {creating ? (
        <CheckEditor
          key={params.toString()}
          initial={initial}
          onSaved={(id) => navigate(`/checks/${id}`)}
          onCancel={() => navigate('/checks')}
        />
      ) : (
        <>
          <div className="filter-bar section-space">
            {Object.entries({ active: 'Активные', paused: 'На паузе', completed: 'Архив' }).map(
              ([k, l]) => (
                <button
                  key={k}
                  className={filter === k ? 'active' : ''}
                  aria-pressed={filter === k}
                  onClick={() => setFilter(k)}
                >
                  {l} · {w!.checks.filter((c) => c.status === k).length}
                </button>
              ),
            )}
          </div>
          <div className="check-register section-space">
            {w!.checks
              .filter((c) => c.status === filter)
              .map((c) => (
                <CheckCard key={c.id} check={c} />
              ))}
          </div>
          {!w!.checks.some((c) => c.status === filter) && (
            <p className="panel empty section-space">В этом разделе пока нет проверок.</p>
          )}
        </>
      )}
    </>
  );
}
function Timeline({ check: c }: { check: CheckView }) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [id, setId] = useState<string | null>(null);
  const empty: CheckEntryInput = {
    kind: 'action',
    occurredAt: c.completedAt || today(),
    text: '',
    url: '',
    type: null,
    numericValue: null,
  };
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setFocus,
    formState: { isDirty },
  } = useForm<CheckEntryInput>({ defaultValues: empty });
  const kind = watch('kind');
  const types = {
    fact: 'Факт',
    observation: 'Наблюдение',
    problem: 'Проблема',
    decision: 'Решение',
  };
  const entries = w!.checkEntries
    .filter((e) => e.checkId === c.id)
    .sort(
      (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt),
    );
  function edit(e: CheckEntry) {
    reset({ ...e });
    setId(e.id);
    requestAnimationFrame(() => setFocus('text'));
  }
  return (
    <section className="section-space check-history">
      <h2>Действия и свидетельства</h2>
      <div className="history-columns">
        <div className="timeline section-space">
          {entries.map((e) => (
            <article id={`entry-${e.id}`} key={e.id} className={`history-entry ${e.kind}`}>
              <div className="row between">
                <strong>{e.kind === 'action' ? 'Внешнее действие' : 'Свидетельство'}</strong>
                <time>{date(e.occurredAt)}</time>
              </div>
              <p className="preserve">{e.text}</p>
              {e.kind === 'evidence' && (
                <p className="muted">
                  {e.type ? types[e.type] : 'Без типа'}
                  {e.numericValue !== null ? ` · ${e.numericValue}` : ''}
                </p>
              )}
              {e.url && (
                <a href={e.url} target="_blank" rel="noopener noreferrer">
                  Открыть источник ↗
                </a>
              )}
              <div className="row">
                <button disabled={busy} onClick={() => edit(e)}>
                  Изменить
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    if (
                      confirm(
                        'Удалить запись? Даты последнего действия и свидетельства будут пересчитаны.',
                      ) &&
                      (await act(
                        () => api(`/checks/${c.id}/entries/${e.id}`, 'DELETE'),
                        'Запись удалена',
                      ))
                    ) {
                      if (id === e.id) {
                        setId(null);
                        reset(empty);
                      }
                    }
                  }}
                >
                  Удалить запись
                </button>
              </div>
            </article>
          ))}
          {!entries.length && (
            <p className="muted">Внешние шаги и свидетельства ещё не записаны.</p>
          )}
        </div>
        <form
          className="entry-editor form"
          onSubmit={handleSubmit(async (v) => {
            if (
              await act(
                () =>
                  api(`/checks/${c.id}/entries${id ? '/' + id : ''}`, id ? 'PUT' : 'POST', {
                    ...v,
                    type: v.type || null,
                    numericValue:
                      v.numericValue === null || String(v.numericValue) === ''
                        ? null
                        : Number(v.numericValue),
                  }),
                'Запись сохранена',
              )
            ) {
              setId(null);
              reset(empty);
            }
          })}
        >
          <UnsavedChanges dirty={isDirty} />
          <h3>{id ? 'Изменить запись' : 'Добавить запись'}</h3>
          <div className="form-grid">
            <label>
              Вид записи
              <select {...register('kind')}>
                <option value="action">Внешнее действие</option>
                <option value="evidence">Свидетельство</option>
              </select>
            </label>
            <label>
              Дата события
              <input
                type="date"
                min={c.startedAt}
                max={c.completedAt || today()}
                required
                {...register('occurredAt')}
              />
            </label>
          </div>
          <label>
            Что произошло
            <textarea rows={3} required {...register('text')} />
          </label>
          <label>
            Ссылка (необязательно)
            <input type="url" placeholder="https://" {...register('url')} />
          </label>
          {kind === 'evidence' && (
            <div className="form-grid">
              <label>
                Тип свидетельства
                <select {...register('type')}>
                  <option value="">Не указан</option>
                  {Object.entries(types).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Числовое значение
                <input type="number" step="any" {...register('numericValue')} />
              </label>
            </div>
          )}
          <div className="row">
            <button className="primary" disabled={busy}>
              Сохранить запись
            </button>
            {id && (
              <button
                type="button"
                onClick={() => {
                  setId(null);
                  reset(empty);
                }}
              >
                Отмена
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
function Complete({ check: c, onDone }: { check: CheckView; onDone: () => void }) {
  const { act, busy } = useActions();
  const {
    register,
    handleSubmit,
    formState: { isDirty },
  } = useForm<Conclusion>({
    defaultValues: {
      actualResult: '',
      whatWasConfirmedOrRejected: '',
      outcome: 'continue',
      basis: '',
      nextQuestion: '',
      completedAt: today(),
    },
  });
  return (
    <form
      className="panel form section-space"
      onSubmit={handleSubmit(async (v) => {
        if (
          confirm('Завершить проверку с этим итогом и перенести в архив?') &&
          (await act(
            () => api(`/checks/${c.id}/complete`, 'POST', v),
            'Проверка завершена и сохранена в архиве',
          ))
        )
          onDone();
      })}
    >
      <UnsavedChanges dirty={isDirty} />
      <h2>Итог проверки</h2>
      {(
        [
          ['actualResult', 'Фактический результат'],
          ['whatWasConfirmedOrRejected', 'Что подтвердилось / не подтвердилось'],
          ['basis', 'Почему'],
          ['nextQuestion', 'Следующий вопрос'],
        ] as const
      ).map(([k, l]) => (
        <label key={k}>
          {l}
          <textarea rows={3} required={k !== 'nextQuestion'} {...register(k)} />
        </label>
      ))}
      <label>
        Итоговое решение
        <select {...register('outcome')}>
          {Object.entries(outcomes).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label>
        Дата завершения
        <input type="date" min={c.startedAt} max={today()} required {...register('completedAt')} />
      </label>
      <button className="primary" disabled={busy}>
        Сохранить итог и завершить
      </button>
    </form>
  );
}
export function CheckDetail() {
  const { id } = useParams();
  const { data: w } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const c = w!.checks.find((c) => c.id === id);
  if (!c) return <p className="empty">Проверка не найдена.</p>;
  return (
    <>
      <Link to="/checks" className="back-link">
        ← Все проверки
      </Link>
      <div className="page-heading">
        <div>
          <h1>{c.title}</h1>
          <p className="subtitle">
            Git показывает работу над проектом. Здесь — движение к внешнему подтверждению.
          </p>
        </div>
        {c.status !== 'completed' && (
          <div className="row">
            <button
              onClick={() => {
                setEditing(!editing);
                setFinishing(false);
              }}
            >
              Изменить проверку
            </button>
            <button
              onClick={() => {
                setFinishing(!finishing);
                setEditing(false);
              }}
            >
              Завершить проверку
            </button>
          </div>
        )}
      </div>
      {editing && (
        <CheckEditor
          initial={c as CheckInput}
          id={c.id}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      )}
      <CheckCard check={c} detail />
      <section className="check-criteria prose section-space">
        <h2>Условия проверки</h2>
        <div className="criteria-grid">
          {(
            [
              ['assumption', 'Предположение'],
              ['expectedExternalResult', 'Ожидаемый внешний результат'],
              ['continueIf', 'Продолжаем, если'],
              ['stopIf', 'Останавливаемся, если'],
              ['reviewCondition', 'Пересмотр'],
            ] as const
          ).map(([k, l]) => (
            <div key={k}>
              <h3>{l}</h3>
              <p>{c[k] || 'Условие не задано'}</p>
            </div>
          ))}
        </div>
        {c.ideaId && (
          <p>
            Идея: {w!.ideas.find((i) => i.id === c.ideaId)?.title} ·{' '}
            <Link to="/ideas">Открыть идеи</Link>
          </p>
        )}
      </section>
      {finishing && <Complete check={c} onDone={() => setFinishing(false)} />}{' '}
      {c.conclusion && (
        <section className="panel prose section-space">
          <h2>Итог · {outcomes[c.conclusion.outcome]}</h2>
          <h3>Фактический результат</h3>
          <p>{c.conclusion.actualResult}</p>
          <h3>Что подтвердилось / не подтвердилось</h3>
          <p>{c.conclusion.whatWasConfirmedOrRejected}</p>
          <h3>Почему</h3>
          <p>{c.conclusion.basis}</p>
          {c.conclusion.nextQuestion && (
            <>
              <h3>Следующий вопрос</h3>
              <p>{c.conclusion.nextQuestion}</p>
              <Link to={`/checks?next=${c.id}`} className="button">
                Создать следующую проверку
              </Link>
            </>
          )}
        </section>
      )}
      <Timeline key={c.id} check={c} />
    </>
  );
}
