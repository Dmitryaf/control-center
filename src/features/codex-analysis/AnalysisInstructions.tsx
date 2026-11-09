import { useQuery } from '@tanstack/react-query';
import type { CodexAnalysisInstructions } from '../../../shared/codex-analysis';
import { api } from '../../shared/http';

export function useCodexInstructions() {
  return useQuery({
    queryKey: ['codex-analysis-instructions'],
    queryFn: ({ signal }) =>
      api<CodexAnalysisInstructions>('/codex-analysis/instructions', 'GET', undefined, signal),
    staleTime: 60000,
  });
}
export function AnalysisInstructions() {
  const query = useCodexInstructions();
  return (
    <details className="analysis-instructions">
      <summary>Промпт анализа по умолчанию</summary>
      {query.data && (
        <>
          <p className="preserve">{query.data.question}</p>
          <details>
            <summary>Инструкция Codex · {query.data.policy}</summary>
            <p className="preserve">{query.data.instruction}</p>
          </details>
        </>
      )}
      {query.isPending && <p role="status">Загрузка промпта…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
    </details>
  );
}
