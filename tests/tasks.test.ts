import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Tasks } from '../server/tasks.js';
import { Records } from '../server/records.js';
import { Projects } from '../server/projects/projects.js';
import { resolveProject } from '../server/projects/resolve.js';
import { defaultSettings } from '../shared/contracts.js';

test('v3 migration backs up WAL, preserves raw records and project links; repeat and numbering are stable', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'data.sqlite');
  const seed = new Store(file);
  const repo = await f.repo('kept-project');
  seed.saveSettings({ ...defaultSettings, roots: [repo] });
  await new Projects(seed).scan();
  const project = seed.projects()[0];
  const task = new Tasks(seed).save({
    title: 'Old task',
    projectId: project.id,
    description: 'Keep details',
  });
  new Records(seed).save('ideas', { title: 'Keep idea', projectId: project.id });
  seed.db.exec(`DROP TABLE task_identity; PRAGMA user_version=3;`);
  // Model legacy JSON exactly, without new optional fields.
  seed.db.prepare('UPDATE records SET data=? WHERE id=?').run(
    JSON.stringify({
      title: 'Old task',
      projectId: project.id,
      description: 'Keep details',
      state: 'now',
      priority: 'high',
      completedAt: null,
      unknown: 'preserved',
    }),
    task.id,
  );
  const before = seed.db.prepare('SELECT * FROM records ORDER BY id').all();
  seed.close();
  const migrated = new Store(file);
  assert.deepEqual(migrated.db.prepare('SELECT * FROM records ORDER BY id').all(), before);
  assert.equal(migrated.project(project.id)?.path, repo);
  const old = new Tasks(migrated).read(task.id);
  assert.equal(old.code, 'CC-1');
  assert.equal(old.projectId, project.id);
  assert.equal(old.expectedResult, '');
  assert.equal(old.result, null);
  assert.equal(migrated.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const backups = await readdir(path.join(f.root, 'backups'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(f.root, 'backups', backups[0]), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 3);
  assert.deepEqual(backup.prepare('SELECT * FROM records ORDER BY id').all(), before);
  backup.close();
  migrated.close();
  const again = new Store(file);
  t.after(async () => {
    again.close();
    await f.cleanup();
  });
  const tasks = new Tasks(again);
  assert.equal(tasks.read(task.id).code, old.code);
  new Records(again).delete('tasks', task.id);
  assert.equal(tasks.save({ title: 'Next number' }).code, 'CC-2');
  assert.equal((await readdir(path.join(f.root, 'backups'))).length, 1);
});

test('backup failure stops upgrade without changing task data or schema', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'blocked.sqlite');
  const seed = new Store(file);
  const task = new Tasks(seed).save({ title: 'Keep on failure' });
  seed.db.exec('DROP TABLE task_identity; PRAGMA user_version=3;');
  const original = seed.db.prepare('SELECT * FROM records WHERE id=?').get(task.id);
  seed.close();
  await writeFile(path.join(f.root, 'backups'), 'A file prevents creating the backup directory');
  assert.throws(() => new Store(file));
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(check.prepare('SELECT * FROM records WHERE id=?').get(task.id), original);
    assert.equal(
      check.prepare("SELECT name FROM sqlite_master WHERE name='task_identity'").get(),
      undefined,
    );
  } finally {
    check.close();
  }
});

test('two SQLite connections reject stale changes, preserve partial results, deduplicate and invalidate detached tasks', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'shared.sqlite');
  const first = new Store(file);
  const second = new Store(file);
  t.after(async () => {
    first.close();
    second.close();
    await f.cleanup();
  });
  const a = new Tasks(first);
  const b = new Tasks(second);
  const task = a.save({ title: 'Work', requestKey: 'same-create' });
  assert.equal(b.save({ title: 'Work', requestKey: 'same-create' }).id, task.id);
  assert.throws(() => b.save({ title: 'Changed', requestKey: 'same-create' }), /ключ/);
  assert.throws(() => b.save({ title: ' WORK ' }), /CC-1/);
  const duplicate = b.save({ title: 'Work', allowDuplicate: true });
  assert.notEqual(duplicate.id, task.id);
  const updated = a.patch(task.code, task.revision, {
    description: 'Latest',
    result: { summary: 'Part done', remaining: 'Checks' },
  });
  assert.throws(() => b.patch(task.code, task.revision, { title: 'Stale' }), /уже изменена/);
  assert.throws(() => b.save({ ...updated, revision: undefined }, updated.id, true), /revision/);
  assert.equal(b.read(task.id).title, 'Work');
  assert.equal(b.read(task.id).result?.remaining, 'Checks');
  assert.throws(
    () => a.complete(task.code, updated.revision, { summary: 'Part', remaining: 'Still work' }),
    /Осталась/,
  );
  assert.throws(
    () => a.patch(task.code, updated.revision, { completedAt: new Date().toISOString() }),
    /Осталась/,
  );
  const done = b.complete(task.code, updated.revision, {
    summary: 'Done',
    verified: 'Integration',
    unverified: 'Live Codex',
  });
  assert.ok(done.completedAt);
  const reopened = a.patch(task.code, done.revision, { completedAt: null });
  assert.equal(reopened.result?.summary, 'Done');
  assert.throws(
    () => a.patch(task.code, reopened.revision, { projectId: randomUUID() }),
    /не найден/,
  );
  const repo = await f.repo('project');
  first.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(first);
  await projects.scan();
  const row = first.projects()[0];
  const linked = a.patch(task.code, reopened.revision, { projectId: row.id });
  assert.equal(a.importPlan(row.id, ['Plan', 'Plan']).length, 2);
  assert.equal(
    a.importPlan(row.id, ['Plan'])[0].code,
    a.list().find((item) => item.title === 'Plan')!.code,
  );
  await projects.forget(row.id);
  assert.equal(b.read(task.code).projectId, null);
  assert.throws(
    () => b.patch(task.code, linked.revision, { title: 'Detached stale edit' }),
    /уже изменена/,
  );
});

test('project resolution uses explicit directory and registered Git worktrees, refusing unrelated and conflicting selectors', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('registered');
  const other = await f.repo('other');
  const worktree = path.join(f.root, 'outside-root-worktree');
  f.git(repo, 'worktree', 'add', '--detach', worktree);
  await mkdir(path.join(worktree, 'nested'));
  store.saveSettings({ ...defaultSettings, roots: [repo, other] });
  await new Projects(store).scan();
  const project = store.projects().find((item) => item.path === repo)!;
  const second = store.projects().find((item) => item.path === other)!;
  assert.equal(
    (await resolveProject(store, { workingDirectory: path.join(worktree, 'nested') })).id,
    project.id,
  );
  assert.equal((await resolveProject(store, { workingDirectory: repo })).id, project.id);
  await assert.rejects(resolveProject(store, {}), /Передайте/);
  await assert.rejects(resolveProject(store, { workingDirectory: 'relative' }), /абсолютным/);
  await assert.rejects(resolveProject(store, { workingDirectory: f.root }), /не найден/);
  await assert.rejects(
    resolveProject(store, { projectId: second.id, workingDirectory: worktree }),
    /не соответствует/,
  );
});
