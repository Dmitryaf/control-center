export function calendarDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function daysBetween(from: string, to: string): number {
  const day = (value: string) => (value.length === 10 ? value : calendarDate(new Date(value)));
  return Math.max(0, Math.floor((Date.parse(day(to)) - Date.parse(day(from))) / 86400000));
}
