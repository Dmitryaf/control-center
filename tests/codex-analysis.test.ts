import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { Tasks } from '../server/tasks.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { CodexAnalysis } from '../server/codex/analysis.js';
import { CodexAnalysisFixture } from './codex-analysis-fixture.js';
import { createApp } from '../server/app.js';

async function setup(t: { after: (action: () => Promise<void>) => void }) {
  const f = await fixture();
  const repo = await f.repo('selected-project');
  const file = path.join(f.root, 'state.sqlite');
  const store = new Store(file);
  store.saveSettings({ ...store.settings(), roots: [repo], autoRefreshMinutes: 0 });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  const review = new Reviews(store).create({
    projectId: project.id,
    kind: 'week',
    anchorDate: '2024-03-10',
  });
  const history = new History(store, projects.decisions);
  let now = Date.now();
  const analyses = new PeriodAnalysis(store, history, { key: '', model: '' }, fetch, () => now);
  const executor = new CodexAnalysisFixture();
  const service = new CodexAnalysis(store, history, analyses, executor, () => now);
  const input = () => ({
    reviewId: review.id,
    requestKey: randomUUID(),
    question: 'Что изменилось и что проверить дальше?',
    selection: {
      projectIds: [project.id],
      includeGeneral: false,
      sourceKinds: ['task', 'observation', 'decision'],
      includeMetadata: true,
      includeOpenTasks: true,
      includeUserText: true,
      includeRelatedReviews: true,
      includeRelatedAnalyses: false,
      codexDigestIds: [],
    },
    files: [],
    readConsent: true,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    await f.cleanup();
  });
  return {
    f,
    repo,
    file,
    store,
    projects,
    project,
    review,
    history,
    analyses,
    executor,
    service,
    input,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function settled(service: CodexAnalysis, id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const run = service.read(id).run;
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic execution did not settle');
}
test('Codex preview → explicit dispatch → persisted report → follow-up and restart without duplicate sends', async (t) => {
  const s = await setup(t);
  const input = s.input();
  const run = await s.service.prepare(input);
  assert.equal(run.origin, 'codex_runtime');
  assert.equal(run.status, 'pending');
  assert.equal(s.executor.prompts.length, 0);
  assert.equal((await s.service.prepare(input)).id, run.id);
  await Promise.all([
    s.service.start(run.id, { packetHash: run.packetHash, consent: true }),
    s.service.start(run.id, { packetHash: run.packetHash, consent: true }),
  ]);
  const report = await settled(s.service, run.id);
  assert.equal(report.status, 'succeeded');
  assert.equal(s.executor.prompts.length, 1);
  await s.service.start(run.id, { packetHash: run.packetHash, consent: true });
  assert.equal(s.executor.prompts.length, 1);
  await assert.rejects(
    s.analyses.run(run.id, { packetHash: run.packetHash, consent: true }),
    /только через встроенный Codex/,
  );
  const followup = await s.service.prepare({
    ...s.input(),
    parentRunId: run.id,
    selection: run.selection,
    question: 'Как проверить этот вывод одним действием?',
  });
  await s.service.start(followup.id, { packetHash: followup.packetHash, consent: true });
  assert.equal((await settled(s.service, followup.id)).status, 'succeeded');
  const supplied = JSON.parse(s.executor.prompts[1].split('\n').at(-1)!);
  assert.equal(supplied.conversation.length, 1);
  assert.equal(supplied.conversation[0].report.narrative, report.report!.narrative);
  const origin = followup.payload.origin;
  assert.ok(origin?.kind === 'codex_runtime');
  const reopened = new Store(s.file);
  try {
    const history = new History(reopened, new Projects(reopened).decisions);
    const analyses = new PeriodAnalysis(reopened, history);
    const service = new CodexAnalysis(reopened, history, analyses, new CodexAnalysisFixture());
    const saved = service.conversation({ sessionId: origin.sessionId });
    assert.equal(saved.turns.length, 2);
    assert.deepEqual(
      saved.turns.map((t) => t.report),
      [report.report, s.service.read(followup.id).run.report],
    );
  } finally {
    reopened.close();
  }
});
test('Codex refuses stale/foreign input and validates actual model output without touching tasks', async (t) => {
  const s = await setup(t);
  const task = new Tasks(s.store).save({ title: 'Existing task', projectId: s.project.id });
  const pending = await s.service.prepare(s.input());
  new Tasks(s.store).patch(task.id, task.revision, { title: 'Concurrent edit' });
  await assert.rejects(
    s.service.start(pending.id, { packetHash: pending.packetHash, consent: true }),
    /Источник изменён/,
  );
  assert.equal(s.executor.prompts.length, 0);
  for (const mode of ['invalid', 'foreign', 'secret'] as const) {
    s.executor.mode = mode;
    const run = await s.service.prepare(s.input());
    await s.service.start(run.id, { packetHash: run.packetHash, consent: true });
    const saved = await settled(s.service, run.id);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.report, null);
  }
  assert.equal(new Tasks(s.store).list().length, 1);
  assert.equal(new Tasks(s.store).read(task.id).title, 'Concurrent edit');
  const input = s.input();
  await s.service.prepare(input);
  await assert.rejects(s.service.prepare({ ...input, question: 'Different request' }), /ключ/);
});
test('selected repository files are bounded, tracked, immutable after preview and included only with consent', async (t) => {
  const s = await setup(t);
  await writeFile(path.join(s.repo, 'untracked.md'), 'not approved');
  const files = await s.service.files({ projectIds: [s.project.id], readConsent: true });
  assert.deepEqual(files.projects[0].files, ['README.md']);
  for (const file of ['../outside.md', 'untracked.md', '.env', 'README.md:secret.md'])
    await assert.rejects(
      s.service.prepare({ ...s.input(), files: [{ projectId: s.project.id, path: file }] }),
    );
  await assert.rejects(
    s.service.prepare({ ...s.input(), files: [{ projectId: randomUUID(), path: 'README.md' }] }),
  );
  const prepared = await s.service.prepare({
    ...s.input(),
    files: [{ projectId: s.project.id, path: 'README.md' }],
  });
  assert.equal(prepared.payload.sources.filter((s) => s.kind === 'repository_file').length, 1);
  await writeFile(path.join(s.repo, 'README.md'), '# Changed after preview');
  await assert.rejects(
    s.service.start(prepared.id, { packetHash: prepared.packetHash, consent: true }),
    /файлы или доступ изменились/,
  );
  assert.equal(s.executor.prompts.length, 0);
  await writeFile(path.join(s.repo, 'README.md'), 'password=synthetic-secret');
  await assert.rejects(
    s.service.prepare({ ...s.input(), files: [{ projectId: s.project.id, path: 'README.md' }] }),
    /возможный секрет/,
  );
});
test('cancel, lease recovery and backups do not resume or repeat a Codex request', async (t) => {
  const s = await setup(t);
  s.executor.mode = 'wait';
  const run = await s.service.prepare(s.input());
  await s.service.start(run.id, { packetHash: run.packetHash, consent: true });
  while (!s.executor.prompts.length) await new Promise((r) => setTimeout(r, 5));
  s.analyses.cancel(run.id);
  s.service.abort(run.id);
  assert.equal((await settled(s.service, run.id)).status, 'unknown');
  await s.service.start(run.id, { packetHash: run.packetHash, consent: true });
  assert.equal(s.executor.prompts.length, 1);
  const second = await s.service.prepare(s.input());
  await s.service.start(second.id, { packetHash: second.packetHash, consent: true });
  while (s.executor.prompts.length < 2) await new Promise((r) => setTimeout(r, 5));
  s.advance(31000);
  assert.equal(s.service.read(second.id).run.status, 'unknown');
  s.executor.release!();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.service.read(second.id).run.status, 'unknown');
  const pending = await s.service.prepare(s.input());
  const backup = path.join(s.f.root, 'backup.sqlite');
  s.store.backup(backup);
  const copy = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(
      copy.prepare('SELECT status FROM analysis_runs WHERE id=?').get(pending.id)?.status,
      'cancelled',
    );
  } finally {
    copy.close();
  }
});

