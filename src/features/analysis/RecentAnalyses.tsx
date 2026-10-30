import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { RecentAnalyses } from '../../../shared/period-analysis';
import { api } from '../../shared/http';

export function SavedAnalyses({ projectIds }: { projectIds: string[] }) {
  const key = [...projectIds].sort().join(',');
  const query = useQuery({
    queryKey: ['recent-project-analyses', key],
    queryFn: ({ signal }) =>
      api<RecentAnalyses>(
        `/period-analysis/recent${key ? `?${new URLSearchParams({ projectIds: key })}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
    refetchInterval: 5000,
  });
  return (
    <section className="panel section-space" aria-label="Сохранённые анализы проектов">
      <h2>Сохранённые анализы</h2>
      <p className="help">
        Результаты остаются в локальной базе после закрытия страницы. Без выбора проектов показаны
        последние анализы всех проектов.
      </p>
      {query.isPending && <p role="status">Загружаем сохранённые анализы…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}{' '}
          <button onClick={() => query.refetch()}>Повторить загрузку анализов</button>
        </p>
      )}
      {query.data?.items.length === 0 && <p className="empty">Сохранённых анализов пока нет.</p>}
      {query.data?.items.map((run) => (
        <article key={run.id}>
          <h3>{run.projectName}</h3>
          <p>
            {run.origin === 'codex_runtime'
              ? 'Codex · Control Center'
              : run.origin === 'codex_manual'
                ? 'Codex · внесён вручную'
                : `OpenAI · ${run.model}`}{' '}
            · {new Date(run.createdAt).toLocaleString('ru')} · Вариант {run.generation}
          </p>
          <Link
            to={`/${run.origin === 'codex_runtime' ? 'codex-analysis' : 'period-analysis'}?review=${run.reviewKey}&run=${run.id}`}
          >
            Открыть анализ →
          </Link>
        </article>
      ))}
      {query.data?.truncated && (
        <p className="help">
          Показаны 10 последних результатов. Более ранние доступны в истории и обзорах периодов.
        </p>
      )}
    </section>
  );
}
