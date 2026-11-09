import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { RecentAnalyses, PeriodRunState } from '../../../shared/period-analysis';
import { date } from '../../shared/labels';
import { api } from '../../shared/http';
import { codexDefaultQuestion } from '../../../shared/codex-analysis';

export function useSavedAnalyses(projectIds: string[]) {
  const key = [...projectIds].sort().join(',');
  return useQuery({
    queryKey: ['recent-project-analyses', 'discussions', key],
    queryFn: ({ signal }) =>
      api<RecentAnalyses>(
        `/period-analysis/recent?${new URLSearchParams(key ? { view: 'discussions', projectIds: key } : { view: 'discussions' })}`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
    refetchInterval: 5000,
  });
}
const discussionState: Record<PeriodRunState, string> = {
  succeeded: '',
  failed: 'Ошибка',
  unknown: 'Результат неизвестен',
  cancelled: 'Отменено',
  pending: 'Ожидает подтверждения',
  running: 'Codex отвечает',
};
export function SavedAnalyses({ query }: { query: ReturnType<typeof useSavedAnalyses> }) {
  return (
    <section className="analysis-saved" aria-label="Сохранённые анализы проектов">
      <h2>Обсуждения</h2>
      {query.isPending && <p role="status">Загружаем сохранённые анализы…</p>}
      {query.error && (
        <p role="alert">
          {query.error.message}{' '}
          <button onClick={() => query.refetch()}>Повторить загрузку анализов</button>
        </p>
      )}
      {query.data?.items.length === 0 && <p className="empty">Сохранённых анализов пока нет.</p>}
      {query.data?.items.map((run) => (
        <article className="analysis-discussion" key={run.id}>
          <Link
            to={`/${run.origin === 'codex_runtime' ? 'codex-analysis' : 'period-analysis'}?review=${run.reviewKey}&run=${run.id}`}
          >
            {run.title === codexDefaultQuestion ? 'Разбор проектов за период' : run.title}
          </Link>
          <p>
            {run.projectName} · {date(run.createdAt)}
            {run.origin === 'codex_manual' && ' · Codex · внесён вручную'}
            {discussionState[run.status] && ` · ${discussionState[run.status]}`}
          </p>
        </article>
      ))}
      {query.data?.truncated && (
        <Link to="/timeline?kind=ai_analysis">Более ранние разборы в истории →</Link>
      )}
    </section>
  );
}
