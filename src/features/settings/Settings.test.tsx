import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Settings from './Settings';
import { DraftProvider } from '../../shared/UnsavedChanges';
import { ActionProvider, workspaceKey, useWorkspace } from '../../shared/workspace';
import { defaultSettings, type Workspace } from '../../../shared/contracts';

const fixture = (): Workspace => ({
  projects: [],
  tasks: [],
  ideas: [],
  decisions: [],
  relations: [],
  checks: [],
  checkEntries: [],
  fileDecisions: [],
  settings: { ...defaultSettings, roots: ['C:/synthetic'] },
  storage: { databasePath: '/synthetic/test.sqlite' },
  scan: { running: false, scannedAt: null, errors: [] },
  refresh: { running: false, lastAttemptAt: null, errors: [] },
});
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
function setup() {
  const data = fixture();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(workspaceKey, data);
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <DraftProvider>
          <Settings />
        </DraftProvider>
      ),
    },
    { path: '/other', element: <p>Other</p> },
  ]);
  render(
    <QueryClientProvider client={client}>
      <ActionProvider>
        <RouterProvider router={router} />
      </ActionProvider>
    </QueryClientProvider>,
  );
  return { client, data, router };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test('a superseded workspace request cannot replace a newer result', async () => {
  const requests: { resolve: (value: Response) => void; reject: (error: Error) => void }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () => new Promise<Response>((resolve, reject) => requests.push({ resolve, reject })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    const q = useWorkspace();
    return <p>{q.data?.storage.databasePath ?? 'Loading'}</p>;
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(requests.length).toBe(1));
  await client.cancelQueries({ queryKey: workspaceKey });
  const latest = client.refetchQueries({ queryKey: workspaceKey });
  await waitFor(() => expect(requests.length).toBe(2));
  requests[1].resolve(
    Response.json({ ...fixture(), storage: { databasePath: 'Latest saved state' } }),
  );
  await latest;
  await screen.findByText('Latest saved state');
  requests[0].reject(new Error('Stale failure'));
  await waitFor(() => expect(screen.queryByText('Loading')).toBeNull());
  expect(client.getQueryState(workspaceKey)?.status).toBe('success');
});
test('workspace refetch preserves a dirty settings form; cancelled navigation retains it', async () => {
  const { client, data, router } = setup();
  const user = userEvent.setup();
  const roots = screen.getByLabelText('Полные пути, каждый с новой строки') as HTMLTextAreaElement;
  await user.clear(roots);
  await user.type(roots, 'C:/draft');
  client.setQueryData(workspaceKey, {
    ...data,
    settings: { ...data.settings, roots: ['C:/external'] },
  });
  await waitFor(() => expect(roots.value).toBe('C:/draft'));
  void router.navigate('/other');
  await user.click(await screen.findByText('Продолжить редактирование'));
  expect(router.state.location.pathname).toBe('/');
  expect(roots.value).toBe('C:/draft');
});
test('a failed save keeps input, is not retried, and sends the existing mutation header', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ error: 'Settings rejected' }, { status: 409 }));
  setup();
  const user = userEvent.setup();
  const roots = screen.getByLabelText('Полные пути, каждый с новой строки') as HTMLTextAreaElement;
  await user.clear(roots);
  await user.type(roots, 'C:/draft');
  await user.click(screen.getByText('Сохранить и сканировать'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(roots.value).toBe('C:/draft');
  expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
    'Content-Type': 'application/json',
    'X-Control-Center': '1',
  });
  expect(fetchMock.mock.calls[0][0]).toBe('/api/settings');
});
