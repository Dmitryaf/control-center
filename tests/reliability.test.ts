import test from 'node:test';
import assert from 'node:assert/strict';
import { rename, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Records } from '../server/records.js';
import { Checks } from '../server/checks/checks.js';
import { Projects } from '../server/projects/projects.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';
import { dataDirectory } from '../server/storage.js';

const checkData = (extra = {}) => ({
  title: 'Check',
  question: 'Question',
  assumption: 'Assumption',
  expectedExternalResult: 'Result',
  startedAt: '2020-01-01',
  continueIf: 'Yes',
  stopIf: 'No',
  nextExternalAction: 'Ask',
  ...extra,
});

test('rebind preserves old ID, every record, checks, relations, notes and local metadata; forget detaches safely', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const oldPath = await f.repo('old');
  await f.repo('tool');
  store.saveSettings({ ...defaultSettings, roots: [f.root] });
  const projects = new Projects(store);
  const records = new Records(store);
  const checks = new Checks(store);
  await projects.scan();
  const old = projects.list().find((p) => p.path === oldPath)!;
  const tool = projects.list().find((p) => p.path !== oldPath)!;
  store.saveMetadata(
    old.id,
    metadataSchema.parse({ ...old.metadata, name: 'Kept title' }),
    'Keep notes',
  );
  const task = records.save('tasks', { title: 'Task', projectId: old.id });
  const idea = records.save('ideas', { title: 'Idea', projectId: old.id });
  const decision = records.save('decisions', {
    title: 'Decision',
    decision: 'Choice',
    date: '2020-01-01',
    projectId: old.id,
  });
  const check = checks.save(checkData({ projectId: old.id, ideaId: idea.id }));
  checks.save(checkData({ projectId: tool.id }));
  const entry = checks.saveEntry(check.id, {
    kind: 'action',
    text: 'Ask',
    occurredAt: '2020-01-02',
  });
  records.relate({ sourceId: old.id, targetId: tool.id, type: 'uses' });
  const movedPath = path.join(f.root, 'renamed');
  await rename(oldPath, movedPath);
  await projects.scan();
  const candidate = projects.list().find((p) => p.path === movedPath)!;
  const rebound = await projects.rebind(old.id, candidate.id);
  assert.equal(rebound.id, old.id);
  assert.equal(rebound.metadata.name, 'Kept title');
  assert.equal(rebound.notes, 'Keep notes');
  assert.equal(store.project(candidate.id), undefined);
  assert.equal(projects.list().length, 2);
  assert.equal(records.list('tasks')[0].id, task.id);
  assert.equal(records.list('decisions')[0].id, decision.id);
  assert.equal(checks.require(check.id).projectId, old.id);
  assert.equal(records.relations()[0].sourceId, old.id);
  store.saveSettings({ ...defaultSettings, roots: [tool.path] });
  await projects.scan();
  await projects.forget(old.id);
  for (const kind of ['tasks', 'ideas', 'decisions'] as const)
    assert.equal(records.list(kind)[0].projectId, null);
  assert.equal(checks.require(check.id).projectId, null);
  assert.equal(checks.entries()[0].id, entry.id);
  assert.equal(records.relations().length, 0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  await access(movedPath);
});

test('rebind rejects a target with user data', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('a');
  await f.repo('b');
  store.saveSettings({ ...defaultSettings, roots: [f.root] });
  const projects = new Projects(store);
  await projects.scan();
  const [one, two] = projects.list();
  store.saveMetadata(two.id, two.metadata, 'Valuable');
  await rename(repo, path.join(f.root, 'moved'));
  await projects.scan();
  await assert.rejects(projects.rebind(one.id, two.id), /свои данные/);
  assert.equal(store.project(two.id)?.notes, 'Valuable');
});

