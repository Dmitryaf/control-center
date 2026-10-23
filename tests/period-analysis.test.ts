import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Reviews } from '../server/reviews.js';
import { History } from '../server/history.js';
import { Tasks } from '../server/tasks.js';
import { Records } from '../server/records.js';
import { Checks } from '../server/checks/checks.js';
import { Observations } from '../server/observations.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { createApp } from '../server/app.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';
import type { PeriodReport, PeriodRun, PeriodSelection } from '../shared/period-analysis.js';

const config = { key: 'fixture-key', model: 'fixture-model' };
const now = Date.parse('2024-03-11T12:00:00Z');
const report: PeriodReport = {
  narrative: 'За неделю выявлено препятствие. Оно требует проверки, результат ещё неизвестен.',
  findings: [],
  uncertainties: ['Нет независимой проверки.'],
  proposals: [],
};
const response = (value: unknown = report) =>
  Response.json({
    id: 'resp_fixture',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 120, output_tokens: 45 },
  });
const selection = (id: string): PeriodSelection => ({
  projectIds: [id],
  includeGeneral: false,
  sourceKinds: ['observation'],
  includeMetadata: true,
  includeOpenTasks: false,
  includeUserText: false,
  includeRelatedReviews: false,
  includeRelatedAnalyses: false,
});
async function setup(t: { after: (fn: () => void | Promise<void>) => void }, file = false) {
  const f = await fixture();
  const store = new Store(file ? path.join(f.root, 'analysis.sqlite') : ':memory:');
  const extraStores: Store[] = [];
  t.after(async () => {
    for (const extra of extraStores) extra.close();
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('period-project');
  store.saveSettings({
    ...defaultSettings,
    roots: [repo],
    timezone: 'America/New_York',
    autoRefreshMinutes: 0,
  });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  store.saveMetadata(
    project.id,
    metadataSchema.parse({ ...project.metadata, goal: 'Check an assumption' }),
    'DO_NOT_SEND_PROJECT_NOTES',
  );
  const review = new Reviews(store).create({
    projectId: project.id,
    kind: 'week',
    anchorDate: '2024-03-10',
  });
  const note = new Observations(store).create({
    projectId: project.id,
    body: 'Observed obstacle',
    occurredOn: '2024-03-10',
  });
  const history = new History(store, projects.decisions);
  return { f, store, projects, project, review, note, history, extraStores };
}
test('period preview freezes only selected context, binds retries to selection, pages generations and blocks oversized/secret packets', async (t) => {
  const { store, project, review, history } = await setup(t);
  let calls = 0;
  const service = new PeriodAnalysis(
    store,
    history,
    config,
    async () => {
      calls++;
      return response();
    },
    () => now,
  );
  new Observations(store).create({ body: 'DO_NOT_SEND_GENERAL', occurredOn: '2024-03-10' });
  const key = randomUUID();
  const input = {
    reviewId: review.id,
    requestKey: key,
    readConsent: true,
    selection: selection(project.id),
  };
  const original = service.prepare(input);
  assert.equal(original.status, 'pending');
  assert.equal(original.generation, 1);
  const json = JSON.stringify(original.payload);
  assert.doesNotMatch(json, /DO_NOT_SEND|\.git|fixture-key/);
  assert.match(json, /Observed obstacle/);
  assert.equal(calls, 0);
  original.payload.sources[0].text = 'Caller tampered';
  assert.doesNotMatch(JSON.stringify(service.read(original.id).payload), /tampered/);
  assert.equal(service.prepare(input).id, original.id);
  assert.throws(
    () => service.prepare({ ...input, selection: { ...input.selection, includeUserText: true } }),
    { status: 409 },
  );
  assert.throws(() => service.prepare({ ...input, requestKey: randomUUID() }), { status: 409 });
  const second = service.prepare({ ...input, requestKey: randomUUID(), repeatConsent: true });
  assert.equal(second.generation, 2);
  assert.equal(service.list(review.id, { limit: 1 }).items[0].id, second.id);
  const firstPage = service.list(review.id, { limit: 1 });
  assert.equal(
    service.list(review.id, { limit: 1, cursor: firstPage.nextCursor }).items[0].id,
    original.id,
  );
  new Reviews(store).patch(review.id, { revision: review.revision, userText: 'x'.repeat(60000) });
  new Tasks(store).save({
    projectId: project.id,
    title: 'Long task',
    description: 'y'.repeat(10000),
    expectedResult: 'z'.repeat(10000),
    acceptance: 'a'.repeat(10000),
  });
  assert.throws(
    () =>
      service.prepare({
        ...input,
        requestKey: randomUUID(),
        repeatConsent: true,
        selection: {
          ...input.selection,
          includeUserText: true,
          includeMetadata: false,
          includeOpenTasks: true,
        },
      }),
    { status: 400 },
  );
  new Observations(store).create({
    projectId: project.id,
    body: 'token=fixture_private_value',
    occurredOn: '2024-03-10',
  });
  assert.throws(
    () => service.prepare({ ...input, requestKey: randomUUID(), repeatConsent: true }),
    { status: 400 },
  );
});

test('durable result preserves user text, source references, exact sent payload, metadata, restart and safe repeated run', async (t) => {
  const { store, project, review, note, history } = await setup(t);
  let calls = 0;
  let sent: Record<string, unknown> | undefined;
  const service = new PeriodAnalysis(
    store,
    history,
    config,
    async (url, options) => {
      calls++;
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      sent = JSON.parse(String(options!.body));
      return response({
        ...report,
        findings: [{ statement: 'There is an obstacle', sources: [`observation:${note.id}`] }],
      });
    },
    () => now,
  );
  const edited = new Reviews(store).patch(review.id, {
    revision: review.revision,
    userText: 'My own report',
  });
  const prepared = service.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: selection(project.id),
  });
  await assert.rejects(service.run(prepared.id, { packetHash: '0'.repeat(64), consent: true }), {
    status: 409,
  });
  const result = await service.run(prepared.id, { packetHash: prepared.packetHash, consent: true });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.approvedAt, new Date(now).toISOString());
  assert.equal(result.trigger, 'manual');
  assert.equal(result.responseId, 'resp_fixture');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 45 });
  assert.deepEqual(new Reviews(store).read(review.id), edited);
  assert.equal(sent!.store, false);
  assert.equal(sent!.tools, undefined);
  assert.deepEqual(JSON.parse((sent!.input as { content: string }[])[0].content), prepared.payload);
  const restarted = new PeriodAnalysis(
    store,
    history,
    config,
    async () => {
      calls++;
      throw new Error('must not retry');
    },
    () => now,
  );
  assert.deepEqual(
    await restarted.run(result.id, { packetHash: result.packetHash, consent: true }),
    result,
  );
  assert.equal(calls, 1);
  new Reviews(store).delete(review.id, { revision: edited.revision });
  assert.equal(restarted.read(result.id).reviewId, null);
  assert.equal(restarted.read(result.id).report!.narrative, report.narrative);
  assert.equal(restarted.list(review.id).items[0].id, result.id);
});

