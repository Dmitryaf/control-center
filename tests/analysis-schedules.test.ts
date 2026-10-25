import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../server/app.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { History } from '../server/history.js';
import { Projects } from '../server/projects/projects.js';
import { Reviews } from '../server/reviews.js';
import { Observations } from '../server/observations.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { AnalysisSchedules } from '../server/analysis/schedules.js';
import { snapshotDatabase, revokeRestoredApprovals } from '../server/storage.js';
import { digest } from '../server/analysis/privacy.js';
import type { PeriodSelection } from '../shared/period-analysis.js';

const selection: PeriodSelection = {
  projectIds: [],
  includeGeneral: true,
  sourceKinds: ['observation'],
  includeMetadata: false,
  includeOpenTasks: false,
  includeUserText: false,
  includeRelatedReviews: false,
  includeRelatedAnalyses: false,
  codexDigestIds: [],
};
const report = { narrative: 'Сохранённый итог.', findings: [], uncertainties: [], proposals: [] };
const response = () =>
  Response.json({
    id: 'resp_schedule',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report) }] }],
  });
async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  mode: 'success' | 'unknown' | 'hold' | 'failed' = 'success',
) {
  const f = await fixture();
  const store = new Store(path.join(f.root, 'schedule.sqlite'));
  const others: Store[] = [];
  t.after(async () => {
    for (const other of others) other.close();
    store.close();
    await f.cleanup();
  });
  store.saveSettings({ ...store.settings(), timezone: 'UTC' });
  const history = new History(store, new Projects(store).decisions);
  let now = Date.parse('2024-03-06T12:00:00Z'),
    calls = 0;
  let finish: (() => void) | undefined;
  const transport: typeof fetch = async () => {
    calls++;
    if (mode === 'unknown') throw new Error('network');
    if (mode === 'failed')
      return Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 });
    if (mode === 'hold')
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return response();
  };
  const analysis = new PeriodAnalysis(
    store,
    history,
    { key: 'fixture', model: 'fixture-model' },
    transport,
    () => now,
  );
  const schedules = new AnalysisSchedules(store, analysis, () => now);
  const review = new Reviews(store).create({
    projectId: null,
    kind: 'week',
    anchorDate: '2024-03-06',
  });
  new Observations(store).create({
    projectId: null,
    body: 'Есть наблюдение',
    occurredOn: '2024-03-06',
  });
  const enable = (revision: number | null = null) =>
    schedules.enable({
      reviewId: review.id,
      revision,
      selection,
      expectedModel: 'fixture-model',
      readConsent: true,
      sendConsent: true,
    });
  return {
    f,
    store,
    history,
    analysis,
    schedules,
    review,
    enable,
    others,
    transport,
    clock: () => now,
    setNow: (value: string) => {
      now = Date.parse(value);
    },
    calls: () => calls,
    finish: () => finish?.(),
  };
}
test('previous context policy cannot send a pending packet or expand a scheduled permission', async (t) => {
  const x = await setup(t);
  const grant = x.enable();
  const pending = x.analysis.prepare({
    reviewId: x.review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection,
  });
  const payload = { ...pending.payload, policyVersion: 'period-review-v5' };
  const hash = digest({ payload, model: pending.model, policy: 'period-review-v5' });
  x.store.db
    .prepare('UPDATE analysis_runs SET payload_json=?,policy_version=?,packet_hash=? WHERE id=?')
    .run(JSON.stringify(payload), 'period-review-v5', hash, pending.id);
  await assert.rejects(
    () => x.analysis.run(pending.id, { packetHash: hash, consent: true }),
    /Конфигурация анализа изменилась/,
  );
  x.store.db
    .prepare('UPDATE analysis_schedules SET policy_version=? WHERE id=?')
    .run('period-review-v5', grant.id);
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.calls(), 0);
  assert.equal(x.schedules.read(grant.id).enabled, false);
  assert.throws(
    () =>
      x.schedules.resume(grant.id, {
        revision: x.schedules.read(grant.id).revision,
        confirm: true,
      }),
    /Подтвердите/,
  );
  assert.deepEqual(x.analysis.read(pending.id).payload, payload);
});
test('schedules are opt-in, bound to revision/model, send only a closed period once and retain provenance in history', async (t) => {
  const x = await setup(t);
  assert.deepEqual(x.schedules.list().items, []);
  assert.throws(
    () =>
      x.schedules.enable({
        reviewId: x.review.id,
        revision: null,
        selection,
        expectedModel: 'fixture-model',
        readConsent: true,
      }),
    /true/,
  );
  const policy = x.enable();
  assert.equal(policy.nextPeriodStart, '2024-03-04');
  assert.throws(() => x.enable(), /изменено/);
  await x.schedules.tick();
  assert.equal(x.calls(), 0);
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.calls(), 1);
  const run = x.analysis.list(x.review.id).items[0];
  assert.equal(run.trigger, 'scheduled');
  assert.equal(run.status, 'succeeded');
  assert.ok(run.approvedAt);
  assert.equal(x.analysis.read(run.id).payload.period.incomplete, false);
  await x.schedules.tick();
  assert.equal(x.calls(), 1);
  const entry = x.history.list({ kind: 'ai_analysis' }).items[0];
  assert.ok(entry.href.includes(run.id));
  assert.equal(
    x.history.forReview(x.review).items.some((e) => e.kind === 'ai_analysis'),
    false,
  );
  new Reviews(x.store).delete(x.review.id, { revision: x.review.revision });
  assert.equal(x.analysis.read(run.id).reviewId, null);
  assert.equal(x.history.list({ kind: 'ai_analysis' }).items[0].sourceId, run.id);
});
test('two processes claim one schedule/run; restart does not duplicate a request', async (t) => {
  const x = await setup(t, 'hold');
  x.enable();
  x.setNow('2024-03-11T00:00:01Z');
  const second = new Store(x.store.path);
  x.others.push(second);
  const otherAnalysis = new PeriodAnalysis(
    second,
    new History(second, new Projects(second).decisions),
    { key: 'fixture', model: 'fixture-model' },
    x.transport,
    x.clock,
  );
  const other = new AnalysisSchedules(second, otherAnalysis, x.clock);
  const first = x.schedules.tick();
  await other.tick();
  assert.equal(x.calls(), 1);
  x.finish();
  await first;
  await other.tick();
  assert.equal(x.calls(), 1);
});
test('unknown result requires explicit continuation; backlog skips without disabling future periods', async (t) => {
  const x = await setup(t, 'unknown');
  const policy = x.enable();
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.calls(), 1);
  assert.equal(x.schedules.list().items[0].enabled, false);
  await x.schedules.tick();
  assert.equal(x.calls(), 1);
  const current = x.schedules.list().items[0];
  assert.throws(() => x.schedules.resume(current.id, { revision: current.revision }), /true/);
  x.schedules.resume(current.id, { revision: current.revision, confirm: true });
  x.setNow('2024-04-01T00:00:01Z');
  await x.schedules.tick();
  const paused = x.schedules.list().items[0];
  assert.equal(paused.enabled, true);
  assert.match(paused.note!, /несколько/);
  assert.equal(x.calls(), 1);
  assert.equal(paused.id, policy.id);
  assert.equal(paused.nextPeriodStart, '2024-04-01');
  await x.schedules.tick();
  assert.equal(x.calls(), 1);
});
test('an explicit HTTP failure is retained once; a later period still runs after restart', async (t) => {
  const x = await setup(t, 'failed');
  x.enable();
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.analysis.list(x.review.id).items[0].status, 'failed');
  assert.equal(x.schedules.list().items[0].enabled, true);
  assert.equal(x.schedules.list().items[0].nextPeriodStart, '2024-03-11');
  await x.schedules.tick();
  assert.equal(x.calls(), 1);
  new Observations(x.store).create({
    projectId: null,
    body: 'Следующий период',
    occurredOn: '2024-03-12',
  });
  const reopened = new Store(x.store.path);
  x.others.push(reopened);
  const owner = new PeriodAnalysis(
    reopened,
    new History(reopened, new Projects(reopened).decisions),
    { key: 'fixture', model: 'fixture-model' },
    x.transport,
    x.clock,
  );
  const schedules = new AnalysisSchedules(reopened, owner, x.clock);
  x.setNow('2024-03-18T00:00:01Z');
  await schedules.tick();
  assert.equal(x.calls(), 2);
  assert.equal(schedules.list().items[0].enabled, true);
});
test('manual variants and empty periods incur no automatic call; disabled grant blocks a prepared scheduled run', async (t) => {
  const x = await setup(t);
  const policy = x.enable();
  x.analysis.prepare({
    reviewId: x.review.id,
    requestKey: randomUUID(),
    selection,
    readConsent: true,
  });
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.calls(), 0);
  x.setNow('2024-03-18T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.calls(), 0);
  assert.match(x.schedules.list().items[0].note!, /нет данных/);
  const nextReview = new Reviews(x.store).create({
    projectId: null,
    kind: 'week',
    anchorDate: '2024-03-18',
  });
  new Observations(x.store).create({ projectId: null, body: 'New', occurredOn: '2024-03-18' });
  const pending = x.analysis.prepareScheduled(
    { reviewId: nextReview.id, requestKey: randomUUID(), selection, readConsent: true },
    { id: policy.id, revision: policy.revision, key: 'fixture-key' },
  );
  x.schedules.disable(policy.id, { revision: policy.revision });
  const result = await x.analysis.run(pending.id, {
    packetHash: pending.packetHash,
    consent: true,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(x.calls(), 0);
});
test('a crash followed by a long outage cannot bypass an uncertain dispatch when skipping backlog', async (t) => {
  const x = await setup(t);
  const grant = x.enable();
  const run = x.analysis.prepareScheduled(
    { reviewId: x.review.id, requestKey: randomUUID(), selection, readConsent: true },
    { id: grant.id, revision: grant.revision, key: `schedule:${grant.id}:week:2024-03-04` },
  );
  // Durable state left by a process crash after sending, before recording a receipt.
  x.store.db
    .prepare(
      "UPDATE analysis_runs SET status='running',lease_until='2024-03-11T00:02:00Z' WHERE id=?",
    )
    .run(run.id);
  x.setNow('2024-04-01T00:00:01Z');
  const reopened = new Store(x.store.path);
  x.others.push(reopened);
  const owner = new PeriodAnalysis(
    reopened,
    new History(reopened, new Projects(reopened).decisions),
    {},
    x.transport,
    x.clock,
  );
  const schedules = new AnalysisSchedules(reopened, owner, x.clock);
  await schedules.tick();
  assert.equal(schedules.list().items[0].enabled, false);
  assert.equal(schedules.list().items[0].lastRunId, run.id);
  assert.equal(owner.read(run.id).status, 'unknown');
  assert.equal(x.calls(), 0);
  await schedules.tick();
  assert.equal(x.calls(), 0);
});
test('deleted runs leave a durable no-repeat marker, and restored copies disable standing approvals', async (t) => {
  const x = await setup(t);
  const policy = x.enable();
  const pending = x.analysis.prepareScheduled(
    { reviewId: x.review.id, requestKey: randomUUID(), selection, readConsent: true },
    { id: policy.id, revision: policy.revision, key: 'once' },
  );
  x.analysis.delete(pending.id);
  assert.throws(
    () =>
      x.analysis.prepareScheduled(
        { reviewId: x.review.id, requestKey: randomUUID(), selection, readConsent: true },
        { id: policy.id, revision: policy.revision, key: 'once' },
      ),
    /удалён/,
  );
  const target = path.join(x.f.root, 'backup.sqlite');
  snapshotDatabase(x.store.db, target);
  const copy = new Store(target);
  x.others.push(copy);
  assert.equal(
    new AnalysisSchedules(
      copy,
      new PeriodAnalysis(copy, new History(copy, new Projects(copy).decisions)),
    ).list().items[0].enabled,
    false,
  );
  assert.equal(x.schedules.list().items[0].enabled, true);
  revokeRestoredApprovals(x.store.db);
  assert.equal(x.schedules.list().items[0].enabled, false);
});
test('schema 8 migration keeps old data and a verified backup; related AI needs a separate explicit source choice', async (t) => {
  const x = await setup(t);
  x.enable();
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  const month = new Reviews(x.store).create({
    projectId: null,
    kind: 'month',
    anchorDate: '2024-03-01',
  });
  const chosen = {
    ...selection,
    sourceKinds: [],
    includeUserText: true,
    includeRelatedAnalyses: true,
  };
  const preview = x.analysis.prepare({
    reviewId: month.id,
    requestKey: randomUUID(),
    selection: chosen,
    readConsent: true,
  });
  const ai = preview.payload.sources.find((s) => s.kind === 'ai_analysis');
  assert.ok(ai);
  assert.equal(ai.dateQuality, 'model');
  const withoutInput = {
    reviewId: month.id,
    requestKey: randomUUID(),
    selection: { ...chosen, includeRelatedAnalyses: false },
    readConsent: true,
    repeatConsent: true,
  };
  // An empty review is no longer counted as evidence when the only real source is excluded.
  assert.throws(() => x.analysis.prepare(withoutInput), /нет данных/);
  new Reviews(x.store).patch(month.id, {
    revision: month.revision,
    userText: 'My own monthly observation',
  });
  const without = x.analysis.prepare(withoutInput);
  assert.equal(
    without.payload.sources.some((s) => s.kind === 'ai_analysis'),
    false,
  );
  x.analysis.delete(ai.id.slice(9));
  assert.equal(
    (await x.analysis.run(preview.id, { packetHash: preview.packetHash, consent: true })).status,
    'cancelled',
  );
  const f = await fixture();
  t.after(() => f.cleanup());
  const file = path.join(f.root, 'v8.sqlite');
  const seed = new Store(file);
  const review = new Reviews(seed).create({
    projectId: null,
    kind: 'week',
    anchorDate: '2024-01-01',
  });
  seed.db.exec(
    'DROP TABLE analysis_schedules; DROP TABLE analysis_schedule_periods; PRAGMA user_version=8;',
  );
  seed.close();
  const upgraded = new Store(file);
  assert.equal(new Reviews(upgraded).read(review.id).id, review.id);
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 12);
  upgraded.close();
  const name = (await readdir(path.join(f.root, 'backups'))).find((n) =>
    n.startsWith('before-schedules-v9'),
  );
  assert.ok(name);
  const backup = new DatabaseSync(path.join(f.root, 'backups', name), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 8);
  backup.close();
});

test('HTTP grants enforce local JSON, both consents and revision; model/access changes stop future dispatch', async (t) => {
  const x = await setup(t);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const { app } = createApp(x.store, port, undefined, x.analysis);
  const server = app.listen(port, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const payload = {
    reviewId: x.review.id,
    revision: null,
    selection,
    expectedModel: 'fixture-model',
    readConsent: true,
    sendConsent: true,
  };
  const url = `http://127.0.0.1:${port}/api/analysis-schedules`;
  const send = (data: unknown, extra: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1', ...extra },
      body: JSON.stringify(data),
    });
  assert.equal((await send(payload, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await send({ ...payload, sendConsent: false })).status, 400);
  assert.equal((await send({ ...payload, expectedModel: 'changed-model' })).status, 409);
  const result = await send(payload);
  assert.equal(result.status, 200);
  assert.equal((await send(payload)).status, 409);
  const policy = await result.json();
  const different = new PeriodAnalysis(
    x.store,
    x.history,
    { key: 'fixture', model: 'changed-model' },
    x.transport,
    x.clock,
  );
  x.setNow('2024-03-11T00:00:01Z');
  await new AnalysisSchedules(x.store, different, x.clock).tick();
  assert.equal(x.calls(), 0);
  assert.equal(x.schedules.list().items[0].enabled, false);
  const repo = await x.f.repo('access-project');
  x.store.saveSettings({ ...x.store.settings(), roots: [repo] });
  const projects = new Projects(x.store);
  await projects.scan();
  const project = projects.list()[0];
  const current = x.schedules.list().items[0];
  x.schedules.enable({
    ...payload,
    revision: current.revision,
    selection: { ...selection, projectIds: [project.id] },
  });
  x.store.db.prepare("UPDATE projects SET visibility='private' WHERE id=?").run(project.id);
  await x.schedules.tick();
  assert.equal(x.calls(), 0);
  assert.equal(x.schedules.list().items[0].enabled, false);
  const fresh = x.schedules.list().items[0];
  x.schedules.enable({ ...payload, revision: fresh.revision });
  await projects.forget(project.id);
  assert.equal(x.schedules.list().items[0].enabled, false);
  assert.ok(policy.id);
});
