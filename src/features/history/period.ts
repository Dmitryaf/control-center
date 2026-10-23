import { dateInZone, periodBounds } from '../../../shared/periods';

export function zonedRange(period: string, timezone: string, now = new Date()) {
  if (!['week', 'previous_week', 'month', 'previous_month'].includes(period))
    return { from: '', to: '' };
  const kind = period.includes('week') ? 'week' : 'month';
  const today = dateInZone(now, timezone);
  let bounds = periodBounds(kind, today, timezone);
  if (period.startsWith('previous_')) {
    const previousDay = new Date(Date.parse(`${bounds.periodStart}T12:00:00Z`) - 86400000)
      .toISOString()
      .slice(0, 10);
    bounds = periodBounds(kind, previousDay, timezone);
    return { from: bounds.periodStart, to: bounds.periodEnd };
  }
  return { from: bounds.periodStart, to: today };
}

export function utcRange(period: string, now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(day);
  if (period === 'week' || period === 'previous_week') {
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    if (period === 'previous_week') {
      day.setUTCDate(day.getUTCDate() - 7);
      end.setTime(day.getTime());
      end.setUTCDate(end.getUTCDate() + 6);
    }
  } else if (period === 'month' || period === 'previous_month') {
    day.setUTCDate(1);
    if (period === 'previous_month') {
      end.setTime(day.getTime());
      end.setUTCDate(0);
      day.setUTCMonth(day.getUTCMonth() - 1);
    }
  } else return { from: '', to: '' };
  return { from: day.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
