import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { fixture } from './fixtures.js';
import type { Workspace } from '../shared/contracts.js';

test('API empty database → scan → metadata → records → relation; validation and Origin/Host protection', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.repo('one');
  await f.repo('two');
  const store = new Store(':memory:');
  t.after(() => store.close());
  // Reserve an ephemeral port, then compose the app with its exact Host boundary.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const { app } = createApp(store, address.port);
  server.on('request', app);
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    url: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + '/api' + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    });
  let workspace = (await (await request('/workspace')).json()) as Workspace;
  assert.equal(workspace.projects.length, 0);
  assert.equal(
    (await request('/settings', 'PUT', { ...workspace.settings, roots: [f.root] })).status,
    200,
  );
  workspace = (await (await request('/workspace')).json()) as Workspace;
  assert.equal(workspace.projects.length, 2);
  const project = workspace.projects[0];
  assert.equal(
    (
      await request(`/projects/${project.id}`, 'PUT', {
        metadata: { ...project.metadata, status: 'active', current_focus: 'Ship', next: ['Test'] },
        notes: 'note',
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/tasks', 'POST', { title: 'Task', projectId: project.id, state: 'now' }))
      .status,
    201,
  );
  assert.equal((await request('/ideas', 'POST', { title: 'Idea' })).status, 201);
  assert.equal(
    (
      await request('/decisions', 'POST', {
        title: 'Decide',
        decision: 'Choose',
        projectId: project.id,
        date: '2026-10-04',
        status: 'pending',
      })
    ).status,
    201,
  );
  const relation = { sourceId: project.id, targetId: workspace.projects[1].id, type: 'uses' };
  await request('/relations', 'POST', relation);
  await request('/relations', 'POST', relation);
  workspace = (await (await request('/workspace')).json()) as Workspace;
  assert.equal(workspace.relations.length, 1);
  assert.ok(workspace.projects[0].signals.some((s) => s.code === 'decision'));
  assert.equal(workspace.tasks[0].state, 'now');
  assert.equal((await request('/tasks', 'POST', { title: '' })).status, 400);
  assert.equal(
    (await request('/settings', 'PUT', { ...workspace.settings, roots: ['relative'] })).status,
    400,
  );
  assert.equal(
    (await request('/relations', 'POST', { ...relation, targetId: project.id })).status,
    400,
  );
  assert.equal(
    (await request('/workspace', 'GET', undefined, { Origin: 'https://attacker.invalid' })).status,
    403,
  );
  assert.equal(
    (await request('/tasks', 'POST', { title: 'attack' }, { 'X-Control-Center': '' })).status,
    403,
  );
  const badHostStatus = await new Promise<number | undefined>((resolve) => {
    get(base + '/api/workspace', { headers: { Host: 'attacker.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request('/missing')).status, 404);
});
