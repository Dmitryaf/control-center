import { isTaskOpen } from '../../../shared/task-status';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '../../../shared/contracts';
import { isClosedProject } from '../../../shared/project-lifecycle';
import { api } from '../../shared/http';
import { useActions, useWorkspace } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';
import { statusLabels } from '../../shared/labels';

export type LifecycleAction = 'close' | 'reopen' | null;
function TransitionForm({
  project,
  action,
  onClose,
}: {
  project: Project;
  action: Exclude<LifecycleAction, null>;
  onClose: () => void;
}) {
  const { data: workspace } = useWorkspace();
  const { act, busy } = useActions();
  const client = useQueryClient();
  const [revision] = useState(project.lifecycle?.revision ?? 0);
  const key = useRef(crypto.randomUUID());
  const {
    register,
    handleSubmit,
    formState: { isDirty },
  } = useForm({
    defaultValues: { outcome: 'completed' as 'completed' | 'stopped', reason: '' },
  });
  const tasks = workspace!.tasks.filter(
    (task) => task.projectId === project.id && isTaskOpen(task),
  );
  const changed = () => {
    key.current = crypto.randomUUID();
  };
  return (
    <form
      className="panel form section-space project-lifecycle-form"
      aria-label={action === 'close' ? 'Закрытие проекта' : 'Возврат проекта в работу'}
      onSubmit={handleSubmit(async (fields) => {
        const ok = await act(
          () =>
            api(`/projects/${project.id}/${action}`, 'POST', {
              revision,
              requestKey: key.current,
              ...(action === 'close'
                ? { outcome: fields.outcome, reason: fields.reason.trim() }
                : {}),
            }),
          action === 'close' ? 'Проект закрыт' : 'Проект возвращён в работу',
        );
        if (ok) {
          await client.invalidateQueries({ queryKey: ['history'] });
          onClose();
        }
      })}
    >
      <UnsavedChanges dirty={action === 'close' && isDirty} />
      <h2>{action === 'close' ? 'Закрыть проект' : 'Вернуть проект в работу?'}</h2>
      {action === 'close' ? (
        <>
          <fieldset disabled={busy}>
            <legend>Итог</legend>
            <label className="checkbox">
              <input
                type="radio"
                value="completed"
                {...register('outcome', { onChange: changed })}
              />
              Завершён
            </label>
            <label className="checkbox">
              <input type="radio" value="stopped" {...register('outcome', { onChange: changed })} />
              Больше не развиваю
            </label>
          </fieldset>
          <label>
            Пояснение
            <textarea
              autoFocus
              rows={3}
              maxLength={10000}
              disabled={busy}
              placeholder="Почему закрываете проект и что стоит сохранить в его истории?"
              {...register('reason', { onChange: changed })}
            />
          </label>
          <p className="help">
            Пояснение необязательно. Дата закрытия сохранится автоматически. Файлы и история проекта
            останутся доступны.
          </p>
          {tasks.length > 0 && (
            <div>
              <h3>Открытые задачи · {tasks.length}</h3>
              <ul>
                {tasks.map((task) => (
                  <li key={task.id}>
                    {task.code} · {task.title}
                  </li>
                ))}
              </ul>
              <p>Эти задачи будут отменены при закрытии проекта. Их результаты сохранятся.</p>
            </div>
          )}
        </>
      ) : (
        <p>Проект снова станет активным. Прежний итог закрытия останется в истории.</p>
      )}
      <div className="row">
        <button className="primary" disabled={busy}>
          {action === 'close' ? 'Подтвердить закрытие' : 'Подтвердить возврат'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!isDirty || confirm('Закрыть форму без сохранения пояснения?')) onClose();
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

export function ProjectLifecycle({
  project,
  action,
  onClose,
}: {
  project: Project;
  action: LifecycleAction;
  onClose: () => void;
}) {
  const { data: workspace } = useWorkspace();
  const closed = isClosedProject(project.metadata.status);
  const outcome = project.lifecycle?.currentClosure;
  if (!closed && !action) return null;
  return (
    <section id="project-closure" className="section-space" aria-label="Итог проекта">
      {closed && (
        <div className="panel prose">
          <h2>{statusLabels[project.metadata.status]}</h2>
          {outcome ? (
            <>
              <p className="help">
                Дата закрытия:{' '}
                {new Intl.DateTimeFormat('ru', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: workspace!.settings.timezone,
                }).format(new Date(outcome.recordedAt))}
              </p>
              <p className="preserve">{outcome.reason || 'Без пояснения.'}</p>
            </>
          ) : (
            <p>Дата и пояснение закрытия не записаны.</p>
          )}
        </div>
      )}
      {action && (
        <TransitionForm
          key={`${project.id}:${action}`}
          project={project}
          action={action}
          onClose={onClose}
        />
      )}
    </section>
  );
}
