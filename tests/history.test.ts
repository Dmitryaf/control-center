import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Tasks } from '../server/tasks.js';
import { Records } from '../server/records.js';
import { Checks } from '../server/checks/checks.js';
import { History } from '../server/history.js';
import { createApp } from '../server/app.js';
import { defaultSettings } from '../shared/contracts.js';
import { fixture } from './fixtures.js';
import { utcRange } from '../src/features/history/period.js';

test('unified history projects existing sources once, keeps dates honest, bounds excerpts and reports missing file context', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const repo = await f.repo('history-project');
  await mkdir(path.join(repo, 'decisions'));
  const decisionFile = path.join(repo, 'decisions/D-0001.md');
  await writeFile(
    decisionFile,
    '---\nschema_version: 1\nid: D-0001\ntitle: File choice\ndate: 2020-01-02\nstatus: accepted\narea: product\nimplementation: implemented\nvisibility: repository\n---\nDO_NOT_COPY_FILE_BODY',
  );
  await writeFile(path.join(repo, 'decisions/map.md'), '# Undated context');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const id = store.projects()[0].id;
  const reported = new Tasks(store).save({
    title: 'Reported work',
    projectId: id,
    result: { summary: 'x'.repeat(800) },
  });
  new Records(store).save('decisions', {
    title: 'Local choice',
    decision: 'Use existing owners',
    date: '2020-01-02',
    projectId: id,
  });
  const checks = new Checks(store);
  const check = checks.save({
    title: 'Check direction',
    question: 'Does it help?',
    assumption: 'Yes',
    expectedExternalResult: 'A reply',
    startedAt: '2020-01-01',
    continueIf: 'Reply',
    stopIf: 'No reply',
    nextExternalAction: 'Ask',
    projectId: id,
  });
  checks.saveEntry(check.id, { kind: 'action', occurredAt: '2020-01-02', text: 'Asked' });
  checks.saveEntry(check.id, {
    kind: 'evidence',
    occurredAt: '2020-01-02',
    text: 'A reply arrived',
    type: 'fact',
  });
  checks.complete(check.id, {
    actualResult: 'A reply',
    whatWasConfirmedOrRejected: 'Question answered',
    outcome: 'continue',
    basis: 'Reply',
    completedAt: '2020-01-03',
  });
  const history = new History(store, projects.decisions);
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  const page = history.list({ limit: 100 });
  assert.equal(page.items.length, 7);
  assert.equal(new Set(page.items.map((entry) => entry.key)).size, 7);
  assert.deepEqual(
    new Set(page.items.map((entry) => entry.kind)),
    new Set(['task', 'check', 'decision', 'file_decision']),
  );
  assert.ok(
    page.items
      .filter((entry) => entry.kind !== 'task')
      .every((entry) => entry.recordedAt === null && entry.dateQuality === 'declared'),
  );
  assert.equal(page.items.find((entry) => entry.kind === 'task')?.excerpt.length, 600);
  assert.equal(page.items.find((entry) => entry.kind === 'task')?.truncated, true);
  assert.deepEqual(page.files, { undated: 1, unavailable: 0, notLoadedProjects: 0 });
  assert.ok(!JSON.stringify(page).includes('DO_NOT_COPY_FILE_BODY'));
  assert.ok(!JSON.stringify(page).includes(repo));
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before);
  assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 12);
  assert.equal(history.list({ from: '2020-01-02', to: '2020-01-02' }).items.length, 4);
  assert.equal(history.list({ projectId: null }).items.length, 0);
  store.db
    .prepare('UPDATE projects SET private_context_path=? WHERE id=?')
    .run(path.join(f.root, 'missing-context'), id);
  await projects.decisions.refresh(id);
  assert.ok(history.list().files.unavailable > 0);
  store.db.prepare('UPDATE projects SET private_context_path=NULL WHERE id=?').run(id);
  await rm(decisionFile);
  await projects.decisions.refresh(id);
  assert.equal(history.list().files.unavailable, 0); // An absent optional file is not fabricated as an event.
  store.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(id);
  await projects.decisions.refresh(id);
  assert.ok(history.list().files.unavailable > 0);
  new Records(store).delete('tasks', reported.id);
  await projects.forget(id);
  const retained = history.list({ kind: 'task' }).items[0];
  assert.equal(retained.projectId, null);
  assert.equal(retained.projectName, 'history-project');
  assert.equal(retained.excerpt, 'x'.repeat(600));
});

test('UTC week and month presets cross years and leap days without inventing timezone settings', () => {
  const now = new Date('2024-03-01T00:00:00Z');
  assert.deepEqual(utcRange('previous_month', now), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(utcRange('week', now), { from: '2024-02-26', to: '2024-03-01' });
  assert.deepEqual(utcRange('previous_week', new Date('2024-01-01T23:00:00Z')), {
    from: '2023-12-25',
    to: '2023-12-31',
  });
  assert.deepEqual(utcRange('month', new Date('2024-01-01T23:00:00Z')), {
    from: '2024-01-01',
    to: '2024-01-01',
  });
});

test('cursor pages have a total order and new head entries do not duplicate or skip existing entries', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const projects = new Projects(store);
  const tasks = new Tasks(store);
  for (let i = 0; i < 7; i++) tasks.save({ title: `Task ${i}`, result: { summary: `Work ${i}` } });
  store.db.exec("UPDATE task_history SET recorded_at='2020-01-02T10:00:00.000Z'");
  const history = new History(store, projects.decisions);
  const expected = history.list({ limit: 100 }).items.map((entry) => entry.key);
  let page = history.list({ limit: 2 });
  const keys = page.items.map((entry) => entry.key);
  tasks.save({ title: 'New head', result: { summary: 'New work' } });
  while (page.nextCursor) {
    page = history.list({ limit: 2, cursor: page.nextCursor });
    keys.push(...page.items.map((entry) => entry.key));
  }
  assert.deepEqual(keys, expected);
  assert.throws(() => history.list({ limit: 101 }));
  assert.throws(() => history.list({ from: '2020-02-01', to: '2020-01-01' }));
  assert.throws(() => history.list({ cursor: '{"key":"injected"}' }));
});

test('history HTTP stays behind loopback guards and validates every filter', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  server.on('request', createApp(store, port).app);
  const root = `http://127.0.0.1:${port}/api/history`;
  assert.equal((await fetch(root)).status, 200);
  assert.equal((await fetch(root, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const foreignHost = await new Promise<number>((resolve) =>
    get(root, { headers: { Host: 'foreign.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    }),
  );
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(root + '/latest-projects')).status, 200);
  assert.equal((await fetch(root + '/latest-projects?timezone=invalid')).status, 400);
  assert.equal((await fetch(root + '/latest-projects?limit=10')).status, 400);
  assert.equal(
    (await fetch(root + '/latest-projects', { headers: { Origin: 'https://foreign.invalid' } }))
      .status,
    403,
  );
  for (const query of [
    '?limit=101',
    '?kind=unknown',
    '?projectId=bad',
    '?cursor=bad',
    '?from=not-a-date',
    '?extra=1',
    '?kind=task&kind=check',
  ])
    assert.equal((await fetch(root + query)).status, 400, query);
});
