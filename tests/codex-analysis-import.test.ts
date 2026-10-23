import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { ProposalAcceptances } from '../server/analysis/acceptances.js';
import { createApp } from '../server/app.js';
import { defaultSettings } from '../shared/contracts.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture();
  let store = new Store(path.join(f.root, 'app.sqlite'));
  const repo = await f.repo('manual-analysis');
  store.saveSettings({ ...defaultSettings, roots: [repo], timezone: 'UTC', autoRefreshMinutes: 0 });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  const reviews = new Reviews(store);
  let review = reviews.create({ projectId: project.id, kind: 'week', anchorDate: '2024-03-06' });
  review = reviews.patch(review.id, {
    revision: review.revision,
    userText: 'User text stays untouched',
  });
  const key = randomUUID();
  const source = `codex_context:${key}`;
  const body = {
    purpose: 'project_review',
    projectId: project.id,
    reviewId: review.id,
    requestKey: key,
    confirm: true,
    context:
      'Codex inspected synthetic evidence. This is a declared external context, not a provider receipt.',
    report: {
      narrative: 'Сохранён ручной анализ <b>как текст</b>.',
      findings: [{ statement: 'Проверка ограничена тестовым примером.', sources: [source] }],
      uncertainties: ['Реальная эксплуатация не проверена.'],
      proposals: [
        {
          kind: 'improvement',
          projectIds: [project.id],
          title: 'Проверить один пример',
          description: 'Сопоставить результат.',
          reason: 'Есть ограниченная проверка.',
          uncertainty: 'Результат неизвестен.',
          cheapCheck: 'Один тестовый файл.',
          sources: [source],
        },
      ],
    },
  };
  let calls = 0;
  const service = () =>
    new PeriodAnalysis(
      store,
      new History(store, new Projects(store).decisions),
      { key: '', model: '' },
      async () => {
        calls++;
        throw new Error('Must not call provider');
      },
    );
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  return {
    body,
    project,
    review,
    service,
    calls: () => calls,
    store: () => store,
    reopen: () => {
      store.close();
      store = new Store(path.join(f.root, 'app.sqlite'));
    },
  };
}

test('manual Codex report persists in the existing analysis owner with honest provenance, no dispatch, safe retry and retained acceptance', async (t) => {
  const f = await setup(t);
  let service = f.service();
  const saved = service.importCodex(f.body);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.origin, 'codex_manual');
  assert.equal(saved.model, '');
  assert.equal(saved.startedAt, null);
  assert.equal(saved.approvedAt, null);
  assert.equal(saved.usage, null);
  assert.equal(saved.responseId, null);
  assert.deepEqual(saved.report, f.body.report);
  assert.equal(
    (await service.run(saved.id, { packetHash: saved.packetHash, consent: true })).id,
    saved.id,
  );
  assert.equal(service.importCodex(f.body).id, saved.id);
  assert.throws(
    () => service.importCodex({ ...f.body, context: 'Changed evidence' }),
    /ключ уже использован/,
  );
  assert.throws(
    () =>
      service.prepare({
        reviewId: f.review.id,
        requestKey: f.body.requestKey,
        readConsent: true,
        selection: saved.selection,
        repeatConsent: true,
      }),
    /ключ подготовки уже использован/,
  );
  assert.equal(new Reviews(f.store()).read(f.review.id).userText, f.review.userText);
  f.reopen();
  service = f.service();
  assert.equal(service.importCodex(f.body).id, saved.id);
  assert.equal(service.recent({ projectIds: f.project.id }).items[0].origin, 'codex_manual');
  assert.equal(service.recent({ projectIds: randomUUID() }).items.length, 0);
  const acceptance = new ProposalAcceptances(f.store(), service).accept(saved.id, 0, {
    kind: 'task',
    projectId: f.project.id,
    title: 'Chosen human wording',
    description: '',
    reason: 'A test is needed.',
    uncertainty: 'Unknown outcome.',
    cheapCheck: 'One file.',
    consent: true,
  });
  assert.equal(acceptance.original.origin, 'codex_manual');
  service.delete(saved.id);
  assert.equal(
    new ProposalAcceptances(f.store(), service).read(acceptance.id).original.origin,
    'codex_manual',
  );
  assert.equal(f.calls(), 0);
});

test('manual import validates scope, references, confirmation and sensitive text without partial writes', async (t) => {
  const f = await setup(t);
  const service = f.service();
  for (const input of [
    { ...f.body, purpose: undefined },
    { ...f.body, purpose: 'analysis_evaluation' },
    { ...f.body, confirm: false },
    { ...f.body, projectId: randomUUID() },
    { ...f.body, context: 'Look in .local/private' },
    {
      ...f.body,
      report: {
        ...f.body.report,
        findings: [{ statement: 'Unsupported', sources: ['unknown-source'] }],
      },
    },
    {
      ...f.body,
      context: '字'.repeat(19000),
      report: { ...f.body.report, narrative: '字'.repeat(19000) },
    },
  ])
    assert.throws(() => service.importCodex(input));
  assert.equal(f.store().db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get()?.n, 0);
  assert.equal(new Reviews(f.store()).read(f.review.id).userText, f.review.userText);
  assert.equal(f.calls(), 0);
});

test('manual portfolio import binds the explicit project set and keeps older imports readable', async (t) => {
  const f = await setup(t);
  const service = f.service();
  const general = new Reviews(f.store()).create({ kind: 'week', anchorDate: '2024-03-06' });
  const input = {
    ...f.body,
    projectId: undefined,
    projectIds: [f.project.id],
    reviewId: general.id,
  };
  const saved = service.importCodex(input);
  assert.equal(saved.scopeKey, 'general');
  assert.deepEqual(saved.payload.scope.projectIds, [f.project.id]);
  assert.equal(saved.payload.origin?.purpose, 'project_review');
  assert.equal(service.recent({ projectIds: f.project.id }).items[0].id, saved.id);
  assert.equal(service.recent({ projectIds: randomUUID() }).items.length, 0);
  assert.throws(() =>
    service.importCodex({
      ...input,
      requestKey: randomUUID(),
      projectIds: [f.project.id, randomUUID()],
    }),
  );
  const legacyPayload = { ...saved.payload, origin: { kind: 'codex_manual' } };
  f.store()
    .db.prepare('UPDATE analysis_runs SET payload_json=? WHERE id=?')
    .run(JSON.stringify(legacyPayload), saved.id);
  assert.deepEqual(service.read(saved.id).report, saved.report);
  assert.deepEqual(service.read(saved.id).payload, legacyPayload);
  assert.equal(f.calls(), 0);
});

test('real HTTP manual import requires the local mutation guard; recent results and source text survive repeated requests', async (t) => {
  const f = await setup(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  server.on('request', createApp(f.store(), port, undefined, f.service()).app);
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = `http://127.0.0.1:${port}/api/period-analysis`;
  const post = (headers: Record<string, string>) =>
    fetch(root + '/import-codex', { method: 'POST', headers, body: JSON.stringify(f.body) });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Control-Center': '1' };
  assert.equal((await post({ ...headers, Origin: 'https://foreign.invalid' })).status, 403);
  const response = await post(headers);
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal((await (await post(headers)).json()).id, saved.id);
  const recent = await (await fetch(root + `/recent?projectIds=${f.project.id}`)).json();
  assert.equal(recent.items[0].id, saved.id);
  assert.equal(recent.items[0].origin, 'codex_manual');
  assert.equal(f.calls(), 0);
});
