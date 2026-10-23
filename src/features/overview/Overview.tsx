import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '../../shared/workspace';
import { api } from '../../shared/http';
import { date, priorityLabels } from '../../shared/labels';
import type { TaskHistoryPage } from '../../../shared/contracts';
import { ProjectCard } from '../projects/Projects';
export default function Overview() {
  const { data: w } = useWorkspace();
  const history = useQuery({
    queryKey: ['recent-work'],
    refetchInterval: 5000,
    queryFn: ({ signal }) =>
      api<TaskHistoryPage>('/task-history?limit=5', 'GET', undefined, signal),
    retry: false,
  });
  const checks = w!.checks
    .filter((c) => c.status === 'active')
    .sort(
      (a, b) =>
        Number(b.signals.some((s) => s.level === 'decision')) -
          Number(a.signals.some((s) => s.level === 'decision')) ||
        b.daysWithoutMovement - a.daysWithoutMovement,
    );
  const active = w!.projects.filter((p) => p.metadata.status === 'active');
  const attention = [
    ...checks.map((c) => ({
      signals: c.signals,
      title: c.title,
      to: `/checks/${c.id}`,
      kind: 'Проверка',
    })),
    ...w!.projects.map((p) => ({
      signals: p.signals,
      title: p.metadata.name,
      to: `/projects/${p.id}`,
      kind: 'Проект',
    })),
  ]
    .map((v) => ({
      ...v,
      signals: v.signals.filter((s) => s.level !== 'info'),
      level: v.signals.some((s) => s.level === 'decision') ? 'decision' : 'attention',
    }))
    .filter((v) => v.signals.length)
    .sort((a, b) => Number(b.level === 'decision') - Number(a.level === 'decision'));
  const now = w!.tasks
    .filter((t) => !t.completedAt && t.state === 'now')
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        b.number - a.number,
    );
  const recent = w!.projects
    .flatMap((project) => project.snapshot.git.commits.map((commit) => ({ project, commit })))
    .sort((a, b) => b.commit.date.localeCompare(a.commit.date))
    .slice(0, 10);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Задачи и результаты</p>
          <h1>Сейчас</h1>
        </div>
        <p className="scan-stamp">
          Последнее сканирование
          <br />
          <time>
            {w!.scan.scannedAt
              ? new Date(w!.scan.scannedAt).toLocaleString('ru')
              : 'Сканирования ещё не было'}
          </time>
        </p>
      </div>
      <section className="current-work" aria-labelledby="current-work-heading">
        <div className="section-heading">
          <h2 id="current-work-heading">В работе</h2>
          <Link to="/tasks">Задачи · {now.length} →</Link>
        </div>
        <ul className="work-list current-task-list">
          {now.map((t) => (
            <li key={t.id}>
              <Link to={`/tasks?task=${t.code}`}>
                {t.code} · {t.title}
              </Link>
              <div className="row">
                {t.projectId ? (
                  <Link to={`/projects/${t.projectId}`}>
                    {w!.projects.find((p) => p.id === t.projectId)?.metadata.name}
                  </Link>
                ) : (
                  <span className="muted">Общая задача</span>
                )}
                <span className="help">{priorityLabels[t.priority]}</span>
              </div>
            </li>
          ))}
        </ul>
        {!now.length && (
          <p className="empty">Выберите задачу на сейчас на доске или создайте новую.</p>
        )}
      </section>
      {!w!.settings.roots.length && (
        <div className="panel welcome">
          <h2>Начните с каталога проектов</h2>
          <p>Укажите, где лежат ваши репозитории. GitHub и PROJECT.yaml не обязательны.</p>
          <Link to="/settings" className="button primary">
            Добавить каталог →
          </Link>
        </div>
      )}
      <section id="attention" className="attention-queue" aria-labelledby="attention-heading">
        <div className="section-heading">
          <h2 id="attention-heading">
            Требуют внимания <span className="count">{attention.length}</span>
          </h2>
          <span className="help">Сначала — решения, затем — сигналы</span>
        </div>
        {attention.map((item) => (
          <div key={item.to} className={`attention-line ${item.level}`}>
            <span className="signal-label">
              {item.level === 'decision' ? 'Решение' : 'Внимание'}
            </span>
            <Link to={item.to}>
              <small>{item.kind}</small>
              {item.title}
            </Link>
            <ul className="signal-reasons">
              {item.signals.map((s, i) => (
                <li key={i}>{s.message}</li>
              ))}
            </ul>
          </div>
        ))}
        {!attention.length && <p className="empty">По доступным данным сигналов нет.</p>}
      </section>
      <section className="recent-work section-space" aria-labelledby="recent-work-heading">
        <div className="section-heading">
          <h2 id="recent-work-heading">Последние результаты</h2>
          <Link to="/history">Вся история →</Link>
        </div>
        <p className="help">
          Последние пять записей работы. Сведения о проверках сохранены со слов пользователя или
          агента.
        </p>
        {history.isPending && <p role="status">Загружаем результаты…</p>}
        {history.error && (
          <div className="message warning" role="alert" aria-label="Последние результаты">
            {history.error.message}
            <button disabled={history.isFetching} onClick={() => history.refetch()}>
              Повторить
            </button>
          </div>
        )}
        <ol className="recent-work-list">
          {history.data?.items.map((e) => (
            <li key={e.id} className="activity">
              <time dateTime={e.recordedAt}>{new Date(e.recordedAt).toLocaleString('ru')}</time>
              <div>
                <Link to={`/history?task=${e.task.code}`}>
                  {e.task.code} · {e.task.title}
                </Link>
                <p className="help">
                  {e.projectName ?? 'Общая задача'} ·{' '}
                  {
                    {
                      baseline: 'Запись при переходе',
                      result: 'Результат сохранён',
                      completed: 'Задача завершена',
                      reopened: 'Возвращена в работу',
                    }[e.kind]
                  }
                </p>
                <p className="preserve">{e.task.result?.summary ?? 'Результат не указан.'}</p>
                {e.task.result?.remaining && (
                  <p className="help">Осталось: {e.task.result.remaining}</p>
                )}
                {e.kind === 'baseline' && (
                  <p className="help">
                    Известная запись при переходе; время последнего сохранения, более ранняя история
                    недоступна.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
        {history.data && !history.data.items.length && (
          <p className="empty">
            Сохранённых результатов пока нет. Они появятся после записи результата или завершения
            задачи.
          </p>
        )}
      </section>
      <div className="row overview-links section-space">
        <Link to="/analysis">Анализ проектов →</Link>
        <Link to="/projects">Все проекты · {w!.projects.length} →</Link>
        <Link to="/ideas">
          Идеи · {w!.ideas.filter((i) => ['new', 'consider', 'testing'].includes(i.state)).length} →
        </Link>
        {w!.decisions.some((d) => d.status === 'pending') && (
          <Link to="/decisions">Ожидают решения →</Link>
        )}
      </div>
      <details className="overview-details section-space">
        <summary>
          Проверки: {checks.length} · активные проекты: {active.length}
        </summary>
        <div className="section-space">
          <section className="checks-overview">
            <div className="section-heading">
              <h2>
                Внешнее движение <span className="count">{checks.length} проверок</span>
              </h2>
              <Link to="/checks">Все проверки →</Link>
            </div>
            <p className="help">
              Время без внешнего шага. Свидетельства и commits не обнуляют этот отсчёт.
            </p>
            <div className="check-register">
              {checks.map((c) => (
                <article className="check-card compact" key={c.id}>
                  <div className="movement-clock">
                    <strong>
                      {c.daysWithoutMovement}
                      <small>дн.</small>
                    </strong>
                    <span>без внешнего шага</span>
                  </div>
                  <div className="check-reading">
                    <h3>
                      <Link to={`/checks/${c.id}`}>{c.title}</Link>
                    </h3>
                    <div className="next-step">
                      <span>Следующий внешний шаг</span>
                      <p>{c.nextExternalAction}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="section-space">
            <div className="section-heading">
              <h2>
                Активные проекты <span className="count">{active.length}</span>
              </h2>
              <Link to="/projects">Все проекты →</Link>
            </div>
            <div className="project-register">
              {active.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          </section>
          <details className="section-space git-overview">
            <summary>Изменения в Git · внутренняя работа</summary>
            <h2>Изменения в Git</h2>
            <div className="activity-list">
              {recent.map(({ project, commit }) => (
                <div className="activity" key={project.id + commit.hash}>
                  <time>{date(commit.date)}</time>
                  <div>
                    <Link to={`/projects/${project.id}`}>{project.metadata.name}</Link>
                    <p>{commit.subject}</p>
                  </div>
                </div>
              ))}
              {!recent.length && (
                <p className="empty">История commits появится после сканирования.</p>
              )}
            </div>
          </details>
        </div>
      </details>
    </>
  );
}