test('remove an available project preserves files and records, excludes only its path across restart, and allows rediscovery', async (t) => {
  const f = await fixture();
  let store = new Store(path.join(f.root, 'workspace.sqlite'));
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('first/product');
  const sibling = await f.repo('second/product');
  const yamlPath = path.join(repo, 'PROJECT.yaml');
  await writeFile(yamlPath, 'name: Repository title\n');
  store.saveSettings({ ...defaultSettings, roots: [f.root, repo] });
  let projects = new Projects(store);
  const records = new Records(store);
  const checks = new Checks(store);
  await projects.scan();
  const project = projects.list().find((p) => p.path === repo)!;
  const other = projects.list().find((p) => p.path === sibling)!;
  store.saveMetadata(project.id, project.metadata, 'Local notes');
  records.save('tasks', { title: 'Task', projectId: project.id });
  const idea = records.save('ideas', { title: 'Idea', projectId: project.id });
  records.save('decisions', {
    title: 'Decision',
    decision: 'Choice',
    date: '2020-01-01',
    projectId: project.id,
  });
  const check = checks.save(checkData({ projectId: project.id, ideaId: idea.id }));
  const entry = checks.saveEntry(check.id, {
    kind: 'action',
    text: 'Ask',
    occurredAt: '2020-01-02',
  });
  records.relate({ sourceId: project.id, targetId: other.id, type: 'uses' });

  projects.scanInfo.running = true;
  await assert.rejects(projects.forget(project.id), /сканирования/);
  assert.ok(store.project(project.id));
  assert.deepEqual(store.settings().excludedProjectPaths, []);
  projects.scanInfo.running = false;
  const refreshing = projects.refresh(project.id);
  await projects.forget(project.id);
  await assert.rejects(refreshing, /не найден/);
  assert.equal(store.project(project.id), undefined);
  for (const kind of ['tasks', 'ideas', 'decisions'] as const)
    assert.equal(records.list(kind)[0].projectId, null);
  assert.equal(checks.require(check.id).projectId, null);
  assert.equal(checks.require(check.id).ideaId, idea.id);
  assert.equal(checks.entries()[0].id, entry.id);
  assert.deepEqual(records.relations(), []);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(await readFile(yamlPath, 'utf8'), 'name: Repository title\n');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), '# Fixture\n');
  await access(path.join(repo, '.git'));
  await assert.rejects(projects.forget(project.id), /не найден/);

  store.close();
  store = new Store(path.join(f.root, 'workspace.sqlite'));
  projects = new Projects(store);
  await projects.scan();
  assert.deepEqual(
    projects.list().map((p) => p.path),
    [sibling],
  );
  assert.deepEqual(store.settings().excludedProjectPaths, [repo]);
  store.saveSettings({ ...store.settings(), excludedProjectPaths: [] });
  await projects.scan();
  const restored = projects.list().find((p) => p.path === repo)!;
  assert.notEqual(restored.id, project.id);
  assert.equal(restored.notes, '');
  assert.equal(restored.metadataSource, 'yaml');
  assert.equal(new Records(store).list('tasks')[0].projectId, null);
});

test('YAML base hash survives rescans and subsequent local edits; explicit keep/use resolves conflict', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('yaml');
  const yaml = path.join(repo, 'PROJECT.yaml');
  await writeFile(yaml, 'name: Original\n');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  store.saveMetadata(project.id, { ...project.metadata, current_focus: 'Local' }, 'Notes');
  const originalHash = store.project(project.id)!.yaml_base_hash;
  await writeFile(yaml, 'name: External\n');
  await projects.scan();
  assert.equal(projects.list()[0].yamlConflict, true);
  store.saveMetadata(project.id, { ...project.metadata, current_focus: 'Edited again' }, 'Notes');
  assert.equal(store.project(project.id)!.yaml_base_hash, originalHash);
  const external = projects.list()[0].snapshot.yaml;
  store.saveMetadata(project.id, projects.list()[0].metadata, 'Notes', external.hash);
  assert.equal(projects.list()[0].yamlConflict, false);
  assert.equal(await readFile(yaml, 'utf8'), 'name: External\n');
  store.saveMetadata(project.id, null, 'Notes');
  assert.equal(projects.list()[0].metadata.name, 'External');
});

test('stable data paths and verified backups include WAL data', async (t) => {
  const f = await fixture();
  const target = path.join(f.root, 'stable');
  const source = new Store(path.join(target, 'control-center.sqlite'));
  t.after(async () => {
    source.close();
    await f.cleanup();
  });
  new Records(source).save('tasks', { title: 'Committed in WAL' });
  const backup = path.join(target, 'copy.sqlite');
  source.backup(backup);
  const copy = new Store(backup);
  assert.equal(new Records(copy).list('tasks')[0].title, 'Committed in WAL');
  assert.equal(copy.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  copy.close();
  assert.equal(
    dataDirectory({ LOCALAPPDATA: f.root }, 'win32', f.root),
    path.join(f.root, 'ControlCenter'),
  );
  assert.equal(
    dataDirectory({ XDG_DATA_HOME: f.root }, 'linux', f.root),
    path.join(f.root, 'control-center'),
  );
  assert.equal(
    dataDirectory({}, 'darwin', f.root),
    path.join(f.root, 'Library', 'Application Support', 'ControlCenter'),
  );
  assert.equal(dataDirectory({ CONTROL_CENTER_DATA_DIR: target }, 'win32', f.root), target);
});