test('two SQLite/HTTP owners claim one Codex dispatch and cannot fork a stale conversation', async (t) => {
  const s = await setup(t);
  const peer = new Store(s.file);
  const peerHistory = new History(peer, new Projects(peer).decisions);
  const peerService = new CodexAnalysis(
    peer,
    peerHistory,
    new PeriodAnalysis(peer, peerHistory, { key: '', model: '' }),
    s.executor,
  );
  try {
    s.executor.mode = 'wait';
    const pending = await s.service.prepare(s.input());
    await Promise.all([
      s.service.start(pending.id, { packetHash: pending.packetHash, consent: true }),
      peerService.start(pending.id, { packetHash: pending.packetHash, consent: true }),
    ]);
    while (!s.executor.prompts.length) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.executor.prompts.length, 1);
    s.executor.release!();
    while (s.service.read(pending.id).run.status === 'running')
      await new Promise((r) => setTimeout(r, 5));
    const followup = { ...s.input(), parentRunId: pending.id, selection: pending.selection };
    await s.service.prepare(followup);
    await assert.rejects(
      peerService.prepare({ ...followup, requestKey: randomUUID() }),
      /Обсуждение уже изменилось/,
    );
  } finally {
    await peerService.stop();
    peer.close();
  }
});

test('loopback HTTP dispatch enforces consent, packet identity and provider ownership', async (t) => {
  const s = await setup(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = createApp(s.store, address.port, undefined, s.analyses, undefined, s.service);
  server.on('request', runtime.app);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const call = (url: string, body: unknown, extra = {}) =>
      fetch(base + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1', ...extra },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await call('/api/codex-analysis/prepare', { ...s.input(), readConsent: false })).status,
      400,
    );
    assert.equal(
      (await call('/api/codex-analysis/prepare', s.input(), { Origin: 'https://example.com' }))
        .status,
      403,
    );
    const response = await call('/api/codex-analysis/prepare', s.input());
    assert.equal(response.status, 201);
    const run = await response.json();
    assert.equal(
      (
        await call(`/api/codex-analysis/${run.id}/start`, {
          packetHash: '0'.repeat(64),
          consent: true,
        })
      ).status,
      409,
    );
    assert.equal(s.executor.prompts.length, 0);
    assert.equal(
      (
        await call(`/api/period-analysis/${run.id}/run`, {
          packetHash: run.packetHash,
          consent: true,
        })
      ).status,
      403,
    );
    const [first, repeat] = await Promise.all([
      call(`/api/codex-analysis/${run.id}/start`, { packetHash: run.packetHash, consent: true }),
      call(`/api/codex-analysis/${run.id}/start`, { packetHash: run.packetHash, consent: true }),
    ]);
    assert.equal(first.status, 202);
    assert.equal(repeat.status, 202);
    assert.equal((await settled(s.service, run.id)).status, 'succeeded');
    assert.equal(s.executor.prompts.length, 1);
    const saved = await (await fetch(`${base}/api/codex-analysis/${run.id}`)).json();
    assert.equal(saved.run.report.proposals.length, 1);
    assert.equal(new Tasks(s.store).list().length, 0);
    const approval = {
      kind: 'task',
      projectId: s.project.id,
      title: 'Выбранная владельцем проверка',
      description: 'Один проход',
      reason: 'Проверить полезный результат',
      uncertainty: 'Результат неизвестен',
      cheapCheck: 'Один пример',
      consent: true,
    };
    assert.equal(
      (
        await call(`/api/period-analysis/${run.id}/proposals/0/accept`, {
          ...approval,
          consent: false,
        })
      ).status,
      400,
    );
    assert.equal(new Tasks(s.store).list().length, 0);
    const accepted = await call(`/api/period-analysis/${run.id}/proposals/0/accept`, approval);
    assert.equal(accepted.status, 201);
    const acceptance = await accepted.json();
    assert.equal(acceptance.original.origin, 'codex_runtime');
    const same = await (
      await call(`/api/period-analysis/${run.id}/proposals/0/accept`, approval)
    ).json();
    assert.equal(same.id, acceptance.id);
    assert.equal(new Tasks(s.store).list().length, 1);
  } finally {
    await runtime.codexAnalysis.stop();
    await runtime.codex.stop();
    await runtime.periodAnalysis.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('two database owners share a two-execution limit rather than only a local in-memory cap', async (t) => {
  const s = await setup(t);
  const peer = new Store(s.file),
    history = new History(peer, new Projects(peer).decisions);
  const service = new CodexAnalysis(
    peer,
    history,
    new PeriodAnalysis(peer, history, { key: '', model: '' }),
    s.executor,
  );
  try {
    s.executor.mode = 'wait';
    const first = await s.service.prepare(s.input()),
      second = await service.prepare(s.input()),
      third = await service.prepare(s.input());
    await s.service.start(first.id, { packetHash: first.packetHash, consent: true });
    await service.start(second.id, { packetHash: second.packetHash, consent: true });
    await assert.rejects(
      service.start(third.id, { packetHash: third.packetHash, consent: true }),
      /два анализа/,
    );
    assert.equal(service.read(third.id).run.status, 'pending');
  } finally {
    await service.stop();
    peer.close();
  }
});
