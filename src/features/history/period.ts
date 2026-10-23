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
