import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { ProjectLifecycle } from '../server/projects/lifecycle.js';
import { Tasks } from '../server/tasks.js';
import { TaskHistory } from '../server/task-history.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { ProjectAnalysis } from '../server/analysis/analysis.js';
import { buildPeriodContext } from '../server/analysis/period-context.js';
import { periodSelectionSchema } from '../shared/period-analysis.js';
import { taskProjectIds } from '../shared/task-projects.js';
import { connectMcp } from './mcp-client.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture();
  const store = new Store(path.join(f.root, 'control-center.sqlite'));
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  store.saveSettings({ ...store.settings(), roots: [await f.repo('alpha'), await f.repo('beta')] });
  const projects = new Projects(store);
  await projects.scan();
  return {
    f,
    store,
    projects,
    ids: projects
      .list()
      .map((p) => p.id)
      .sort(),
    tasks: new Tasks(store),
  };
}

test('shared task keeps one identity, CAS and create replay; legacy edits preserve all memberships', async (t) => {
  const { f, store, projects, ids, tasks } = await setup(t);
  const input = { title: 'Shared work', projectIds: [...ids].reverse(), requestKey: randomUUID() };
  const task = tasks.save(input);
  assert.deepEqual(task.projectIds, ids);
  assert.equal(tasks.save({ ...input, projectIds: ids }).id, task.id);
  assert.throws(() => tasks.save({ ...input, projectIds: ids.slice(1) }), /ключ/);
  const { projectIds: ignored, ...legacy } = task;
  void ignored;
  const edited = tasks.save({ ...legacy, title: 'Keep both' }, task.id, true);
  assert.deepEqual(edited.projectIds, ids);
  assert.throws(() => tasks.patch(task.id, task.revision, { title: 'Stale' }), /изменена/);
  assert.throws(() => tasks.patch(task.id, edited.revision, { projectId: null }), /projectIds/);
  const done = tasks.complete(task.id, edited.revision, { summary: 'One result' });
  const history = new TaskHistory(store);
  for (const id of ids) assert.equal(history.list({ projectId: id }).items[0].task.id, task.id);
  assert.equal(history.list().total, 1);
  assert.equal(done.code, task.code);
  assert.throws(
    () => tasks.save({ title: 'Unknown project', projectIds: [randomUUID()] }),
    /проект/,
  );
  const originalPath = store.project(ids[0])!.path;
  store.db
    .prepare('UPDATE projects SET path=? WHERE id=?')
    .run(path.join(originalPath, 'missing-fixture'), ids[0]);
  await assert.rejects(projects.rebind(ids[0], ids[1]), /свои данные/);
  store.db.prepare('UPDATE projects SET path=?,available=1 WHERE id=?').run(originalPath, ids[0]);
  const mcp = await connectMcp(f.root, projects.list()[0].path);
  for (const id of ids) {
    const result = await mcp.call('task_list', { projectId: id, completed: 'done' });
    assert.equal(result.value.items[0].id, task.id);
  }
  const created = await mcp.call('task_create', {
    title: 'MCP shared task',
    projectIds: ids,
    requestKey: randomUUID(),
  });
  assert.equal(created.isError, false);
  assert.deepEqual(created.value.projectIds, ids);
  const changed = await mcp.call('task_update', {
    identifier: created.value.code,
    revision: created.value.revision,
    change: { projectIds: [ids[1]] },
  });
  assert.equal(changed.isError, false);
  assert.deepEqual(tasks.read(created.value.id).projectIds, [ids[1]]);
  await mcp.close();
});

test('closing one project retains shared task, closing last cancels; removal detaches and preserves raw history', async (t) => {
  const { store, projects, ids, tasks } = await setup(t);
  const task = tasks.save({
    title: 'Shared lifecycle',
    projectIds: ids,
    result: { summary: 'Partial' },
  });
  const lifecycle = new ProjectLifecycle(store);
  lifecycle.close(ids[0], {
    outcome: 'stopped',
    revision: 0,
    requestKey: randomUUID(),
    reason: 'Stop first',
  });
  assert.equal(tasks.read(task.id).cancellation, null);
  assert.equal(tasks.read(task.id).revision, task.revision);
  lifecycle.close(ids[1], { outcome: 'completed', revision: 0, requestKey: randomUUID() });
  assert.ok(tasks.read(task.id).cancellation);
  const raw = store.db.prepare('SELECT snapshot FROM task_history ORDER BY id').all();
  const before = tasks.read(task.id);
  await projects.forget(ids[0]);
  assert.deepEqual(tasks.read(task.id).projectIds, [ids[1]]);
  assert.equal(tasks.read(task.id).revision, before.revision + 1);
  await projects.forget(ids[1]);
  assert.deepEqual(tasks.read(task.id).projectIds, []);
  assert.equal(tasks.read(task.id).projectId, null);
  assert.deepEqual(store.db.prepare('SELECT snapshot FROM task_history ORDER BY id').all(), raw);
  assert.equal(new TaskHistory(store).list({ projectId: ids[1] }).total, 2);
  assert.equal(new TaskHistory(store).list({ projectId: null }).total, 0);
});

