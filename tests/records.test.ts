import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { Records } from '../server/records.js';
import type { Task, Idea, Decision } from '../shared/contracts.js';

test('task creation, movement, completion, restore, edit and deletion', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = new Records(store);
  const task = records.save('tasks', { title: 'First' }) as Task;
  assert.equal(task.state, 'next');
  assert.equal(task.projectId, null);
  const moved = records.save(
    'tasks',
    { ...task, state: 'now', description: 'Details' },
    task.id,
    true,
  ) as Task;
  assert.equal(moved.createdAt, task.createdAt);
  assert.equal(moved.state, 'now');
  const done = records.save(
    'tasks',
    { ...moved, completedAt: new Date().toISOString() },
    task.id,
    true,
  ) as Task;
  assert.ok(done.completedAt);
  assert.equal(
    (records.save('tasks', { ...done, completedAt: null }, task.id, true) as Task).completedAt,
    null,
  );
  assert.throws(() => records.save('tasks', { title: 'Bad', state: 'invalid' }));
  assert.throws(
    () => records.save('tasks', { title: 'Bad', projectId: randomUUID() }),
    /не найден/,
  );
  records.delete('tasks', task.id);
  assert.equal(records.list('tasks').length, 0);
  assert.throws(() => records.save('tasks', task, task.id, true), /не найдена/);
});

test('ideas and decisions preserve reasons, statuses and isolate record kinds', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = new Records(store);
  const idea = records.save('ideas', { title: 'Try', description: 'hypothesis' }) as Idea;
  assert.equal(idea.state, 'new');
  assert.equal(
    (records.save('ideas', { ...idea, state: 'testing' }, idea.id, true) as Idea).state,
    'testing',
  );
  const decision = records.save('decisions', {
    title: 'Local data',
    decision: 'SQLite',
    reason: 'No server',
    context: 'Personal tool',
    date: '2026-10-04',
  }) as Decision;
  assert.equal(decision.reason, 'No server');
  assert.equal(
    (
      records.save(
        'decisions',
        { ...decision, status: 'superseded' },
        decision.id,
        true,
      ) as Decision
    ).status,
    'superseded',
  );
  assert.throws(() => records.save('decisions', { ...decision, decision: '' }));
  assert.throws(() => records.save('decisions', decision, idea.id, true), /не найдена/);
  records.delete('ideas', idea.id);
  records.delete('decisions', decision.id);
  assert.equal(records.list('ideas').length + records.list('decisions').length, 0);
});
