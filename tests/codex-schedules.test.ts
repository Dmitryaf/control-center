import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { Observations } from '../server/observations.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { AnalysisSchedules } from '../server/analysis/schedules.js';
import { CodexAnalysis, codexAnalysisPolicy } from '../server/codex/analysis.js';
import { CodexAnalysisFixture } from './codex-analysis-fixture.js';
import { CodexExecutionError } from '../server/codex/execution.js';

async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  kind: 'week' | 'month' = 'week',
) {
  const f = await fixture();
  const repo = await f.repo('fictional-garden');
  const file = path.join(f.root, 'schedules.sqlite');
  const store = new Store(file);
  store.saveSettings({
    ...store.settings(),
    roots: [repo],
    timezone: 'UTC',
    autoRefreshMinutes: 0,
  });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  const history = new History(store, projects.decisions);
  let now = Date.parse('2024-03-06T12:00:00Z');
  let apiCalls = 0;
  const analyses = new PeriodAnalysis(
    store,
    history,
    { key: '', model: '' },
    async () => {
      apiCalls++;
      throw new Error('No API fallback');
    },
    () => now,
  );
  const executor = new CodexAnalysisFixture();
  const codex = new CodexAnalysis(store, history, analyses, executor, () => now);
  const schedules = new AnalysisSchedules(store, analyses, () => now, undefined, codex);
  const otherOwners: { store: Store; schedules: AnalysisSchedules }[] = [];
  const review = new Reviews(store).create({
    projectId: project.id,
    kind,
    anchorDate: '2024-03-06',
  });
  new Observations(store).create({
    projectId: project.id,
    occurredOn: '2024-03-06',
    body: 'Участники сохранили список посадок и смогли открыть его на следующей встрече.',
  });
  const selection = {
    projectIds: [project.id],
    includeGeneral: false,
    sourceKinds: ['observation'],
    includeMetadata: true,
    includeOpenTasks: false,
    includeUserText: false,
    includeRelatedReviews: false,
    includeRelatedAnalyses: false,
    codexDigestIds: [],
  };
  const enable = () =>
    schedules.enable({
      provider: 'codex',
      expectedPolicy: codexAnalysisPolicy,
      expectedModel: 'codex-default',
      reviewId: review.id,
      revision: null,
      selection,
      readConsent: true,
      sendConsent: true,
    });
  t.after(async () => {
    await schedules.stop();
    for (const other of otherOwners) {
      await other.schedules.stop();
      other.store.close();
    }
    store.close();
    await f.cleanup();
  });
  async function settle() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!store.db.prepare("SELECT id FROM analysis_runs WHERE status='running'").get()) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await schedules.tick();
  }
  return {
    f,
    file,
    store,
    history,
    analyses,
    executor,
    codex,
    schedules,
    project,
    review,
    selection,
    enable,
    settle,
    apiCalls: () => apiCalls,
    setNow: (date: string) => {
      now = Date.parse(date);
    },
    clock: () => now,
    otherOwners,
  };
}

for (const kind of ['week', 'month'] as const) {
  test(`Codex ${kind} schedule sends one closed period, saves provenance and accepts a manual follow-up without API configuration`, async (t) => {
    const x = await setup(t, kind);
    const schedule = x.enable();
    assert.equal(schedule.provider, 'codex');
    await x.schedules.tick();
    assert.equal(x.executor.prompts.length, 0);
    x.setNow(kind === 'week' ? '2024-03-11T00:00:01Z' : '2024-04-01T00:00:01Z');
    await Promise.all([x.schedules.tick(), x.schedules.tick()]);
    await x.settle();
    assert.equal(x.executor.prompts.length, 1);
    assert.equal(x.apiCalls(), 0);
    const saved = x.schedules.list().items[0];
    const run = x.analyses.read(saved.lastRunId!);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.trigger, 'scheduled');
    assert.equal(run.payload.origin?.kind, 'codex_runtime');
    assert.deepEqual(run.selection.projectIds, [x.project.id]);
    assert.ok(x.analyses.recent().items.some((r) => r.id === run.id));
    assert.equal(x.store.db.prepare('SELECT count(*) n FROM records').get()?.n, 0);
    await assert.rejects(
      x.analyses.run(run.id, { packetHash: run.packetHash, consent: true }),
      /только через встроенный Codex/,
    );
    await x.schedules.tick();
    assert.equal(x.executor.prompts.length, 1);
    const followup = await x.codex.prepare({
      reviewId: run.reviewId,
      requestKey: randomUUID(),
      parentRunId: run.id,
      selection: run.selection,
      question: 'Как проверить пользу этой идеи?',
      readConsent: true,
    });
    assert.equal(followup.approvedAt, null);
    await x.codex.start(followup.id, { packetHash: followup.packetHash, consent: true });
    await x.settle();
    assert.equal(x.analyses.read(followup.id).status, 'succeeded');
    assert.equal(x.executor.prompts.length, 2);
  });
}

