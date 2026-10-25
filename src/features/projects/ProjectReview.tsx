import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { LatestProjectReview } from '../../../shared/reviews';
import { api } from '../../shared/http';
import { date } from '../../shared/labels';

export function ProjectReview({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['reviews', 'latest-project', projectId],
    queryFn: ({ signal }) =>
      api<LatestProjectReview | null>(
        `/projects/${projectId}/latest-review`,
        'GET',
        undefined,
        signal,
      ),
    retry: false,
    refetchInterval: 5000,
  });
  const review = query.data;
  return (
    <section className="panel section-space project-development" aria-label="Итоги проекта">
      <h2>Итоги и развитие</h2>
      {query.isPending && <p role="status">Загружаем последний обзор…</p>}
      {query.error && (
        <div role="alert" className="message warning">
          <p>Не удалось загрузить обзор. Сохранённые записи остаются в истории.</p>
          <button disabled={query.isFetching} onClick={() => query.refetch()}>
            Повторить загрузку обзора
          </button>
        </div>
      )}
      {review && (
        <article className="latest-review">
          <p className="help">
            {review.analysisId ? 'Сохранённый ИИ-анализ' : 'Последний обзор'} ·{' '}
            {date(review.periodStart)} — {date(review.periodEnd)}
          </p>
          <p className="preserve">
            {review.excerpt}
            {review.excerpt.length === 600 ? '…' : ''}
          </p>
          <Link
            to={
              review.analysisId
                ? `/period-analysis?review=${review.id}&run=${review.analysisId}`
                : `/reviews?id=${review.id}`
            }
          >
            Читать полностью →
          </Link>
        </article>
      )}
      {query.isSuccess && !review && (
        <p className="empty">
          Итогов пока нет. В конце недели запишите, что получилось и что хотите попробовать дальше.
        </p>
      )}
      <div className="row section-space">
        <Link className="button primary" to={`/reviews?project=${projectId}&kind=week`}>
          Подвести итоги недели
        </Link>
        <Link to={`/reviews?project=${projectId}&kind=month`}>Обзор месяца →</Link>
      </div>
      <p className="help section-space">
        В обзоре можно записать собственные выводы и получить ИИ-анализ выбранного периода.
      </p>
      <div className="row">
        <Link to={`/analysis?project=${projectId}`}>Получить ИИ-анализ →</Link>
        <Link to={`/timeline?project=${projectId}&kind=review`}>Прежние обзоры →</Link>
      </div>
    </section>
  );
}
