import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../server/errors.js';
import type { CodexTransport, ReadMethod } from '../server/codex/rpc.js';
export function codexFixture(cwd: string) {
  const threadId = randomUUID(),
    turnId = randomUUID();
  const state = {
    cwd,
    updatedAt: 100,
    name: 'Содержательный диалог',
    text: 'Проверю один пример. Это намерение, не выполненная работа.',
    foreign: false,
    unavailable: false,
  };
  const calls: { method: ReadMethod; params: Record<string, unknown> }[] = [];
  const transport: CodexTransport = {
    probe: async () => ({ version: '0.158.0' }),
    read: async (_signal, action) =>
      action({
        request: async (method, params) => {
          calls.push({ method, params: params as Record<string, unknown> });
          if (state.unavailable) throw new HttpError(503, 'Fixture unavailable');
          // Producer fields and names verified against CLI 0.158.0 generated schemas.
          const thread = {
            id: threadId,
            cwd: state.foreign ? path.dirname(cwd) : state.cwd,
            name: state.name,
            updatedAt: state.updatedAt,
            createdAt: 90,
            cliVersion: '0.158.0',
            historyMode: 'paginated',
            ephemeral: false,
            modelProvider: 'fixture',
            preview: 'DO_NOT_EXPOSE_PREVIEW',
            status: { type: 'notLoaded' },
            source: 'appServer',
            turns: [],
            path: 'DO_NOT_EXPOSE_PATH',
          };
          if (method === 'thread/list') return { data: [thread], nextCursor: null };
          if (method === 'thread/read') return { thread };
          if (method === 'thread/turns/list')
            return {
              data: [
                {
                  id: turnId,
                  status: 'completed',
                  startedAt: Date.parse('2024-03-06T12:00:00Z') / 1000,
                  items: [],
                  itemsView: 'notLoaded',
                },
                { id: 'undated', status: 'completed', startedAt: null, items: [] },
              ],
              nextCursor: null,
            };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId,
                  item: {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [
                      { type: 'text', text: state.text, text_elements: [] },
                      { type: 'localImage', path: 'DO_NOT_PERSIST_ATTACHMENT' },
                    ],
                  },
                },
                {
                  turnId,
                  item: {
                    type: 'commandExecution',
                    id: 'command-1',
                    command: 'DO_NOT_PERSIST_COMMAND',
                    aggregatedOutput: 'DO_NOT_PERSIST_OUTPUT',
                  },
                },
                {
                  turnId,
                  item: {
                    type: 'reasoning',
                    id: 'reasoning-1',
                    summary: ['DO_NOT_PERSIST_REASONING'],
                  },
                },
                {
                  turnId,
                  item: {
                    type: 'agentMessage',
                    id: 'assistant-1',
                    text: 'Предложение: сначала подтвердить результат.',
                    phase: 'final_answer',
                  },
                },
              ],
              nextCursor: null,
            };
          throw new Error('forbidden');
        },
      }),
  };
  return { state, calls, transport, threadId, turnId };
}
