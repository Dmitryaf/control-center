import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Tasks } from '../server/tasks.js';
import { Reviews } from '../server/reviews.js';
import { History } from '../server/history.js';
import { buildPeriodContext } from '../server/analysis/period-context.js';
import { coreSelection, emptySelection } from '../src/features/period-analysis/SourceSelection.js';

test('structured source privacy accepts paragraphs but rejects real and JSON-escaped paths and keys', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('paragraphs');
  store.saveSettings({ ...store.settings(), roots: [repo], timezone: 'UTC' });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  const review = new Reviews(store).create({
    projectId: project.id,
    kind: 'week',
    anchorDate: '2024-03-12',
  });
  const history = new History(store, projects.decisions);
  const build = () =>
    buildPeriodContext(
      store,
      history,
      review,
      coreSelection(emptySelection(project.id)),
      Date.now(),
    );
  const setGoal = (goal: string) =>
    store.saveMetadata(project.id, { ...project.metadata, goal }, '');
  setGoal('First paragraph\n\nSecond paragraph');
  assert.doesNotThrow(build);
  for (const goal of [
    'C:\\private\\notes',
    '\\\\server\\share\\private',
    '/home/owner/private',
    'sk-fixture-secret-123456789',
    JSON.stringify({ path: 'C:\\private\\notes' }),
    '{"path":"\\u0043:\\u005cprivate"}',
  ]) {
    setGoal(goal);
    assert.throws(build, /секрет|путь/);
  }
});

test('background contains five latest immutable completions before the period, scoped and opt-in', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  await f.repo('selected');
  await f.repo('unselected');
  store.saveSettings({ ...store.settings(), roots: [f.root], timezone: 'America/New_York' });
  const projects = new Projects(store);
  await projects.scan();
  const selected = projects.list().find((p) => p.metadata.name === 'selected')!;
  const other = projects.list().find((p) => p.id !== selected.id)!;
  const tasks = new Tasks(store);
  for (let i = 1; i <= 7; i++) {
    const task = tasks.save({
      title: `Done ${i}`,
      projectId: selected.id,
      completedAt: `2024-03-0${i}T12:00:00Z`,
      result: { summary: `Saved result ${i}` },
    });
    store.db
      .prepare('UPDATE task_history SET recorded_at=? WHERE task_id=?')
      .run(`2024-03-0${i}T12:00:00Z`, task.id);
    if (i === 7) tasks.patch(task.id, task.revision, { title: 'Later mutable title' });
  }
  const foreign = tasks.save({
    title: 'Foreign completion',
    projectId: other.id,
    completedAt: '2024-03-07T12:00:00Z',
    result: { summary: 'FOREIGN' },
  });
  store.db
    .prepare('UPDATE task_history SET recorded_at=? WHERE task_id=?')
    .run('2024-03-07T12:00:00Z', foreign.id);
  // At 00:30 UTC this is still Sunday in the review timezone, so it belongs to background.
  const boundary = tasks.save({
    title: 'Timezone boundary',
    projectId: selected.id,
    completedAt: '2024-03-11T00:30:00Z',
    result: { summary: 'Sunday result' },
  });
  store.db
    .prepare('UPDATE task_history SET recorded_at=? WHERE task_id=?')
    .run('2024-03-11T00:30:00Z', boundary.id);
  const review = new Reviews(store).create({
    projectId: selected.id,
    kind: 'week',
    anchorDate: '2024-03-12',
  });
  const selection = coreSelection(emptySelection(selected.id));
  const history = new History(store, projects.decisions);
  const build = (enabled: boolean) =>
    buildPeriodContext(
      store,
      history,
      review,
      { ...selection, includeProjectHistory: enabled },
      Date.parse('2024-03-13T12:00:00Z'),
    ).payload;
  const sources = build(true).sources.filter(
    (s) => s.kind === 'task' && s.dateQuality === 'background',
  );
  assert.equal(sources.length, 5);
  assert.equal(sources[0].day, '2024-03-10');
  assert.ok(sources.some((s) => s.text === 'Saved result 7' && s.title.includes('Done 7')));
  assert.ok(!JSON.stringify(sources).includes('Later mutable title'));
  assert.ok(!JSON.stringify(sources).includes('FOREIGN'));
  assert.ok(!JSON.stringify(sources).includes('Saved result 1'));
  assert.equal(build(false).sources.filter((s) => s.dateQuality === 'background').length, 0);
  const october = new Reviews(store).create({
    projectId: selected.id,
    kind: 'month',
    anchorDate: '2024-02-15',
  });
  assert.equal(
    buildPeriodContext(
      store,
      history,
      october,
      selection,
      Date.parse('2024-03-13T12:00:00Z'),
    ).payload.sources.filter((s) => s.kind === 'task').length,
    0,
  );
});