test('two Store writers claim once; expired running becomes unknown and never automatically resends', async (t) => {
  const { f, store, project, review, history, extraStores } = await setup(t, true);
  const secondStore = new Store(path.join(f.root, 'analysis.sqlite'));
  extraStores.push(secondStore);
  let clock = now,
    calls = 0,
    finish!: (value: Response) => void;
  const first = new PeriodAnalysis(
    store,
    history,
    config,
    async () => {
      calls++;
      return new Promise<Response>((resolve) => (finish = resolve));
    },
    () => clock,
  );
  const other = new PeriodAnalysis(
    secondStore,
    new History(secondStore, new Projects(secondStore).decisions),
    config,
    async () => {
      calls++;
      return response();
    },
    () => clock,
  );
  const packet = first.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: selection(project.id),
  });
  const pending = first.run(packet.id, { packetHash: packet.packetHash, consent: true });
  assert.equal(
    (await other.run(packet.id, { packetHash: packet.packetHash, consent: true })).status,
    'running',
  );
  assert.equal(calls, 1);
  assert.equal(other.read(packet.id).status, 'running');
  clock += 121000;
  assert.equal(other.read(packet.id).status, 'unknown');
  assert.equal(
    (await other.run(packet.id, { packetHash: packet.packetHash, consent: true })).status,
    'unknown',
  );
  assert.equal(calls, 1);
  finish(response());
  assert.equal((await pending).status, 'unknown');
  assert.equal(calls, 1);
});

