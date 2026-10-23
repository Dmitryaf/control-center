import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import type { EvaluationCase } from './period-evaluation-fixture.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Reviews } from '../server/reviews.js';
import { Observations } from '../server/observations.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { defaultSettings, metadataSchema } from '../shared/contracts.js';

// Shared input producer for tests and the offline evaluation command.
export async function evaluationPacket(example: EvaluationCase) {
  const f = await fixture();
  const store = new Store(':memory:');
  const cleanup = async () => {
    store.close();
    await f.cleanup();
  };
  try {
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
    return { run, ids, calls: () => calls, cleanup };
  } catch (cause) {
    await cleanup();
    throw cause;
  }
}
