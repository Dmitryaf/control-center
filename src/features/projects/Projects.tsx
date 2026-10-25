import { useState } from 'react';
import { Link } from 'react-router';
import type { Project } from '../../../shared/contracts';
import { statusLabels, typeLabels, date, priorityLabels } from '../../shared/labels';
import { useWorkspace } from '../../shared/workspace';
import { RecentHistoryResult, type RecentHistoryState } from '../history/RecentHistory';
export function ProjectCard({
  project,
  overview = false,
  recentHistory,
}: {
  project: Project;
  overview?: boolean;
  recentHistory?: RecentHistoryState;
}) {
  const { data: w } = useWorkspace();
  const tasks = w!.tasks
    .filter((t) => t.projectId === project.id && !t.completedAt)
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        b.number - a.number,
    );
  const checks = w!.checks.filter((c) => c.projectId === project.id && c.status === 'active');
  const action = checks
    .flatMap((c) => (c.lastExternalActionAt ? [c.lastExternalActionAt] : []))
    .sort()
    .at(-1);
  return (
    <article
      className={`project-row${overview ? ' project-summary' : ''}`}
      aria-label={project.metadata.name}
    >
      <div className="project-identity">
        <p className="section-label">
          {typeLabels[project.metadata.type]} · {statusLabels[project.metadata.status]}
        </p>
        <h3>
          <Link to={`/projects/${project.id}`}>{project.metadata.name}</Link>
        </h3>
        {project.metadata.priority === 'high' && <p className="priority">↑ Высокий приоритет</p>}
        {project.metadata.stage && <p className="help">Этап · {project.metadata.stage}</p>}
        <p className="project-goal preserve">{project.metadata.goal || 'Цель пока не записана.'}</p>
        {overview && !project.available && (
          <p className="warning-text">Каталог недоступен · сохранённый снимок</p>
        )}
      </div>
      <div className="project-focus">
        <p className="section-label">Открытые задачи · {tasks.length}</p>
        <ul className="work-list current-task-list">
          {tasks.slice(0, 3).map((task) => (
            <li key={task.id}>
              <Link to={`/tasks?task=${task.code}`}>
                {task.code} · {task.title}
              </Link>
              <p className="help">{priorityLabels[task.priority]} приоритет</p>
            </li>
          ))}
        </ul>
        {!tasks.length && <p className="help">Открытых задач нет.</p>}
        {tasks.length > 3 && <Link to={`/tasks?project=${project.id}`}>Все задачи →</Link>}
        {project.metadata.blocked_by.length > 0 && (
          <p className="help">Препятствия: {project.metadata.blocked_by.join('; ')}</p>
        )}
      </div>
      <div className="project-activity">
        {overview && (
          <div className="project-latest">
            <p className="section-label">Последняя запись работы</p>
            {recentHistory && (
              <RecentHistoryResult
                query={{
                  ...recentHistory,
                  data: recentHistory.data
                    ? {
                        ...recentHistory.data,
                        items: recentHistory.data.items.filter(
                          (item) => item.scopeProjectId === project.id,
                        ),
                      }
                    : undefined,
                }}
                timezone={w!.settings.timezone}
                compact
              />
            )}
          </div>
        )}
        <details open={overview ? undefined : true} className="project-snapshot">
          <summary>Файлы и проверки</summary>
          <p className="help">
            {project.available ? 'Снимок файлов:' : 'Последний доступный снимок:'}{' '}
            <time dateTime={project.snapshot.scannedAt}>
              {new Date(project.snapshot.scannedAt).toLocaleString('ru')}
            </time>
          </p>
          <p>{checks.length} активных проверок</p>
          <p className="help">
            Внешний шаг: {action ? date(action) : 'нет записи в активных проверках'}
          </p>
          <p className="help">
            {project.snapshot.git.present
              ? `Git: ${date(project.snapshot.git.commits[0]?.date)}`
              : 'Без Git'}
          </p>
          {!project.available ? (
            <p className="warning-text">Каталог недоступен · сохранённый снимок</p>
          ) : (
            project.snapshot.git.dirty && <p className="help">Есть незакоммиченные изменения</p>
          )}
        </details>
      </div>
    </article>
  );
}
export default function Projects() {
  const { data: w } = useWorkspace();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const filters = {
    all: 'Все',
    active: 'Активные',
    paused: 'Отложенные',
    completed: 'Завершённые',
    tool: 'Инструменты',
    product: 'Продукты',
    experiment: 'Эксперименты',
    high: 'Высокий приоритет',
  };
  const projects = w!.projects.filter(
    (p) =>
      (filter === 'all' ||
        [p.metadata.status, p.metadata.type, p.metadata.priority].some((v) => v === filter)) &&
      `${p.metadata.name} ${p.path}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru')),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">Каталог</p>
          <h1>
            Проекты <span className="count">{w!.projects.length}</span>
          </h1>
          <p className="subtitle">Продукты, инструменты и эксперименты рядом.</p>
        </div>
        <Link className="button" to="/settings">
          Каталоги проектов
        </Link>
      </div>
      <div className="toolbar">
        <div className="filter-bar">
          {Object.entries(filters).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              className={filter === key ? 'active' : ''}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Поиск проектов"
          placeholder="Найти проект…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="project-register">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
      {!projects.length && (
        <div className="panel empty">
          <h2>Проекты не найдены</h2>
          <p>Измените фильтр или добавьте каталог в настройках.</p>
          <Link to="/settings">Открыть настройки →</Link>
        </div>
      )}
    </>
  );
}
