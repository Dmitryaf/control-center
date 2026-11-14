import { taskInProject } from '../../../shared/task-projects';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Project } from '../../../shared/contracts';
import { isClosedProject } from '../../../shared/project-lifecycle';
import { isTaskOpen } from '../../../shared/task-status';
import { statusLabels, typeLabels, date, priorityLabels } from '../../shared/labels';
import { useWorkspace } from '../../shared/workspace';
import { ActionMenu, ActionMenuItem } from '../../shared/ActionMenu';
import { RemoveProject } from './RemoveProject';
import './projects.css';

function CatalogRow({ project }: { project: Project }) {
  const { data: w } = useWorkspace();
  const { name, status, goal, type, priority } = project.metadata;
  const count = w!.tasks.filter((t) => taskInProject(t, project.id) && isTaskOpen(t)).length;
  const checks = w!.checks.filter((c) => c.projectId === project.id && c.status === 'active');
  const lastAction = checks
    .flatMap((c) => (c.lastExternalActionAt ? [c.lastExternalActionAt] : []))
    .sort()
    .at(-1);
  return (
    <article className="project-row catalog-row" aria-label={name}>
      <div>
        <h2>
          <Link to={`/projects/${project.id}`}>{name}</Link>
        </h2>
        {goal && <p className="catalog-goal">{goal}</p>}
        <div className="catalog-meta">
          {status !== 'unknown' && <span>{statusLabels[status]}</span>}
          {type !== 'other' && <span>{typeLabels[type]}</span>}
          {priority !== 'normal' && <span>{priorityLabels[priority]} приоритет</span>}
          <Link to={`/tasks?project=${project.id}`}>Открытые задачи · {count}</Link>
        </div>
        {!project.available && (
          <p className="warning-text">
            Каталог недоступен. Последний доступный снимок:{' '}
            <time dateTime={project.snapshot.scannedAt}>
              {new Date(project.snapshot.scannedAt).toLocaleString('ru')}
            </time>
          </p>
        )}
        <details className="catalog-diagnostics">
          <summary>Файлы и проверки</summary>
          {project.available && (
            <p>
              Снимок файлов:{' '}
              <time dateTime={project.snapshot.scannedAt}>
                {new Date(project.snapshot.scannedAt).toLocaleString('ru')}
              </time>
            </p>
          )}
          <p>{checks.length} активных проверок</p>
          {lastAction && <p>Внешний шаг: {date(lastAction)}</p>}
          <p>
            {project.snapshot.git.present
              ? `Git: ${date(project.snapshot.git.commits[0]?.date)}`
              : 'Без Git'}
          </p>
          {project.available && project.snapshot.git.dirty && <p>Есть незакоммиченные изменения</p>}
        </details>
      </div>
      <ActionMenu label={`Действия проекта ${name}`}>
        <ActionMenuItem asChild>
          <Link to={`/tasks?project=${project.id}&new=1`}>Добавить задачу</Link>
        </ActionMenuItem>
        <RemoveProject id={project.id} name={name} />
      </ActionMenu>
    </article>
  );
}

export default function Projects() {
  const { data: w } = useWorkspace();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [type, priority].filter(Boolean).length;
  const projects = w!.projects.filter(
    (p) =>
      (!status ||
        (status === 'closed'
          ? isClosedProject(p.metadata.status)
          : p.metadata.status === status)) &&
      (!type || p.metadata.type === type) &&
      (!priority || p.metadata.priority === priority) &&
      `${p.metadata.name} ${p.path}`
        .toLocaleLowerCase('ru')
        .includes(query.trim().toLocaleLowerCase('ru')),
  );
  function reset() {
    setQuery('');
    setStatus('');
    setType('');
    setPriority('');
    setFiltersOpen(false);
  }
  return (
    <div className="project-catalog">
      <div className="page-heading">
        <h1>
          Проекты{' '}
          <span className="count">
            {projects.length === w!.projects.length
              ? projects.length
              : `${projects.length} из ${w!.projects.length}`}
          </span>
        </h1>
        <Link to="/settings">Каталоги проектов</Link>
      </div>
      <div className="catalog-filters">
        <input
          type="search"
          aria-label="Поиск проектов"
          placeholder="Найти проект…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Статус проекта"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Все статусы</option>
          <option value="active">Активные</option>
          <option value="paused">Отложенные</option>
          <option value="closed">Закрытые</option>
          <option value="unknown">Без статуса</option>
        </select>
        <button
          aria-expanded={filtersOpen}
          aria-controls="catalog-extra-filters"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          Фильтры{activeFilters > 0 && ` · ${activeFilters}`}
        </button>
        {(query || status || type || priority) && <button onClick={reset}>Сбросить</button>}
        <div id="catalog-extra-filters" className="catalog-extra-filters" hidden={!filtersOpen}>
          <select aria-label="Тип проекта" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Все типы</option>
            {Object.entries(typeLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="Приоритет проекта"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="">Любой приоритет</option>
            {Object.entries(priorityLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="catalog-list">
        {projects.map((p) => (
          <CatalogRow key={p.id} project={p} />
        ))}
      </div>
      {!projects.length && (
        <div className="panel empty">
          <h2>Проекты не найдены</h2>
          <p>Измените фильтр или добавьте каталог в настройках.</p>
          <Link to="/settings">Открыть настройки →</Link>
        </div>
      )}
    </div>
  );
}
