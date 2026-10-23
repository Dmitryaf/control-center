import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { discover, inspectProject } from '../server/projects/scan.js';
import { readMetadata, exportMetadata } from '../server/projects/metadata.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { attention } from '../server/projects/attention.js';
import { Tasks } from '../server/tasks.js';
import { Records } from '../server/records.js';
import { assertProjectAccess } from '../server/filesystem/access.js';

test('discovery finds multiple repositories, non-Git projects, overlapping roots, exclusions and missing roots', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = await f.repo('one');
  const second = await f.repo('group/two', false);
  await f.repo('archive/ignored');
  await f.repo('one/nested');
  const plain = path.join(f.root, 'plain');
  await mkdir(plain);
  await writeFile(
    path.join(plain, 'package.json'),
    '{"name":"plain","scripts":{"dev":"do not run"}}',
  );
  const result = await discover({
    ...defaultSettings,
    roots: [f.root, first, path.join(f.root, 'missing')],
  });
  assert.deepEqual(result.paths.sort(), [first, second, plain].sort());
  assert.equal(result.errors.length, 1);
  const snapshot = await inspectProject(plain);
  assert.equal(snapshot.git.present, false);
  assert.equal(snapshot.yaml.exists, false);
  assert.deepEqual(snapshot.package?.scripts, ['dev']);
});

test('Git reads real commits, branch, remote, rename, dirty and unborn repository', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await f.repo('git');
  f.git(repo, 'remote', 'add', 'origin', 'https://user:secret@example.invalid/repo.git');
  const clean = await inspectProject(repo);
  assert.equal(clean.git.dirty, false);
  assert.equal(clean.git.branch, 'main');
  assert.equal(clean.git.commits[0].subject, 'Initial fixture');
  assert.equal(clean.git.remote, 'https://example.invalid/repo.git');
  f.git(repo, 'mv', 'README.md', 'Renamed.md');
  await writeFile(path.join(repo, 'untracked.txt'), 'hello');
  const dirty = await inspectProject(repo);
  assert.equal(dirty.git.dirty, true);
  assert.equal(dirty.git.changedFiles, 2);
  const empty = await inspectProject(await f.repo('empty', false));
  assert.equal(empty.git.error, null);
  assert.deepEqual(empty.git.commits, []);
  assert.equal(empty.git.branch, 'main');
  f.git(repo, 'checkout', '--detach');
  assert.equal((await inspectProject(repo)).git.branch, 'detached HEAD');
});

test('YAML missing, invalid, valid, export unknown fields and conflict', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await f.repo('metadata');
  assert.equal((await readMetadata(repo)).exists, false);
  const file = path.join(repo, 'PROJECT.yaml');
  await writeFile(
    file,
    'name: Demo\nstatus: active\nlast_reviewed: 2026-10-04\ncustom: preserved\n# keep comment\n',
  );
  const read = await readMetadata(repo);
  assert.equal(read.error, null);
  assert.equal(read.metadata?.last_reviewed, '2026-10-04');
  await exportMetadata(repo, { ...read.metadata!, current_focus: 'Ship MVP' }, read.hash);
  assert.match(await readFile(file, 'utf8'), /custom: preserved/);
  assert.match(await readFile(file, 'utf8'), /keep comment/);
  await assert.rejects(exportMetadata(repo, read.metadata!, read.hash), /изменился/);
  await writeFile(file, 'name: [broken');
  assert.ok((await readMetadata(repo)).error);
  await writeFile(file, 'name: Demo\nstatus: active\nnext: 4');
  assert.match((await readMetadata(repo)).error!, /next/);
});

test('scan preserves manual overrides and notes; missing project remains; reopening SQLite preserves state', async (t) => {
  const f = await fixture();
  const repo = await f.repo('project');
  const file = path.join(f.root, 'state.sqlite');
  let store = new Store(file);
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await Promise.all([projects.scan(), projects.scan()]);
  const project = projects.list()[0];
  assert.equal(project.metadata.name, 'project');
  assert.equal(project.metadataSource, 'defaults');
  store.saveMetadata(
    project.id,
    metadataSchema.parse({ name: 'Manual', status: 'active' }),
    'Private note',
  );
  await writeFile(path.join(repo, 'PROJECT.yaml'), 'name: External\nstatus: completed');
  await projects.scan();
  assert.equal(projects.list()[0].metadata.name, 'Manual');
  store.saveSettings({ ...defaultSettings, roots: [] });
  await projects.scan();
  assert.equal(projects.list()[0].available, false);
  store.close();
  store = new Store(file);
  assert.equal(store.projects().length, 1);
  assert.equal(store.projects()[0].notes, 'Private note');
  assert.equal(new Projects(store).list()[0].metadata.name, 'Manual');
});

