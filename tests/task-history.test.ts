import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Tasks } from '../server/tasks.js';
import { TaskHistory } from '../server/task-history.js';
import { Records } from '../server/records.js';
import { Projects } from '../server/projects/projects.js';
import { createApp } from '../server/app.js';
import { defaultSettings } from '../shared/contracts.js';

test('v4 upgrade backs up committed WAL, preserves records/identity, seeds only known results and reopens without duplicating history', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'history.sqlite');
  const seed = new Store(file);
  const repo = await f.repo('old-project');
  seed.saveSettings({ ...defaultSettings, roots: [repo] });
  await new Projects(seed).scan();
  const project = seed.projects()[0];
  const tasks = new Tasks(seed);
  const plain = tasks.save({ title: 'No known work', projectId: project.id });
  const partial = tasks.save({
    title: 'Partial',
    projectId: project.id,
    result: { summary: 'Known partial', remaining: 'Tests' },
  });
  const done = tasks.complete(plain.code, plain.revision, {
    summary: 'Known completed',
    verified: 'Reported checks',
  });
  tasks.save({ title: 'No result' });
  const legacyDone = tasks.save({
    title: 'Legacy completion without result',
    completedAt: '2026-10-01T12:00:00.000Z',
  });
  // Model the previous supported version, retaining raw unknown JSON.
  seed.db
    .prepare("UPDATE records SET data=json_set(data,'$.unknown','keep') WHERE id=?")
    .run(partial.id);
  seed.db.exec('DROP TABLE task_history; PRAGMA user_version=4;');
  const raw = seed.db.prepare('SELECT * FROM records ORDER BY id').all();
  const identity = seed.db.prepare('SELECT * FROM task_identity ORDER BY number').all();
  const upgraded = new Store(file); // seed is still open: backup must include committed WAL.
  seed.close();
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM records ORDER BY id').all(), raw);
  assert.deepEqual(
    upgraded.db.prepare('SELECT * FROM task_identity ORDER BY number').all(),
    identity,
  );
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 5);
  const history = new TaskHistory(upgraded).list();
  assert.equal(history.total, 3);
  assert.ok(history.items.every((item) => item.kind === 'baseline'));
  assert.equal(history.items.find((item) => item.task.id === legacyDone.id)?.task.result, null);
  assert.equal(
    history.items.find((item) => item.task.id === partial.id)?.projectName,
    'old-project',
  );
  const completed = history.items.find((item) => item.task.id === done.id)!;
  assert.equal(completed.task.result?.summary, 'Known completed');
  assert.equal(completed.recordedAt, done.updatedAt);
  assert.equal(completed.task.completedAt, done.completedAt);
  assert.equal(
    history.items.find((item) => item.task.id === partial.id)?.task.result?.remaining,
    'Tests',
  );
  assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const backupFiles = await readdir(path.join(f.root, 'backups'));
  assert.equal(backupFiles.length, 1);
  assert.match(backupFiles[0], /^before-history-v5-/);
  const backup = new DatabaseSync(path.join(f.root, 'backups', backupFiles[0]), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 4);
  assert.deepEqual(backup.prepare('SELECT * FROM records ORDER BY id').all(), raw);
  assert.equal(
    backup.prepare("SELECT name FROM sqlite_master WHERE name='task_history'").get(),
    undefined,
  );
  backup.close();
  upgraded.close();
  const reopened = new Store(file);
  try {
    assert.equal(new TaskHistory(reopened).list().total, 3);
    assert.equal(new Tasks(reopened).read(partial.code).id, partial.id);
    assert.equal((await readdir(path.join(f.root, 'backups'))).length, 1);
  } finally {
    reopened.close();
  }
});

