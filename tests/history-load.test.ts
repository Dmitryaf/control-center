import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Observations } from '../server/observations.js';
import { Tasks } from '../server/tasks.js';
import { designFixture } from './e2e/design-fixture.js';

for (const count of [10, 20, 30]) {
  test(`latest project history matches individual reads at ${count} projects`, (t) => {
    const store = new Store(':memory:');
    t.after(() => store.close());
    const sample = designFixture().projects[0];
    const ids = Array.from({ length: count }, () => randomUUID());
    const tasks = new Tasks(store);
    const observations = new Observations(store);
    for (const id of ids) {
      store.saveSnapshot(id, { ...sample.snapshot, path: `/synthetic/${id}` });
      for (let n = 0; n < 80; n++)
        observations.create({
          projectId: id,
          occurredOn: '2024-03-06',
          body: `Observation ${n}: ${'context '.repeat(100)}`,
        });
      for (let n = 0; n < 20; n++)
        tasks.save({ projectId: id, title: `Work ${n}`, result: { summary: `Result ${n}` } });
    }
    const history = new History(store, new Projects(store).decisions);
    const individual = () =>
      ids.map(
        (projectId) =>
          history.list({ projectId, timezone: 'Asia/Yekaterinburg', limit: 1 }).items[0],
      );
    const aggregate = () => history.latestProjects({ timezone: 'Asia/Yekaterinburg' }).items;
    const expected = individual()
      .map((item) => item.key)
      .sort();
    assert.deepEqual(
      aggregate()
        .map((item) => item.key)
        .sort(),
      expected,
    );
    const measure = (read: () => unknown) => {
      const times = Array.from({ length: 7 }, () => {
        const start = performance.now();
        read();
        return performance.now() - start;
      }).sort((a, b) => a - b);
      return { medianMs: +times[3].toFixed(2), maxMs: +times[6].toFixed(2) };
    };
    console.log(
      JSON.stringify({
        projects: count,
        events: count * 100,
        individual: measure(individual),
        aggregate: measure(aggregate),
      }),
    );
    assert.throws(() => history.latestProjects({ projectId: ids[0] }));
    assert.equal(history.latestProjects().nextCursor, null);
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
  });
}
