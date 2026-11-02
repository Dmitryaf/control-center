import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { ProjectLifecycle } from '../server/projects/lifecycle.js';
import { Tasks } from '../server/tasks.js';
import { TaskHistory } from '../server/task-history.js';
import { History } from '../server/history.js';
import { connectMcp } from './mcp-client.js';
import { taskSchema } from '../shared/contracts.js';
import { ProjectAnalysis } from '../server/analysis/analysis.js';

for (const outcome of ['stopped', 'completed'])
  test(`${outcome} cancels open tasks once, retains results and leaves completed/other tasks intact`, async (t) => {
    const f = await fixture(),
      store = new Store(':memory:');
    t.after(async () => {
      store.close();
      await f.cleanup();
    });
    const repo = await f.repo('project');
    store.saveSettings({ ...store.settings(), roots: [repo] });
    const projects = new Projects(store);
    await projects.scan();
    const project = projects.list()[0],
      tasks = new Tasks(store),
      owner = new ProjectLifecycle(store);
    const partial = tasks.save({
      title: 'Partial work',
      projectId: project.id,
      priority: 'high',
      result: { summary: 'First step', remaining: 'Next step' },
    });
    const plain = tasks.save({ title: 'Not started', projectId: project.id });
    const general = tasks.save({ title: 'Other work', projectId: null });
    const done = tasks.save({
      title: 'Done',
      projectId: project.id,
      completedAt: '2026-11-01T10:00:00Z',
      result: { summary: 'Actual result' },
    });
    const input = {
      outcome,
      revision: 0,
      requestKey: randomUUID(),
      reason: 'Private project explanation',
    };
    owner.close(project.id, input);
    const event = owner.state(project.id).currentClosure!;
    const cancelled = tasks.read(partial.id);
    assert.equal(cancelled.cancellation?.projectEventId, event.id);
    assert.equal(cancelled.cancellation?.at, event.recordedAt);
    assert.equal(cancelled.completedAt, null);
    assert.deepEqual(cancelled.result, partial.result);
    assert.equal(cancelled.priority, partial.priority);
    assert.equal(cancelled.number, partial.number);
    assert.equal(cancelled.revision, partial.revision + 1);
    assert.equal(cancelled.createdAt, partial.createdAt);
    assert.ok(tasks.read(plain.id).cancellation);
    const preview = new ProjectAnalysis(store, { key: '', model: '' }).prepare({
      projectIds: [project.id],
    });
    assert.deepEqual(preview.payload.projects[0].tasks, []);
    assert.ok(!JSON.stringify(preview).includes(input.reason));
    assert.deepEqual(tasks.read(done.id), done);
    assert.deepEqual(tasks.read(general.id), general);
    owner.close(project.id, input);
    assert.deepEqual(tasks.read(partial.id), cancelled);
    assert.throws(() => tasks.patch(partial.id, partial.revision, { title: 'Stale' }), /изменена/);
    assert.throws(
      () => tasks.complete(partial.id, cancelled.revision, { summary: 'Pretend done' }),
      /возврат|верните/i,
    );
    // Older clients omitting the new field cannot accidentally resurrect a cancellation.
    const { cancellation: ignored, ...legacy } = cancelled;
    void ignored;
    const edited = tasks.save({ ...legacy, title: 'Edited description' }, partial.id, true);
    assert.deepEqual(edited.cancellation, cancelled.cancellation);
    owner.reopen(project.id, { revision: 1, requestKey: randomUUID() });
    assert.ok(tasks.read(partial.id).cancellation);
    const reopened = tasks.patch(partial.id, edited.revision, { cancellation: null });
    assert.equal(reopened.cancellation, null);
    assert.deepEqual(reopened.result, partial.result);
    owner.close(project.id, input);
    assert.deepEqual(tasks.read(partial.id), reopened);
    assert.deepEqual(
      new TaskHistory(store).list({ identifier: partial.id }).items.map((entry) => entry.kind),
      ['reopened', 'cancelled', 'result'],
    );
    const history = new History(store, projects.decisions).list({
      kind: 'task',
      projectId: project.id,
    });
    assert.ok(history.items.some((entry) => entry.event === 'task_cancelled'));
    assert.ok(!JSON.stringify(history).includes(input.reason));
  });