test('Codex schedule pauses without login or after a policy/access change; never uses API fallback', async (t) => {
  const x = await setup(t);
  x.executor.authenticated = false;
  const schedule = x.enable();
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.schedules.list().items[0].enabled, false);
  assert.match(x.schedules.list().items[0].note!, /профиль|Войдите/);
  assert.equal(x.executor.prompts.length, 0);
  assert.equal(x.apiCalls(), 0);
  x.executor.authenticated = true;
  const resumed = x.schedules.resume(schedule.id, {
    revision: x.schedules.list().items[0].revision,
    confirm: true,
  });
  x.store.db
    .prepare('UPDATE analysis_schedules SET policy_version=? WHERE id=?')
    .run('codex-project-review-v3', resumed.id);
  x.setNow('2024-03-18T00:00:01Z');
  await x.schedules.tick();
  assert.equal(x.schedules.list().items[0].enabled, false);
  assert.equal(x.executor.prompts.length, 0);
});

test('Codex unknown outcome pauses and resume skips it; deleted successful runs retain no-repeat markers', async (t) => {
  const x = await setup(t);
  const realExecute = x.executor.execute.bind(x.executor);
  x.executor.execute = async (input) => {
    x.executor.prompts.push(input.prompt);
    throw new CodexExecutionError('Synthetic uncertain send', 'unknown');
  };
  const grant = x.enable();
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  await x.settle();
  const paused = x.schedules.list().items[0];
  assert.equal(paused.enabled, false);
  assert.equal(x.analyses.read(paused.lastRunId!).status, 'unknown');
  x.executor.execute = realExecute;
  x.schedules.resume(grant.id, { revision: paused.revision, confirm: true });
  await x.schedules.tick();
  assert.equal(x.executor.prompts.length, 1);
  x.setNow('2024-03-18T00:00:01Z');
  new Observations(x.store).create({
    projectId: x.project.id,
    occurredOn: '2024-03-13',
    body: 'Вторая встреча.',
  });
  await x.schedules.tick();
  await x.settle();
  const run = x.analyses.read(x.schedules.list().items[0].lastRunId!);
  assert.equal(run.status, 'succeeded');
  const marker = x.store.db
    .prepare('SELECT automatic_key FROM analysis_runs WHERE id=?')
    .get(run.id)!;
  x.analyses.delete(run.id);
  assert.ok(
    x.store.db
      .prepare('SELECT * FROM analysis_schedule_periods WHERE automatic_key=?')
      .get(marker.automatic_key!),
  );
  x.store.db
    .prepare('UPDATE analysis_schedules SET next_period_start=? WHERE id=?')
    .run('2024-03-11', grant.id);
  await x.schedules.tick();
  assert.equal(x.executor.prompts.length, 2);
});

