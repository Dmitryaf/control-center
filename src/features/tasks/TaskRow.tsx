import { ActionMenu, ActionMenuItem } from '../../shared/ActionMenu';
import { Check, Flag, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import type { Task } from '../../../shared/contracts';
import { isTaskOpen } from '../../../shared/task-status';
import { date, priorityLabels } from '../../shared/labels';

export function TaskRow({
  task,
  proposalId,
  busy,
  resultOpen,
  onEdit,
  onResult,
  onFinish,
  onDelete,
}: {
  task: Task;
  proposalId?: string;
  busy: boolean;
  resultOpen: boolean;
  onEdit: () => void;
  onResult: () => void;
  onFinish: () => void;
  onDelete: () => void;
}) {
  const open = isTaskOpen(task);
  const finishLabel = open ? 'Завершить' : 'Вернуть';
  return (
    <article className="task-card task-line">
      <button
        className="task-check"
        aria-label={finishLabel}
        aria-describedby={`title-${task.id}`}
        title={finishLabel}
        disabled={busy}
        onClick={onFinish}
      >
        {open ? <span /> : task.completedAt ? <Check size={17} /> : <Undo2 size={17} />}
      </button>
      <div className="task-copy">
        <h3 id={`title-${task.id}`}>
          <button id={`task-open-${task.id}`} onClick={onEdit} className="task-title">
            {task.title}
          </button>
        </h3>
        <div className="task-meta">
          <span>{task.code}</span>
          {task.priority !== 'normal' && (
            <span className={`task-priority ${task.priority}`}>
              <Flag size={12} aria-hidden="true" />
              {priorityLabels[task.priority]} приоритет
            </span>
          )}
          {task.completedAt && <span>Завершена: {date(task.completedAt)}</span>}
        </div>
        {task.cancellation && (
          <p className="task-note">
            Отменена при закрытии проекта · {date(task.cancellation.at)}{' '}
            <Link to={`/project-lifecycle/${task.cancellation.projectEventId}`}>
              Причина закрытия →
            </Link>
          </p>
        )}
        {proposalId && (
          <p className="task-note">
            <Link to={`/proposal-acceptances?id=${proposalId}`}>
              Основания принятого предложения →
            </Link>
          </p>
        )}
        {(task.expectedResult || task.acceptance || task.links.length > 0 || task.result) && (
          <details className="task-details">
            <summary>Условия и результат</summary>
            {task.expectedResult && (
              <p className="preserve">
                <strong>Ожидаемый результат:</strong> {task.expectedResult}
              </p>
            )}
            {task.acceptance && (
              <p className="preserve">
                <strong>Условия завершения:</strong> {task.acceptance}
              </p>
            )}
            {task.links.map((link, i) => (
              <p className="preserve" key={i}>
                {link}
              </p>
            ))}
            {task.result && (
              <>
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
              </>
            )}
          </details>
        )}
      </div>
      <ActionMenu label={`Действия ${task.code}`}>
        <ActionMenuItem disabled={resultOpen} onSelect={onResult}>
          {task.result ? 'Изменить итог' : 'Добавить итог'}
        </ActionMenuItem>
        <ActionMenuItem asChild>
          <Link to={`/history?task=${task.code}`}>История</Link>
        </ActionMenuItem>
        <ActionMenuItem disabled={busy} onSelect={onDelete}>
          Удалить
        </ActionMenuItem>
      </ActionMenu>
    </article>
  );
}