test('history migration backup failure leaves v4 schema and data untouched', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'blocked.sqlite');
  const seed = new Store(file);
  const task = new Tasks(seed).save({ title: 'Keep', result: { summary: 'Known' } });
  seed.db.exec('DROP TABLE task_history; PRAGMA user_version=4;');
  const raw = seed.db.prepare('SELECT * FROM records').all();
  seed.close();
  await writeFile(path.join(f.root, 'backups'), 'Directory blocked');
  assert.throws(() => new Store(file));
  const untouched = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(untouched.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.deepEqual(untouched.prepare('SELECT * FROM records').all(), raw);
    assert.equal(
      untouched.prepare("SELECT name FROM sqlite_master WHERE name='task_history'").get(),
      undefined,
    );
    assert.ok(task.id);
  } finally {
    untouched.close();
  }
});

test('upgrade rechecks a stale schema version after another SQLite connection completes migration', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'interleaved.sqlite');
  const seed = new Store(file);
  new Tasks(seed).save({ title: 'Known work', result: { summary: 'Keep once' } });
  seed.db.exec('DROP TABLE task_history; PRAGMA user_version=4;');
  seed.close();
  const prepare = DatabaseSync.prototype.prepare;
  let interleaved = false;
  // Deterministically pause at the same boundary as two app/MCP startups:
  // one sees v4, another commits v5 before the first acquires its write lock.
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === 'PRAGMA user_version' && !interleaved) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const stale = get(...args);
        assert.equal(stale?.user_version, 4);
        interleaved = true;
        const competing = new Store(file);
        assert.equal(new TaskHistory(competing).list().total, 1);
        competing.close();
        return stale;
      };
    }
    return statement;
  };
  try {
    const late = new Store(file);
    try {
      assert.ok(interleaved);
      assert.equal(late.db.prepare('PRAGMA user_version').get()?.user_version, 5);
      assert.equal(new TaskHistory(late).list().total, 1);
    } finally {
      late.close();
    }
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
});

