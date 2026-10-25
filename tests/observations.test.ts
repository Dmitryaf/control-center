import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Observations } from '../server/observations.js';
import { Tasks } from '../server/tasks.js';
import { Projects } from '../server/projects/projects.js';
import { createApp } from '../server/app.js';
import { History } from '../server/history.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';

function downgradeFixture(store: Store) {
  store.db.exec('DROP TABLE observations; PRAGMA user_version=5;');
  store.close();
}

test('v5 upgrade backs up committed WAL, keeps task snapshots, restarts and restores observations without duplication', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'notes.sqlite');
  const seed = new Store(file);
  const task = new Tasks(seed).save({ title: 'Known task', result: { summary: 'Keep work' } });
  const before = seed.db.prepare('SELECT * FROM task_history').all();
  seed.db.exec('DROP TABLE observations; PRAGMA user_version=5;');
  let upgraded: Store;
  try {
    upgraded = new Store(file);
  } finally {
    seed.close();
  }
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 12);
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM task_history').all(), before);
  assert.equal(new Tasks(upgraded).read(task.code).result?.summary, 'Keep work');
  const files = await readdir(path.join(f.root, 'backups'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^before-observations-v6-/);
  const backup = new DatabaseSync(path.join(f.root, 'backups', files[0]), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.equal(
    backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='observations'").get()?.n,
    0,
  );
  assert.deepEqual(backup.prepare('SELECT * FROM task_history').all(), before);
  backup.close();
  const note = new Observations(upgraded).create({
    body: 'Private observation',
    occurredOn: '2020-02-29',
  });
  const restoredFile = path.join(f.root, 'restore.sqlite');
  upgraded.backup(restoredFile);
  upgraded.close();
  const reopened = new Store(file);
  const restored = new Store(restoredFile);
  try {
    assert.deepEqual(new Observations(reopened).read(note.id), note);
    assert.deepEqual(new Observations(restored).read(note.id), note);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM observations').get()?.n, 1);
    assert.equal((await readdir(path.join(f.root, 'backups'))).length, 1);
    assert.equal(reopened.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    reopened.close();
    restored.close();
  }
});

test('backup and DDL failures leave v5 unchanged; future version under the write lock is never downgraded', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'blocked.sqlite');
  downgradeFixture(new Store(file));
  await writeFile(path.join(f.root, 'backups'), 'A file blocks the backup directory');
  assert.throws(() => new Store(file));
  let check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 5);
  check.close();
  const directory = path.join(f.root, 'ddl');
  const ddlFile = path.join(directory, 'ddl.sqlite');
  downgradeFixture(new Store(ddlFile));
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS observations'))
      throw new Error('Synthetic DDL failure');
    return exec.call(this, sql);
  };
  try {
    assert.throws(() => new Store(ddlFile), /Synthetic DDL failure/);
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  check = new DatabaseSync(ddlFile, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.equal(
    check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='observations'").get()?.n,
    0,
  );
  check.close();
  const futureFile = path.join(f.root, 'future', 'db.sqlite');
  downgradeFixture(new Store(futureFile));
  const prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === 'PRAGMA user_version' && !changed) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const stale = get(...args);
        changed = true;
        const future = new DatabaseSync(futureFile);
        future.exec('PRAGMA user_version=13');
        future.close();
        return stale;
      };
    }
    return statement;
  };
  try {
    assert.throws(() => new Store(futureFile), /Версия базы/);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  check = new DatabaseSync(futureFile, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 13);
  check.close();
});

test('overlapping v5 startups recheck the committed v6 version and keep the competing observation', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'race.sqlite');
  downgradeFixture(new Store(file));
  const prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  let id = '';
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === 'PRAGMA user_version' && !changed) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const stale = get(...args);
        changed = true;
        const competing = new Store(file);
        id = new Observations(competing).create({
          body: 'Competing saved note',
          occurredOn: '2020-01-01',
        }).id;
        competing.close();
        return stale;
      };
    }
    return statement;
  };
  try {
    const late = new Store(file);
    try {
      assert.equal(new Observations(late).read(id).body, 'Competing saved note');
      assert.equal(late.db.prepare('SELECT count(*) AS n FROM observations').get()?.n, 1);
    } finally {
      late.close();
    }
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
});

