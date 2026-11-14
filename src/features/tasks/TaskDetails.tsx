import { Link } from 'react-router';
import type { Task } from '../../../shared/contracts';
import { date, priorityLabels } from '../../shared/labels';

export function TaskDetails({ task, proposalId }: { task: Task; proposalId?: string }) {
  return (
    <div className="task-detail-copy">
      <p className="task-meta">
        {task.completedAt
          ? `Завершена: ${date(task.completedAt)}`
          : task.cancellation
            ? 'Отменена'
            : 'Открыта'}
        {' · '}
        {priorityLabels[task.priority]} приоритет
      </p>
      {task.cancellation && (
        <p>
          Отменена при закрытии проекта · {date(task.cancellation.at)}{' '}
          <Link to={`/project-lifecycle/${task.cancellation.projectEventId}`}>
            Причина закрытия →
          </Link>
        </p>
      )}
      {proposalId && (
        <p>
          <Link to={`/proposal-acceptances?id=${proposalId}`}>
            Основания принятого предложения →
          </Link>
        </p>
      )}
      {task.description && (
        <section>
          <h3>Описание</h3>
          <p className="preserve">{task.description}</p>
        </section>
      )}
      {task.expectedResult && (
        <section>
          <h3>Ожидаемый результат</h3>
          <p className="preserve">{task.expectedResult}</p>
        </section>
      )}
      {task.acceptance && (
        <section>
          <h3>Условия завершения</h3>
          <p className="preserve">{task.acceptance}</p>
        </section>
      )}
      {task.links.length > 0 && (
        <section>
          <h3>Ссылки</h3>
          {task.links.map((link, i) => (
            <p className="preserve" key={i}>
              {link}
            </p>
          ))}
        </section>
      )}
      {task.result && (
        <section>
          <h3>Результат</h3>
          <p className="preserve">
            <strong>Что сделано:</strong> {task.result.summary}
          </p>
          {task.result.verified && (
            <p className="preserve">
              <strong>Проверено:</strong> {task.result.verified}
            </p>
          )}
          {task.result.unverified && (
            <p className="preserve">
              <strong>Не проверено:</strong> {task.result.unverified}
            </p>
          )}
          {task.result.remaining && (
            <p className="preserve">
              <strong>Осталось:</strong> {task.result.remaining}
            </p>
          )}
        </section>
      )}
      <Link to={`/history?task=${task.code}`}>История задачи →</Link>
    </div>
  );
}
