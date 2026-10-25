import test from 'node:test';
import assert from 'node:assert/strict';
import { clipExcerpt, extractContext } from '../server/codex/extract.js';
import type { CodexPreview, CodexExcerpt } from '../shared/codex-context.js';

function preview(turns: [string, string, string?][]): CodexPreview {
  return {
    id: 'preview',
    reviewId: 'review',
    projectId: 'project',
    thread: { id: 'thread', name: 'Synthetic discussion', updatedAt: 1 },
    expiresAt: '',
    sourceHash: '',
    limitations: [],
    excerpts: turns
      .flatMap(([user, assistant, status], n): CodexExcerpt[] => [
        {
          id: `${n}:u`,
          turnId: `${n}`,
          itemId: 'u',
          role: 'user',
          at: `2024-03-0${n + 1}T12:00:00Z`,
          text: user,
          partial: false,
          timeBasis: 'turn_start',
          turnStatus: status ?? 'completed',
        },
        {
          id: `${n}:a`,
          turnId: `${n}`,
          itemId: 'a',
          role: 'assistant',
          at: `2024-03-0${n + 1}T12:00:00Z`,
          text: assistant,
          partial: false,
          timeBasis: 'turn_start',
          turnStatus: status ?? 'completed',
        },
      ])
      .reverse(),
  };
}

test('extract keeps a short reversal and its own reply instead of older keyword-rich ideas', () => {
  for (const [start, middle, final] of [
    [
      'Идея: общий чат для всех. Цель: больше совместной работы.',
      'Сначала сравним чат и личные записи.',
      'Нет. Только личные записи.',
    ],
    [
      'Goal: multiplayer game because competition seems interesting.',
      'Try a cooperative prototype first.',
      'Drop co-op. Test duels.',
    ],
    [
      'Решение: выбираем облако ради синхронизации.',
      'Проверили локальную версию, она закрывает задачу.',
      'Согласен, облако убираем.',
    ],
  ]) {
    const result = extractContext(
      preview([
        [start, 'Первоначальный вариант.'],
        [middle, 'Промежуточный вывод.'],
        [final, 'Поздний ответ на поправку.'],
      ]),
    )!;
    assert.deepEqual(
      result.excerpts.map((item) => item.text),
      [middle, final, 'Поздний ответ на поправку.'],
    );
    assert.match(result.summary, /не смысловой итог/);
    assert.equal(result.excerpts[1].turnId, result.excerpts[2].turnId);
  }
});

test('an interrupted answer is not substituted by an unrelated older response; clipping retains the conclusion', () => {
  const result = extractContext(
    preview([
      ['Обсудим идею.', 'Старая рекомендация.'],
      ['Это отменяем.', 'Незавершённый ответ.', 'interrupted'],
    ]),
  )!;
  assert.ok(result.excerpts.every((item) => item.role === 'user'));
  const text = `Начальный вопрос. ${'Длинное обсуждение. '.repeat(120)} Окончательно: решение отменено.`;
  const clipped = clipExcerpt(text, 500);
  assert.ok(Buffer.byteLength(clipped) <= 500);
  assert.ok(clipped.startsWith('Начальный вопрос.'));
  assert.ok(clipped.endsWith('Окончательно: решение отменено.'));
  assert.match(clipped, /сокращено/);
});