test('observations use explicit patches and revisions, repeat creation safely and retain project identity after removal', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'crud.sqlite');
  const store = new Store(file);
  const second = new Store(file);
  t.after(async () => {
    second.close();
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('observation-project');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const project = store.projects()[0];
  const notes = new Observations(store);
  const other = new Observations(second);
  const requestKey = randomUUID();
  const input = {
    body: 'Observed a real obstacle',
    occurredOn: '2020-01-01',
    projectId: project.id,
    requestKey,
  };
  const note = notes.create(input);
  const history = new History(store, projects.decisions);
  assert.equal(
    history.list({ projectId: project.id, kind: 'observation' }).items[0].key,
    history.list({ kind: 'observation' }).items[0].key,
  );
  assert.equal(notes.create(input).id, note.id);
  assert.throws(() => notes.create({ ...input, body: 'Different payload' }), /ключ создания/);
  store.saveMetadata(project.id, metadataSchema.parse({ name: 'Renamed project' }), '');
  const saved = notes.patch(note.id, { revision: note.revision, body: 'Revised observation' });
  assert.equal(saved.occurredOn, note.occurredOn);
  assert.equal(saved.projectId, note.projectId);
  assert.equal(saved.projectName, 'observation-project');
  assert.throws(
    () => other.patch(note.id, { revision: note.revision, occurredOn: '2020-02-01' }),
    /уже изменено/,
  );
  assert.throws(() => other.delete(note.id, { revision: note.revision }), /уже изменено/);
  assert.equal(notes.create(input).revision, saved.revision);
  await projects.forget(project.id);
  const detached = notes.read(note.id);
  assert.equal(detached.projectId, null);
  assert.equal(detached.scopeProjectId, project.id);
  assert.equal(detached.projectName, 'observation-project');
  assert.equal(
    history.list({ projectId: project.id, kind: 'observation' }).items[0].scopeProjectId,
    project.id,
  );
  assert.equal(
    history.list({ projectId: null, kind: 'observation' }).items[0].projectName,
    'observation-project',
  );
  assert.equal(detached.revision, saved.revision + 1);
  const afterBody = notes.patch(note.id, {
    revision: detached.revision,
    body: 'After project removal',
  });
  assert.equal(afterBody.scopeProjectId, project.id);
  const general = notes.patch(note.id, { revision: afterBody.revision, projectId: null });
  assert.equal(general.scopeProjectId, null);
  assert.equal(general.projectName, null);
  assert.throws(() => notes.patch(note.id, { revision: general.revision, body: '   ' }));
  notes.delete(note.id, { revision: general.revision });
  assert.throws(() => notes.read(note.id), /не найдено/);
});

test('HTTP observation CRUD validates input and requires loopback JSON consent headers for writes', async (t) => {
  const store = new Store(':memory:');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  server.on('request', createApp(store, port).app);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const root = `http://127.0.0.1:${port}/api/observations`;
  const headers = { 'Content-Type': 'application/json', 'X-Control-Center': '1' };
  const body = { body: 'General note', occurredOn: '2020-01-01', requestKey: randomUUID() };
  assert.equal(
    (
      await fetch(root, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  const created = await fetch(root, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(created.status, 201);
  const note = await created.json();
  assert.equal(
    (await fetch(root + '/' + note.id, { headers: { Origin: 'https://foreign.invalid' } })).status,
    403,
  );
  assert.equal(
    (
      await fetch(root + '/' + note.id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ revision: 1, occurredOn: 'invalid' }),
      })
    ).status,
    400,
  );
  const patched = await fetch(root + '/' + note.id, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ revision: 1, body: 'Updated' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).occurredOn, '2020-01-01');
  assert.equal(
    (
      await fetch(root + '/' + note.id, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ revision: 1 }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(root + '/' + note.id, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ revision: 2 }),
      })
    ).status,
    200,
  );
});
