import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { CodexChoices } from './CodexChoices';
import { emptySelection } from '../period-analysis/SourceSelection';
import { workspaceKey } from '../../shared/workspace';
import { designFixture } from '../../../tests/e2e/design-fixture';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test('current saved dialogs on a later page stay selectable when stale summaries fill the first page', async () => {
  const workspace = designFixture(),
    projectId = workspace.projects[0].id;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(workspaceKey, workspace);
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/digests?'))
      return Response.json(
        url.includes('cursor=next')
          ? {
              items: [
                {
                  id: 'current',
                  scopeProjectId: projectId,
                  projectName: 'Current',
                  thread: { name: 'Available dialog' },
                  eligible: true,
                  stale: false,
                },
              ],
              nextCursor: null,
            }
          : {
              items: Array.from({ length: 20 }, (_, i) => ({
                id: `stale-${i}`,
                scopeProjectId: projectId,
                projectName: 'Old',
                thread: { name: `Dialog ${i}` },
                eligible: false,
                stale: true,
              })),
              nextCursor: 'next',
            },
      );
    return Response.json({ projectId, enabled: false, revision: null });
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CodexChoices
          reviewId="review"
          value={{ ...emptySelection(projectId), codexDigestIds: [] }}
          onChange={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const current = await screen.findByRole('checkbox', { name: 'Current · Available dialog' });
  expect((current as HTMLInputElement).disabled).toBe(false);
  expect(urls.filter((url) => url.includes('/digests?'))).toHaveLength(2);
  client.clear();
});