test('two scheduler owners and a restart never send a Codex period twice', async (t) => {
  const x = await setup(t);
  x.enable();
  const otherStore = new Store(x.file);
  const history = new History(otherStore, new Projects(otherStore).decisions);
  const analyses = new PeriodAnalysis(otherStore, history, { key: '', model: '' }, fetch, x.clock);
  const codex = new CodexAnalysis(otherStore, history, analyses, x.executor, x.clock);
  const other = new AnalysisSchedules(otherStore, analyses, x.clock, undefined, codex);
  x.otherOwners.push({ store: otherStore, schedules: other });
  x.executor.mode = 'wait';
  x.setNow('2024-03-11T00:00:01Z');
  await Promise.all([x.schedules.tick(), other.tick()]);
  assert.equal(x.executor.prompts.length, 1);
  x.executor.release?.();
  await x.settle();
  await other.tick();
  assert.equal(x.executor.prompts.length, 1);
  assert.equal(x.schedules.list().items[0].lastRunId, other.list().items[0].lastRunId);
});

test('a fresh scheduler recovers an expired Codex lease as unknown without resending', async (t) => {
  const x = await setup(t);
  x.enable();
  x.executor.mode = 'wait';
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  const running = x.store.db.prepare("SELECT id FROM analysis_runs WHERE status='running'").get()!;
  x.store.db
    .prepare('UPDATE analysis_runs SET lease_until=? WHERE id=?')
    .run('2024-03-10T00:00:00Z', running.id!);
  const otherStore = new Store(x.file);
  const history = new History(otherStore, new Projects(otherStore).decisions);
  const analyses = new PeriodAnalysis(otherStore, history, { key: '', model: '' }, fetch, x.clock);
  const codex = new CodexAnalysis(otherStore, history, analyses, x.executor, x.clock);
  const other = new AnalysisSchedules(otherStore, analyses, x.clock, undefined, codex);
  x.otherOwners.push({ store: otherStore, schedules: other });
  await other.tick();
  assert.equal(other.list().items[0].enabled, false);
  assert.equal(analyses.read(String(running.id)).status, 'unknown');
  assert.equal(x.executor.prompts.length, 1);
  x.executor.release?.();
  await x.settle();
  await other.tick();
  assert.equal(x.executor.prompts.length, 1);
  assert.equal(analyses.read(String(running.id)).status, 'unknown');
});

for (const change of ['disable', 'access', 'stop'] as const) {
  test(`Codex ${change} during asynchronous probe prevents dispatch`, async (t) => {
    const x = await setup(t);
    const grant = x.enable();
    const probe = x.executor.probe.bind(x.executor);
    let release: (() => void) | undefined;
    x.executor.probe = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return probe();
    };
    x.setNow('2024-03-11T00:00:01Z');
    const tick = x.schedules.tick();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    let stopped: Promise<void> | undefined;
    if (change === 'disable') x.schedules.disable(grant.id, { revision: grant.revision });
    else if (change === 'access')
      x.store.db.prepare("UPDATE projects SET visibility='private' WHERE id=?").run(x.project.id);
    else stopped = x.schedules.stop();
    release();
    await tick;
    await stopped;
    assert.equal(x.executor.prompts.length, 0);
    assert.equal(x.apiCalls(), 0);
  });
}

test('downtime skips backlog and stale prepared Codex grants cannot be started manually', async (t) => {
  const x = await setup(t);
  const grant = x.enable();
  const run = await x.codex.prepareScheduled(
    { reviewId: x.review.id, requestKey: randomUUID(), selection: x.selection, readConsent: true },
    { id: grant.id, revision: grant.revision, key: 'synthetic-period' },
  );
  x.schedules.disable(grant.id, { revision: grant.revision });
  assert.equal(
    (await x.codex.start(run.id, { packetHash: run.packetHash, consent: true })).run.status,
    'cancelled',
  );
  const resumed = x.schedules.resume(grant.id, {
    revision: x.schedules.list().items[0].revision,
    confirm: true,
  });
  x.setNow('2024-05-02T12:00:00Z');
  await x.schedules.tick();
  assert.equal(x.executor.prompts.length, 0);
  const saved = x.schedules.list().items.find((item) => item.id === resumed.id)!;
  assert.equal(saved.nextPeriodStart, '2024-04-29');
  assert.match(saved.note!, /Пропущено/);
});

