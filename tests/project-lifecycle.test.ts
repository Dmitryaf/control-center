import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Tasks } from '../server/tasks.js';
import { createApp } from '../server/app.js';
import { ProjectLifecycle } from '../server/projects/lifecycle.js';
import { History } from '../server/history.js';
import { periodSelectionSchema } from '../shared/period-analysis.js';

test('closure history does not silently expand the accepted AI source categories', () => {
  assert.equal(
    periodSelectionSchema.safeParse({
      projectIds: [randomUUID()],
      includeGeneral: false,
      sourceKinds: ['project'],
      includeMetadata: false,
      includeOpenTasks: false,
      includeUserText: false,
      includeRelatedReviews: false,
    }).success,
    false,
  );
});

test('v12 project closure migration preserves old records without inventing closure dates', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'legacy.sqlite');
  const seed = new Store(file);
  const repo = await f.repo('finished-project');
  seed.saveSettings({ ...seed.settings(), roots: [repo] });
  const projects = new Projects(seed);
  await projects.scan();
  const project = projects.list()[0];
  seed.saveMetadata(project.id, { ...project.metadata, status: 'completed' }, 'Existing notes');
  const tasks = new Tasks(seed);
  const task = tasks.save({ title: 'Preserved work', projectId: project.id });
  tasks.complete(task.code, task.revision, { summary: 'Saved result' });
  const before = ['projects', 'records', 'task_identity', 'task_history', 'reviews'].map((name) =>
    seed.db.prepare(`SELECT * FROM ${name}`).all(),
  );
  seed.db.exec('DROP TABLE IF EXISTS project_lifecycle_events; PRAGMA user_version=12;');
  seed.close();
  const store = new Store(file);
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 16);
  for (const [index, name] of [
    'projects',
    'records',
    'task_identity',
    'task_history',
    'reviews',
  ].entries())
    assert.deepEqual(store.db.prepare(`SELECT * FROM ${name}`).all(), before[index]);
  assert.deepEqual(store.db.prepare('SELECT * FROM project_lifecycle_events').all(), []);
  assert.equal(new Projects(store).list()[0].metadata.status, 'completed');
  assert.deepEqual(new Projects(store).list()[0].lifecycle, { revision: 0, currentClosure: null });
  const backups = await readdir(path.join(f.root, 'backups'));
  const backup = new DatabaseSync(
    path.join(
      f.root,
      'backups',
      backups.find((name) => name.startsWith('before-project-lifecycle-v13'))!,
    ),
    { readOnly: true },
  );
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 12);
  assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  backup.close();
});

