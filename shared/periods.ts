import { z } from 'zod';
import { TZDateMini } from '@date-fns/tz';
import { addDays, addMonths, startOfWeek, startOfMonth } from 'date-fns';
import { calendarDate } from './time.js';

export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    if (/^[+-]/.test(zone)) return false;
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Укажите существующий часовой пояс IANA, например Asia/Yekaterinburg.');
export const periodKindSchema = z.enum(['week', 'month']);
export type PeriodKind = z.infer<typeof periodKindSchema>;
// Years before 1900 and beyond 9998 are outside this app's review calendar.
export const periodDateSchema = z
  .string()
  .date()
  .refine((day) => day >= '1900-01-01' && day <= '9998-12-31');
export function dateInZone(now: Date, timezone: string): string {
  return calendarDate(new TZDateMini(now.getTime(), timezone));
}
export function periodBounds(kind: PeriodKind, anchorDate: string, timezone: string) {
  periodDateSchema.parse(anchorDate);
  timezoneSchema.parse(timezone);
  const [year, month, day] = anchorDate.split('-').map(Number);
  const anchor = new TZDateMini(year, month - 1, day, timezone);
  const start = kind === 'week' ? startOfWeek(anchor, { weekStartsOn: 1 }) : startOfMonth(anchor);
  const next = kind === 'week' ? addDays(start, 7) : addMonths(start, 1);
  return {
    periodStart: calendarDate(start),
    periodEnd: calendarDate(addDays(next, -1)),
    timezone,
    startAt: new Date(start.getTime()).toISOString(),
    nextStartAt: new Date(next.getTime()).toISOString(),
  };
}
