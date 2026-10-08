import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { ProjectRefresh } from '../server/projects/refresh.js';
import { Records } from '../server/records.js';
import { Checks } from '../server/checks/checks.js';
import { createApp } from '../server/app.js';
import { inspectProject } from '../server/projects/scan.js';
import {
  defaultSettings,
  metadataSchema,
  settingsSchema,
  type Workspace,
} from '../shared/contracts.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('out-of-order snapshots from independent stores preserve the newer observation and manual data', async (t) => {
  const f = await fixture();
  const database = path.join(f.root, 'state.sqlite');
  const a = new Store(database);
  const b = new Store(database);
  t.after(async () => {
    a.close();
    b.close();
    await f.cleanup();
  });
  const repo = await f.repo('observed');
  const id = randomUUID();
  const older = await inspectProject(repo);
  older.scannedAt = '2026-10-08T10:00:00.000Z';
  a.saveSnapshot(id, older);
  a.saveMetadata(id, metadataSchema.parse({ name: 'Keep manual' }), 'Keep note');
  f.git(repo, 'switch', '-c', 'newer');
  const newer = await inspectProject(repo);
  newer.scannedAt = '2026-10-08T10:01:00.000Z';
  b.saveSnapshot(randomUUID(), newer);
  a.saveSnapshot(randomUUID(), older);
  assert.deepEqual(JSON.parse(a.project(id)!.snapshot), newer);
  assert.equal(a.project(id)!.notes, 'Keep note');
  assert.equal(JSON.parse(a.project(id)!.metadata!).name, 'Keep manual');
  assert.equal(a.projects().length, 1);
  b.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(id);
  a.saveSnapshot(randomUUID(), older);
  assert.equal(a.project(id)!.available, 0);
});

test('known-project refresh reads real Git/YAML/decisions, preserves local work and handles loss/recovery without discovery', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('known');
  const yaml = path.join(repo, 'PROJECT.yaml');
  await writeFile(yaml, 'name: Original\n');
  store.saveSettings({ ...defaultSettings, roots: [f.root] });
  const projects = new Projects(store);
  await projects.scan();
  const initial = projects.list()[0]!;
  store.saveMetadata(
    initial.id,
    metadataSchema.parse({ ...initial.metadata, current_focus: 'Keep local' }),
    'Keep note',
  );
  const baseHash = store.project(initial.id)!.yaml_base_hash;
  const records = new Records(store);
  const task = records.save('tasks', { projectId: initial.id, title: 'Keep task' });
  const checks = new Checks(store);
  const check = checks.save({
    title: 'Keep check',
    projectId: initial.id,
    question: 'Question',
    assumption: 'Assumption',
    expectedExternalResult: 'Result',
    startedAt: '2026-01-01',
    continueIf: 'Continue',
    stopIf: 'Stop',
    nextExternalAction: 'Ask',
  });
  const entry = checks.saveEntry(check.id, {
    kind: 'action',
    text: 'External step',
    occurredAt: '2026-01-02',
  });
  await writeFile(yaml, 'name: External\n');
  await writeFile(path.join(repo, 'DECISIONS.md'), '# Updated choice\n\nRead at source.\n');
  f.git(repo, 'switch', '-c', 'work');
  await writeFile(path.join(repo, 'change.txt'), 'new work');
  f.git(repo, 'add', 'change.txt');
  f.git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'New local work',
  );
  const undiscovered = await f.repo('not-yet-registered');
  assert.deepEqual(await projects.refreshKnown(), []);
  const updated = projects.list()[0]!;
  assert.equal(updated.id, initial.id);
  assert.equal(updated.snapshot.git.branch, 'work');
  assert.equal(updated.snapshot.git.commits[0]!.subject, 'New local work');
  assert.equal(updated.snapshot.git.dirty, true);
  assert.equal(updated.metadata.current_focus, 'Keep local');
  assert.equal(updated.notes, 'Keep note');
  assert.equal(updated.yamlConflict, true);
  assert.equal(store.project(initial.id)!.yaml_base_hash, baseHash);
  assert.deepEqual(records.list('tasks'), [task]);
  assert.deepEqual(checks.entries(), [entry]);
  assert.equal(checks.require(check.id).startedAt, '2026-01-01');
  assert.equal(projects.decisions.list()[0]!.title, 'Updated choice');
  assert.equal(
    projects.list().some((p) => p.path === undiscovered),
    false,
  );
  assert.equal(await readFile(yaml, 'utf8'), 'name: External\n');

  const moved = path.join(f.root, 'temporarily-moved');
  assert.equal(path.dirname(repo), f.root);
  assert.equal(path.dirname(moved), f.root);
  await rename(repo, moved);
  assert.equal((await projects.refreshKnown()).length, 1);
  assert.equal(projects.list()[0]!.available, false);
  assert.deepEqual(projects.list()[0]!.snapshot, updated.snapshot);
  await rename(moved, repo);
  assert.deepEqual(await projects.refreshKnown(), []);
  assert.equal(projects.list()[0]!.available, true);

  const beforeRevocation = projects.list()[0]!.snapshot;
  store.saveSettings({ ...store.settings(), roots: [] });
  await writeFile(yaml, 'name: Must not be read\n');
  assert.deepEqual(await projects.refreshKnown(), []);
  assert.deepEqual(projects.list()[0]!.snapshot, beforeRevocation);
  assert.equal(projects.list()[0]!.available, false);
  assert.deepEqual(records.list('tasks'), [task]);
});

