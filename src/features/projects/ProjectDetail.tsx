import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import type { Metadata, Project } from '../../../shared/contracts';
import { api } from '../../shared/http';
import {
  date,
  lines,
  today,
  statusLabels,
  typeLabels,
  priorityLabels,
  relationLabels,
  taskLabels,
  decisionLabels,
} from '../../shared/labels';
import { useWorkspace, useActions, workspaceKey } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { CheckCard } from '../checks/Checks';

function MetadataEditor({ project, onClose }: { project: Project; onClose: () => void }) {
  const { act, busy } = useActions();
  const [expectedHash] = useState(project.snapshot.yaml.hash);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { isDirty },
  } = useForm<Metadata & { notes: string; blocked: string; relatedText: string }>({
    defaultValues: {
      ...project.metadata,
      notes: project.notes,
      blocked: project.metadata.blocked_by.join('\n'),
      relatedText: project.metadata.related.join('\n'),
    },
  });
  return (
    <form
      className="panel form section-space"
      onSubmit={handleSubmit(async (v) => {
        const { notes, blocked, relatedText, ...metadata } = v;
        const ok = await act(
          () =>
            api(`/projects/${project.id}`, 'PUT', {
              metadata: {
                ...metadata,
                current_focus: undefined,
                next: undefined,
                blocked_by: lines(blocked),
                related: lines(relatedText),
                last_reviewed: metadata.last_reviewed || null,
              },
              notes,
              expectedHash,
            }),
          'Сводка сохранена в Control Center',
        );
        if (ok) onClose();
      })}
    >
      <UnsavedChanges dirty={isDirty} />
      <h2>Сводка проекта</h2>
      <div className="form-grid">
        <label>
          Название
          <input required maxLength={240} {...register('name')} />
        </label>
        {(
          [
            ['type', 'Тип', typeLabels],
            ['status', 'Статус', statusLabels],
            ['priority', 'Приоритет', priorityLabels],
          ] as const
        ).map(([key, label, options]) => (
          <label key={key}>
            {label}
            <select {...register(key)}>
              {Object.entries(options).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          Этап
          <input maxLength={120} {...register('stage')} />
        </label>
        <label>
          Дата пересмотра
          <input type="date" {...register('last_reviewed')} />
        </label>
      </div>
      <label>
        Зачем существует
        <textarea rows={2} {...register('goal')} />
      </label>
      <label>
        Блокировки, по одной на строку
        <textarea rows={2} {...register('blocked')} />
      </label>
      <label>
        Связанные имена для PROJECT.yaml
        <textarea rows={2} {...register('relatedText')} />
      </label>
      <label>
        Заметки
        <textarea rows={3} {...register('notes')} />
      </label>
      <div className="row">
        <button className="primary" disabled={busy}>
          Сохранить сводку
        </button>
        <button
          type="button"
          onClick={() => setValue('last_reviewed', today(), { shouldDirty: true })}
        >
          Пересмотрено сегодня
        </button>
        <button
          type="button"
          onClick={() => {
            if (!isDirty || confirm('Отбросить несохранённые изменения сводки?')) onClose();
          }}
        >
          Закрыть редактор
        </button>
      </div>
    </form>
  );
}

export function DecisionFiles({ projectId }: { projectId?: string }) {
  const { data: w } = useWorkspace();
  const [contents, setContents] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const records = w!.fileDecisions.filter((d) => !projectId || d.projectId === projectId);
  return (
    <section id="file-decisions" className="section-space">
      <h2>
        Проектные решения из файлов <span className="count">{records.length}</span>
      </h2>
      <p className="help">
        Источник истины — файл. Control Center только читает; изменения вносятся в исходный
        документ.
      </p>
      <div className="timeline section-space">
        {records.map((record) => (
          <article className="panel prose" key={record.key}>
            {!projectId && (
              <Link to={`/projects/${record.projectId}`}>
                {w!.projects.find((p) => p.id === record.projectId)?.metadata.name}
              </Link>
            )}
            <div className="row between">
              <h3>
                {record.metadata?.id} {record.title}
              </h3>
              <span className="badge">
                Проектное решение ·{' '}
                {record.source === 'repository'
                  ? 'repository'
                  : record.source === 'private_context'
                    ? 'private context'
                    : 'приватный каталог решений'}
              </span>
            </div>
            <p className="source-path">{record.sourcePath}</p>
            {record.error ? (
              <p className="signal attention">{record.error}</p>
            ) : record.metadata ? (
              <>
                <p>
                  {
                    {
                      proposed: 'Предложено',
                      accepted: 'Принято',
                      rejected: 'Отклонено',
                      superseded: 'Заменено',
                    }[record.metadata.status]
                  }{' '}
                  ·{' '}
                  {
                    {
                      unknown: 'Не проверено',
                      not_implemented: 'Не реализовано',
                      partial: 'Частично',
                      implemented: 'Реализовано',
                    }[record.metadata.implementation]
                  }{' '}
                  · {date(record.metadata.date)}
                </p>
                {record.metadata.review_after && (
                  <p>Пересмотр: {date(record.metadata.review_after)}</p>
                )}
                <details>
                  <summary>Метаданные</summary>
                  <dl className="check-dates">
                    <dt>Область</dt>
                    <dd>{record.metadata.area}</dd>
                    <dt>Заменяет</dt>
                    <dd>{record.metadata.supersedes.join(', ') || 'Нет'}</dd>
                    <dt>Заменено решением</dt>
                    <dd>{record.metadata.superseded_by || 'Нет'}</dd>
                    <dt>Видимость / схема</dt>
                    <dd>
                      {record.metadata.visibility} / {record.metadata.schema_version}
                    </dd>
                  </dl>
                </details>
              </>
            ) : (
              <p>Неструктурированная запись решения</p>
            )}
            {record.signals.map((s) => (
              <p className={`signal ${s.level}`} key={s.code}>
                {s.message}
              </p>
            ))}
            {record.hasContent && (
              <details
                onToggle={async (event) => {
                  if (!event.currentTarget.open) {
                    setContents((v) => {
                      const next = { ...v };
                      delete next[record.key];
                      return next;
                    });
                    return;
                  }
                  setErrors((v) => ({ ...v, [record.key]: '' }));
                  try {
                    const result = await api<{ body: string }>(
                      `/projects/${record.projectId}/decision-content`,
                      'POST',
                      { key: record.key },
                    );
                    setContents((v) => ({ ...v, [record.key]: result.body }));
                  } catch (cause) {
                    setErrors((v) => ({ ...v, [record.key]: (cause as Error).message }));
                  }
                }}
              >
                <summary>Читать решение</summary>
                {errors[record.key] ? (
                  <p role="alert">{errors[record.key]}</p>
                ) : contents[record.key] !== undefined ? (
                  <pre className="decision-body">{contents[record.key]}</pre>
                ) : (
                  <p>Чтение исходного файла…</p>
                )}
              </details>
            )}
          </article>
        ))}
      </div>
      {!records.length && (
        <p className="empty">
          Файлов решений пока нет. Поддерживаются DECISIONS.md и decisions/*.md.
        </p>
      )}
    </section>
  );
}

function Context({ project }: { project: Project }) {
  const { act, busy } = useActions();
  const { data: w } = useWorkspace();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm({
    defaultValues: {
      visibility: project.context.visibility,
      privateContextPath: project.context.privateContextPath ?? '',
    },
  });
  useEffect(() => {
    if (!isDirty)
      reset({
        visibility: project.context.visibility,
        privateContextPath: project.context.privateContextPath ?? '',
      });
  }, [project.context.visibility, project.context.privateContextPath, isDirty, reset]);
  const save = async (v: {
    visibility: Project['context']['visibility'];
    privateContextPath: string;
  }) => {
    const next = v.privateContextPath.trim() || null;
    if (
      project.context.privateContextPath &&
      next !== project.context.privateContextPath &&
      !confirm(
        'Файлы не будут удалены. Control Center перестанет их индексировать.' +
          (next ? ' Будет подключён новый каталог.' : ''),
      )
    )
      return;
    if (
      await act(
        () => api(`/projects/${project.id}/context`, 'PUT', { ...v, privateContextPath: next }),
        'Настройки контекста сохранены',
      )
    )
      reset(v);
  };
  const allow = (path: string, allowed: boolean) =>
    act(
      () => api(`/projects/${project.id}/publication-allowlist`, 'PUT', { path, allowed }),
      allowed ? 'Путь отмечен как намеренно публичный' : 'Путь снова проверяется',
    );
  const files = w!.fileDecisions.filter((r) => r.projectId === project.id && r.hasContent);
  return (
    <section className="panel section-space context-panel">
      <UnsavedChanges dirty={isDirty} />
      <h2>Источники контекста</h2>
      <dl className="check-dates">
        <dt>Репозиторий</dt>
        <dd>
          {project.context.visibility === 'unknown' ? 'Не указано' : project.context.visibility}
        </dd>
        <dt>Agent Kit</dt>
        <dd>
          {
            {
              unknown: 'Не проверен',
              local: 'Локальный режим — не отслеживается Git',
              tracked: 'Внутренние файлы отслеживаются Git',
              missing: 'Не найден',
              partial: 'Неполное локальное подключение',
            }[project.context.audit.kit]
          }
        </dd>
        <dt>Приватный контекст</dt>
        <dd>
          {
            {
              disconnected: 'Не подключён',
              connected: 'Подключён',
              unavailable: 'Приватный контекст недоступен',
            }[project.context.privateStatus]
          }
        </dd>
        <dt>Решения</dt>
        <dd>
          {files.filter((r) => r.source === 'repository').length} repository ·{' '}
          {files.filter((r) => r.source !== 'repository').length} private ·{' '}
          {w!.decisions.filter((r) => r.projectId === project.id).length} local
        </dd>
      </dl>
      {project.context.privateContextPath && (
        <p className="source-path">{project.context.privateContextPath}</p>
      )}
      {project.context.hasPrivateMap && <p>Приватная карта проекта найдена</p>}
      <details className="section-space">
        <summary>Настройки контекста</summary>
        <form className="form section-space" onSubmit={handleSubmit(save)}>
          <label>
            Видимость репозитория
            <select {...register('visibility')} disabled={busy}>
              <option value="unknown">Не указано</option>
              <option value="private">Репозиторий приватный</option>
              <option value="public">Репозиторий публичный</option>
            </select>
          </label>
          <label>
            Каталог приватного контекста
            <input {...register('privateContextPath')} disabled={busy} />
          </label>
          <p className="help">
            Настройки хранятся только в SQLite. Control Center читает файлы; версионирование и
            резервное хранение каталога настраиваете вы.
          </p>
          <div className="row">
            <button disabled={busy}>Сохранить контекст</button>
            {project.context.privateContextPath && (
              <button
                disabled={busy}
                type="button"
                onClick={handleSubmit((v) => save({ ...v, privateContextPath: '' }))}
              >
                Отключить приватный контекст
              </button>
            )}
          </div>
        </form>
        <h3>Намеренно публичные пути</h3>
        {project.context.allowlist.map((file) => (
          <p className="row between" key={file}>
            <span className="source-path">{file}</span>
            <button disabled={busy} onClick={() => allow(file, false)}>
              Убрать из списка
            </button>
          </p>
        ))}
      </details>
      {project.context.visibility === 'public' && (
        <details className="section-space">
          <summary>Проверка публикации · {project.context.audit.findings.length}</summary>
          <p className="help">
            Проверяются отслеживаемые файлы Git, включая подготовленные изменения. Это не проверка
            remote или истории публикаций.
          </p>
          {project.context.audit.status !== 'ok' ? (
            <p>Не удалось проверить отслеживаемые Git файлы.</p>
          ) : (
            !project.context.audit.findings.length && (
              <p>Нет путей, требующих проверки публикации.</p>
            )
          )}
          {project.context.audit.findings.map((f) => (
            <article className="section-space" key={f.path}>
              <p className="source-path">
                <strong>{f.path}</strong>
              </p>
              <p>
                {f.kind === 'infrastructure'
                  ? 'В публичном репозитории отслеживается внутренняя инфраструктура. Проверьте необходимость публикации.'
                  : 'Проверьте, что файл действительно должен быть публичным и предназначен для внешней аудитории.'}
              </p>
              <button disabled={busy} onClick={() => allow(f.path, true)}>
                Этот путь намеренно публичный
              </button>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}

function Maintenance({ project }: { project: Project }) {
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [candidate, setCandidate] = useState('');
  const [sources, setSources] = useState(project.decisionSources.join('\n'));
  const hash = { expectedHash: project.snapshot.yaml.hash };
  return (
    <>
      {!project.available && (
        <section className="panel form section-space">
          <h2>Каталог проекта недоступен</h2>
          <p>
            После переноса обновите список проектов и выберите обнаруженный каталог. Совпадение
            remote — подсказка, не автоматическая привязка.
          </p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (
                confirm(
                  'Перепривязать к выбранному каталогу? Старый ID, записи и локальная сводка сохранятся. Новый обнаруженный элемент будет заменён.',
                )
              )
                void act(
                  () => api(`/projects/${project.id}/rebind`, 'POST', { targetId: candidate }),
                  'Проект перепривязан, история сохранена',
                );
            }}
          >
            <label>
              Новый найденный каталог
              <select value={candidate} onChange={(e) => setCandidate(e.target.value)} required>
                <option value="" disabled>
                  Выберите каталог
                </option>
                {w!.projects
                  .filter((p) => p.id !== project.id && p.available)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.path}
                      {p.snapshot.git.remote &&
                      p.snapshot.git.remote === project.snapshot.git.remote
                        ? ' · совпадает remote'
                        : ''}
                    </option>
                  ))}
              </select>
            </label>
            <button disabled={busy || !candidate}>Перепривязать</button>
          </form>
        </section>
      )}
      {project.yamlConflict && (
        <section className="message warning section-space">
          <h2>PROJECT.yaml изменился после локального редактирования</h2>
          <details>
            <summary>Посмотреть различия</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Поле</th>
                    <th>Control Center</th>
                    <th>PROJECT.yaml сейчас</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(project.metadata).map((key) => {
                    const k = key as keyof Metadata;
                    return (
                      <tr key={k}>
                        <th>{k}</th>
                        <td>{String(project.metadata[k] ?? '')}</td>
                        <td>{String(project.snapshot.yaml.metadata?.[k] ?? 'Нет данных')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
          {project.snapshot.yaml.error && <p>{project.snapshot.yaml.error}</p>}
          <div className="row section-space">
            <button
              disabled={busy || !!project.snapshot.yaml.error || !project.available}
              onClick={() => {
                if (
                  confirm(
                    'Заменить локальную сводку текущими данными PROJECT.yaml? Заметки сохранятся.',
                  )
                )
                  void act(
                    () => api(`/projects/${project.id}/use-yaml`, 'POST', hash),
                    'Используется PROJECT.yaml',
                  );
              }}
            >
              Использовать PROJECT.yaml
            </button>
            <button
              disabled={busy || !!project.snapshot.yaml.error || !project.available}
              onClick={() =>
                act(
                  () => api(`/projects/${project.id}/keep-local`, 'POST', hash),
                  'Оставлена версия Control Center. Файл не изменён.',
                )
              }
            >
              Оставить версию Control Center
            </button>
          </div>
        </section>
      )}
      <details className="panel section-space">
        <summary>Дополнительные каталоги решений</summary>
        <form
          className="form section-space"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                api(`/projects/${project.id}/decision-sources`, 'PUT', { paths: lines(sources) }),
              'Источники решений сохранены и прочитаны',
            );
          }}
        >
          <label>
            Каталоги решений, каждый с новой строки
            <textarea rows={3} value={sources} onChange={(e) => setSources(e.target.value)} />
          </label>
          <button disabled={busy}>Сохранить источники решений</button>
        </form>
      </details>
    </>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: w } = useWorkspace();
  const { act, busy } = useActions();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState('');
  const [relationType, setRelationType] = useState('uses');
  const p = w!.projects.find((p) => p.id === id);
  useEffect(() => {
    let current = true;
    void api(`/projects/${id}`)
      .then(() => {
        if (current) void client.invalidateQueries({ queryKey: workspaceKey });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [id, client]);
  if (!p) return <p className="empty">Проект не загружен.</p>;
  const tasks = w!.tasks.filter((t) => t.projectId === p.id && !t.completedAt);
  const checks = w!.checks.filter((c) => c.projectId === p.id && c.status !== 'completed');
  const request = (suffix: string, message: string) =>
    act(
      () => api(`/projects/${p.id}/${suffix}`, 'POST', { expectedHash: p.snapshot.yaml.hash }),
      message,
    );
  return (
    <>
      <Link to="/projects" className="back-link">
        ← Все проекты
      </Link>
      <div className="page-heading">
        <div>
          <p className="section-label">{typeLabels[p.metadata.type]}</p>
          <h1>{p.metadata.name}</h1>
          <div className="row">
            <span className={`badge ${p.metadata.status}`}>{statusLabels[p.metadata.status]}</span>
            <span className="muted">Приоритет: {priorityLabels[p.metadata.priority]}</span>
            <span className="muted">{p.metadata.stage}</span>
          </div>
          <p className="help">
            {p.available ? 'Снимок файлов:' : 'Последний доступный снимок:'}{' '}
            <time dateTime={p.snapshot.scannedAt}>
              {new Date(p.snapshot.scannedAt).toLocaleString('ru')}
            </time>
          </p>
        </div>
        <div className="row">
          {!editing && (
            <button disabled={busy} onClick={() => setEditing(true)}>
              Изменить сводку
            </button>
          )}
          <button
            disabled={busy}
            onClick={async () => {
              if (
                confirm(
                  `Удалить «${p.metadata.name}» из Control Center? Каталог и файлы останутся на диске. Записи будут отвязаны, локальная сводка и связи удалены, путь исключён из сканирования.`,
                ) &&
                (await act(
                  () => api(`/projects/${p.id}`, 'DELETE'),
                  'Проект удалён из Control Center',
                ))
              )
                void navigate('/projects');
            }}
          >
            Удалить из Control Center
          </button>
        </div>
      </div>
      {!p.available && (
        <div className="message warning">
          Каталог недоступен или вне настроек. Показан сохранённый снимок.
        </div>
      )}
      {editing && (
        <MetadataEditor key={`metadata:${p.id}`} project={p} onClose={() => setEditing(false)} />
      )}
      <div className="project-dossier section-space">
        <div>
          <section className="project-brief prose">
            <h2>Зачем существует</h2>
            <p className="preserve">{p.metadata.goal || 'Цель пока не описана.'}</p>
            {(['now', 'next'] as const).map((state) => (
              <div key={state}>
                <h2>{state === 'now' ? 'Сейчас' : 'Следующий шаг'}</h2>
                {tasks.some((t) => t.state === state) ? (
                  <ol>
                    {tasks
                      .filter((t) => t.state === state)
                      .map((t) => (
                        <li key={t.id}>
                          <Link to={`/tasks?project=${p.id}&task=${t.code}`}>
                            {t.code} · {t.title}
                          </Link>
                        </li>
                      ))}
                  </ol>
                ) : (
                  <p className="muted">
                    {state === 'now'
                      ? 'Задачи на сейчас ещё не выбраны.'
                      : 'Следующие задачи ещё не выбраны.'}
                  </p>
                )}
              </div>
            ))}
            {(p.metadata.current_focus || p.metadata.next.length > 0) && (
              <details className="section-space legacy-plan">
                <summary>Прежний план из сводки</summary>
                <p className="preserve">
                  <strong>Фокус:</strong> {p.metadata.current_focus}
                </p>
                <ol>
                  {p.metadata.next.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ol>
                <p>
                  Текущая работа редактируется на доске задач. Прежний план доступен только для
                  чтения; экспорт сохраняет его и не заменяет задачами.
                </p>
                {p.metadata.next.length > 0 && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      request(
                        'import-plan',
                        'Следующие шаги добавлены на доску. Прежняя сводка сохранена.',
                      )
                    }
                  >
                    Добавить шаги на доску
                  </button>
                )}
              </details>
            )}
          </section>
          {!!checks.length && (
            <section className="section-space">
              <h2>Проверки проекта</h2>
              {checks.map((c) => (
                <CheckCard key={c.id} check={c} compact />
              ))}
              <Link to={`/checks?new=1&project=${p.id}`}>Новая проверка →</Link>
            </section>
          )}
          <section className="section-space">
            <div className="section-heading">
              <h2>
                Задачи <span className="count">{tasks.length}</span>
              </h2>
              <Link to={`/tasks?project=${p.id}`}>Добавить задачу →</Link>
              <Link to={`/history?project=${p.id}`}>История работы →</Link>
              <Link to={`/timeline?project=${p.id}`}>История проекта →</Link>
            </div>
            <div className="panel compact-list">
              {tasks.map((t) => (
                <div className="row between" key={t.id}>
                  <span>{t.title}</span>
                  <span className="badge">{taskLabels[t.state]}</span>
                </div>
              ))}
              {!tasks.length && <p className="muted">Открытых задач нет.</p>}
            </div>
          </section>
          <section className="section-space">
            <h2>Последние изменения</h2>
            <div className="panel activity-list">
              {p.snapshot.git.commits.map((c) => (
                <div className="activity" key={c.hash}>
                  <code>{c.hash.slice(0, 7)}</code>
                  <div>
                    <p>{c.subject}</p>
                    <small>{date(c.date)}</small>
                  </div>
                </div>
              ))}
              {!p.snapshot.git.commits.length && (
                <p className="empty">{p.snapshot.git.error || 'История commits отсутствует.'}</p>
              )}
            </div>
          </section>
          <section className="section-space">
            <div className="section-heading">
              <h2>Локальные решения Control Center</h2>
              <Link to="/decisions">Все решения →</Link>
            </div>
            <div className="panel compact-list">
              {w!.decisions
                .filter((d) => d.projectId === p.id)
                .map((d) => (
                  <div key={d.id}>
                    <strong>{d.title}</strong>
                    <p>{d.decision}</p>
                    <small>
                      {decisionLabels[d.status]} · {date(d.date)}
                    </small>
                  </div>
                ))}
            </div>
          </section>
          {p.notes && (
            <section className="panel prose section-space">
              <h2>Заметки</h2>
              <p className="preserve">{p.notes}</p>
            </section>
          )}
        </div>
        <aside>
          <section className="panel prose">
            <h2>Требуют внимания</h2>
            <ul className="project-signals">
              {p.signals.map((s, i) => (
                <li key={i} className={`signal ${s.level || 'attention'}`}>
                  <strong>
                    {s.level === 'info'
                      ? 'Информация'
                      : s.level === 'decision'
                        ? 'Решение'
                        : 'Внимание'}
                    .
                  </strong>{' '}
                  <span>{s.message}</span>
                </li>
              ))}
            </ul>
            {!p.signals.length && <p className="muted">По доступным данным сигналов нет.</p>}
            <h3>Блокировки</h3>
            {p.metadata.blocked_by.length ? (
              <ul>
                {p.metadata.blocked_by.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            ) : (
              <p>Не указаны.</p>
            )}
          </section>
          <Context key={p.id} project={p} />
          <section className="panel section-space">
            <h2>Связи</h2>
            {w!.relations
              .filter((r) => r.sourceId === p.id || r.targetId === p.id)
              .map((r) => (
                <div className="relation-item" key={r.id}>
                  <div>
                    <small>
                      {r.sourceId === p.id
                        ? relationLabels[r.type]
                        : `Входящая связь: ${relationLabels[r.type].toLowerCase()}`}
                    </small>
                    <Link to={`/projects/${r.sourceId === p.id ? r.targetId : r.sourceId}`}>
                      {
                        w!.projects.find(
                          (v) => v.id === (r.sourceId === p.id ? r.targetId : r.sourceId),
                        )?.metadata.name
                      }
                    </Link>
                  </div>
                  <button
                    className="text-button"
                    aria-label="Удалить связь"
                    disabled={busy}
                    onClick={() => act(() => api(`/relations/${r.id}`, 'DELETE'), 'Связь удалена')}
                  >
                    ×
                  </button>
                </div>
              ))}
            <form
              className="form section-space"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    () =>
                      api('/relations', 'POST', {
                        sourceId: p.id,
                        targetId: target,
                        type: relationType,
                      }),
                    'Связь добавлена',
                  )
                )
                  setTarget('');
              }}
            >
              <label>
                Тип связи
                <select value={relationType} onChange={(e) => setRelationType(e.target.value)}>
                  {Object.entries(relationLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Связанный проект
                <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                  <option value="" disabled>
                    Выберите проект
                  </option>
                  {w!.projects
                    .filter((v) => v.id !== p.id)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.metadata.name}
                      </option>
                    ))}
                </select>
              </label>
              <button disabled={busy || !target}>Добавить связь</button>
            </form>
          </section>
          <section className="panel section-space prose">
            <h2>Метаданные</h2>
            <p>
              Источник:{' '}
              <strong>
                {p.metadataSource === 'local'
                  ? 'Control Center'
                  : p.metadataSource === 'yaml'
                    ? 'PROJECT.yaml'
                    : 'Имя каталога'}
              </strong>
            </p>
            <p className="help">
              Экспорт записывает сводку и сохранённый прежний план в PROJECT.yaml. Задачи и
              результаты остаются в Control Center. Неизвестные поля сохраняются.
            </p>
            <div className="form">
              <button
                disabled={busy || editing || !p.available}
                onClick={() => request('export', 'PROJECT.yaml записан в репозиторий')}
              >
                {p.snapshot.yaml.exists ? 'Обновить PROJECT.yaml' : 'Создать PROJECT.yaml'}
              </button>
              {p.metadataSource === 'local' && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        'Убрать локальные правки сводки и использовать PROJECT.yaml? Заметки сохранятся.',
                      )
                    )
                      void request('use-yaml', 'Источник сводки обновлён');
                  }}
                >
                  Использовать данные из YAML
                </button>
              )}
            </div>
            <small>Пересмотрено: {date(p.metadata.last_reviewed)}</small>
          </section>
        </aside>
      </div>
      <DecisionFiles projectId={p.id} />
      <Maintenance key={`maintenance:${p.id}`} project={p} />
      <details className="panel section-space">
        <summary>Информация о репозитории</summary>
        <dl className="repository-info">
          <dt>Локальный путь</dt>
          <dd>{p.path}</dd>
          <dt>Git / ветка</dt>
          <dd>
            {p.snapshot.git.present ? p.snapshot.git.branch || 'Не удалось определить' : 'Без Git'}
          </dd>
          <dt>Рабочая директория</dt>
          <dd>
            {p.snapshot.git.dirty === null
              ? 'Нет данных'
              : p.snapshot.git.dirty
                ? `Изменённых файлов: ${p.snapshot.git.changedFiles}`
                : 'Нет изменений'}
          </dd>
          <dt>Remote</dt>
          <dd>{p.snapshot.git.remote || 'Не указан'}</dd>
          <dt>AGENTS.md</dt>
          <dd>{p.snapshot.hasAgents ? 'Есть' : 'Нет'}</dd>
          <dt>Карта проекта</dt>
          <dd>{p.snapshot.mapFile || 'Не найдена'}</dd>
          <dt>Основные файлы</dt>
          <dd>{p.snapshot.files.join(', ') || 'Не найдены'}</dd>
          <dt>package.json</dt>
          <dd>
            {p.snapshot.package?.name || 'Нет имени пакета'} · scripts:{' '}
            {p.snapshot.package?.scripts.join(', ') || 'нет'}
          </dd>
          <dt>Снимок</dt>
          <dd>{new Date(p.snapshot.scannedAt).toLocaleString('ru')}</dd>
        </dl>
      </details>
    </>
  );
}