test('history survives result edits, clearing, reopening, deletion and project removal; conflicts/retries do not append and append failure rolls back task', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'shared.sqlite');
  const first = new Store(file);
  const second = new Store(file);
  t.after(async () => {
    first.close();
    second.close();
    await f.cleanup();
  });
  const repo = await f.repo('Original project');
  first.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(first);
  await projects.scan();
  const project = first.projects()[0];
  const a = new Tasks(first),
    b = new Tasks(second),
    history = new TaskHistory(second);
  const initial = a.save({ title: 'Original title', projectId: project.id, requestKey: 'same' });
  assert.equal(history.list().total, 0);
  const partial = a.patch(initial.code, initial.revision, {
    result: { summary: 'First pass', remaining: 'Review' },
  });
  assert.throws(
    () => b.patch(initial.code, initial.revision, { result: { summary: 'Stale' } }),
    /уже изменена/,
  );
  assert.equal(
    b.save({ title: 'Original title', projectId: project.id, requestKey: 'same' }).id,
    initial.id,
  );
  assert.equal(history.list().total, 1);
  const renamed = a.patch(initial.code, partial.revision, { title: 'New title', state: 'now' });
  assert.equal(history.list().total, 1);
  const done = b.complete(initial.code, renamed.revision, {
    summary: 'First completion',
    verified: 'First tests',
    unverified: 'Owner data',
  });
  const reopen = a.patch(initial.code, done.revision, { completedAt: null });
  const cleared = b.patch(initial.code, reopen.revision, { result: null });
  first.db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON task_history BEGIN SELECT RAISE(ABORT,'history blocked'); END;",
  );
  assert.throws(
    () => a.complete(initial.code, cleared.revision, { summary: 'Must rollback' }),
    /history blocked/,
  );
  assert.deepEqual(b.read(initial.code), cleared);
  assert.equal(history.list().total, 4);
  first.db.exec('DROP TRIGGER fail_history;');
  const row = projects.view(project);
  first.saveMetadata(project.id, { ...row.metadata, name: 'Renamed project' }, '');
  b.complete(initial.code, cleared.revision, {
    summary: 'Second completion',
    verified: 'Second tests',
  });
  const entries = history.list({ identifier: initial.code }).items;
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['completed', 'result', 'reopened', 'completed', 'result'],
  );
  assert.equal(entries[0].projectName, 'Renamed project');
  assert.equal(entries[4].projectName, 'Original project');
  assert.equal(entries[4].task.title, 'Original title');
  assert.equal(entries[3].task.result?.summary, 'First completion');
  assert.equal(entries[1].task.result, null);
  const targetRepo = await f.repo('empty-rebind-target');
  first.saveSettings({ ...first.settings(), roots: [targetRepo] });
  await projects.scan();
  const target = first.projects().find((row) => row.path === targetRepo)!;
  await projects.rebind(project.id, target.id);
  assert.equal(first.project(project.id)?.path, targetRepo);
  assert.equal(history.list({ projectId: project.id }).total, 5);
  assert.equal(history.list({ identifier: initial.code }).items[4].projectName, 'Original project');
  const blockedRepo = await f.repo('target-with-only-history');
  first.saveSettings({ ...first.settings(), roots: [blockedRepo] });
  await projects.scan();
  const blocked = first.projects().find((row) => row.path === blockedRepo)!;
  const archived = a.save({
    title: 'Deleted task still has work',
    projectId: blocked.id,
    result: { summary: 'Retained history' },
  });
  new Records(first).delete('tasks', archived.id);
  await assert.rejects(projects.rebind(project.id, blocked.id), /свои данные/);
  new Records(first).delete('tasks', initial.id);
  assert.ok(history.list({ identifier: initial.id }).items.every((entry) => !entry.taskExists));
  assert.equal(history.list({ projectId: project.id }).total, 5);
  await projects.forget(project.id);
  assert.equal(history.list({ projectId: project.id }).total, 0);
  assert.equal(history.list({ projectId: null }).total, 0);
  assert.ok(
    history
      .list({ identifier: initial.code })
      .items.every((entry) => entry.projectId === null && entry.projectName),
  );
  assert.equal(first.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const backupFile = path.join(f.root, 'saved-history.sqlite');
  first.backup(backupFile);
  const restored = new Store(backupFile);
  try {
    assert.deepEqual(new TaskHistory(restored).list(), history.list());
  } finally {
    restored.close();
  }
});

test('history filters UTC inclusive dates, task identity, general/project and bounded pages through HTTP', async (t) => {
  const store = new Store(':memory:');
  const tasks = new Tasks(store);
  for (let i = 0; i < 52; i++)
    tasks.save({ title: `General ${i}`, result: { summary: `Result ${i}` } });
  store.db.exec(
    "UPDATE task_history SET recorded_at=CASE WHEN id=1 THEN '2026-10-07T23:59:59.999Z' WHEN id=2 THEN '2026-10-09T00:00:00.000Z' ELSE '2026-10-08T00:00:00.000Z' END;",
  );
  const history = new TaskHistory(store);
  assert.equal(history.list({ from: '2026-10-08', to: '2026-10-08' }).total, 50);
  assert.equal(history.list({ identifier: 'cc-1' }).total, 1);
  assert.equal(history.list({ offset: 50 }).items.length, 2);
  assert.throws(() => history.list({ from: '2026-10-09', to: '2026-10-08' }));
  assert.throws(() => history.list({ limit: 101 }));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const { app } = createApp(store, port);
  server.on('request', app);
  const get = (query: string) => fetch(`http://127.0.0.1:${port}/api/task-history?${query}`);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const response = await get(
    'projectId=__general__&from=2026-10-08&to=2026-10-08&limit=10&offset=40',
  );
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.total, 50);
  assert.equal(page.items.length, 10);
  assert.equal((await get('limit=101')).status, 400);
  assert.equal((await get('from=2026-10-09&to=2026-10-08')).status, 400);
  assert.equal((await get('projectId=not-a-uuid')).status, 400);
  assert.equal((await get('identifier=CC-1&identifier=CC-2')).status, 400);
});