test('source mutation, access revocation, deleted review and expiry prevent dispatch; config/model/hash are rechecked', async (t) => {
  const { store, project, review, note, history } = await setup(t);
  let calls = 0,
    clock = now;
  const service = new PeriodAnalysis(
    store,
    history,
    config,
    async () => {
      calls++;
      return response();
    },
    () => clock,
  );
  const prepare = () =>
    service.prepare({
      reviewId: review.id,
      requestKey: randomUUID(),
      readConsent: true,
      repeatConsent: true,
      selection: selection(project.id),
    });
  const first = prepare();
  new Observations(store).patch(note.id, {
    revision: note.revision,
    body: 'Corrected observation',
  });
  assert.equal(
    (await service.run(first.id, { packetHash: first.packetHash, consent: true })).status,
    'cancelled',
  );
  const second = prepare();
  store.db.prepare("UPDATE projects SET visibility='private' WHERE id=?").run(project.id);
  assert.equal(
    (await service.run(second.id, { packetHash: second.packetHash, consent: true })).status,
    'cancelled',
  );
  const expired = prepare();
  clock += 16 * 60000;
  assert.equal(
    (await service.run(expired.id, { packetHash: expired.packetHash, consent: true })).status,
    'cancelled',
  );
  const packet = prepare();
  const metadataPacket = prepare();
  store.saveMetadata(
    project.id,
    metadataSchema.parse({
      ...JSON.parse(store.project(project.id)!.metadata!),
      goal: 'Corrected goal',
    }),
    'Retained private notes',
  );
  assert.equal(
    (await service.run(metadataPacket.id, { packetHash: metadataPacket.packetHash, consent: true }))
      .status,
    'cancelled',
  );
  const changed = new PeriodAnalysis(
    store,
    history,
    { ...config, model: 'different-model' },
    async () => {
      calls++;
      return response();
    },
    () => clock,
  );
  await assert.rejects(changed.run(packet.id, { packetHash: packet.packetHash, consent: true }), {
    status: 409,
  });
  const unready = new PeriodAnalysis(
    store,
    history,
    { key: '', model: config.model },
    async () => {
      calls++;
      return response();
    },
    () => clock,
  );
  await assert.rejects(unready.run(packet.id, { packetHash: packet.packetHash, consent: true }), {
    status: 503,
  });
  store.db
    .prepare(
      "UPDATE analysis_runs SET payload_json=json_set(payload_json,'$.policyVersion','tampered') WHERE id=?",
    )
    .run(packet.id);
  await assert.rejects(service.run(packet.id, { packetHash: packet.packetHash, consent: true }), {
    status: 409,
  });
  assert.equal(calls, 0);
});

test('mutable checks, decisions and refreshed file metadata cannot change under an approved packet', async (t) => {
  const { store, project, review, history, projects } = await setup(t);
  let calls = 0;
  const checks = new Checks(store);
  const records = new Records(store);
  const check = checks.save({
    projectId: project.id,
    title: 'A check',
    question: 'Question',
    assumption: 'Assumption',
    expectedExternalResult: 'Evidence',
    startedAt: '2024-03-04',
    continueIf: 'Yes',
    stopIf: 'No',
    nextExternalAction: 'Ask',
  });
  const entry = checks.saveEntry(check.id, {
    kind: 'action',
    occurredAt: '2024-03-10',
    text: 'Asked',
  });
  const decision = records.save('decisions', {
    projectId: project.id,
    title: 'Choice',
    decision: 'Try it',
    date: '2024-03-10',
  });
  const file = path.join(project.path, 'DECISIONS.md');
  const content = (title: string) =>
    `---\nschema_version: 1\nid: D-0001\ntitle: ${title}\ndate: 2024-03-10\nstatus: accepted\narea: product\nimplementation: implemented\nvisibility: repository\n---\nBody stays excluded`;
  await writeFile(file, content('Original'));
  await projects.refresh(project.id);
  const service = new PeriodAnalysis(
    store,
    history,
    config,
    async () => {
      calls++;
      return response();
    },
    () => now,
  );
  const prepare = () =>
    service.prepare({
      reviewId: review.id,
      requestKey: randomUUID(),
      readConsent: true,
      repeatConsent: true,
      selection: {
        ...selection(project.id),
        includeMetadata: false,
        sourceKinds: ['check', 'decision', 'file_decision'],
      },
    });
  const first = prepare();
  assert.ok(first.payload.sources.some((source) => source.kind === 'file_decision'));
  assert.doesNotMatch(JSON.stringify(first.payload), /Body stays excluded/);
  checks.saveEntry(
    check.id,
    { kind: 'action', occurredAt: '2024-03-10', text: 'Corrected action' },
    entry.id,
  );
  assert.equal(
    (await service.run(first.id, { packetHash: first.packetHash, consent: true })).status,
    'cancelled',
  );
  const second = prepare();
  records.save(
    'decisions',
    { projectId: project.id, title: 'Choice', decision: 'Revised', date: '2024-03-10' },
    decision.id,
    true,
  );
  assert.equal(
    (await service.run(second.id, { packetHash: second.packetHash, consent: true })).status,
    'cancelled',
  );
  const third = prepare();
  await writeFile(file, content('Revised title'));
  await projects.refresh(project.id);
  assert.equal(
    (await service.run(third.id, { packetHash: third.packetHash, consent: true })).status,
    'cancelled',
  );
  assert.equal(calls, 0);
});

