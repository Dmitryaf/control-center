import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Reviews } from '../server/reviews.js';
import { Projects } from '../server/projects/projects.js';
import { Tasks } from '../server/tasks.js';
import { Observations } from '../server/observations.js';
import { History } from '../server/history.js';
import { TaskHistory } from '../server/task-history.js';
import { createApp } from '../server/app.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';
import { periodBounds, dateInZone, timezoneSchema } from '../shared/periods.js';
import { zonedRange } from '../src/features/history/period.js';

test('review calendar uses named zones, Monday weeks, leap months, DST and year boundaries', () => {
  const spring = periodBounds('week', '2024-03-10', 'America/New_York');
  assert.deepEqual(spring, {
    periodStart: '2024-03-04',
    periodEnd: '2024-03-10',
    timezone: 'America/New_York',
    startAt: '2024-03-04T05:00:00.000Z',
    nextStartAt: '2024-03-11T04:00:00.000Z',
  });
  const autumn = periodBounds('week', '2024-11-03', 'America/New_York');
  assert.equal((Date.parse(autumn.nextStartAt) - Date.parse(autumn.startAt)) / 3600000, 169);
  assert.equal((Date.parse(spring.nextStartAt) - Date.parse(spring.startAt)) / 3600000, 167);
  const leap = periodBounds('month', '2024-02-29', 'Europe/Berlin');
  assert.equal(leap.periodEnd, '2024-02-29');
  assert.equal(leap.startAt, '2024-01-31T23:00:00.000Z');
  assert.equal(leap.nextStartAt, '2024-02-29T23:00:00.000Z');
  assert.equal(periodBounds('week', '2025-01-01', 'Asia/Yekaterinburg').periodStart, '2024-12-30');
  assert.equal(dateInZone(new Date('2024-12-31T20:00:00Z'), 'Asia/Yekaterinburg'), '2025-01-01');
  assert.deepEqual(
    zonedRange('previous_month', 'Asia/Yekaterinburg', new Date('2024-12-31T20:00:00Z')),
    { from: '2024-12-01', to: '2024-12-31' },
  );
  assert.deepEqual(zonedRange('week', 'Asia/Yekaterinburg', new Date('2024-12-31T20:00:00Z')), {
    from: '2024-12-30',
    to: '2025-01-01',
  });
  for (const zone of ['not/a-zone', '+05:00', ''])
    assert.equal(timezoneSchema.safeParse(zone).success, false);
  assert.throws(() => periodBounds('month', '2023-02-29', 'UTC'));
});

