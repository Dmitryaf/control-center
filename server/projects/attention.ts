import type { Metadata, Settings, Signal, Snapshot } from '../../shared/contracts.js';

export function attention(
  metadata: Metadata,
  snapshot: Snapshot,
  settings: Settings,
  now = Date.now(),
): Signal[] {
  const signals: Signal[] = [];
  const add = (code: string, message: string) => signals.push({ code, message });
  if (snapshot.git.error) add('git-error', snapshot.git.error);
  if (snapshot.yaml.error) add('yaml-error', snapshot.yaml.error);
  for (const error of snapshot.errors) add('read-error', error);
  if (snapshot.git.dirty) add('dirty', 'Есть незакоммиченные изменения');
  if (metadata.blocked_by.length) add('blocked', `Блокировки: ${metadata.blocked_by.join('; ')}`);
  if (metadata.status === 'active') {
    const last = snapshot.git.commits[0]?.date;
    if (last) {
      const days = Math.floor((now - Date.parse(last)) / 86400000);
      if (days >= settings.inactivityDays) add('inactive', `Нет новых commits ${days} дн.`);
    }
    if (!metadata.current_focus) add('focus', 'Не определён текущий фокус');
    if (!metadata.next.length) add('next', 'Не определён следующий шаг');
    if (!metadata.last_reviewed) add('review', 'Метаданные ещё не пересматривались');
    else if ((now - Date.parse(metadata.last_reviewed)) / 86400000 >= settings.reviewDays)
      add('review', 'Пора пересмотреть метаданные');
  }
  return signals;
}
