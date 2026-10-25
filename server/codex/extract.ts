import type { CodexPreview } from '../../shared/codex-context.js';

function clip(text: string, bytes: number) {
  let result = '',
    size = 0;
  for (const char of text) {
    size += Buffer.byteLength(char);
    if (size > bytes) break;
    result += char;
  }
  return result;
}
// Keep the beginning and the conclusion; an explicit gap never pretends continuity.
export function clipExcerpt(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text;
  const gap = ' [… сокращено …] ';
  const half = Math.floor((bytes - Buffer.byteLength(gap)) / 2);
  const tail = [...clip([...text].reverse().join(''), half)].reverse().join('');
  return clip(text, half) + gap + tail;
}
// This is a bounded extract, not an AI summary or a claim that work was done.
export function extractContext(preview: CodexPreview) {
  const seen = new Set<string>();
  const candidates = [...preview.excerpts]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((item) => {
      const normalized = item.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      if (
        !normalized ||
        /^(коммить|пуш|продолжай|согласен|давай дальше)[.!]?$/i.test(normalized) ||
        seen.has(normalized) ||
        /<environment_context>|# AGENTS\.md|^<in-app-browser-context>/i.test(normalized)
      )
        return false;
      seen.add(normalized);
      return true;
    });
  const users = candidates.filter((item) => item.role === 'user').slice(0, 2);
  if (!users.length) return null;
  const assistant = candidates
    .filter(
      (item) =>
        item.role === 'assistant' &&
        item.turnStatus === 'completed' &&
        item.turnId === users[0].turnId,
    )
    .slice(-1);
  const excerpts = [...users, ...assistant]
    .sort(
      (a, b) =>
        a.at.localeCompare(b.at) || Number(a.role === 'assistant') - Number(b.role === 'assistant'),
    )
    .map((item) => {
      const text = clipExcerpt(item.text, 500);
      return { ...item, text, partial: item.partial || text !== item.text };
    });
  return {
    summary:
      'Автоматическая выборка: два последних содержательных сообщения пользователя и ответ на последнее из них, если он завершён. Порядок хронологический; поздняя поправка может отменять раннее предложение. Это выдержки, не смысловой итог: выполнение работы и окончательность решений не подтверждены. Выборка неполная, без команд и вывода инструментов.',
    excerpts,
  };
}
