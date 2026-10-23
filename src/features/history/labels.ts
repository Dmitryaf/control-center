import type { HistoryEvent } from '../../../shared/history';

export const historyEventLabels: Record<HistoryEvent, string> = {
  task_baseline: 'Запись при переходе',
  task_result: 'Результат сохранён',
  task_completed: 'Задача завершена',
  task_reopened: 'Возвращена в работу',
  check_started: 'Проверка начата',
  check_completed: 'Проверка завершена',
  check_action: 'Внешнее действие',
  check_evidence: 'Свидетельство',
  decision: 'Локальное решение',
  file_decision: 'Решение из файла',
  observation: 'Наблюдение',
  review: 'Обзор периода',
  ai_analysis: 'Сохранённый AI-анализ',
};
