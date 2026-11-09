import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CodexGrant } from '../../../shared/codex-context';
import type { PeriodRun, PeriodSelection, PeriodSource } from '../../../shared/period-analysis';
import { codexDefaultQuestion } from '../../../shared/codex-analysis';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';
import { CodexChoices } from '../codex-context/CodexChoices';
import { AnalysisInstructions } from './AnalysisInstructions';

const shortDate = (value: string) => value.split('-').reverse().join('.');
const fieldNames: Record<string, string> = {
  name: 'Название',
  type: 'Тип',
  goal: 'Цель',
  currentFocus: 'Сейчас в фокусе',
  status: 'Состояние',
  stage: 'Этап',
  blockedBy: 'Препятствия',
  description: 'Описание',
  expectedResult: 'Ожидаемый результат',
  acceptance: 'Критерий готовности',
  code: 'Задача',
};
function sourceText(source: PeriodSource) {
  try {
    const value = JSON.parse(source.text);
    if (
      source.kind === 'codex_digest' &&
      value &&
      typeof value.summary === 'string' &&
      Array.isArray(value.excerpts)
    )
      return [
        value.summary,
        ...value.excerpts.map(
          (excerpt: { role: string; text: string }) =>
            `${excerpt.role === 'user' ? 'Вы' : 'Codex'}: ${excerpt.text}`,
        ),
      ].join('\n\n');
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.entries(value)
        .filter(
          ([key, v]) =>
            key !== 'available' &&
            v &&
            v !== 'unknown' &&
            v !== 'other' &&
            (!Array.isArray(v) || v.length),
        )
        .map(
          ([key, v]) =>
            `${fieldNames[key] || key}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`,
        )
        .join('\n');
  } catch {
    /* Plain-text records need no conversion. */
  }
  return source.text;
}

