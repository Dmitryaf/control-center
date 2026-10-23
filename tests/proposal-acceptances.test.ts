import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { readdir, rename } from 'node:fs/promises';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { Tasks } from '../server/tasks.js';
import { Records } from '../server/records.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { ProposalAcceptances } from '../server/analysis/acceptances.js';
import type { ProposalApproval } from '../shared/proposal-acceptances.js';

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const f = await fixture();
  const file = path.join(f.root, 'proposals.sqlite');
  const store = new Store(file);
  const others: Store[] = [];
  t.after(async () => {
    for (const other of others) other.close();
    store.close();
    await f.cleanup();
  });
  const reviews = new Reviews(store);
  let review = reviews.create({ projectId: null, kind: 'week', anchorDate: '2024-03-06' });
  review = reviews.patch(review.id, {
    revision: review.revision,
    userText: 'Оригинальное пользовательское наблюдение.',
  });
  const report = {
    narrative: 'Есть предположение.',
    findings: [],
    uncertainties: ['Нужна проверка.'],
    proposals: [
      {
        kind: 'idea',
        projectIds: [],
        title: 'Исходное AI название',
        description: 'Исходный текст AI',
        reason: 'Модель связала наблюдение с проверкой.',
        uncertainty: 'Нет свидетельства спроса.',
        cheapCheck: 'Один короткий разговор.',
        sources: [`review:${review.id}`],
      },
    ],
  };
  const analysis = new PeriodAnalysis(
    store,
    new History(store, new Projects(store).decisions),
    { key: 'fixture', model: 'fixture-model' },
    async () =>
      Response.json({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report) }] },
        ],
      }),
  );
  const prepared = analysis.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    selection: {
      projectIds: [],
      includeGeneral: true,
      sourceKinds: [],
      includeMetadata: false,
      includeOpenTasks: false,
      includeUserText: true,
      includeRelatedReviews: false,
    },
    readConsent: true,
  });
  const run = await analysis.run(prepared.id, { packetHash: prepared.packetHash, consent: true });
  assert.equal(run.status, 'succeeded');
  const approvals = new ProposalAcceptances(store, analysis);
  const input: ProposalApproval = {
    kind: 'task',
    projectId: null,
    title: 'Моя проверенная формулировка',
    description: 'Мой план',
    reason: 'Я уточнил основание.',
    uncertainty: 'Ответ пока неизвестен.',
    cheapCheck: 'Проверить один пример.',
    expectedResult: 'Понятный ответ',
    acceptance: 'Сохранить свидетельство',
    priority: 'normal',
    allowDuplicate: false,
    consent: true,
  };
  return { f, file, store, others, analysis, approvals, review, run, input };
}
test('human edits and frozen model evidence are separate; retry/restart never overwrite an edited or deleted task', async (t) => {
  const x = await setup(t);
  const before = x.analysis.read(x.run.id);
  assert.throws(() => x.approvals.accept(x.run.id, 0, { ...x.input, consent: false }));
  assert.throws(
    () => x.approvals.accept(x.run.id, 0, { ...x.input, projectId: randomUUID() }),
    /проект/,
  );
  const saved = x.approvals.accept(x.run.id, 0, x.input);
  assert.equal(saved.approved.title, x.input.title);
  assert.equal(saved.original.proposal.title, 'Исходное AI название');
  assert.equal(saved.original.sources[0].text, 'Оригинальное пользовательское наблюдение.');
  assert.deepEqual(x.analysis.read(x.run.id), before);
  const tasks = new Tasks(x.store);
  assert.equal(x.approvals.links()[saved.resultId], saved.id);
  const task = tasks.read(saved.resultId);
  assert.equal(task.state, 'next');
  assert.equal(task.expectedResult, x.input.expectedResult);
  assert.match(task.description, /Дешёвая проверка: Проверить один пример/);
  tasks.patch(task.id, task.revision, { title: 'Изменено после принятия' });
  const second = new Store(x.file);
  x.others.push(second);
  const other = new ProposalAcceptances(
    second,
    new PeriodAnalysis(second, new History(second, new Projects(second).decisions)),
  );
  assert.equal(other.accept(x.run.id, 0, x.input).id, saved.id);
  assert.equal(tasks.read(task.id).title, 'Изменено после принятия');
  new Records(x.store).delete('tasks', task.id);
  assert.equal(x.approvals.links()[saved.resultId], undefined);
  assert.equal(other.accept(x.run.id, 0, x.input).resultExists, false);
  assert.equal(tasks.list().length, 0);
});
test('one proposal cannot create both an idea and a task; deleting a run retains the accepted provenance', async (t) => {
  const x = await setup(t);
  const accepted = x.approvals.accept(x.run.id, 0, { ...x.input, kind: 'idea' });
  assert.equal(new Records(x.store).list('ideas').length, 1);
  assert.throws(() => x.approvals.accept(x.run.id, 0, x.input), /другой редакцией/);
  assert.throws(
    () => x.approvals.accept(x.run.id, 0, { ...x.input, kind: 'idea', reason: 'Другая редакция' }),
    /другой редакцией/,
  );
  assert.equal(new Tasks(x.store).list().length, 0);
  x.analysis.delete(x.run.id);
  const retained = x.approvals.read(accepted.id);
  assert.equal(retained.runId, null);
  assert.equal(retained.resultExists, true);
  assert.equal(retained.original.sources[0].text, 'Оригинальное пользовательское наблюдение.');
  assert.equal(x.approvals.forRun(x.run.id)[0].id, accepted.id);
  assert.equal(x.approvals.accept(x.run.id, 0, { ...x.input, kind: 'idea' }).id, accepted.id);
});
test('mapping write failures roll back task and idea creation; normal task invariants still reject duplicates', async (t) => {
  const x = await setup(t);
  const prepare = x.store.db.prepare;
  x.store.db.prepare = function (sql: string) {
    if (sql.startsWith('INSERT INTO analysis_acceptances'))
      throw new Error('injected mapping failure');
    return prepare.call(this, sql);
  };
  try {
    assert.throws(() => x.approvals.accept(x.run.id, 0, x.input), /injected/);
    assert.equal(new Tasks(x.store).list().length, 0);
    assert.throws(() => x.approvals.accept(x.run.id, 0, { ...x.input, kind: 'idea' }), /injected/);
    assert.equal(new Records(x.store).list('ideas').length, 0);
  } finally {
    x.store.db.prepare = prepare;
  }
  assert.deepEqual(x.approvals.forRun(x.run.id), []);
  const duplicate = new Tasks(x.store).save({ title: x.input.title });
  assert.throws(() => x.approvals.accept(x.run.id, 0, x.input), /Похожая задача/);
  assert.equal(x.approvals.forRun(x.run.id).length, 0);
  const saved = x.approvals.accept(x.run.id, 0, { ...x.input, allowDuplicate: true });
  assert.notEqual(saved.resultId, duplicate.id);
  assert.equal(new Tasks(x.store).list().length, 2);
  assert.equal(x.approvals.accept(x.run.id, 0, { ...x.input, allowDuplicate: true }).id, saved.id);
});
test('acceptance refuses missing sources, pending/failed variants and unknown proposal indexes', async (t) => {
  const x = await setup(t);
  assert.throws(() => x.approvals.accept(x.run.id, 7, x.input), /существующее/);
  assert.throws(() => x.approvals.accept(x.run.id, 100, x.input));
  x.store.db.prepare("UPDATE analysis_runs SET status='failed' WHERE id=?").run(x.run.id);
  assert.throws(() => x.approvals.accept(x.run.id, 0, x.input), /успешный/);
  x.store.db
    .prepare(
      "UPDATE analysis_runs SET status='succeeded',report_json=json_set(report_json,'$.proposals[0].sources[0]','foreign') WHERE id=?",
    )
    .run(x.run.id);
  assert.throws(() => x.approvals.accept(x.run.id, 0, x.input), /Основания/);
  assert.equal(new Tasks(x.store).list().length, 0);
});
test('schema 9 migration preserves runs, copies approval state safely and rolls back failed DDL', async (t) => {
  const x = await setup(t);
  const accepted = x.approvals.accept(x.run.id, 0, x.input);
  x.store.db.exec('DROP TABLE analysis_acceptances; PRAGMA user_version=9;');
  const upgraded = new Store(x.file);
  x.others.push(upgraded);
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 11);
  assert.ok(new Tasks(upgraded).read(accepted.resultId));
  assert.ok(upgraded.db.prepare('SELECT id FROM analysis_runs WHERE id=?').get(x.run.id));
  const name = (await readdir(path.join(x.f.root, 'backups'))).find((n) =>
    n.startsWith('before-proposals-v10'),
  );
  assert.ok(name);
  const backup = new DatabaseSync(path.join(x.f.root, 'backups', name), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 9);
  backup.close();
  const failed = path.join(x.f.root, 'failed.sqlite');
  const seed = new Store(failed);
  seed.db.exec('DROP TABLE analysis_acceptances; PRAGMA user_version=9;');
  seed.close();
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS analysis_acceptances'))
      throw new Error('injected v10 DDL failure');
    return exec.call(this, sql);
  };
  try {
    assert.throws(() => new Store(failed), /injected/);
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  const untouched = new DatabaseSync(failed);
  assert.equal(untouched.prepare('PRAGMA user_version').get()?.user_version, 9);
  assert.equal(
    untouched.prepare("SELECT name FROM sqlite_master WHERE name='analysis_acceptances'").get(),
    undefined,
  );
  untouched.close();
});