test('history uses half-open zoned timestamp days while date-only records and legacy task history keep their contracts', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const tasks = new Tasks(store);
  const moments = [
    '2024-03-04T04:59:59.999Z',
    '2024-03-04T05:00:00.000Z',
    '2024-03-11T03:59:59.999Z',
    '2024-03-11T04:00:00.000Z',
  ];
  const ids = moments.map((instant, i) => {
    const task = tasks.save({ title: `Boundary ${i}`, result: { summary: `Result ${i}` } });
    store.db.prepare('UPDATE task_history SET recorded_at=? WHERE task_id=?').run(instant, task.id);
    return task.id;
  });
  const note = new Observations(store).create({ body: 'Declared day', occurredOn: '2024-03-10' });
  const history = new History(store, new Projects(store).decisions);
  const scoped = history.list({
    from: '2024-03-04',
    to: '2024-03-10',
    timezone: 'America/New_York',
  });
  assert.deepEqual(
    scoped.items.filter((e) => e.kind === 'task').map((e) => e.title.slice(-1)),
    ['2', '1'],
  );
  assert.equal(scoped.items.filter((e) => e.sourceId === note.id)[0].day, '2024-03-10');
  assert.deepEqual(
    history
      .list({ from: '2024-03-04', to: '2024-03-10', kind: 'task' })
      .items.map((e) => e.title.slice(-1)),
    ['1', '0'],
  );
  assert.equal(
    history.list({
      from: '2024-03-10',
      to: '2024-03-10',
      kind: 'observation',
      timezone: 'Pacific/Honolulu',
    }).items[0].day,
    '2024-03-10',
  );
  const old = new TaskHistory(store).list({ from: '2024-03-04', to: '2024-03-10' });
  assert.equal(old.items.length, 2);
  assert.ok(old.items.some((e) => e.task.id === ids[0]));
  assert.ok(!old.items.some((e) => e.task.id === ids[2]));
  store.saveSettings({ ...defaultSettings, timezone: 'America/New_York' });
  const review = new Reviews(store).create({ kind: 'week', anchorDate: '2024-03-10' });
  assert.deepEqual(
    history
      .forReview(review)
      .items.filter((e) => e.kind === 'task')
      .map((e) => e.title.slice(-1)),
    ['2', '1'],
  );
  // Simulate saved instants from a previous timezone-rule edition. Reads must use
  // those canonical instants even when today's zone rules would derive other ones.
  store.db
    .prepare('UPDATE reviews SET start_at=?,next_start_at=? WHERE id=?')
    .run('2024-03-04T06:00:00.000Z', '2024-03-11T05:00:00.000Z', review.id);
  const frozen = new Reviews(store).read(review.id);
  store.saveSettings({ ...store.settings(), timezone: 'Europe/Berlin' });
  const sourcePage = history.forReview(frozen, { limit: 1 });
  const sourceItems = [...sourcePage.items];
  let cursor = sourcePage.nextCursor;
  while (cursor) {
    const next = history.forReview(frozen, { limit: 1, cursor });
    sourceItems.push(...next.items);
    cursor = next.nextCursor;
  }
  assert.deepEqual(
    sourceItems.filter((e) => e.kind === 'task').map((e) => e.title.slice(-1)),
    ['3', '2'],
  );
  assert.equal(sourceItems.filter((e) => e.sourceId === note.id)[0].day, '2024-03-10');
  assert.equal(new Set(sourceItems.map((e) => e.key)).size, 3);
  assert.ok(sourceItems.every((e) => e.kind !== 'review'));
});

