import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { HistoryPage } from '../../../shared/history';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { date } from '../../shared/labels';
import { historyEventLabels } from './labels';

export function RecentHistory({
  projectId,
  from,
  to,
  compact = false,
}: {
  projectId?: string;
  from?: string;
  to?: string;
  compact?: boolean;
}) {
  const { data: workspace } = useWorkspace();
  const timezone = workspace!.settings.timezone;
  const params = new URLSearchParams({
    timezone,
    limit: compact ? '1' : '5',
    ...(projectId ? { projectId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const query = useQuery({
    queryKey: ['history', 'recent', params.toString()],
    retry: false,
    refetchInterval: 5000,
    queryFn: ({ signal }) => api<HistoryPage>(`/history?${params}`, 'GET', undefined, signal),
  });
  return <RecentHistoryResult query={query} timezone={timezone} compact={compact} />;
}
export interface RecentHistoryState {
  data?: HistoryPage;
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => unknown;
}
export function RecentHistoryResult({
  query,
  timezone,
  compact = false,
}: {
  query: RecentHistoryState;
  timezone: string;
  compact?: boolean;
}) {
  return (
    <>
      {query.isPending && (
        <p role="status">{compact ? 'Загружаем запись…' : 'Загружаем результаты…'}</p>
      )}
      {query.error && (
        <div
          className="message warning"
          role="alert"
          aria-label={compact ? 'Последняя запись проекта' : 'Последние результаты'}
        >
          <p>{compact ? 'Не удалось обновить запись.' : query.error.message}</p>
          <button disabled={query.isFetching} onClick={() => query.refetch()}>
            Повторить
          </button>
        </div>
      )}
      <ol className={compact ? 'work-list' : 'recent-work-list'}>
        {query.data?.items.map((entry) => (
          <li key={entry.key} className={compact ? undefined : 'activity'}>
            <time dateTime={entry.recordedAt ?? entry.day}>
              {entry.recordedAt
                ? new Date(entry.recordedAt).toLocaleString('ru', { timeZone: timezone })
                : date(entry.day)}
            </time>
            <div>
              <Link to={entry.href}>
                {historyEventLabels[entry.event]} · {entry.title}
              </Link>
              {!compact && <p className="help">{entry.projectName ?? 'Без связи с проектом'}</p>}
              <p className="preserve">{entry.excerpt}</p>
              {entry.truncated && (
                <p className="help">Показан фрагмент; полный текст — в источнике.</p>
              )}
              {entry.dateQuality === 'baseline' && (
                <p className="help">
                  Известная запись при переходе; более ранняя история недоступна.
                </p>
              )}
              {entry.dateQuality === 'declared' && (
                <p className="help">Указана дата, время неизвестно.</p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {query.data && !query.data.items.length && (
        <p className="empty">
          {compact
            ? 'Записей работы пока нет.'
            : 'В доступных источниках за выбранный период записей нет.'}
        </p>
      )}
    </>
  );
}