test('network unknown and received refusal/invalid references retain safe error/usage without retry or unsafe output', async (t) => {
  const { store, project, review, history } = await setup(t);
  const cases: [() => Promise<Response>, string][] = [
    [
      async () => {
        throw new Error('network');
      },
      'unknown',
    ],
    [
      async () =>
        Response.json({
          id: 'resp_refusal',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal' }] }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      'failed',
    ],
    [
      async () =>
        response({ ...report, findings: [{ statement: 'Invented', sources: ['not-approved'] }] }),
      'failed',
    ],
    [async () => response({ ...report, narrative: 'token=private_value' }), 'failed'],
    [
      async () =>
        Response.json({
          id: 'resp_incomplete',
          status: 'incomplete',
          output: [],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
      'failed',
    ],
  ];
  for (const [transport, state] of cases) {
    let calls = 0;
    const service = new PeriodAnalysis(
      store,
      history,
      config,
      async () => {
        calls++;
        return transport();
      },
      () => now,
    );
    const packet = service.prepare({
      reviewId: review.id,
      requestKey: randomUUID(),
      readConsent: true,
      repeatConsent: true,
      selection: selection(project.id),
    });
    const result = await service.run(packet.id, { packetHash: packet.packetHash, consent: true });
    assert.equal(result.status, state);
    assert.equal(result.report, null);
    assert.equal(result.rawOutput, null);
    assert.ok(result.error);
    assert.equal(
      (await service.run(packet.id, { packetHash: packet.packetHash, consent: true })).status,
      state,
    );
    assert.equal(calls, 1);
    if (state === 'failed') assert.ok(result.usage);
  }
});

test('cancel during dispatch remains uncertain, cancellation before dispatch sends nothing, and deletion does not touch review', async (t) => {
  const { store, project, review, history } = await setup(t);
  let calls = 0;
  const service = new PeriodAnalysis(
    store,
    history,
    config,
    async (_url, options) => {
      calls++;
      return new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    },
    () => now,
  );
  const input = {
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: selection(project.id),
  };
  const packet = service.prepare(input);
  const result = service.run(packet.id, { packetHash: packet.packetHash, consent: true });
  assert.throws(() => service.delete(packet.id), { status: 409 });
  assert.equal(service.cancel(packet.id).cancelRequested, true);
  assert.equal((await result).status, 'unknown');
  assert.equal(calls, 1);
  const pending = service.prepare({ ...input, requestKey: randomUUID(), repeatConsent: true });
  service.cancel(pending.id);
  assert.equal(
    (await service.run(pending.id, { packetHash: pending.packetHash, consent: true })).status,
    'cancelled',
  );
  assert.equal(calls, 1);
  service.delete(pending.id);
  assert.throws(() => service.read(pending.id), { status: 404 });
  assert.equal(new Reviews(store).read(review.id).userText, '');
});

test('v7 upgrade preserves sources, creates verified backup and restores saved runs without dispatch approvals', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.root, 'migration.sqlite');
  const seed = new Store(file);
  const review = new Reviews(seed).create({ kind: 'month', anchorDate: '2024-02-02' });
  new Reviews(seed).patch(review.id, { revision: review.revision, userText: 'Retained user text' });
  seed.db.exec('DROP TABLE analysis_runs; PRAGMA user_version=7;');
  const before = seed.db.prepare('SELECT * FROM reviews').all();
  seed.close();
  const store = new Store(file);
  const backups = await readdir(path.join(f.root, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^before-analysis-v8-/);
  const old = new DatabaseSync(path.join(f.root, 'backups', backups[0]), { readOnly: true });
  assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 7);
  assert.deepEqual(old.prepare('SELECT * FROM reviews').all(), before);
  old.close();
  const service = new PeriodAnalysis(
    store,
    new History(store, new Projects(store).decisions),
    config,
    async () => response(),
    () => now,
  );
  const sel: PeriodSelection = {
    ...selection(randomUUID()),
    projectIds: [],
    includeGeneral: true,
    sourceKinds: [],
    includeMetadata: false,
    includeUserText: true,
  };
  const pending = service.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: sel,
  });
  const success = service.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: sel,
    repeatConsent: true,
  });
  await service.run(success.id, { packetHash: success.packetHash, consent: true });
  const running = service.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: sel,
    repeatConsent: true,
  });
  store.db
    .prepare("UPDATE analysis_runs SET status='running',lease_until=? WHERE id=?")
    .run(new Date(now + 10000).toISOString(), running.id);
  const copy = path.join(f.root, 'copy.sqlite');
  store.backup(copy);
  assert.equal(service.read(pending.id).status, 'pending');
  store.close();
  const restored = new Store(copy);
  const read = new PeriodAnalysis(
    restored,
    new History(restored, new Projects(restored).decisions),
    config,
    async () => {
      throw new Error('no restore dispatch');
    },
    () => now,
  );
  assert.equal(read.read(pending.id).status, 'cancelled');
  assert.equal(read.read(running.id).status, 'unknown');
  assert.equal(read.read(success.id).report!.narrative, report.narrative);
  assert.deepEqual(restored.db.prepare('SELECT * FROM reviews').all(), before);
  restored.close();
  const failedFile = path.join(f.root, 'ddl-failure.sqlite');
  const failedSeed = new Store(failedFile);
  failedSeed.db.exec('DROP TABLE analysis_runs; PRAGMA user_version=7;');
  failedSeed.close();
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS analysis_runs'))
      throw new Error('Injected analysis DDL failure');
    return originalExec.call(this, sql);
  };
  try {
    assert.throws(() => new Store(failedFile), /Injected analysis DDL failure/);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  const failedRead = new DatabaseSync(failedFile);
  assert.equal(failedRead.prepare('PRAGMA user_version').get()?.user_version, 7);
  assert.equal(
    failedRead.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='analysis_runs'").get()
      ?.n,
    0,
  );
  failedRead.close();
  const blockedRoot = path.join(f.root, 'blocked');
  const blockedFile = path.join(blockedRoot, 'db.sqlite');
  const blocked = new Store(blockedFile);
  blocked.db.exec('DROP TABLE analysis_runs; PRAGMA user_version=7;');
  blocked.close();
  await writeFile(path.join(blockedRoot, 'backups'), 'blocked');
  assert.throws(() => new Store(blockedFile));
  const intact = new DatabaseSync(blockedFile);
  assert.equal(intact.prepare('PRAGMA user_version').get()?.user_version, 7);
  intact.close();
});

