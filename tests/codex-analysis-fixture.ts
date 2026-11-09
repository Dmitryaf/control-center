import {
  CodexExecutionError,
  type CodexExecutor,
  type CodexExecutionResult,
} from '../server/codex/execution.js';
import type { PeriodReport } from '../shared/period-analysis.js';
import type { CodexExecutionStatus } from '../shared/codex-analysis.js';

export class CodexAnalysisFixture implements CodexExecutor {
  available = true;
  authenticated = true;
  loginState: CodexExecutionStatus['login'] = null;
  loginCalls = 0;
  mode: 'success' | 'wait' | 'invalid' | 'foreign' | 'secret' = 'success';
  report: PeriodReport | null = null;
  prompts: string[] = [];
  release: (() => void) | null = null;
  async probe() {
    return {
      available: this.available,
      version: this.available ? 'fixture' : null,
      reason: this.available ? null : 'Fixture unavailable',
      authenticated: this.authenticated,
      login: this.loginState,
    };
  }
  async login() {
    this.loginCalls++;
    this.loginState = {
      state: 'waiting',
      code: 'ABCD-EFGH',
      url: 'https://auth.openai.com/codex/device',
      error: null,
    };
    return this.probe();
  }
  async cancelLogin() {
    this.loginState = null;
  }
  async execute(input: Parameters<CodexExecutor['execute']>[0]): Promise<CodexExecutionResult> {
    input.beforeDispatch?.();
    this.prompts.push(input.prompt);
    input.onProgress('Codex анализирует выбранный контекст');
    if (this.mode === 'wait')
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(new CodexExecutionError('Fixture interrupted; result unknown', 'unknown'));
        this.release = () => {
          input.signal.removeEventListener('abort', abort);
          resolve();
        };
        if (input.signal.aborted) abort();
        else input.signal.addEventListener('abort', abort, { once: true });
      });
    const packet = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n') + 1));
    const source = packet.context.sources.find((s: { kind: string }) => s.kind === 'project');
    const report: PeriodReport = {
      narrative: packet.conversation.length
        ? 'Попроси одного человека записать наблюдение и вернуться к нему позже. Посмотри, сможет ли он найти запись без подсказки.'
        : 'Я бы сначала проверил, легко ли вернуться к прошлой записи. Записать наблюдение — только полдела: оно пригодится, когда человек в следующий раз откроет дневник.',
      findings: [
        {
          statement:
            'В описании проекта есть цель, но пока нет отзыва человека, который попробовал им пользоваться.',
          sources: [source.id],
        },
      ],
      uncertainties: ['Получается ли найти прошлую запись без подсказки?'],
      proposals: [
        {
          kind: 'improvement',
          projectIds: [source.projectId],
          title: 'Проверить основной сценарий',
          description: 'Пройти создание и повторное открытие первой записи.',
          reason: 'Это проверит полезный результат проекта.',
          uncertainty: 'Поведение пользователей пока неизвестно.',
          cheapCheck: 'Один проход на синтетических данных.',
          sources: [source.id],
        },
      ],
    };
    if (this.mode === 'foreign') report.findings[0].sources = ['project:unselected'];
    if (this.mode === 'secret') report.narrative = 'password=synthetic-secret-value';
    return {
      output: this.mode === 'invalid' ? 'not json' : JSON.stringify(this.report ?? report),
      threadId: 'synthetic-codex-execution',
      usage: { inputTokens: 120, outputTokens: 80 },
    };
  }
}
