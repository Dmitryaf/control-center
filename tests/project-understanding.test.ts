import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Reviews } from '../server/reviews.js';
import { Observations } from '../server/observations.js';
import { History } from '../server/history.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';
import { buildPeriodContext, verifyContextGuards } from '../server/analysis/period-context.js';
import { periodSelectionSchema } from '../shared/period-analysis.js';

test('project understanding uses explicit bounded background for every selected project, not future, general or unselected records', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const roots = await Promise.all(['play', 'research', 'excluded'].map((name) => f.repo(name)));
  store.saveSettings({ ...defaultSettings, roots, timezone: 'UTC', autoRefreshMinutes: 0 });
  const projects = new Projects(store);
  await projects.scan();
  const ids = roots.map((root) => projects.list().find((p) => p.path === root)!.id);
  const reviews = new Reviews(store),
    notes = new Observations(store);
  for (const [index, id] of ids.entries()) {
    store.saveMetadata(
      id,
      metadataSchema.parse({
        name: `Project ${index}`,
        type: 'experiment',
        goal: index === 0 ? 'Игра с понятным выбором в бою' : 'Исследование сравнимых результатов',
        current_focus: `Focus ${index}`,
        status: 'active',
      }),
      'PRIVATE_NOTES',
    );
    for (const day of ['2024-02-01', '2024-02-08', '2024-02-15', '2024-02-22']) {
      const prior = reviews.create({ projectId: id, kind: 'week', anchorDate: day });
      reviews.patch(prior.id, { revision: prior.revision, userText: `Prior ${index} ${day}` });
    }
    for (let day = 1; day <= 7; day++)
      notes.create({
        projectId: id,
        occurredOn: `2024-02-0${day}`,
        body: `Background ${index} ${day}`,
      });
    notes.create({ projectId: id, occurredOn: '2024-03-06', body: `This period ${index}` });
    notes.create({ projectId: id, occurredOn: '2024-03-20', body: 'FUTURE_CANARY' });
  }
  const mixed = reviews.create({ kind: 'week', anchorDate: '2024-02-15' });
  reviews.patch(mixed.id, { revision: mixed.revision, userText: 'UNSELECTED_GENERAL_CANARY' });
  const review = reviews.create({ kind: 'week', anchorDate: '2024-03-06' });
  const history = new History(store, projects.decisions);
  const selection = periodSelectionSchema.parse({
    projectIds: ids.slice(0, 2),
    includeGeneral: false,
    sourceKinds: ['observation'],
    includeMetadata: true,
    includeOpenTasks: false,
    includeUserText: false,
    includeRelatedReviews: false,
    includeProjectHistory: true,
  });
  const now = Date.parse('2024-03-11T12:00:00Z');
  const { payload, guards } = buildPeriodContext(store, history, review, selection, now);
  assert.deepEqual(payload.scope.projectIds, ids.slice(0, 2));
  for (const [index, id] of ids.slice(0, 2).entries()) {
    assert.match(
      payload.sources.find((s) => s.id === `project:${id}`)!.text,
      new RegExp(`Focus ${index}`),
    );
    const background = payload.sources.filter(
      (s) => s.projectId === id && s.dateQuality === 'background',
    );
    assert.equal(background.length, 8);
    assert.equal(background.filter((s) => s.kind === 'review_text').length, 3);
    assert.ok(background.every((s) => s.day! < payload.period.from));
    assert.match(JSON.stringify(payload), new RegExp(`This period ${index}`));
  }
  assert.doesNotMatch(
    JSON.stringify(payload),
    /PRIVATE_NOTES|FUTURE_CANARY|UNSELECTED_GENERAL|Prior 2|Background 2|busy-week/,
  );
  const off = buildPeriodContext(
    store,
    history,
    review,
    { ...selection, includeProjectHistory: false },
    now,
  );
  assert.ok(off.payload.sources.every((s) => s.dateQuality !== 'background'));
  verifyContextGuards(store, guards, history);
  const old = payload.sources.find(
    (s) => s.dateQuality === 'background' && s.kind === 'review_text',
  )!;
  const saved = reviews.read(old.id.slice(7));
  reviews.patch(saved.id, { revision: saved.revision, userText: 'Changed premise' });
  assert.throws(() => verifyContextGuards(store, guards, history), /Источник изменён/);

  let sent = '';
  const service = new PeriodAnalysis(
    store,
    history,
    { key: 'fixture', model: 'fixture' },
    async (_url, init) => {
      sent = String(init?.body);
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  narrative: 'Synthetic transport response',
                  findings: [],
                  uncertainties: [],
                  proposals: [],
                }),
              },
            ],
          },
        ],
      });
    },
    () => now,
  );
  const run = service.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    selection,
    readConsent: true,
  });
  await service.run(run.id, { packetHash: run.packetHash, consent: true });
  assert.match(sent, /scope.projectIds/);
  assert.match(sent, /предыстор/);
  assert.ok(ids.slice(0, 2).every((id) => sent.includes(id)));
  assert.ok(!sent.includes(ids[2]));
});
