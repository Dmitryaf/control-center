export const statusLabels = {
  active: 'Активный',
  paused: 'Отложен',
  completed: 'Завершён',
  unknown: 'Не задан',
};
export const typeLabels = {
  product: 'Продукт',
  tool: 'Инструмент',
  experiment: 'Эксперимент',
  other: 'Другое',
};
export const priorityLabels = { high: 'Высокий', normal: 'Обычный', low: 'Низкий' };
export const taskLabels = { now: 'Сейчас', next: 'Следом', later: 'Позже' };
export const ideaLabels = {
  new: 'Новая',
  consider: 'Стоит проверить',
  testing: 'Проверяется',
  accepted: 'Принята',
  rejected: 'Отклонена',
};
export const decisionLabels = {
  pending: 'Ожидает решения',
  active: 'Действует',
  superseded: 'Заменено',
};
export const relationLabels = {
  uses: 'Использует',
  depends_on: 'Зависит от',
  related_to: 'Связан с',
  produces: 'Создаёт',
};
export function date(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(value.length === 10 ? `${value}T12:00:00` : value),
      )
    : 'Нет данных';
}
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function lines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
