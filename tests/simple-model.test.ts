import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Tasks } from '../server/tasks.js';
import { TaskHistory } from '../server/task-history.js';
import { Projects } from '../server/projects/projects.js';
import { defaultSettings } from '../shared/contracts.js';

test('v11 upgrade removes active scheduling and extra sources, preserves task identities/history, and supports backup restore', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'legacy.sqlite');
  const seed = new Store(file);
  const repo = await f.repo('project');
  const extra = path.join(f.root, 'obsolete');
  await mkdir(extra);
  await writeFile(path.join(extra, 'choice.md'), '# Obsolete choice\nDo not ingest.');
  await writeFile(path.join(repo, 'DECISIONS.md'), '# Standard choice\nKeep this source.');
  seed.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(seed);
  await projects.scan();
  const id = seed.projects()[0].id;
  const tasks = new Tasks(seed);
  for (const state of ['now', 'next', 'later']) {
    const created = tasks.save({
      title: state,
      projectId: id,
      priority: 'high',
      requestKey: state,
    });
    const done = tasks.complete(created.code, created.revision, {
      summary: 'Kept result',
      verified: 'Fixture',
    });
    seed.db
      .prepare("UPDATE records SET data=json_set(data,'$.state',?) WHERE id=?")
      .run(state, done.id);
    seed.db
      .prepare("UPDATE task_history SET snapshot=json_set(snapshot,'$.state',?) WHERE task_id=?")
      .run(state, done.id);
  }
  seed.db.exec(
    "ALTER TABLE projects ADD COLUMN decision_sources TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=11;",
  );
  seed.db
    .prepare('UPDATE projects SET decision_sources=? WHERE id=?')
    .run(JSON.stringify([extra]), id);
  const identities = seed.db.prepare('SELECT * FROM task_identity').all();
  const history = seed.db.prepare('SELECT * FROM task_history').all();
  const originals = seed.db.prepare('SELECT * FROM records').all();
  seed.close();
  const migrated = new Store(file);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 12);
    assert.deepEqual(migrated.db.prepare('SELECT * FROM task_identity').all(), identities);
    assert.deepEqual(migrated.db.prepare('SELECT * FROM task_history').all(), history);
    assert.equal(
      migrated.db
        .prepare('PRAGMA table_info(projects)')
        .all()
        .some((c) => c.name === 'decision_sources'),
      false,
    );
    const active = new Tasks(migrated);
    for (const task of active.list()) {
      assert.equal(Object.hasOwn(task, 'state'), false);
      assert.equal(task.priority, 'high');
      assert.equal(task.projectId, id);
      assert.ok(task.completedAt);
      assert.equal(task.result?.summary, 'Kept result');
      assert.throws(
        () => active.patch(task.code, task.revision, { state: 'next' }),
        /state больше не поддерживается/,
      );
      const edited = active.patch(task.code, task.revision, { description: 'After upgrade' });
      assert.equal(edited.code, task.code);
      assert.equal(edited.completedAt, task.completedAt);
      assert.deepEqual(edited.result, task.result);
    }
    assert.throws(
      () => active.save({ title: 'Old client', state: 'now' }),
      /state больше не поддерживается/,
    );
    assert.equal(new TaskHistory(migrated).list().items.length, 3);
    const refreshed = new Projects(migrated);
    await refreshed.scan();
    assert.equal(Object.hasOwn(refreshed.list()[0], 'decisionSources'), false);
    assert.deepEqual(
      refreshed.decisions.list().map((d) => d.title),
      ['Standard choice'],
    );
    assert.equal(
      await readFile(path.join(extra, 'choice.md'), 'utf8'),
      '# Obsolete choice\nDo not ingest.',
    );
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migrated.close();
  }
  const backupPath = path.join(f.root, 'backups', (await readdir(path.join(f.root, 'backups')))[0]);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.deepEqual(backup.prepare('SELECT * FROM records').all(), originals);
  assert.deepEqual(backup.prepare('SELECT * FROM task_history').all(), history);
  backup.close();
  const restoredPath = path.join(f.root, 'restored.sqlite');
  await copyFile(backupPath, restoredPath);
  const restored = new Store(restoredPath);
  assert.deepEqual(restored.db.prepare('SELECT * FROM task_identity').all(), identities);
  assert.equal(new Tasks(restored).list().length, 3);
  restored.close();
  const restarted = new Store(file);
  assert.ok(new Tasks(restarted).list().every((task) => task.description === 'After upgrade'));
  restarted.close();
});