test('attention has threshold boundaries, unknown activity and paused projects', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const snapshot = await inspectProject(await f.repo('attention'));
  snapshot.git.commits[0].date = '2026-09-20T00:00:00Z';
  snapshot.git.dirty = true;
  const metadata = metadataSchema.parse({
    name: 'A',
    status: 'active',
    last_reviewed: '2026-09-01',
    blocked_by: ['Need input'],
  });
  const signals = attention(
    metadata,
    snapshot,
    defaultSettings,
    Date.parse('2026-10-04T00:00:00Z'),
  );
  // Git inactivity is context, while legacy planning fields no longer own current work.
  assert.deepEqual(
    signals.map((s) => s.code),
    ['dirty', 'blocked', 'inactive', 'review'],
  );
  assert.equal(signals.find((s) => s.code === 'inactive')?.level, 'info');
  snapshot.git.commits = [];
  assert.equal(
    attention(metadata, snapshot, defaultSettings).some((s) => s.code === 'inactive'),
    false,
  );
  assert.deepEqual(
    attention({ ...metadata, status: 'paused' }, snapshot, defaultSettings).map((s) => s.code),
    ['dirty', 'blocked'],
  );
});

test('project attention keeps Tasks authoritative and gives pending local decisions decision priority', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const repo = await f.repo('work-status');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const id = store.projects()[0].id;
  const metadata = metadataSchema.parse({ name: 'Work status', status: 'active' });
  store.saveMetadata(id, metadata, '');
  const tasks = new Tasks(store);
  const current = tasks.save({ title: 'Current work', projectId: id, state: 'now' });
  tasks.save({ title: 'Next work', projectId: id, state: 'next' });
  const signals = () => projects.view(projects.require(id)).signals;
  const planSignals = () => signals().filter((s) => ['focus', 'next'].includes(s.code));
  assert.deepEqual(planSignals(), []);
  tasks.complete(current.code, current.revision, { summary: 'Reported result' });
  assert.deepEqual(planSignals(), []);
  const beforeLegacyEdit = signals();
  store.saveMetadata(id, { ...metadata, current_focus: 'Old focus', next: ['Old step'] }, '');
  assert.deepEqual(signals(), beforeLegacyEdit);
  const records = new Records(store);
  const decision = records.save('decisions', {
    title: 'Choose direction',
    projectId: id,
    decision: 'Choose',
    date: '2026-10-23',
    status: 'pending',
  });
  assert.equal(signals().find((s) => s.code === 'decision')?.level, 'decision');
  records.save('decisions', { ...decision, status: 'active' }, decision.id, true);
  assert.equal(
    signals().some((s) => s.code === 'decision'),
    false,
  );
  for (const status of ['paused', 'completed'] as const) {
    store.saveMetadata(id, { ...metadata, status }, '');
    assert.deepEqual(signals(), []);
  }
});

test('filesystem access rejects removed roots and symlink escapes', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await f.repo('inside');
  await assert.rejects(assertProjectAccess(repo, []), /вне/);
  const nested = path.join(f.root, 'container');
  await mkdir(nested);
  const link = path.join(nested, 'linked');
  await symlink(repo, link, 'junction');
  const result = await discover({ ...defaultSettings, roots: [nested] });
  assert.equal(result.paths.length, 0);
  await assert.rejects(assertProjectAccess(link, [nested]), /пределы|ссылки/);
});

test('Git inspection does not execute repository fsmonitor helpers and supports worktrees', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await f.repo('source');
  const hook = path.join(repo, 'monitor.sh');
  await writeFile(hook, '#!/bin/sh\necho executed > fsmonitor-executed\n');
  f.git(repo, 'config', 'core.fsmonitor', hook.replaceAll('\\', '/'));
  const snapshot = await inspectProject(repo);
  assert.equal(snapshot.git.error, null);
  await assert.rejects(access(path.join(repo, 'fsmonitor-executed')));
  f.git(repo, 'config', '--unset', 'core.fsmonitor');
  const worktree = path.join(f.root, 'worktree');
  f.git(repo, 'worktree', 'add', '-b', 'feature', worktree);
  const result = await inspectProject(worktree);
  assert.equal(result.git.present, true);
  assert.equal(result.git.branch, 'feature');
  assert.equal(result.git.commits[0].subject, 'Initial fixture');
});