test('HTTP period analysis requires origin/header and exact consent; persisted DTO remains available through guarded routes', async (t) => {
  const { store, project, review, history } = await setup(t);
  let calls = 0;
  const service = new PeriodAnalysis(
    store,
    history,
    config,
    async () => {
      calls++;
      return response();
    },
    () => now,
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  server.on('request', createApp(store, port, undefined, service).app);
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = `http://127.0.0.1:${port}/api`;
  const headers = { 'Content-Type': 'application/json', 'X-Control-Center': '1' };
  const body = {
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: selection(project.id),
  };
  assert.equal(
    (
      await fetch(root + '/period-analysis/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(root + '/period-analysis/prepare', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://foreign.invalid' },
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  const created = await fetch(root + '/period-analysis/prepare', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(created.status, 201);
  const packet = (await created.json()) as PeriodRun;
  assert.equal(
    (
      await fetch(`${root}/period-analysis/${packet.id}/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ packetHash: packet.packetHash, consent: false }),
      })
    ).status,
    400,
  );
  assert.equal(calls, 0);
  const sent = await fetch(`${root}/period-analysis/${packet.id}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ packetHash: packet.packetHash, consent: true }),
  });
  assert.equal(sent.status, 200);
  assert.equal(((await sent.json()) as PeriodRun).status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal((await fetch(`${root}/reviews/${review.id}/analyses`)).status, 200);
});
