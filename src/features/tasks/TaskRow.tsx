import { ActionMenu, ActionMenuItem } from '../../shared/ActionMenu';
import { Check, Flag, Undo2 } from 'lucide-react';
import type { Task } from '../../../shared/contracts';
import { isTaskOpen } from '../../../shared/task-status';
import { priorityLabels } from '../../shared/labels';
import { Link } from 'react-router';

export function TaskRow({
  task,
  projectNames,
  selected,
  busy,
  resultOpen,
  onEdit,
  onResult,
  onFinish,
  onDelete,
}: {
  task: Task;
  projectNames?: string;
  selected?: boolean;
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
    <article className={`task-card task-line${selected ? ' selected' : ''}`}>
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
        <h3 id={`title-${task.id}`} aria-label={task.title}>
          <button
            id={`task-open-${task.id}`}
            onClick={onEdit}
            className="task-title"
            aria-expanded={selected}
            aria-controls="task-detail-panel"
          >
            {task.title}
          </button>
          <span className="task-code">{task.code}</span>
        </h3>
        <div className="task-meta">
          {projectNames && <span>{projectNames}</span>}
          {task.priority !== 'normal' && (
            <span className={`task-priority ${task.priority}`}>
              <Flag size={12} aria-hidden="true" />
              {priorityLabels[task.priority]} приоритет
            </span>
          )}
        </div>
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
