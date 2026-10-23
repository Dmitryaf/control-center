import type { CodexExcerpt, CodexPreview } from '../../shared/codex-context.js';

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
// This is a bounded extract, not an AI summary or a claim that work was done.
export function extractContext(preview: CodexPreview) {
  const seen = new Set<string>();
  const candidates = [...preview.excerpts]
    .sort((a, b) => Number(b.role === 'user') - Number(a.role === 'user'))
    .filter((item) => {
      const normalized = item.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      if (
        normalized.length < 30 ||
        (/^(коммить|пуш|продолжай|согласен|давай дальше)/i.test(normalized) &&
          normalized.length < 100) ||
        seen.has(normalized) ||
        /<environment_context>|# AGENTS\.md|^<in-app-browser-context>/i.test(normalized)
      )
        return false;
      seen.add(normalized);
      return true;
    });
  const score = (item: CodexExcerpt) =>
    /цел[ьи]|иде[яию]|почему|причин|реш[еи]|вместо|отказ|направлен|гипотез|вопрос|goal|because|decid/i.test(
      item.text,
    )
      ? 1
      : 0;
  const users = candidates
    .filter((item) => item.role === 'user')
    .sort((a, b) => score(b) - score(a) || b.at.localeCompare(a.at))
    .slice(0, 2);
  if (!users.length) return null;
  const assistant = candidates
    .filter((item) => item.role === 'assistant' && item.turnStatus === 'completed')
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 1);
  const excerpts = [...users, ...assistant].map((item) => {
    const text = clip(item.text, 500);
    return { ...item, text, partial: item.partial || text !== item.text };
  });
  return {
    summary:
      'Автоматическая выборка: намерения и вопросы пользователя; заявления ассистента приведены отдельно. Выполнение работы не подтверждено. Выборка неполная, без команд и вывода инструментов.',
    excerpts,
  };
}