test('cancellation history failure rolls back the project, every task and all events', async (t) => {
  const f = await fixture(),
    store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('rollback');
  store.saveSettings({ ...store.settings(), roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0],
    tasks = new Tasks(store),
    owner = new ProjectLifecycle(store);
  const one = tasks.save({ title: 'One', projectId: project.id });
  tasks.save({ title: 'Two', projectId: project.id });
  const before = tasks.list();
  store.db.exec(
    `CREATE TRIGGER fail_second_cancel BEFORE INSERT ON task_history WHEN NEW.kind='cancelled' AND NEW.task_id='${one.id}' BEGIN SELECT RAISE(ABORT,'cancellation fixture failure'); END;`,
  );
  assert.throws(
    () => owner.close(project.id, { outcome: 'stopped', revision: 0, requestKey: randomUUID() }),
    /cancellation fixture failure/,
  );
  assert.deepEqual(tasks.list(), before);
  assert.equal(owner.state(project.id).revision, 0);
  assert.equal(projects.list()[0].metadata.status, project.metadata.status);
  assert.equal(new TaskHistory(store).list().total, 0);
});

test('legacy task create keys and records missing cancellation remain readable and idempotent', () => {
  const store = new Store(':memory:');
  try {
    const tasks = new Tasks(store),
      input = { title: 'Legacy key', requestKey: 'legacy' };
    const task = tasks.save(input);
    const { cancellation: ignored, ...old } = taskSchema.parse(input);
    void ignored;
    store.db
      .prepare("UPDATE records SET data=json_remove(data,'$.cancellation') WHERE id=?")
      .run(task.id);
    store.db
      .prepare('UPDATE task_identity SET request_hash=? WHERE record_id=?')
      .run(createHash('sha256').update(JSON.stringify(old)).digest('hex'), task.id);
    assert.equal(tasks.save(input).id, task.id);
    assert.equal(tasks.read(task.id).cancellation, null);
    assert.equal(tasks.list().length, 1);
  } finally {
    store.close();
  }
});

test('summary and explicit YAML reconciliation cancel open tasks through the same owner', async (t) => {
  const f = await fixture(),
    store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('yaml-reconciliation');
  store.saveSettings({ ...store.settings(), roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0],
    tasks = new Tasks(store),
    owner = new ProjectLifecycle(store);
  const first = tasks.save({ title: 'Summary task', projectId: project.id });
  owner.saveMetadata(project.id, { ...project.metadata, status: 'completed' }, '', undefined, 0);
  assert.ok(tasks.read(first.id).cancellation);
  owner.saveMetadata(project.id, { ...project.metadata, status: 'active' }, '', undefined, 1);
  const second = tasks.save({ title: 'YAML task', projectId: project.id });
  await writeFile(path.join(repo, 'PROJECT.yaml'), 'name: YAML close\nstatus: stopped\n');
  await projects.refresh(project.id);
  assert.throws(() => owner.saveMetadata(project.id, null, '', undefined, 1), /изменилось/);
  assert.equal(tasks.read(second.id).cancellation, null);
  owner.saveMetadata(project.id, null, '', undefined, 2);
  assert.ok(tasks.read(second.id).cancellation);
  const snapshot = tasks.list();
  owner.saveMetadata(project.id, null, '', undefined, 3);
  assert.deepEqual(tasks.list(), snapshot);
});

test('schema13 migration preserves raw history, sequence and a verified compatible backup', async (t) => {
  const f = await fixture(),
    file = path.join(f.root, 'legacy.sqlite'),
    seed = new Store(file);
  t.after(f.cleanup);
  const repo = await f.repo('previously-closed');
  seed.saveSettings({ ...seed.settings(), roots: [repo] });
  const projects = new Projects(seed);
  await projects.scan();
  const project = projects.list()[0];
  seed.saveMetadata(project.id, { ...project.metadata, status: 'completed' }, '');
  const tasks = new Tasks(seed);
  tasks.save({ title: 'Previous work', result: { summary: 'Saved' } });
  const legacyOpen = tasks.save({ title: 'Legacy open', projectId: project.id });
  seed.db.exec(`ALTER TABLE task_history RENAME TO fixture_history;
    CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,revision INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('baseline','result','completed','reopened')),recorded_at TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,project_name TEXT,snapshot TEXT NOT NULL,UNIQUE(task_id,revision));
    INSERT INTO task_history SELECT * FROM fixture_history; DROP TABLE fixture_history;
    CREATE INDEX task_history_project_time ON task_history(project_id,recorded_at);
    UPDATE sqlite_sequence SET seq=70 WHERE name='task_history'; PRAGMA user_version=13;`);
  const rows = seed.db.prepare('SELECT * FROM task_history').all();
  seed.close();
  const migrated = new Store(file);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 14);
  assert.equal(new Tasks(migrated).read(legacyOpen.id).cancellation, null);
  assert.deepEqual(migrated.db.prepare('SELECT * FROM task_history').all(), rows);
  assert.equal(
    migrated.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='task_history'").get()?.seq,
    70,
  );
  const next = new Tasks(migrated).save({ title: 'New result', result: { summary: 'Next' } });
  assert.equal(new TaskHistory(migrated).list({ identifier: next.id }).items[0].id, 71);
  migrated.close();
  const names = await readdir(path.join(f.root, 'backups'));
  const backup = new DatabaseSync(
    path.join(
      f.root,
      'backups',
      names.find((name) => name.startsWith('before-task-cancellation-v14'))!,
    ),
    { readOnly: true },
  );
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 13);
  assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  backup.close();
});

test('real MCP excludes cancelled tasks from open work and can explicitly return one task', async (t) => {
  const f = await fixture(),
    data = path.join(f.root, 'data'),
    store = new Store(path.join(data, 'control-center.sqlite'));
  const repo = await f.repo('mcp-project');
  store.saveSettings({ ...store.settings(), roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0],
    tasks = new Tasks(store);
  const task = tasks.save({ title: 'Cancelled work', projectId: project.id });
  new ProjectLifecycle(store).close(project.id, {
    outcome: 'completed',
    revision: 0,
    requestKey: randomUUID(),
  });
  const mcp = await connectMcp(data, repo);
  t.after(async () => {
    await mcp.close();
    store.close();
    await f.cleanup();
  });
  const open = await mcp.call('task_list', { projectId: project.id });
  assert.equal(open.value.total, 0);
  const cancelled = await mcp.call('task_list', { projectId: project.id, completed: 'cancelled' });
  assert.equal(cancelled.isError, false);
  assert.equal(cancelled.value.total, 1);
  assert.ok(cancelled.value.items[0].cancellation);
  const context = await mcp.call('project_context', { projectId: project.id });
  assert.deepEqual(context.value.tasks, []);
  const reopened = await mcp.call('task_update', {
    identifier: task.code,
    revision: tasks.read(task.id).revision,
    change: { cancellation: null },
  });
  assert.equal(reopened.isError, false);
  assert.equal(tasks.read(task.id).cancellation, null);
});
