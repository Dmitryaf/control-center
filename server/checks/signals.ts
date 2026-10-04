import type { Check, CheckEntry, CheckView } from '../../shared/checks.js';
import type { Settings, Snapshot, Signal } from '../../shared/contracts.js';
import { calendarDate, daysBetween } from '../../shared/time.js';

export function checkView(
  check: Check,
  entries: CheckEntry[],
  settings: Settings,
  snapshot?: Snapshot,
  today = calendarDate(),
): CheckView {
  const latest = (kind: CheckEntry['kind']) =>
    entries
      .filter((e) => e.checkId === check.id && e.kind === kind)
      .map((e) => e.occurredAt)
      .sort()
      .at(-1) ?? null;
  const lastExternalActionAt = latest('action');
  const lastEvidenceAt = latest('evidence');
  const end = check.completedAt ?? today;
  const daysWithoutMovement = daysBetween(lastExternalActionAt ?? check.startedAt, end);
  const signals: Signal[] = [];
  if (check.status === 'active') {
    if (daysWithoutMovement >= settings.movementDecisionDays)
      signals.push({
        code: 'movement',
        level: 'decision',
        message: `${daysWithoutMovement} дн. без внешнего движения. Пора решить: продолжить, изменить или остановить проверку.`,
      });
    else if (daysWithoutMovement >= settings.movementAttentionDays)
      signals.push({
        code: 'movement',
        level: 'attention',
        message: `${daysWithoutMovement} дн. не было внешнего движения`,
      });
    else if (daysWithoutMovement >= settings.movementInfoDays)
      signals.push({
        code: 'movement',
        level: 'info',
        message: `Давно не было внешнего шага: ${daysWithoutMovement} дн.`,
      });
    if (check.reviewAt && check.reviewAt <= today)
      signals.push({
        code: 'review',
        level: 'decision',
        message: `Наступила дата пересмотра: ${check.reviewAt}`,
      });
    if (
      daysWithoutMovement >= settings.movementAttentionDays &&
      snapshot?.git.commits.some(
        (c) => calendarDate(new Date(c.date)) <= today && daysBetween(c.date, today) <= 7,
      )
    ) {
      signals.push({
        code: 'internal-only',
        level: 'attention',
        message: `Проект активно меняется, но ${daysWithoutMovement} дн. не было внешней проверки.`,
      });
    }
  }
  return {
    ...check,
    lastExternalActionAt,
    lastEvidenceAt,
    daysWithoutMovement,
    daysActive: daysBetween(check.startedAt, end),
    signals,
  };
}
