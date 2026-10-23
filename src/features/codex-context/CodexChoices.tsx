import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { CodexDigest } from '../../../shared/codex-context';
import type { PeriodSelection } from '../../../shared/period-analysis';
import { api } from '../../shared/http';

export function CodexChoices({
  reviewId,
  value,
  onChange,
}: {
  reviewId: string;
  value: PeriodSelection;
  onChange: (value: PeriodSelection) => void;
}) {
  const query = useQuery({
    queryKey: ['codex-digests', reviewId],
    queryFn: ({ signal }) =>
      api<{ items: CodexDigest[] }>(
        `/codex-context/digests?reviewId=${reviewId}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 5000,
  });
  return (
    <fieldset>
      <legend>Итоги диалогов Codex — только по отдельному выбору</legend>
      <p>
        <Link to={`/codex-context?review=${reviewId}`}>
          Выбрать диалоги и сохранить краткий итог →
        </Link>
      </p>
      {query.error && (
        <p role="alert">
          Не удалось загрузить итоги диалогов. Анализ остальных источников доступен.
        </p>
      )}
      {query.data?.items.map((item) => {
        const checked = value.codexDigestIds.includes(item.id);
        const available = item.eligible && value.projectIds.includes(item.scopeProjectId);
        return (
          <label className="check" key={item.id}>
            <input
              type="checkbox"
              checked={checked}
              disabled={!checked && (!available || value.codexDigestIds.length >= 2)}
              onChange={(event) =>
                onChange({
                  ...value,
                  codexDigestIds: event.target.checked
                    ? [...value.codexDigestIds, item.id]
                    : value.codexDigestIds.filter((id) => id !== item.id),
                })
              }
            />
            {item.projectName} · {item.thread.name}
            {!available ? ' · проверьте разрешение, свежесть и выбор проекта' : ''}
          </label>
        );
      })}
      <p className="help">
        До двух сохранённых итогов за этот период. В пакет попадут ваш пересказ и выбранные
        выдержки; перед отправкой вы увидите их целиком. Автоматические расписания их не используют.
      </p>
    </fieldset>
  );
}