test('review identity survives retries, zone changes, renames and project removal; two writers reject stale edits', async (t) => {
  const f = await fixture();
  const file = path.join(f.root, 'reviews.sqlite');
  const store = new Store(file);
  const second = new Store(file);
  t.after(async () => {
    second.close();
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('review-project');
  store.saveSettings({ ...defaultSettings, roots: [repo], timezone: 'America/New_York' });
  const projects = new Projects(store);
  await projects.scan();
  const project = store.projects()[0];
  const reviews = new Reviews(store),
    other = new Reviews(second);
  const input = { projectId: project.id, kind: 'week', anchorDate: '2024-03-10' };
  const original = reviews.create(input);
  assert.equal(original.startAt, '2024-03-04T05:00:00.000Z');
  const saved = other.patch(original.id, { revision: 1, userText: 'My own conclusions' });
  assert.equal(reviews.create({ ...input, anchorDate: '2024-03-04' }).id, original.id);
  assert.equal(reviews.create(input).userText, 'My own conclusions');
  assert.throws(() => reviews.patch(original.id, { revision: 1, userText: 'Stale' }), {
    status: 409,
  });
  assert.throws(() => reviews.delete(original.id, { revision: 1 }), { status: 409 });
  assert.throws(() =>
    reviews.patch(original.id, {
      revision: saved.revision,
      userText: 'Try to move',
      projectId: null,
    }),
  );
  store.saveSettings({ ...store.settings(), timezone: 'Asia/Yekaterinburg' });
  const retried = other.create(input);
  assert.deepEqual(retried, saved);
  const general = reviews.create({ kind: 'week', anchorDate: '2024-03-10' });
  assert.notEqual(general.id, saved.id);
  assert.equal(general.scopeKey, 'general');
  store.saveMetadata(project.id, metadataSchema.parse({ name: 'Renamed project' }), '');
  assert.equal(reviews.read(saved.id).projectName, 'review-project');
  projects.forget(project.id);
  const retained = reviews.read(saved.id);
  assert.equal(retained.projectId, null);
  assert.equal(retained.scopeKey, `project:${project.id}`);
  assert.equal(retained.projectName, 'review-project');
  assert.equal(retained.revision, saved.revision + 1);
  assert.throws(
    () => reviews.patch(saved.id, { revision: saved.revision, userText: 'Stale after removal' }),
    { status: 409 },
  );
  const edited = reviews.patch(saved.id, {
    revision: retained.revision,
    userText: 'Still my project review',
  });
  const history = new History(store, projects.decisions);
  assert.equal(history.list({ projectId: project.id, kind: 'review' }).items[0].sourceId, saved.id);
  assert.equal(
    history.list({ projectId: project.id, kind: 'review' }).items[0].scopeProjectId,
    project.id,
  );
  assert.equal(other.create(input).id, saved.id);
  reviews.delete(saved.id, { revision: edited.revision });
  assert.throws(() => reviews.read(saved.id), { status: 404 });
  assert.equal(reviews.read(general.id).userText, '');
});

test('monthly and general reviews link whole overlapping weeks once, page links, and never copy their text', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('links-project');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const projectId = store.projects()[0].id;
  const reviews = new Reviews(store);
  const first = reviews.create({ projectId, kind: 'week', anchorDate: '2024-09-30' });
  const last = reviews.create({ projectId, kind: 'week', anchorDate: '2024-10-31' });
  const middle = reviews.create({ projectId, kind: 'week', anchorDate: '2024-10-14' });
  reviews.patch(first.id, { revision: first.revision, userText: 'Do not copy into month' });
  const month = reviews.create({ projectId, kind: 'month', anchorDate: '2024-10-15' });
  const links = reviews.related(month.id, { limit: 2 });
  assert.equal(links.items.length, 2);
  assert.ok(links.nextCursor);
  const more = reviews.related(month.id, { limit: 2, cursor: links.nextCursor });
  assert.equal(new Set([...links.items, ...more.items].map((e) => e.id)).size, 3);
  assert.equal(
    [...links.items, ...more.items].find((e) => e.id === first.id)?.overlapsBoundary,
    true,
  );
  assert.equal(
    [...links.items, ...more.items].find((e) => e.id === last.id)?.overlapsBoundary,
    true,
  );
  assert.equal(
    [...links.items, ...more.items].find((e) => e.id === middle.id)?.overlapsBoundary,
    false,
  );
  assert.equal(reviews.read(month.id).userText, '');
  const common = reviews.create({ kind: 'month', anchorDate: '2024-10-01' });
  assert.equal(reviews.related(common.id).items.length, 4);
  const week = reviews.create({ kind: 'week', anchorDate: '2024-10-31' });
  assert.deepEqual(
    reviews.related(week.id).items.map((e) => e.id),
    [last.id],
  );
  reviews.delete(first.id, { revision: reviews.read(first.id).revision });
  assert.equal(reviews.related(month.id).items.length, 2);
  assert.equal(reviews.read(month.id).userText, '');
});

test('schema 6 upgrade snapshots WAL, retains sources/settings, rolls back failed DDL and supports review backup/restart/restore', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'migration.sqlite');
  const seed = new Store(file);
  seed.saveSettings({ ...defaultSettings, timezone: 'Europe/Berlin' });
  const note = new Observations(seed).create({
    body: 'Preserve existing note',
    occurredOn: '2020-01-01',
  });
  const task = new Tasks(seed).save({ title: 'Preserve task', result: { summary: 'Keep' } });
  const rows = seed.db.prepare('SELECT * FROM task_history').all();
  seed.db.exec('DROP TABLE reviews; PRAGMA user_version=6;');
  const upgraded = new Store(file);
  seed.close();
  const backups = await readdir(path.join(f.root, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^before-reviews-v7-/);
  const backup = new DatabaseSync(path.join(f.root, 'backups', backups[0]), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 6);
  assert.equal(
    backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='reviews'").get()?.n,
    0,
  );
  backup.close();
  assert.equal(upgraded.settings().timezone, 'Europe/Berlin');
  assert.equal(new Observations(upgraded).read(note.id).body, note.body);
  assert.equal(new Tasks(upgraded).read(task.id).code, task.code);
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM task_history').all(), rows);
  const review = new Reviews(upgraded).create({ kind: 'month', anchorDate: '2024-02-29' });
  const saved = new Reviews(upgraded).patch(review.id, {
    revision: 1,
    userText: 'Survives backup',
  });
  const copy = path.join(f.root, 'copy.sqlite');
  upgraded.backup(copy);
  upgraded.close();
  const reopened = new Store(file);
  assert.deepEqual(
    new Reviews(reopened).create({ kind: 'month', anchorDate: '2024-02-01' }),
    saved,
  );
  reopened.close();
  const restored = new Store(copy);
  assert.deepEqual(new Reviews(restored).read(saved.id), saved);
  restored.close();
  const legacyFile = path.join(f.root, 'legacy-settings.sqlite');
  const legacy = new Store(legacyFile);
  legacy.saveSettings({ ...defaultSettings, reviewDays: 47 });
  legacy.db.exec(
    "UPDATE settings SET data=json_remove(data,'$.timezone'); DROP TABLE reviews; PRAGMA user_version=6;",
  );
  legacy.close();
  const migrated = new Store(legacyFile);
  assert.equal(migrated.settings().timezone, 'Asia/Yekaterinburg');
  assert.equal(migrated.settings().reviewDays, 47);
  assert.equal(
    migrated.db.prepare("SELECT json_extract(data,'$.timezone') AS zone FROM settings").get()?.zone,
    'Asia/Yekaterinburg',
  );
  migrated.close();
  const failedFile = path.join(f.root, 'failed.sqlite');
  const before = new Store(failedFile);
  before.db.exec('DROP TABLE reviews; PRAGMA user_version=6;');
  before.close();
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS reviews'))
      throw new Error('Injected review DDL failure');
    return original.call(this, sql);
  };
  try {
    assert.throws(() => new Store(failedFile), /Injected review DDL failure/);
  } finally {
    DatabaseSync.prototype.exec = original;
  }
  const failed = new DatabaseSync(failedFile);
  assert.equal(failed.prepare('PRAGMA user_version').get()?.user_version, 6);
  assert.equal(
    failed.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='reviews'").get()?.n,
    0,
  );
  failed.close();
  const blockedRoot = path.join(f.root, 'blocked');
  const blockedFile = path.join(blockedRoot, 'blocked.sqlite');
  const blocked = new Store(blockedFile);
  blocked.db.exec('DROP TABLE reviews; PRAGMA user_version=6;');
  blocked.close();
  await writeFile(path.join(blockedRoot, 'backups'), 'blocked');
  assert.throws(() => new Store(blockedFile));
  const intact = new DatabaseSync(blockedFile);
  assert.equal(intact.prepare('PRAGMA user_version').get()?.user_version, 6);
  intact.close();
});

