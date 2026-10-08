import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { fixture } from './fixtures.js';
import { connectMcp } from './mcp-client.js';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { Projects } from '../server/projects/projects.js';
import { defaultSettings } from '../shared/contracts.js';

test('project context refreshes saved Git and YAML in a standalone MCP process without UI or a background timer', async (t) => {
  const f = await fixture();
  const data = path.join(f.root, 'data');
  const store = new Store(path.join(data, 'control-center.sqlite'));
  const repo = await f.repo('context-freshness');
  store.saveSettings({ ...defaultSettings, roots: [repo], autoRefreshMinutes: 0 });
  await new Projects(store).scan();
  const id = store.projects()[0]!.id;
  const previousSnapshot = store.project(id)!.snapshot;
  await writeFile(
    path.join(repo, 'PROJECT.yaml'),
    'name: Fresh context\ncurrent_focus: New context\n',
  );
  f.git(repo, 'switch', '-c', 'context-work');
  const mcp = await connectMcp(data, f.root);
  t.after(async () => {
    await mcp.close();
    store.close();
    await f.cleanup();
  });
  const result = await mcp.call('project_context', { projectId: id });
  assert.equal(result.isError, false);
  assert.equal(result.value.project.name, 'Fresh context');
  assert.equal(result.value.project.metadata.current_focus, 'New context');
  assert.equal(result.value.project.git.branch, 'context-work');
  assert.equal(result.value.project.git.dirty, true);
  assert.deepEqual(result.value.project.readErrors, []);
  assert.notEqual(store.project(id)!.snapshot, previousSnapshot);
  const saved = JSON.parse(store.project(id)!.snapshot);
  assert.equal(saved.git.branch, 'context-work');
  assert.equal(saved.git.dirty, true);
  assert.equal(result.value.project.snapshotAt, saved.scannedAt);
  assert.equal(store.settings().autoRefreshMinutes, 0);
});