test('retained acceptance alone prevents rebind from overwriting a project after report and target deletion', async (t) => {
  const x = await setup(t);
  const oldPath = await x.f.repo('old');
  const targetPath = await x.f.repo('target');
  x.store.saveSettings({ ...x.store.settings(), roots: [x.f.root] });
  const projects = new Projects(x.store);
  await projects.scan();
  const old = projects.list().find((p) => p.path === oldPath)!;
  const target = projects.list().find((p) => p.path === targetPath)!;
  const reviews = new Reviews(x.store);
  let review = reviews.create({ projectId: target.id, kind: 'week', anchorDate: '2013-03-06' });
  review = reviews.patch(review.id, {
    revision: review.revision,
    userText: 'Текущее свидетельство',
  });
  const proposal = {
    ...x.run.report!.proposals[0],
    kind: 'improvement',
    projectIds: [target.id],
    sources: [`review:${review.id}`],
  };
  const service = new PeriodAnalysis(
    x.store,
    new History(x.store, projects.decisions),
    { key: 'fixture', model: 'fixture-model' },
    async () =>
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ ...x.run.report, proposals: [proposal] }),
              },
            ],
          },
        ],
      }),
  );
  const prepared = service.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    selection: { ...x.run.selection, includeGeneral: false, projectIds: [target.id] },
    readConsent: true,
  });
  const run = await service.run(prepared.id, { packetHash: prepared.packetHash, consent: true });
  assert.equal(run.status, 'succeeded');
  const saved = new ProposalAcceptances(x.store, service).accept(run.id, 0, {
    ...x.input,
    projectId: target.id,
  });
  service.delete(run.id);
  new Records(x.store).delete('tasks', saved.resultId);
  reviews.delete(review.id, { revision: review.revision });
  await rename(oldPath, path.join(x.f.root, 'moved-old'));
  await projects.scan();
  await assert.rejects(() => projects.rebind(old.id, target.id), /уже есть свои данные/);
  assert.equal(x.approvals.read(saved.id).resultExists, false);
});