test('manual reads share an in-flight observation; scan waits and removed projects are not restored by background reads', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('known');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const id = projects.list()[0]!.id;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = projects.context.refresh.bind(projects.context);
  const observing = t.mock.method(projects.context, 'refresh', async (row) => {
    await original(row);
    entered();
    await held;
  });
  const first = projects.refresh(id);
  const second = projects.refresh(id);
  await ready;
  assert.equal(observing.mock.callCount(), 1);
  const scan = projects.scan();
  let scanned = false;
  void scan.then(() => {
    scanned = true;
  });
  await settle();
  assert.equal(scanned, false);
  assert.equal(projects.scanInfo.running, true);
  await writeFile(path.join(repo, 'while-reading.txt'), 'later change');
  const afterScan = projects.refresh(id);
  release();
  const [one, two, latest] = await Promise.all([first, second, afterScan, scan]);
  assert.deepEqual(one.snapshot, two.snapshot);
  assert.equal(latest.snapshot.git.dirty, true);
  assert.equal(projects.scanInfo.running, false);
  observing.mock.restore();

  const background = projects.refreshKnown();
  await projects.forget(id);
  assert.deepEqual(await background, []);
  assert.equal(store.project(id), undefined);
  await projects.scan();
  assert.equal(projects.list().length, 0);
  assert.deepEqual(store.settings().excludedProjectPaths, [repo]);
});

test('scheduler starts after the interval, never overlaps, retries failures, reschedules, disables and drains before shutdown', async (t) => {
  const store = new Store(':memory:');
  const projects = new Projects(store);
  const refresh = new ProjectRefresh(projects);
  t.after(async () => {
    await refresh.stop();
    store.close();
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-08T10:00:00Z') });
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const waiting = new Promise<string[]>((resolve) => {
    release = () => resolve([]);
  });
  const reads = t.mock.method(projects, 'refreshKnown', (input?: AbortSignal) => {
    signal = input;
    return waiting;
  });
  refresh.start();
  refresh.start();
  t.mock.timers.tick(59999);
  assert.equal(reads.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(refresh.info.lastAttemptAt, '2026-10-08T10:01:00.000Z');
  assert.equal(refresh.info.running, true);
  t.mock.timers.tick(600000);
  assert.equal(reads.mock.callCount(), 1);
  release();
  await settle();
  assert.equal(refresh.info.running, false);
  reads.mock.mockImplementation(() => {
    throw new Error('Read failed');
  });
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(refresh.info.errors.length, 1);
  reads.mock.mockImplementation(async () => []);
  store.saveSettings({ ...store.settings(), autoRefreshMinutes: 5 });
  refresh.reschedule();
  const count = reads.mock.callCount();
  t.mock.timers.tick(299999);
  assert.equal(reads.mock.callCount(), count);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(reads.mock.callCount(), count + 1);
  assert.deepEqual(refresh.info.errors, []);
  store.saveSettings({ ...store.settings(), autoRefreshMinutes: 0 });
  refresh.reschedule();
  t.mock.timers.tick(3600000);
  assert.equal(reads.mock.callCount(), count + 1);

  let finish!: () => void;
  reads.mock.mockImplementation((input?: AbortSignal) => {
    signal = input;
    return new Promise<string[]>((resolve) => {
      finish = () => resolve([]);
    });
  });
  store.saveSettings({ ...store.settings(), autoRefreshMinutes: 1 });
  refresh.reschedule();
  t.mock.timers.tick(60000);
  let stopped = false;
  const stopping = refresh.stop().then(() => {
    stopped = true;
  });
  await settle();
  assert.equal(signal?.aborted, true);
  assert.equal(stopped, false);
  finish();
  await stopping;
  t.mock.timers.tick(3600000);
  assert.equal(reads.mock.callCount(), count + 2);
});

test('legacy settings default safely; API validates and preserves the interval across older payloads and SQLite reopen', async (t) => {
  const legacy: Record<string, unknown> = { ...defaultSettings };
  delete legacy.autoRefreshMinutes;
  assert.equal(settingsSchema.parse(legacy).autoRefreshMinutes, 1);
  for (const value of [-1, 61, 1.5, '1'])
    assert.equal(
      settingsSchema.safeParse({ ...defaultSettings, autoRefreshMinutes: value }).success,
      false,
    );
  const f = await fixture();
  let store = new Store(path.join(f.root, 'workspace.sqlite'));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  });
  const port = (server.address() as { port: number }).port;
  const { app } = createApp(store, port);
  server.on('request', app);
  const url = `http://127.0.0.1:${port}/api`;
  const update = (data: unknown) =>
    fetch(url + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
      body: JSON.stringify(data),
    });
  assert.equal((await update({ ...legacy, autoRefreshMinutes: 0 })).status, 200);
  assert.equal((await update(legacy)).status, 200);
  assert.equal(store.settings().autoRefreshMinutes, 0);
  assert.equal((await update({ ...legacy, autoRefreshMinutes: 61 })).status, 400);
  const workspace = (await (await fetch(url + '/workspace')).json()) as Workspace;
  assert.equal(workspace.settings.autoRefreshMinutes, 0);
  assert.deepEqual(workspace.refresh, { running: false, lastAttemptAt: null, errors: [] });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  store = new Store(path.join(f.root, 'workspace.sqlite'));
  assert.equal(store.settings().autoRefreshMinutes, 0);
});