test('review HTTP rejects foreign/non-JSON writes, preserves omitted timezone and exposes revision conflicts', async (t) => {
  const store = new Store(':memory:');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  server.on('request', createApp(store, port).app);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const url = `http://127.0.0.1:${port}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Control-Center': '1' };
  assert.equal(
    (
      await fetch(url + '/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + '/reviews', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://foreign.invalid' },
        body: '{}',
      })
    ).status,
    403,
  );
  store.saveSettings({ ...defaultSettings, timezone: 'Europe/Berlin', autoRefreshMinutes: 0 });
  const oldClient = { ...defaultSettings, autoRefreshMinutes: 0 } as Partial<
    typeof defaultSettings
  >;
  delete oldClient.timezone;
  assert.equal(
    (await fetch(url + '/settings', { method: 'PUT', headers, body: JSON.stringify(oldClient) }))
      .status,
    200,
  );
  assert.equal(store.settings().timezone, 'Europe/Berlin');
  const response = await fetch(url + '/reviews', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'week', anchorDate: '2024-03-10' }),
  });
  assert.equal(response.status, 201);
  const saved = (await response.json()) as { id: string };
  assert.equal(
    (
      await fetch(`${url}/reviews/${saved.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ revision: 1, userText: 'HTTP text' }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${url}/reviews/${saved.id}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ revision: 1 }),
      })
    ).status,
    409,
  );
  assert.equal((await fetch(`${url}/reviews/${saved.id}/related`)).status, 200);
  assert.equal((await fetch(`${url}/reviews/${saved.id}/history`)).status, 200);
  assert.equal((await fetch(`${url}/reviews/${saved.id}/history?from=2024-01-01`)).status, 400);
  assert.equal((await fetch(`${url}/history?timezone=not-a-zone`)).status, 400);
});
