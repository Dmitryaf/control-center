import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';

test('removing a project removes its explicit scan roots but keeps shared parents and other roots', async (t) => {
  const f = await fixture(),
    store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('removed');
  const other = await f.repo('retained');
  const aliases = [repo, repo + path.sep, path.join(repo, '..', 'removed')];
  if (process.platform === 'win32') aliases.push(repo.toUpperCase());
  store.saveSettings({ ...store.settings(), roots: [f.root, ...aliases, other] });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list().find((item) => item.path === repo)!;
  await projects.forget(project.id);
  assert.deepEqual(store.settings().roots, [f.root, other]);
  assert.deepEqual(store.settings().excludedProjectPaths, [repo]);
  await projects.scan();
  assert.ok(!projects.list().some((item) => item.path === repo));
  assert.ok(projects.list().some((item) => item.path === other));
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), '# Fixture\n');
});

test('failure to remove a project rolls back scan roots and exclusions with its local record', async (t) => {
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
    settings = store.settings();
  store.db.exec(
    "CREATE TRIGGER fixture_refuse_project_removal BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
  );
  await assert.rejects(() => projects.forget(project.id), /fixture failure/);
  assert.deepEqual(store.settings(), settings);
  assert.ok(store.project(project.id));
});