test('real stdio clients without UI: project/worktree, bidirectional HTTP tasks, concurrent edits, idempotency and denied capabilities', async (t) => {
  const f = await fixture();
  const data = path.join(f.root, 'data');
  const store = new Store(path.join(data, 'control-center.sqlite'));
  const repo = await f.repo('selected');
  const other = await f.repo('other');
  const worktree = path.join(f.root, 'worktree');
  f.git(repo, 'worktree', 'add', '--detach', worktree);
  await writeFile(path.join(repo, 'DECISIONS.md'), '# Storage\n\nKeep data local.\n');
  store.saveSettings({ ...defaultSettings, roots: [repo, other] });
  await new Projects(store).scan();
  const project = store.projects().find((row) => row.path === repo)!;
  const a = await connectMcp(data, other);
  const b = await connectMcp(data, f.root);
  t.after(async () => {
    await a.close();
    await b.close();
    store.close();
    await f.cleanup();
  });
  const tools = (await a.client.listTools()).tools;
  assert.match(a.client.getInstructions() ?? '', /Незавершённую работу сохраняйте task_update/);
  assert.equal(tools.length, 8);
  assert.equal(
    tools.some((tool) => /delete|shell|exec|file/.test(tool.name)),
    false,
  );
  assert.equal((await a.call('projects')).value.total, 2);
  const context = await a.call('project_context', { workingDirectory: worktree });
  assert.equal(context.value.project.id, project.id);
  assert.equal(context.value.decisions.length, 1);
  assert.equal(context.value.taskSource, 'tasks');
  const content = await a.call('project_context', {
    projectId: project.id,
    decisionKey: context.value.decisions[0].key,
  });
  assert.ok(JSON.stringify(content.value.decision).includes('Keep data local'));
  assert.ok(
    (
      await a.call('project_context', {
        projectId: project.id,
        decisionKey: path.join(other, 'README.md'),
      })
    ).isError,
  );
  assert.ok((await a.call('project_context', { workingDirectory: f.root })).isError);
  assert.ok((await a.call('project_context')).isError);
  const created = await a.call('task_create', {
    title: 'MCP without interface',
    projectId: project.id,
    requestKey: 'mcp-retry',
  });
  assert.equal(created.isError, false);
  assert.equal(
    (await b.call('task_read', { identifier: created.value.code })).value.id,
    created.value.id,
  );
  // A repeated request and two simultaneous creates commit one record.
  const concurrent = await Promise.all([
    a.call('task_create', {
      title: 'Concurrent create',
      projectId: null,
      requestKey: 'shared-key',
    }),
    b.call('task_create', {
      title: 'Concurrent create',
      projectId: null,
      requestKey: 'shared-key',
    }),
  ]);
  assert.equal(concurrent[0].value.id, concurrent[1].value.id);
  assert.ok(
    (
      await b.call('task_create', {
        title: 'Different request',
        projectId: null,
        requestKey: 'shared-key',
      })
    ).isError,
  );
  const collision = await b.call('task_create', {
    title: 'MCP without interface',
    projectId: project.id,
    requestKey: 'other-key',
  });
  assert.equal(collision.value.status, 409);
  const edits = await Promise.all([
    a.call('task_update', {
      identifier: created.value.code,
      revision: created.value.revision,
      change: { description: 'A' },
    }),
    b.call('task_update', {
      identifier: created.value.code,
      revision: created.value.revision,
      change: { description: 'B' },
    }),
  ]);
  assert.equal(edits.filter((item) => !item.isError).length, 1);
  assert.equal(edits.filter((item) => item.value.status === 409).length, 1);
  const current = (await b.call('task_read', { identifier: created.value.code })).value;
  assert.ok(
    (
      await a.call('task_complete', {
        identifier: current.code,
        revision: current.revision,
        result: { summary: 'Partial', remaining: 'Still work' },
      })
    ).isError,
  );
  assert.ok(
    (
      await a.call('task_update', {
        identifier: current.code,
        revision: current.revision,
        change: { completedAt: new Date().toISOString() },
      })
    ).isError,
  );
  const done = await a.call('task_complete', {
    identifier: current.code,
    revision: current.revision,
    result: { summary: 'Done', verified: 'Actual stdio', unverified: 'Native Codex session' },
  });
  assert.ok(done.value.completedAt);
  const restored = await b.call('task_update', {
    identifier: current.code,
    revision: done.value.revision,
    change: { completedAt: null },
  });
  assert.equal(restored.value.result.summary, 'Done');
  const history = await a.call('task_history', { identifier: current.code, projectId: project.id });
  assert.equal(history.isError, false);
  assert.equal(history.value.items[0].kind, 'reopened');
  assert.equal(history.value.items[1].kind, 'completed');
  assert.equal(history.value.items[1].task.result.summary, 'Done');
  assert.equal(
    (await b.call('task_history', { identifier: current.id })).value.total,
    history.value.total,
  );
  assert.equal((await a.call('task_history', { limit: 101 })).isError, true);
  assert.equal(
    (await a.call('task_history', { from: '2026-10-09', to: '2026-10-08' })).isError,
    true,
  );
  const replay = await a.call('task_create', {
    title: 'MCP without interface',
    projectId: project.id,
    requestKey: 'mcp-retry',
  });
  assert.equal(replay.value.id, restored.value.id);
  assert.equal(replay.value.revision, restored.value.revision);
  assert.ok(
    (
      await a.call('task_update', {
        identifier: current.code,
        revision: restored.value.revision,
        change: { command: 'anything' },
      })
    ).isError,
  );
  assert.ok((await a.call('read_file', { path: path.join(other, 'README.md') })).isError);
  assert.ok((await a.call('task_list', { workingDirectory: other })).isError);
  assert.equal(
    (
      await a.call('task_list', {
        projectId: store.projects().find((row) => row.path === other)!.id,
      })
    ).value.total,
    0,
  );
  assert.equal(
    (await a.call('task_list', { projectId: project.id, query: current.code })).value.items[0].id,
    current.id,
  );
  // Add HTTP only after the standalone MCP scenario has succeeded.
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const port = (http.address() as { port: number }).port;
  http.on('request', createApp(store, port).app);
  const base = `http://127.0.0.1:${port}/api`;
  const fromHttp = await (
    await fetch(base + '/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
      body: JSON.stringify({ title: 'HTTP to MCP', projectId: project.id }),
    })
  ).json();
  assert.equal(
    (await a.call('task_read', { identifier: fromHttp.code })).value.title,
    'HTTP to MCP',
  );
  const workspace = await (await fetch(base + '/workspace')).json();
  assert.equal(
    workspace.tasks.find((task: { id: string }) => task.id === current.id).result.summary,
    'Done',
  );
  const stale = await fetch(base + `/tasks/${current.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
    body: JSON.stringify({ ...created.value, title: 'Stale HTTP edit' }),
  });
  assert.equal(stale.status, 409);
  await a.close();
  const restarted = await connectMcp(data, other);
  try {
    assert.equal(
      (await restarted.call('task_read', { identifier: current.code })).value.result.summary,
      'Done',
    );
  } finally {
    await restarted.close();
  }
});
