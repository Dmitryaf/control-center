import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { evaluationCases } from './period-evaluation-fixture.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { Observations } from '../server/observations.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';

// These tests establish what reaches the model, not the quality of an answer.
// No recorded or generated "ideal answer" is substituted for a live evaluation.
for (const example of evaluationCases) {
  test(`evaluation packet: ${example.id} preserves facts, scope and uncertainty without dispatch`, async (t) => {
    const f = await fixture();
    const store = new Store(':memory:');
    t.after(async () => {
      store.close();
      await f.cleanup();
    });
    const roots = await Promise.all(
      [...example.projects.map((p) => p.name), 'Unselected canary'].map((_, i) =>
        f.repo(`project-${i}`),
      ),
    );
    store.saveSettings({ ...defaultSettings, roots, timezone: 'UTC', autoRefreshMinutes: 0 });
    const projects = new Projects(store);
    await projects.scan();
    const notes = new Observations(store);
    const ids: string[] = [];
    for (let i = 0; i < example.projects.length; i++) {
      const input = example.projects[i];
      const project = projects.list().find((p) => p.path === roots[i])!;
      ids.push(project.id);
      store.saveMetadata(
        project.id,
        metadataSchema.parse({
          ...project.metadata,
          name: input.name,
          status: input.status,
          stage: input.stage,
        }),
        'UNSELECTED_PRIVATE_NOTE',
      );
      for (const body of input.notes)
        notes.create({ projectId: project.id, occurredOn: '2024-03-10', body });
      notes.create({
        projectId: project.id,
        occurredOn: '2024-03-11',
        body: 'OUTSIDE_PERIOD_CANARY',
      });
    }
    const excluded = projects.list().find((p) => p.path === roots.at(-1))!;
    notes.create({
      projectId: excluded.id,
      occurredOn: '2024-03-10',
      body: 'UNSELECTED_PROJECT_CANARY',
    });
    const review = new Reviews(store).create({
      projectId: ids.length === 1 ? ids[0] : null,
      kind: 'week',
      anchorDate: '2024-03-10',
    });
    let calls = 0;
    const analysis = new PeriodAnalysis(
      store,
      new History(store, projects.decisions),
      { key: 'fixture', model: 'not-a-live-model' },
      async () => {
        calls++;
        throw new Error('Packet evaluation must never dispatch');
      },
      () => Date.parse('2024-03-11T12:00:00Z'),
    );
    const run = analysis.prepare({
      reviewId: review.id,
      requestKey: randomUUID(),
      readConsent: true,
      selection: {
        projectIds: ids,
        includeGeneral: false,
        sourceKinds: ['observation'],
        includeMetadata: true,
        includeOpenTasks: false,
        includeUserText: false,
        includeRelatedReviews: false,
      },
    });
    const observations = run.payload.sources.filter((s) => s.kind === 'observation');
    assert.deepEqual(
      observations.map((s) => s.text).sort(),
      example.projects.flatMap((p) => p.notes).sort(),
    );
    for (const source of run.payload.sources)
      assert.ok(source.projectId && ids.includes(source.projectId));
    const packet = JSON.stringify(run.payload);
    for (const project of example.projects) {
      assert.ok(packet.includes(project.name));
      assert.ok(packet.includes(project.stage));
      assert.ok(packet.includes(project.status));
    }
    assert.doesNotMatch(
      packet,
      /OUTSIDE_PERIOD_CANARY|UNSELECTED_PROJECT_CANARY|UNSELECTED_PRIVATE_NOTE/,
    );
    // Evaluator expectations must not become leading instructions in input.
    assert.ok(!packet.includes(example.recognize));
    assert.ok(!packet.includes(example.avoid));
    assert.equal(run.payload.period.incomplete, false);
    assert.ok(run.payload.limitations.length > 0);
    assert.equal(run.status, 'pending');
    assert.equal(run.approvedAt, null);
    assert.equal(run.report, null);
    assert.equal(calls, 0);
  });
}
