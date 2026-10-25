import { Link } from 'react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HistoryPage } from '../../../shared/history';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { date, priorityLabels } from '../../shared/labels';
import { RecentHistory } from '../history/RecentHistory';
import { dateInZone } from '../../../shared/periods';
import { ProjectCard } from '../projects/Projects';
export default function Overview() {
  const { data: w } = useWorkspace();
  const timezone = w!.settings.timezone;
  const latestHistory = useQuery({
    queryKey: ['history', 'latest-projects', timezone],
    queryFn: ({ signal }) =>
      api<HistoryPage>(
        `/history/latest-projects?timezone=${encodeURIComponent(timezone)}`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
    refetchInterval: 5000,
  });
  const [period, setPeriod] = useState('all');
  const today = dateInZone(new Date(), w!.settings.timezone);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (period === 'all' ? 0 : Number(period) - 1));
  const range = period === 'all' ? '' : `&from=${start.toISOString().slice(0, 10)}&to=${today}`;
  const checks = w!.checks
    .filter((c) => c.status === 'active')
    .sort(
      (a, b) =>
        Number(b.signals.some((s) => s.level === 'decision')) -
          Number(a.signals.some((s) => s.level === 'decision')) ||
        b.daysWithoutMovement - a.daysWithoutMovement,
    );
  const projects = [...w!.projects].sort(
    (a, b) =>
      ({ active: 0, paused: 1, unknown: 2, completed: 3 })[a.metadata.status] -
        { active: 0, paused: 1, unknown: 2, completed: 3 }[b.metadata.status] ||
      Number(b.metadata.priority === 'high') - Number(a.metadata.priority === 'high') ||
      a.metadata.name.localeCompare(b.metadata.name, 'ru'),
  );
  const attention = [
    ...checks.map((c) => ({
      signals: c.signals,
      title: c.title,
      to: `/checks/${c.id}`,
      kind: 'Проверка',
      key: `check:${c.id}`,
    })),
    ...w!.projects.map((p) => ({
      signals: p.signals.map((signal) =>
        signal.code === 'decision'
          ? {
              ...signal,
              message: `${signal.message} · ${w!.decisions
                .filter((decision) => decision.projectId === p.id && decision.status === 'pending')
                .map((decision) => decision.title)
                .join('; ')}`,
            }
          : signal,
      ),
      title: p.metadata.name,
      to: `/projects/${p.id}`,
      kind: 'Проект',
      key: `project:${p.id}`,
    })),
    ...w!.decisions
      .filter(
        (decision) =>
          decision.status === 'pending' &&
          (!decision.projectId ||
            !w!.projects.some((project) => project.id === decision.projectId)),
      )
      .map((decision) => ({
        signals: [{ code: 'decision', level: 'decision' as const, message: decision.decision }],
        title: decision.title,
        to: '/decisions',
        key: decision.id,
        kind: 'Общее решение',
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
          <p className="section-label">Проекты и работа</p>
          <h1>Обзор</h1>
          <p className="subtitle">Где находятся проекты, что в работе и что удалось сохранить.</p>
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
      <div className="row overview-shortcuts">
        <Link to="/observations">Записать наблюдение</Link>
        <Link to="/reviews?kind=week">Обзор недели →</Link>
        <Link to="/reviews?kind=month">Обзор месяца →</Link>
        <a href="#attention">Решения и внимание · {attention.length} ↓</a>
        <a href="#recent-work">Записи за период ↓</a>
      </div>
      <section className="current-work" aria-labelledby="current-work-heading">
        <div className="section-heading">
          <h2 id="current-work-heading">Проекты сейчас</h2>
          <Link to="/projects">Все проекты · {projects.length} →</Link>
        </div>
        <div className="project-register">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              overview
              recentHistory={latestHistory}
            />
          ))}
        </div>
        {!projects.length && (
          <p className="empty">Проектов пока нет. Добавьте каталог в настройках.</p>
        )}
        {now.some(
          (task) => !task.projectId || !projects.some((project) => project.id === task.projectId),
        ) && (
          <section className="general-work section-space" aria-labelledby="general-work-heading">
            <h3 id="general-work-heading">Общие задачи на сейчас</h3>
            <ul className="work-list current-task-list">
              {now
                .filter(
                  (task) =>
                    !task.projectId || !projects.some((project) => project.id === task.projectId),
                )
                .map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks?task=${t.code}`}>
                      {t.code} · {t.title}
                    </Link>
                    <div className="row">
                      <span className="muted">
                        {t.projectId ? 'Проект недоступен в списке' : 'Общая задача'}
                      </span>
                      <span className="help">{priorityLabels[t.priority]}</span>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}
        <p className="help section-space">
          <Link to="/tasks">Открыть доску задач →</Link>
        </p>
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
          <div key={item.key} className={`attention-line ${item.level}`}>
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
      <section
        id="recent-work"
        className="recent-work section-space"
        aria-labelledby="recent-work-heading"
      >
        <div className="section-heading">
          <h2 id="recent-work-heading">Последние результаты</h2>
          <Link
            to={`/timeline${range ? `?${range.slice(1)}&timezone=${encodeURIComponent(w!.settings.timezone)}` : ''}`}
          >
            Вся история →
          </Link>
        </div>
        <label className="overview-period">
          Период записей
          <select value={period} onChange={(event) => setPeriod(event.target.value)}>
            <option value="all">Все время</option>
            <option value="7">Последние 7 дней</option>
            <option value="30">Последние 30 дней</option>
          </select>
        </label>
        <p className="help">
          До пяти последних записей: результаты, наблюдения, решения, проверки и обзоры. Часовой
          пояс: {w!.settings.timezone}. Сохранённые сведения не являются независимой проверкой.
          {period !== 'all' &&
            ` Диапазон: ${start.toISOString().slice(0, 10)} — ${today}; текущий день ещё не завершён.`}
        </p>
        <RecentHistory
          from={period === 'all' ? undefined : start.toISOString().slice(0, 10)}
          to={period === 'all' ? undefined : today}
        />
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
        <summary>Внешние проверки: {checks.length} · изменения в Git</summary>
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