test('standing consent is checked at actual executor dispatch, after its asynchronous preparation', async (t) => {
  const x = await setup(t);
  const grant = x.enable();
  const execute = x.executor.execute.bind(x.executor);
  let sent = false;
  x.executor.execute = async (input) => {
    x.schedules.disable(grant.id, { revision: grant.revision });
    const dispatch = input as typeof input & { beforeDispatch?: () => void };
    dispatch.beforeDispatch?.();
    sent = true;
    return execute(input);
  };
  x.setNow('2024-03-11T00:00:01Z');
  await x.schedules.tick();
  await x.settle();
  assert.equal(sent, false);
  assert.equal(x.executor.prompts.length, 0);
});

test('a scheduled packet cannot expand the sources of its standing consent', async (t) => {
  const x = await setup(t);
  const grant = x.enable();
  await assert.rejects(
    x.codex.prepareScheduled(
      {
        reviewId: x.review.id,
        requestKey: randomUUID(),
        selection: { ...x.selection, includeOpenTasks: true },
        readConsent: true,
      },
      { id: grant.id, revision: grant.revision, key: 'synthetic-expanded' },
    ),
    /источники|выбор/i,
  );
  assert.equal(x.store.db.prepare('SELECT count(*) n FROM analysis_runs').get()?.n, 0);
});

test('schema14 → 15 preserves previous schedules and markers, backs up and rolls back failed provider DDL', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'legacy.sqlite');
  const seed = new Store(file);
  const review = new Reviews(seed).create({
    projectId: null,
    kind: 'week',
    anchorDate: '2024-03-06',
  });
  const analysis = new PeriodAnalysis(seed, new History(seed, new Projects(seed).decisions), {
    key: 'synthetic',
    model: 'kept-model',
  });
  const oldSchedule = new AnalysisSchedules(seed, analysis).enable({
    reviewId: review.id,
    revision: null,
    selection: {
      projectIds: [],
      includeGeneral: true,
      sourceKinds: ['observation'],
      includeMetadata: false,
      includeOpenTasks: false,
      includeUserText: false,
      includeRelatedReviews: false,
      includeRelatedAnalyses: false,
      codexDigestIds: [],
    },
    expectedModel: 'kept-model',
    readConsent: true,
    sendConsent: true,
  });
  if (
    seed.db
      .prepare('PRAGMA table_info(analysis_schedules)')
      .all()
      .some((column) => column.name === 'provider')
  )
    seed.db.exec('ALTER TABLE analysis_schedules DROP COLUMN provider');
  seed.db.exec(
    "INSERT INTO analysis_schedule_periods VALUES('already-sent','kept-id'); PRAGMA user_version=14",
  );
  const schedulesBefore = seed.db.prepare('SELECT * FROM analysis_schedules').all();
  seed.close();
  const beforeExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.includes('ADD COLUMN provider')) throw new Error('Synthetic provider DDL failure');
    return beforeExec.call(this, sql);
  };
  try {
    assert.throws(() => new Store(file), /Synthetic provider DDL failure/);
  } finally {
    DatabaseSync.prototype.exec = beforeExec;
  }
  const raw = new DatabaseSync(file, { readOnly: true });
  assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 14);
  raw.close();
  const migrated = new Store(file);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 16);
    const kept = migrated.db
      .prepare('SELECT * FROM analysis_schedules WHERE id=?')
      .get(oldSchedule.id)!;
    assert.equal(kept.provider, 'openai');
    const previousFields = { ...kept };
    delete previousFields.provider;
    assert.deepEqual(previousFields, { ...schedulesBefore[0] });
    assert.equal(
      migrated.db.prepare('SELECT run_key FROM analysis_schedule_periods').get()?.run_key,
      'kept-id',
    );
    const backups = await readdir(path.join(f.root, 'backups'));
    const backup = new DatabaseSync(path.join(f.root, 'backups', backups[0]), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 14);
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    assert.equal(backup.prepare('SELECT enabled FROM analysis_schedules').get()?.enabled, 0);
    backup.close();
  } finally {
    migrated.close();
  }
});
