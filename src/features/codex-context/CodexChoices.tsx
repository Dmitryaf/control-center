import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import type { CodexDigest, CodexGrant } from '../../../shared/codex-context';
import type { PeriodSelection } from '../../../shared/period-analysis';
import { api } from '../../shared/http';
import { useWorkspace } from '../../shared/workspace';

export function CodexChoices({
  reviewId,
  value,
  onChange,
}: {
  reviewId: string;
  value: PeriodSelection;
  onChange: (value: PeriodSelection) => void;
}) {
  const client = useQueryClient();
  const { data: workspace } = useWorkspace();
  const [consentFor, setConsentFor] = useState('');
  const scope = [...value.projectIds].sort().join(',');
  const current = useRef(value);
  current.current = value;
  const grants = useQuery({
    queryKey: ['codex-grants', scope],
    queryFn: ({ signal }) =>
      Promise.all(
        value.projectIds.map((id) =>
          api<CodexGrant>(`/projects/${id}/codex-context`, 'GET', undefined, signal),
        ),
      ),
    enabled: !!scope,
    retry: false,
  });
  const prepare = useMutation({
    retry: false,
    mutationFn: async (projectIds: string[]) => {
      const projects = [];
      for (const grant of (grants.data ?? []).filter((grant) =>
        projectIds.includes(grant.projectId),
      )) {
        const approved = grant.enabled
          ? grant
          : await api<CodexGrant>(`/projects/${grant.projectId}/codex-context`, 'PUT', {
              revision: grant.revision,
              enabled: true,
              readConsent: true,
            });
        projects.push({ projectId: grant.projectId, revision: approved.revision });
      }
      return api<{ items: CodexDigest[]; limitations: string[] }>(
        '/codex-context/prepare',
        'POST',
        { reviewId, projects, readConsent: true, saveConsent: true },
      );
    },
    onSuccess: async (result, preparedProjectIds) => {
      const next = current.current;
      const included = result.items.filter((item) => next.projectIds.includes(item.scopeProjectId));
      onChange({
        ...next,
        codexDigestIds: [
          ...new Set([
            ...next.codexDigestIds.filter(
              (id) =>
                !query.data?.items.some(
                  (item) => item.id === id && preparedProjectIds.includes(item.scopeProjectId),
                ),
            ),
            ...included.filter((item) => item.eligible).map((item) => item.id),
          ]),
        ],
      });
      setConsentFor('');
      await client.invalidateQueries({ queryKey: ['codex-digests'] });
      await client.invalidateQueries({ queryKey: ['codex-grants'] });
    },
    onError: async () => {
      // An earlier project may already have been saved before another one failed.
      await client.invalidateQueries({ queryKey: ['codex-grants'] });
      await client.invalidateQueries({ queryKey: ['codex-digests'] });
    },
  });
  const query = useQuery({
    queryKey: ['codex-digests', reviewId],
    queryFn: async ({ signal }) => {
      const items: CodexDigest[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: CodexDigest[]; nextCursor: string | null } = await api(
          `/codex-context/digests?${new URLSearchParams({ reviewId, ...(cursor ? { cursor } : {}) })}`,
          'GET',
          undefined,
          signal,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return { items };
    },
    refetchInterval: 5000,
  });
  return (
    <fieldset>
      <legend>Контекст Codex — по желанию</legend>
      <p>
        До двух содержательных диалогов на каждый выбранный проект. Приложение выделит короткие
        сообщения пользователя и заявления ассистента, уберёт повторы и вывод инструментов. Это
        ограниченная выборка, а не проверенные результаты.
      </p>
      <p>
        {workspace!.projects
          .filter((project) => value.projectIds.includes(project.id))
          .map((project) => project.metadata.name)
          .join(', ') || 'Сначала выберите проекты.'}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={!!scope && consentFor === scope}
          disabled={!scope || prepare.isPending}
          onChange={(event) => setConsentFor(event.target.checked ? scope : '')}
        />
        Разрешаю читать диалоги выбранных проектов и их проверенных worktree, подготовить и
        сохранить ограниченные выдержки локально. Отправка потребует отдельного подтверждения
        пакета.
      </label>
      <button
        type="button"
        disabled={
          !scope || consentFor !== scope || !grants.data || !!grants.error || prepare.isPending
        }
        onClick={() => prepare.mutate(value.projectIds)}
      >
        {prepare.isPending ? 'Подготавливаем контекст…' : 'Подготовить контекст выбранных проектов'}
      </button>
      {grants.error && (
        <p role="alert">Не удалось проверить разрешения Codex. Остальные источники доступны.</p>
      )}
      {prepare.error && <p role="alert">{prepare.error.message}</p>}
      {prepare.data && (
        <div role="status">
          {prepare.data.limitations.map((text) => (
            <p className="help" key={text}>
              {workspace!.projects.reduce(
                (message, project) => message.replaceAll(project.id, project.metadata.name),
                text,
              )}
            </p>
          ))}
        </div>
      )}
      <p>
        <Link
          to={`/codex-context?${new URLSearchParams({ review: reviewId, projects: value.projectIds.join(',') })}`}
        >
          Выбрать отдельный диалог, исправить итог или отключить чтение →
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
              disabled={
                !checked &&
                (!available ||
                  (query.data?.items.filter(
                    (other) =>
                      other.scopeProjectId === item.scopeProjectId &&
                      value.codexDigestIds.includes(other.id),
                  ).length ?? 0) >= 2)
              }
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
            {item.stale
              ? ' · диалог изменился — пересмотрите сохранённый итог'
              : !available
                ? ' · проверьте разрешение и выбор проекта'
                : ''}
          </label>
        );
      })}
      <p className="help">
        Снимите выбор, чтобы исключить диалог из пакета. Перед отправкой доступен весь пакет.
        Автоматическая отправка новых разговоров требует отдельного разрешения в расписании.
      </p>
    </fieldset>
  );
}