test('HTTP close → repeat → reopen → close retains dates, project history and retained cancelled tasks', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'workspace.sqlite');
  const store = new Store(file);
  const repo = await f.repo('garden-project');
  store.saveSettings({ ...store.settings(), roots: [repo], autoRefreshMinutes: 0 });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  store.saveMetadata(project.id, { ...project.metadata, status: 'active' }, 'Preserve notes');
  new Tasks(store).save({
    title: 'Unfinished work',
    projectId: project.id,
    result: { summary: 'Partial result', remaining: 'One more check' },
  });
  const taskRowsBefore = store.db.prepare("SELECT * FROM records WHERE kind='tasks'").all();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const runtime = createApp(store, address.port);
  server.on('request', runtime.app);
  t.after(async () => {
    await runtime.codexAnalysis.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  });
  const request = (suffix: string, data?: unknown, method = 'POST') =>
    fetch(`http://127.0.0.1:${address.port}/api${suffix}`, {
      method: data ? method : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
      body: data ? JSON.stringify(data) : undefined,
    });
  const close = {
    outcome: 'stopped',
    reason: 'The experiment answered the question; no further development is planned.',
    revision: 0,
    requestKey: randomUUID(),
  };
  const first = await request(`/projects/${project.id}/close`, close);
  assert.equal(first.status, 200);
  const closed = await first.json();
  assert.equal(closed.metadata.status, 'stopped');
  const taskRows = store.db.prepare("SELECT * FROM records WHERE kind='tasks'").all();
  assert.notDeepEqual(taskRows, taskRowsBefore);
  assert.equal(closed.lifecycle.revision, 1);
  assert.equal(closed.lifecycle.currentClosure.reason, close.reason);
  assert.ok(Number.isFinite(Date.parse(closed.lifecycle.currentClosure.recordedAt)));
  assert.equal(
    (
      await request(
        `/projects/${project.id}`,
        {
          metadata: { ...project.metadata, status: 'active' },
          notes: 'Preserve notes',
          expectedLifecycleRevision: 0,
        },
        'PUT',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/projects/${project.id}`,
        {
          metadata: { ...closed.metadata, goal: 'Updated description' },
          notes: 'Preserve notes',
          expectedLifecycleRevision: 1,
        },
        'PUT',
      )
    ).status,
    200,
  );
  const repeated = await request(`/projects/${project.id}/close`, close);
  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).lifecycle, closed.lifecycle);
  assert.equal(
    (await request(`/projects/${project.id}/close`, { ...close, reason: 'Different' })).status,
    409,
  );
  assert.equal(
    (await request(`/projects/${project.id}/reopen`, { revision: 0, requestKey: randomUUID() }))
      .status,
    409,
  );
  const reopened = await request(`/projects/${project.id}/reopen`, {
    revision: 1,
    requestKey: randomUUID(),
  });
  assert.equal(reopened.status, 200);
  const active = await reopened.json();
  assert.equal(active.metadata.status, 'active');
  assert.equal(active.lifecycle.revision, 2);
  assert.equal(active.lifecycle.currentClosure, null);
  // A delayed retry of the first close cannot close an already reopened project again.
  assert.equal(
    (await (await request(`/projects/${project.id}/close`, close)).json()).metadata.status,
    'active',
  );
  assert.equal(
    (await request(`/projects/${project.id}/close`, { ...close, requestKey: randomUUID() })).status,
    409,
  );
  const second = await request(`/projects/${project.id}/close`, {
    outcome: 'completed',
    reason: 'The goal has now been reached.',
    revision: 2,
    requestKey: randomUUID(),
  });
  assert.equal(second.status, 200);
  const history = await (
    await request(`/history?projectId=${project.id}&kind=project&timezone=UTC`)
  ).json();
  assert.deepEqual(
    history.items.map((entry: { event: string }) => entry.event),
    ['project_closed', 'project_reopened', 'project_closed'],
  );
  assert.ok(
    history.items.some((entry: { excerpt: string }) => entry.excerpt.includes(close.reason)),
  );
  assert.deepEqual(store.db.prepare("SELECT * FROM records WHERE kind='tasks'").all(), taskRows);
  assert.equal(store.project(project.id)?.notes, 'Preserve notes');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_lifecycle_events').get()?.n, 3);
  const originalEvent = store.db
    .prepare('SELECT id FROM project_lifecycle_events WHERE revision=1')
    .get()!;
  const event = await request(`/project-lifecycle/${originalEvent.id}`);
  assert.equal(event.status, 200);
  assert.equal((await event.json()).reason, close.reason);
  // Explicit reconciliation and summary edits use the same transition owner.
  await writeFile(path.join(repo, 'PROJECT.yaml'), 'name: Garden\nstatus: active\n');
  const yaml = await projects.refresh(project.id);
  const staleYaml = await request(`/projects/${project.id}/use-yaml`, {
    expectedHash: yaml.snapshot.yaml.hash,
    expectedLifecycleRevision: 2,
  });
  assert.equal(staleYaml.status, 409);
  assert.equal(projects.list()[0].metadata.status, 'completed');
  const useYaml = { expectedHash: yaml.snapshot.yaml.hash, expectedLifecycleRevision: 3 };
  assert.equal((await request(`/projects/${project.id}/use-yaml`, useYaml)).status, 200);
  assert.equal(projects.list()[0].metadata.status, 'active');
  assert.equal(
    (
      await request(`/projects/${project.id}/use-yaml`, {
        ...useYaml,
        expectedLifecycleRevision: 4,
      })
    ).status,
    200,
  );
  const summary = {
    metadata: { ...projects.list()[0].metadata, status: 'stopped' },
    notes: 'Preserve notes',
    expectedLifecycleRevision: 4,
  };
  assert.equal((await request(`/projects/${project.id}`, summary, 'PUT')).status, 200);
  assert.equal(
    (
      await request(
        `/projects/${project.id}`,
        {
          ...summary,
          expectedLifecycleRevision: 5,
        },
        'PUT',
      )
    ).status,
    200,
  );
  assert.equal(projects.list()[0].lifecycle?.currentClosure?.reason, '');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_lifecycle_events').get()?.n, 5);
  assert.deepEqual(store.db.prepare("SELECT * FROM records WHERE kind='tasks'").all(), taskRows);
});

test('discovery of closed YAML never fabricates a closure event', async (t) => {
  const f = await fixture(),
    store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('yaml-closed');
  await writeFile(path.join(repo, 'PROJECT.yaml'), 'name: Previously stopped\nstatus: stopped\n');
  store.saveSettings({ ...store.settings(), roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  assert.equal(projects.list()[0].metadata.status, 'stopped');
  assert.deepEqual(projects.list()[0].lifecycle, { revision: 0, currentClosure: null });
  await projects.scan();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_lifecycle_events').get()?.n, 0);
});

test('two SQLite owners preserve lifecycle ordering, rollback, backups and retained history', async (t) => {
  const f = await fixture(),
    file = path.join(f.root, 'two-owners.sqlite');
  const store = new Store(file);
  const repo = await f.repo('retained-project');
  store.saveSettings({ ...store.settings(), roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  store.saveMetadata(project.id, { ...project.metadata, status: 'active' }, '');
  const other = new Store(file),
    clock = () => new Date('2026-10-31T23:30:00Z');
  t.after(async () => {
    other.close();
    store.close();
    await f.cleanup();
  });
  const owner = new ProjectLifecycle(store, clock),
    second = new ProjectLifecycle(other, clock);
  const close = {
    outcome: 'stopped',
    reason: 'A durable explanation. '.repeat(50),
    revision: 0,
    requestKey: randomUUID(),
  };
  owner.close(project.id, close);
  second.reopen(project.id, { revision: 1, requestKey: randomUUID() });
  assert.throws(
    () => owner.reopen(project.id, { revision: 1, requestKey: randomUUID() }),
    /изменилось/,
  );
  owner.close(project.id, close);
  assert.equal(projects.view(projects.require(project.id)).metadata.status, 'active');
  store.db.exec(
    `CREATE TRIGGER fixture_fail_lifecycle BEFORE INSERT ON project_lifecycle_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`,
  );
  const last = {
    outcome: 'completed',
    reason: 'Goal reached',
    revision: 2,
    requestKey: randomUUID(),
  };
  assert.throws(() => owner.close(project.id, last), /fixture failure/);
  assert.equal(projects.view(projects.require(project.id)).metadata.status, 'active');
  assert.equal(owner.state(project.id).revision, 2);
  store.db.exec('DROP TRIGGER fixture_fail_lifecycle');
  owner.close(project.id, last);
  const backup = path.join(f.root, 'backup.sqlite');
  store.backup(backup);
  const restored = new Store(backup);
  assert.equal(
    new ProjectLifecycle(restored).state(project.id).currentClosure?.reason,
    'Goal reached',
  );
  restored.close();
  await projects.forget(project.id);
  const history = new History(store, projects.decisions).list({
    projectId: project.id,
    kind: 'project',
    from: '2026-11-01',
    to: '2026-11-01',
    timezone: 'Asia/Yekaterinburg',
  });
  assert.deepEqual(
    history.items.map((entry) => entry.event),
    ['project_closed', 'project_reopened', 'project_closed'],
  );
  assert.equal(history.items[2].truncated, true);
  const retained = owner.event(history.items[2].sourceId);
  assert.equal(retained.reason, close.reason.trim());
  assert.equal(retained.projectId, null);
  assert.equal(history.items[0].recordedAt, '2026-10-31T23:30:00.000Z');
  assert.equal(history.items[0].projectId, null);
  assert.equal(history.items[0].scopeProjectId, project.id);
});

test('rebind keeps source closure and refuses a target that has lifecycle history', async (t) => {
  const f = await fixture(),
    store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  await f.repo('source');
  await f.repo('target');
  await f.repo('fresh');
  store.saveSettings({ ...store.settings(), roots: [f.root] });
  const projects = new Projects(store);
  await projects.scan();
  const source = projects.list().find((p) => p.path.endsWith('source'))!;
  const target = projects.list().find((p) => p.path.endsWith('target'))!;
  const fresh = projects.list().find((p) => p.path.endsWith('fresh'))!;
  const owner = new ProjectLifecycle(store);
  owner.close(source.id, {
    outcome: 'stopped',
    reason: 'Preserved across a move',
    revision: 0,
    requestKey: randomUUID(),
  });
  owner.close(target.id, { outcome: 'completed', revision: 0, requestKey: randomUUID() });
  owner.saveMetadata(target.id, null, '');
  await rename(source.path, path.join(f.root, 'moved-source'));
  await assert.rejects(() => projects.rebind(source.id, target.id), /свои данные/);
  const rebound = await projects.rebind(source.id, fresh.id);
  assert.equal(rebound.id, source.id);
  assert.equal(rebound.lifecycle?.currentClosure?.reason, 'Preserved across a move');
});
