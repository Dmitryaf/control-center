import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { Checks } from '../server/checks/checks.js';
import { Records } from '../server/records.js';
import { checkView } from '../server/checks/signals.js';
import { checkSchema, type Check, type CheckEntry } from '../shared/checks.js';
import { defaultSettings, settingsSchema, type Snapshot } from '../shared/contracts.js';
import { calendarDate, daysBetween } from '../shared/time.js';

export const checkInput = (extra = {}) =>
  checkSchema.parse({
    title: 'Test hypothesis',
    question: 'Will this help?',
    assumption: 'It saves time',
    expectedExternalResult: 'A person uses it',
    startedAt: '2020-01-01',
    continueIf: 'Used twice',
    stopIf: 'No need',
    nextExternalAction: 'Show prototype',
    ...extra,
  });

test('checks from ideas: several active checks, explicit duplicate confirmation, pause/resume and deletion detaches idea', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const checks = new Checks(store);
  const records = new Records(store);
  const idea = records.save('ideas', { title: 'Idea' });
  const one = checks.save(checkInput({ ideaId: idea.id }));
  assert.equal((records.list('ideas')[0] as { state: string }).state, 'testing');
  assert.throws(() => checks.save(checkInput({ ideaId: idea.id })), /активная/);
  const two = checks.save(checkInput({ ideaId: idea.id }), undefined, true);
  assert.equal(checks.list().length, 2);
  checks.save({ ...one, status: 'paused' }, one.id);
  assert.throws(() => checks.save({ ...one, status: 'active' }, one.id), /активная/);
  checks.save({ ...one, status: 'active' }, one.id, true);
  assert.throws(() => checks.save(checkInput({ startedAt: '2999-01-01' })), /будущем/);
  records.delete('ideas', idea.id);
  assert.equal(checks.require(one.id).ideaId, null);
  assert.equal(checks.require(two.id).ideaId, null);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('timeline CRUD derives latest dates and distinguishes evidence from action', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const checks = new Checks(store);
  const check = checks.save(checkInput());
  const action = checks.saveEntry(check.id, {
    kind: 'action',
    text: 'Contacted users',
    occurredAt: '2020-01-05',
  });
  const evidence = checks.saveEntry(check.id, {
    kind: 'evidence',
    text: 'Two replies',
    occurredAt: '2020-01-08',
    numericValue: 2,
    type: 'fact',
    url: 'https://example.invalid',
  });
  const newer = checks.saveEntry(check.id, {
    kind: 'action',
    text: 'Demo',
    occurredAt: '2020-01-09',
  });
  assert.equal(checks.views()[0].lastExternalActionAt, '2020-01-09');
  checks.saveEntry(check.id, { ...newer, occurredAt: '2020-01-03' }, newer.id);
  assert.equal(checks.views()[0].lastExternalActionAt, '2020-01-05');
  checks.deleteEntry(check.id, action.id);
  assert.equal(checks.views()[0].lastExternalActionAt, '2020-01-03');
  assert.equal(checks.views()[0].lastEvidenceAt, evidence.occurredAt);
  checks.deleteEntry(check.id, evidence.id);
  assert.equal(checks.views()[0].lastEvidenceAt, null);
  assert.throws(
    () => checks.saveEntry(check.id, { kind: 'action', text: 'Bad', occurredAt: '2019-01-01' }),
    /периода/,
  );
  assert.throws(() =>
    checks.saveEntry(check.id, {
      kind: 'evidence',
      text: 'Bad',
      occurredAt: '2020-01-01',
      url: 'javascript:alert(1)',
    }),
  );
  assert.throws(() => checks.save({ ...check, startedAt: '2020-01-10' }, check.id), /хронологии/);
  const other = checks.save(checkInput());
  assert.throws(() => checks.deleteEntry(other.id, newer.id), /не найдена/);
});

test('3/7/14 day thresholds, exact review date, paused/completed suppression and Git independence', () => {
  const check: Check = {
    ...checkInput(),
    id: 'check',
    status: 'active',
    conclusion: null,
    completedAt: null,
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2020-01-01T00:00:00Z',
  };
  for (const [day, level] of [
    [3, undefined],
    [4, 'info'],
    [7, 'info'],
    [8, 'attention'],
    [14, 'attention'],
    [15, 'decision'],
  ] as const) {
    assert.equal(
      checkView(check, [], defaultSettings, undefined, `2020-01-${String(day).padStart(2, '0')}`)
        .signals[0]?.level,
      level,
    );
  }
  const snapshot = {
    git: { commits: [{ date: '2020-01-14T00:00:00Z', hash: 'x', subject: 'Internal work' }] },
  } as Snapshot;
  const view = checkView(check, [], defaultSettings, snapshot, '2020-01-15');
  assert.equal(view.daysWithoutMovement, 14);
  assert.ok(view.signals.some((s) => s.code === 'internal-only'));
  const evidence = { checkId: check.id, kind: 'evidence', occurredAt: '2020-01-14' } as CheckEntry;
  assert.equal(
    checkView(check, [evidence], defaultSettings, snapshot, '2020-01-15').daysWithoutMovement,
    14,
  );
  const action = { ...evidence, kind: 'action' } as CheckEntry;
  assert.equal(
    checkView(check, [action], defaultSettings, snapshot, '2020-01-15').signals.length,
    0,
  );
  assert.equal(
    checkView({ ...check, status: 'paused' }, [], defaultSettings, snapshot, '2020-01-15').signals
      .length,
    0,
  );
  assert.ok(
    checkView(
      { ...check, reviewAt: '2020-01-02' },
      [],
      defaultSettings,
      undefined,
      '2020-01-02',
    ).signals.some((s) => s.code === 'review'),
  );
  assert.equal(
    checkView(
      { ...check, status: 'completed', completedAt: '2020-01-03' },
      [],
      defaultSettings,
      snapshot,
      '2020-01-15',
    ).daysActive,
    2,
  );
  assert.equal(daysBetween('2020-03-07', '2020-03-09'), 2);
  const localLate = new Date(2026, 9, 5, 23, 30);
  const localEarly = new Date(2026, 9, 5, 0, 30);
  assert.equal(daysBetween(localLate.toISOString(), calendarDate(localLate)), 0);
  assert.equal(daysBetween(localEarly.toISOString(), calendarDate(localEarly)), 0);
  assert.throws(() => settingsSchema.parse({ ...defaultSettings, movementDecisionDays: 2 }));
});

test('completion requires explicit result and basis, archives history and cannot be silently reopened', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const checks = new Checks(store);
  const check = checks.save(checkInput());
  checks.saveEntry(check.id, { kind: 'evidence', text: 'No interest', occurredAt: '2020-01-03' });
  assert.throws(() => checks.complete(check.id, { outcome: 'stop' }));
  const result = {
    actualResult: 'No one used it',
    whatWasConfirmedOrRejected: 'Need not confirmed',
    outcome: 'change',
    basis: 'Three interviews',
    nextQuestion: 'Another audience?',
    completedAt: '2020-01-04',
  };
  const done = checks.complete(check.id, result);
  assert.equal(done.status, 'completed');
  assert.equal(done.conclusion?.basis, result.basis);
  assert.equal(checks.views()[0].signals.length, 0);
  assert.throws(() => checks.save(checkInput(), check.id), /архиве/);
  assert.throws(() => checks.complete(check.id, result), /уже завершена/);
  assert.throws(
    () => checks.saveEntry(check.id, { kind: 'action', text: 'Late', occurredAt: '2020-01-05' }),
    /периода/,
  );
  assert.equal(checks.entries().length, 1);
});