export function RequestPreview({
  run,
  turns,
  busy,
  canStart,
  onStart,
  onCancel,
  onReprepare,
}: {
  run: PeriodRun;
  turns: PeriodRun[];
  busy: boolean;
  canStart: boolean;
  onStart: () => void;
  onCancel: () => void;
  onReprepare: (selection: PeriodSelection) => void;
}) {
  const { data: workspace } = useWorkspace();
  const [approved, setApproved] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [selection, setSelection] = useState(run.selection);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const scope = [...run.selection.projectIds].sort().join(',');
  const grants = useQuery({
    queryKey: ['codex-grants', scope],
    queryFn: ({ signal }) =>
      Promise.all(
        run.selection.projectIds.map((id) =>
          api<CodexGrant>(`/projects/${id}/codex-context`, 'GET', undefined, signal),
        ),
      ),
    enabled: !!scope,
    retry: false,
  });
  const changed = JSON.stringify(selection) !== JSON.stringify(run.selection);
  const expired = Date.parse(run.expiresAt) <= clock;
  const origin = run.payload.origin;
  const question = origin?.kind === 'codex_runtime' ? origin.question : '';
  const followup = origin?.kind === 'codex_runtime' && !!origin.parentRunId;
  return (
    <section className="analysis-request" aria-label="Просмотр запроса Codex">
      <header className="request-heading">
        <p className="request-step">Проверка перед отправкой</p>
        <h2>
          {question === codexDefaultQuestion ? 'Разбор проектов за период' : 'Запрос к Codex'}
        </h2>
        <p className="request-period">
          {run.payload.period.kind === 'week' ? 'Неделя' : 'Месяц'} ·{' '}
          {shortDate(run.payload.period.from)} — {shortDate(run.payload.period.to)}
        </p>
      </header>
      <div className="request-question">
        <h3>Что разберём</h3>
        <p>
          {question === codexDefaultQuestion
            ? 'Что изменилось в проектах, что это даёт и на чём стоит сосредоточиться дальше.'
            : question}
        </p>
        <details>
          <summary>Полный текст запроса</summary>
          <p className="preserve">{question}</p>
        </details>
      </div>
      <h3>Какие данные отправим</h3>
      <div className="request-projects">
        {run.selection.projectIds.map((id) => {
          const sources = run.payload.sources.filter((s) => s.projectId === id);
          const project = sources.find((s) => s.kind === 'project');
          const name =
            project?.title ||
            workspace?.projects.find((p) => p.id === id)?.metadata.name ||
            'Прежний проект';
          const current = sources.filter(
            (s) => s.dateQuality === 'current' && s.kind !== 'project',
          );
          const background = sources.filter((s) => s.dateQuality === 'background');
          const events = sources.filter(
            (s) => s.dateQuality !== 'current' && s.dateQuality !== 'background',
          );
          const chats = sources.filter((s) => s.kind === 'codex_digest');
          const grant = grants.data?.find((g) => g.projectId === id);
          const useful =
            sources.some((s) => s.kind !== 'project') ||
            (project && /"(?:goal|currentFocus)":"[^"\s]/.test(project.text));
          return (
            <section className="request-project" key={id}>
              <h4>{name}</h4>
              <p className="request-counts">
                <span>За период · {events.length}</span>
                <span>Предыстория · {background.length}</span>
                <span>Текущие записи · {current.length}</span>
              </p>
              {!useful && (
                <p className="request-empty">
                  Пока только карточка проекта. Добавьте результаты или выдержки чатов, чтобы разбор
                  был содержательнее.
                </p>
              )}
              <p className="request-chat-state">
                {chats.length ? `Чаты в запросе · ${chats.length}` : 'Чаты не подключены'}
                {!chats.length && (
                  <small>
                    {grant?.enabled
                      ? ' · доступ разрешён, выберите выдержки ниже'
                      : grants.isPending
                        ? ' · проверяем доступ'
                        : grants.error
                          ? ' · не удалось проверить доступ'
                          : ' · доступ выключен'}
                  </small>
                )}
              </p>
              <details>
                <summary>Прочитать данные проекта</summary>
                {sources.map((s) => (
                  <article className="request-source" key={s.id}>
                    <h5>{s.title}</h5>
                    {s.day && (
                      <p className="help">
                        {shortDate(s.day)}
                        {s.dateQuality === 'background' ? ' · предыстория' : ''}
                      </p>
                    )}
                    <p className="preserve">{sourceText(s)}</p>
                    {s.partial && <small>Сокращённая запись</small>}
                  </article>
                ))}
              </details>
            </section>
          );
        })}
      </div>
      {run.payload.sources.some((s) => s.projectId === null) && (
        <details className="request-general">
          <summary>Общие записи</summary>
          {run.payload.sources
            .filter((s) => s.projectId === null)
            .map((s) => (
              <article className="request-source" key={s.id}>
                <h4>{s.title}</h4>
                <p className="preserve">{sourceText(s)}</p>
              </article>
            ))}
        </details>
      )}
      {followup ? (
        <p className="help">
          Вместе с вопросом будут отправлены данные и предыдущие успешные ответы этого обсуждения.
        </p>
      ) : (
        <details className="request-chats">
          <summary>Добавить выдержки чатов проектов</summary>
          <CodexChoices
            reviewId={run.reviewKey}
            value={selection}
            disabled={busy}
            onBusyChange={setCollecting}
            onChange={(value) => {
              setApproved(false);
              setSelection(value);
            }}
          />
          {changed && (
            <div className="message">
              <p>Состав данных изменён. Обновите запрос и просмотрите его перед отправкой.</p>
              <button type="button" disabled={busy} onClick={() => onReprepare(selection)}>
                Обновить запрос
              </button>
            </div>
          )}
        </details>
      )}
      <div className="request-confirmation">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={approved}
            disabled={busy || collecting || changed || expired}
            onChange={(event) => setApproved(event.target.checked)}
          />
          <span>Я просмотрел контекст и разрешаю отправить этот запрос в Codex.</span>
        </label>
        <p className="help">
          Запрос использует лимиты вашего входа в Codex; при входе через API возможна оплата.
        </p>
        {expired && <p role="alert">Срок просмотра истёк. Подготовьте новый запрос.</p>}
        <div className="request-actions">
          <button
            className="primary"
            disabled={busy || collecting || !approved || !canStart || changed || expired}
            onClick={onStart}
          >
            Запустить Codex
          </button>
          <button disabled={busy} onClick={onCancel}>
            Отменить запрос
          </button>
        </div>
      </div>
      <details className="request-technical">
        <summary>Технические сведения</summary>
        <AnalysisInstructions />
        <p className="help">
          Запрос действует до {new Date(run.expiresAt).toLocaleString('ru')}. Повторная отправка
          автоматически не выполняется.
        </p>
        <details>
          <summary>Точный контекст и ограничения</summary>
          <pre className="analysis-packet">{JSON.stringify(run.payload, null, 2)}</pre>
          {turns
            .filter((t) => t.status === 'succeeded')
            .map((t) => (
              <pre key={t.id} className="analysis-packet">
                {JSON.stringify(t.report, null, 2)}
              </pre>
            ))}
        </details>
      </details>
    </section>
  );
}