test('overview groups task events before pagination; project history and selected analysis include shared work once', async (t) => {
  const { store, projects, ids, tasks } = await setup(t);
  const task = tasks.save({ title: 'Work in both', projectIds: ids, result: { summary: 'First' } });
  tasks.complete(task.id, task.revision, { summary: 'Finished' });
  const history = new History(store, projects.decisions);
  assert.equal(history.list({ kind: 'task' }).items.length, 2);
  assert.equal(history.list({ groupTasks: 'latest', limit: 1 }).items[0].event, 'task_completed');
  assert.equal(history.list({ groupTasks: 'latest', limit: 1 }).nextCursor, null);
  for (const id of ids) assert.equal(history.list({ projectId: id }).items.length, 2);
  assert.equal(history.latestProjects().items.length, 2);
  const open = tasks.save({ title: 'Open in both', projectIds: ids });
  const review = new Reviews(store).create({
    kind: 'week',
    anchorDate: new Date().toISOString().slice(0, 10),
  });
  const selection = periodSelectionSchema.parse({
    projectIds: ids,
    sourceKinds: ['task'],
    includeMetadata: false,
    includeOpenTasks: true,
    includeGeneral: false,
    includeUserText: false,
    includeRelatedReviews: false,
  });
  const both = buildPeriodContext(store, history, review, selection, Date.now());
  const sources = both.payload.sources;
  assert.equal(sources.filter((s) => s.id === `open-task:${open.id}`).length, 1);
  assert.equal(sources.filter((s) => s.kind === 'task').length, 2);
  const single = buildPeriodContext(
    store,
    history,
    review,
    { ...selection, projectIds: [ids[1]] },
    Date.now(),
  );
  assert.ok(!JSON.stringify(single.payload).includes(ids[0]));
  assert.equal(single.payload.sources.filter((s) => s.kind === 'open_task').length, 1);
  const old = new ProjectAnalysis(store, { key: '', model: '' }).prepare({ projectIds: ids });
  assert.equal(old.payload.projects.flatMap((p) => p.tasks).length, 1);
  assert.equal(old.payload.projects.flatMap((p) => p.recentWork).length, 2);
});

test('v15 upgrade backs up without rewriting records, identity or immutable snapshots', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'legacy.sqlite');
  const store = new Store(file);
  const tasks = new Tasks(store);
  const input = { title: 'Legacy replay', requestKey: randomUUID(), result: { summary: 'Kept' } };
  const task = tasks.save(input);
  const data = JSON.parse(
    String(store.db.prepare('SELECT data FROM records WHERE id=?').get(task.id)!.data),
  );
  delete data.projectIds;
  store.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data), task.id);
  store.db.exec('PRAGMA user_version=15');
  const before = ['records', 'task_identity', 'task_history'].map((table) =>
    store.db.prepare(`SELECT * FROM ${table}`).all(),
  );
  store.close();
  const migrated = new Store(file);
  t.after(async () => {
    migrated.close();
    await f.cleanup();
  });
  assert.equal(migrated.db.prepare('PRAGMA user_version').get()!.user_version, 16);
  assert.deepEqual(
    ['records', 'task_identity', 'task_history'].map((table) =>
      migrated.db.prepare(`SELECT * FROM ${table}`).all(),
    ),
    before,
  );
  assert.equal(new Tasks(migrated).save(input).id, task.id);
  assert.deepEqual(taskProjectIds(new Tasks(migrated).read(task.id)), []);
  assert.ok(
    (await readdir(path.join(f.root, 'backups'))).some((name) =>
      name.startsWith('before-task-projects-v16'),
    ),
  );
});
