import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { History } from '../server/history.js';
import { Tasks } from '../server/tasks.js';
import { Records } from '../server/records.js';
import { Reviews } from '../server/reviews.js';
import { Observations } from '../server/observations.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { buildPeriodContext, verifyContextGuards } from '../server/analysis/period-context.js';
import { metadataSchema } from '../shared/contracts.js';
import { coreSelection, emptySelection } from '../src/features/period-analysis/SourceSelection.js';
import { designFixture } from './e2e/design-fixture.js';

test('realistic monthly context preserves three project stories and makes volume limits explicit without dispatch', (t) => {
  const now = Date.parse('2024-03-20T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveSettings({ ...store.settings(), timezone: 'UTC' });
  const sample = designFixture().projects[0];
  const stories = [
    {
      name: 'Садовый дневник',
      goal: 'Помочь садоводу сравнивать полив и состояние растений, чтобы выбирать уход по наблюдениям.',
      result: 'Запись полива работает без сети; синхронизацию пока не проверяли.',
      observation:
        'Два участника записали полив, но забыли отметить состояние листьев. Добавили понятную подпись.',
      decision:
        'Сначала проверяем дневник на одном участке, потому что сравнение разных условий пока ненадёжно.',
    },
    {
      name: 'Тренажёр ритма',
      goal: 'Помочь начинающему музыканту удерживать ритм через короткие упражнения и обратную связь.',
      result: 'Упражнение сохраняет отклонение от ритма; эффект обучения ещё неизвестен.',
      observation:
        'Три участника поняли упражнение, но длинный урок не закончили. Проверяем короткие занятия.',
      decision:
        'Отложили новые инструменты: сначала проверим повторное прохождение короткого урока.',
    },
    {
      name: 'Карта прогулок',
      goal: 'Помочь жителям выбирать спокойные маршруты рядом с домом по собственным заметкам.',
      result: 'Сохранённый маршрут доступен без сети; безопасность прогулки не оценивалась.',
      observation:
        'Прогулка выявила закрытый проход. Теперь отдельно отмечаем дату проверки маршрута.',
      decision:
        'Отказались от рейтинга безопасности: нет достаточных данных. Показываем наблюдения и их дату.',
    },
  ];
  const ids = stories.map((story) => {
    const id = randomUUID();
    store.saveSnapshot(id, { ...sample.snapshot, path: `/synthetic/${id}` });
    store.saveMetadata(
      id,
      metadataSchema.parse({
        name: story.name,
        type: 'experiment',
        goal: story.goal,
        stage: 'prototype',
        current_focus: story.decision,
      }),
      'PRIVATE_NOTES_CANARY',
    );
    return id;
  });
  const excluded = randomUUID();
  store.saveSnapshot(excluded, { ...sample.snapshot, path: '/synthetic/excluded' });
  store.saveMetadata(
    excluded,
    metadataSchema.parse({ name: 'UNSELECTED_CANARY', goal: 'EXCLUDED_GOAL' }),
    '',
  );
  const tasks = new Tasks(store),
    notes = new Observations(store),
    records = new Records(store),
    reviews = new Reviews(store);
  for (const [index, id] of ids.entries()) {
    const story = stories[index];
    for (let n = 0; n < 10; n++)
      tasks.save({
        projectId: id,
        title: `Проверка ${n}: ${story.name}`,
        completedAt: '2024-03-20T12:00:00Z',
        result: { summary: story.result },
      });
    for (let n = 0; n < 8; n++)
      notes.create({
        projectId: id,
        occurredOn: `2024-03-${String(n + 1).padStart(2, '0')}`,
        body: `${story.observation} Наблюдение ${n + 1}; это ограниченная проверка, а не доказательство спроса.`,
      });
    for (let n = 0; n < 2; n++)
      records.save('decisions', {
        projectId: id,
        title: `Направление ${n + 1}`,
        date: '2024-03-12',
        decision: story.decision,
        reason: 'Сначала нужен сопоставимый пример результата.',
      });
    tasks.save({
      projectId: id,
      title: `Следующая проверка: ${story.name}`,
      description: story.goal,
    });
    for (const day of ['2024-02-19', '2024-03-04', '2024-03-11', '2024-03-18']) {
      const week = reviews.create({ projectId: id, kind: 'week', anchorDate: day });
      reviews.patch(week.id, {
        revision: week.revision,
        userText: `${story.result} ${story.observation} Следующий шаг: ${story.decision}`,
      });
    }
  }
  notes.create({ projectId: excluded, occurredOn: '2024-03-10', body: 'UNSELECTED_CANARY' });
  const month = reviews.create({ kind: 'month', anchorDate: '2024-03-20' });
  const review = reviews.patch(month.id, {
    revision: month.revision,
    userText:
      'Переключил время с карты на дневник: у дневника появились первые наблюдения. Во всех проектах сначала проверяю один полезный сценарий. Не хочу выдавать техническую готовность за спрос.',
  });
  const selection = coreSelection({ ...emptySelection(null), projectIds: ids });
  const history = new History(store, new Projects(store).decisions);
  let calls = 0;
  const owner = new PeriodAnalysis(
    store,
    history,
    { key: 'fixture', model: 'fixture' },
    async () => {
      calls++;
      throw new Error('No paid calls during context checks');
    },
    () => now,
  );
  const measure = () => {
    const started = performance.now();
    const result = buildPeriodContext(store, history, review, selection, now);
    const bytes = Buffer.byteLength(JSON.stringify(result.payload));
    console.log(
      JSON.stringify({
        scenario: 'three-project-month',
        sources: result.payload.sources.length,
        bytes,
        prepareMs: +(performance.now() - started).toFixed(2),
      }),
    );
    return result;
  };
  const baseline = measure();
  const json = JSON.stringify(baseline.payload);
  for (const story of stories)
    for (const field of ['goal', 'result', 'observation', 'decision'] as const)
      assert.ok(json.includes(story[field]), `Missing ${story.name}: ${field}`);
  assert.ok(json.includes(review.userText));
  assert.ok(
    json.includes('Сначала нужен сопоставимый пример результата.'),
    'A selected decision must include its separately saved reason',
  );
  assert.doesNotMatch(json, /UNSELECTED_CANARY|EXCLUDED_GOAL|PRIVATE_NOTES_CANARY/);
  assert.ok(baseline.payload.sources.some((s) => s.dateQuality === 'background'));
  const run = owner.prepare({
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection,
  });
  assert.equal(run.status, 'pending');
  assert.equal(calls, 0);
  const outcomes: string[] = [];
  for (let batch = 1; batch <= 5; batch++) {
    for (const id of ids)
      for (let n = 0; n < 10; n++)
        notes.create({
          projectId: id,
          occurredOn: '2024-03-21',
          body: `Дополнительная проверка ${batch}-${n}: ${'Проверили один пример, наблюдение пока не подтверждает общий спрос. '.repeat(5)}`,
        });
    try {
      measure();
      outcomes.push('ok');
    } catch (error) {
      assert.match((error as Error).message, /80 000|200 исходных/);
      outcomes.push((error as Error).message);
      console.log(
        JSON.stringify({
          scenario: 'three-project-month-growth',
          addedEvents: batch * 30,
          error: (error as Error).message,
        }),
      );
    }
  }
  assert.ok(outcomes.some((text) => text.includes('80 000')));
  assert.ok(outcomes.some((text) => text.includes('200 исходных')));
  assert.throws(
    () =>
      owner.prepare({
        reviewId: review.id,
        requestKey: randomUUID(),
        repeatConsent: true,
        readConsent: true,
        selection,
      }),
    /200 исходных/,
  );
  assert.equal(owner.list(review.id).items.length, 1, 'No partial packet was persisted');
  assert.equal(calls, 0);
  // A narrower scope is an explicit, usable fallback, not silent truncation.
  assert.doesNotThrow(() =>
    buildPeriodContext(
      store,
      history,
      review,
      { ...selection, projectIds: [ids[0]], includeRelatedReviews: false },
      now,
    ),
  );
});

test('empty current review text is not a source, remains guarded, and nonempty project/general text is opt-in', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const id = randomUUID(),
    sample = designFixture().projects[0];
  store.saveSnapshot(id, { ...sample.snapshot, path: '/synthetic/review' });
  const history = new History(store, new Projects(store).decisions),
    reviews = new Reviews(store);
  for (const projectId of [null, id]) {
    const review = reviews.create({ projectId, kind: 'month', anchorDate: '2024-03-20' });
    const selection = coreSelection({ ...emptySelection(projectId), projectIds: [id] });
    const before = buildPeriodContext(store, history, review, selection, Date.now());
    assert.ok(!before.payload.sources.some((s) => s.id === `review:${review.id}`));
    const updated = reviews.patch(review.id, {
      revision: review.revision,
      userText: 'Моё объяснение смены направления',
    });
    assert.throws(() => verifyContextGuards(store, before.guards, history), /Источник изменён/);
    const included = buildPeriodContext(store, history, updated, selection, Date.now());
    assert.equal(
      included.payload.sources.find((s) => s.id === `review:${review.id}`)?.text,
      updated.userText,
    );
    const excluded = buildPeriodContext(
      store,
      history,
      updated,
      { ...selection, includeUserText: false },
      Date.now(),
    );
    assert.ok(!excluded.payload.sources.some((s) => s.id === `review:${review.id}`));
  }
});
