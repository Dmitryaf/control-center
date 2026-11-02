import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { ProjectLifecycleRecord } from '../../../shared/project-lifecycle';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { statusLabels } from '../../shared/labels';

export default function ProjectLifecycleHistory() {
  const { id } = useParams();
  const { data: workspace } = useWorkspace();
  const query = useQuery({
    queryKey: ['project-lifecycle', id],
    queryFn: ({ signal }) =>
      api<ProjectLifecycleRecord>(`/project-lifecycle/${id}`, 'GET', undefined, signal),
  });
  if (query.isPending) return <p role="status">Загружаем событие проекта…</p>;
  if (query.error)
    return (
      <div className="message error" role="alert">
        {query.error.message}
        <button onClick={() => query.refetch()} disabled={query.isFetching}>
          Повторить
        </button>
      </div>
    );
  const event = query.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="section-label">История проекта · {event.projectName}</p>
          <h1>{event.action === 'closed' ? 'Закрытие проекта' : 'Возврат проекта в работу'}</h1>
          <p className="subtitle">
            {new Date(event.recordedAt).toLocaleString('ru', {
              timeZone: workspace!.settings.timezone,
            })}
          </p>
        </div>
      </div>
      <article className="panel prose" aria-label="Сохранённое событие проекта">
        {event.outcome && <h2>{statusLabels[event.outcome]}</h2>}
        <p className="preserve">{event.reason || 'Без пояснения.'}</p>
        <p className="help">Сохранённое событие. Последующие изменения проекта его не заменяют.</p>
      </article>
      <div className="row section-space">
        <Link to={`/timeline?project=${event.scopeProjectId}&kind=project`}>История проекта →</Link>
        {event.projectId && <Link to={`/projects/${event.projectId}`}>Открыть проект →</Link>}
      </div>
    </>
  );
}
