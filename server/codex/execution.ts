import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { periodReportSchema } from '../../shared/period-analysis.js';
import type { CodexExecutionStatus } from '../../shared/codex-analysis.js';
import { ensureAnalysisProfile } from './analysis-profile.js';

export const executionTimeoutMs = 5 * 60_000;
const disabledFeatures = [
  'shell_tool',
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'view_image',
  'code_mode',
  'code_mode_host',
  'multi_agent',
  'skill_search',
  'remote_plugin',
  'unbounded_connection_retries',
  'memories',
  'external_agent_memory_import',
];
const featureArgs = disabledFeatures.flatMap((name) => ['--disable', name]);
export interface CodexExecutionResult {
  output: string;
  threadId: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}
export interface CodexExecutor {
  probe(): Promise<CodexExecutionStatus>;
  login?(): Promise<CodexExecutionStatus>;
  cancelLogin?(): Promise<void>;
  execute(input: {
    prompt: string;
    model: string | null;
    signal: AbortSignal;
    onProgress: (stage: string) => void;
  }): Promise<CodexExecutionResult>;
}
export class CodexExecutionError extends Error {
  constructor(
    message: string,
    readonly state: 'failed' | 'unknown',
  ) {
    super(message);
  }
}
export function executionArguments(schema: string, model: string | null) {
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--json',
    '--output-schema',
    schema,
    '--skip-git-repo-check',
    '--color',
    'never',
    '-c',
    'web_search="disabled"',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'memories.use_memories=false',
    '-c',
    'memories.generate_memories=false',
    '-c',
    'skills.include_instructions=false',
    '--enable',
    'skip_host_skill_discovery',
    ...featureArgs,
    ...(model ? ['--model', model] : []),
    '-',
  ];
}
export function codexChildEnvironment(env: NodeJS.ProcessEnv, home: string) {
  const allowed = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'HOME',
    'CODEX_HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase()))),
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
  };
}
export class LocalCodexExecutor implements CodexExecutor {
  private cached: CodexExecutionStatus | null = null;
  private checkedAt = 0;
  private loginState: CodexExecutionStatus['login'] = null;
  private loginChild: ChildProcessWithoutNullStreams | null = null;
  private loginDone: Promise<void> | null = null;
  private loginStarting: Promise<CodexExecutionStatus> | null = null;
  constructor(
    private program = process.env.CONTROL_CENTER_CODEX_PATH ||
      (process.platform === 'win32' ? 'codex.exe' : 'codex'),
    private prefix: string[] = [],
    private env: NodeJS.ProcessEnv = process.env,
    private executionOptions: string[] = [],
  ) {}
  async probe(): Promise<CodexExecutionStatus> {
    if (this.cached && Date.now() - this.checkedAt < 30000)
      return { ...this.cached, login: this.loginState };
    let home: string;
    try {
      home = await ensureAnalysisProfile(this.env);
    } catch {
      return {
        available: false,
        version: null,
        reason:
          'Профиль анализа недоступен или содержит AGENTS.md. Для анализа используется отдельный профиль без личных инструкций.',
      };
    }
    const options = {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: codexChildEnvironment(this.env, home),
      cwd: home,
    };
    try {
      const version = (
        await promisify(execFile)(this.program, [...this.prefix, '--version'], options)
      ).stdout.trim();
      if (!/^codex-cli [\w.+-]{1,100}$/.test(version)) throw new Error();
      const help = (
        await promisify(execFile)(this.program, [...this.prefix, 'exec', '--help'], options)
      ).stdout;
      for (const flag of [
        '--ignore-user-config',
        '--ephemeral',
        '--output-schema',
        '--json',
        '--sandbox',
      ])
        if (!help.includes(flag)) throw new Error();
      const features = (
        await promisify(execFile)(
          this.program,
          [...this.prefix, ...featureArgs, 'features', 'list'],
          options,
        )
      ).stdout;
      for (const name of disabledFeatures)
        if (!new RegExp(`^${name}\\s+.*\\sfalse\\s*$`, 'm').test(features)) throw new Error();
      let authenticated = false;
      try {
        await promisify(execFile)(this.program, [...this.prefix, 'login', 'status'], options);
        authenticated = true;
      } catch {
        /* CLI owns credentials; never read or return its diagnostics. */
      }
      this.cached = { available: true, version: version.slice(10), reason: null, authenticated };
      this.checkedAt = Date.now();
      return { ...this.cached, login: this.loginState };
    } catch {
      this.cached = null;
      return {
        available: false,
        version: null,
        reason:
          'Codex CLI недоступен или не поддерживает изолированный анализ. Проверьте установку и вход через codex login. Сохранённые данные доступны.',
      };
    }
  }
  login(): Promise<CodexExecutionStatus> {
    if (this.loginStarting) return this.loginStarting;
    this.loginStarting = this.beginLogin().finally(() => {
      this.loginStarting = null;
    });
    return this.loginStarting;
  }
  private async beginLogin(): Promise<CodexExecutionStatus> {
    const status = await this.probe();
    if (!status.available || status.authenticated || this.loginChild) return status;
    const home = await ensureAnalysisProfile(this.env);
    this.loginState = { state: 'starting', code: null, url: null, error: null };
    const child = spawn(this.program, [...this.prefix, 'login', '--device-auth'], {
      cwd: home,
      env: codexChildEnvironment(this.env, home),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.loginChild = child;
    child.stdin.on('error', () => {});
    child.stdin.end();
    let bytes = 0,
      buffer = '',
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 15 * 60_000);
    const receive = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024) {
        failed = true;
        child.kill();
        return;
      }
      buffer += stripVTControlCharacters(chunk.toString('utf8'));
      const code = buffer.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0];
      if (code && buffer.includes('https://auth.openai.com/codex/device'))
        this.loginState = {
          state: 'waiting',
          code,
          url: 'https://auth.openai.com/codex/device',
          error: null,
        };
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', () => {
      failed = true;
    });
    this.loginDone = new Promise<void>((resolve) =>
      child.once('close', (code) => {
        clearTimeout(timer);
        this.loginChild = null;
        this.cached = null;
        if (this.loginState)
          this.loginState =
            code === 0 && !failed
              ? null
              : {
                  state: 'failed',
                  code: null,
                  url: null,
                  error:
                    'Вход не завершён. Разрешите вход по коду устройства в настройках безопасности ChatGPT и повторите попытку.',
                };
        buffer = '';
        resolve();
      }),
    );
    return { ...status, login: this.loginState };
  }
  async cancelLogin() {
    if (this.loginStarting) await this.loginStarting.catch(() => {});
    this.loginState = null;
    this.loginChild?.kill();
    await this.loginDone;
  }
  async execute({
    prompt,
    model,
    signal,
    onProgress,
  }: Parameters<CodexExecutor['execute']>[0]): Promise<CodexExecutionResult> {
    if (model && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(model))
      throw new CodexExecutionError('Недопустимый идентификатор модели.', 'failed');
    const status = await this.probe();
    if (!status.available)
      throw new CodexExecutionError('Codex CLI недоступен. Запрос не запущен.', 'failed');
    if (status.authenticated === false)
      throw new CodexExecutionError(
        'Войдите в отдельный профиль Codex в Control Center. Запрос не запущен.',
        'failed',
      );
    if (signal.aborted) throw new CodexExecutionError('Запуск отменён до отправки.', 'failed');
    const home = await ensureAnalysisProfile(this.env);
    const directory = await mkdtemp(path.join(tmpdir(), 'control-center-codex-exec-'));
    try {
      const schema = path.join(directory, 'report.schema.json');
      await writeFile(
        schema,
        JSON.stringify(z.toJSONSchema(periodReportSchema, { target: 'draft-7' })),
        { flag: 'wx' },
      );
      return await new Promise<CodexExecutionResult>((resolve, reject) => {
        const args = executionArguments(schema, model);
        const child = spawn(
          this.program,
          [...this.prefix, args[0], ...this.executionOptions, ...args.slice(1)],
          {
            cwd: directory,
            env: codexChildEnvironment(this.env, home),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let buffer = '',
          output = '',
          bytes = 0,
          threadId: string | null = null;
        let usage: CodexExecutionResult['usage'] = null;
        let completed = false,
          started = false;
        let failure: CodexExecutionError | null = null;
        const fail = (
          message: string,
          state: 'failed' | 'unknown' = started ? 'unknown' : 'failed',
        ) => {
          failure ??= new CodexExecutionError(message, state);
          child.kill();
        };
        const abort = () =>
          fail(
            'Выполнение остановлено. Ответ не сохранён; запрос мог использовать лимит Codex. Автоматического повтора нет.',
          );
        const timer = setTimeout(
          () =>
            fail(
              'Codex не завершил анализ за пять минут. Результат неизвестен; автоматического повтора нет.',
            ),
          executionTimeoutMs,
        );
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          buffer += chunk;
          if (bytes > 1024 * 1024 || Buffer.byteLength(buffer) > 128 * 1024)
            return fail('Ответ Codex превышает допустимый размер.');
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'thread.started') {
                if (typeof event.thread_id !== 'string' || event.thread_id.length > 150)
                  throw new Error();
                threadId = event.thread_id;
              } else if (event.type === 'turn.started') {
                started = true;
                onProgress('Codex анализирует выбранный контекст');
              } else if (event.type === 'item.completed') {
                if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
                  output = event.item.text;
                  if (Buffer.byteLength(output) > 64 * 1024)
                    return fail('Ответ Codex больше 64 КБ.');
                } else if (
                  !['reasoning', 'plan', 'todo_list', 'error'].includes(event.item?.type)
                ) {
                  return fail(
                    `Неподдерживаемый тип элемента Codex: ${typeof event.item?.type === 'string' && /^[a-z_]{1,40}$/.test(event.item.type) ? event.item.type : 'unknown'}. Ответ отклонён.`,
                    'failed',
                  );
                }
              } else if (
                event.type === 'item.started' &&
                !['agent_message', 'reasoning', 'plan', 'todo_list', 'error'].includes(
                  event.item?.type,
                )
              ) {
                return fail(
                  'Инструменты недоступны для встроенного анализа. Ответ отклонён.',
                  'failed',
                );
              } else if (event.type === 'turn.completed') {
                completed = true;
                const u = event.usage;
                if (
                  Number.isSafeInteger(u?.input_tokens) &&
                  u.input_tokens >= 0 &&
                  Number.isSafeInteger(u?.output_tokens) &&
                  u.output_tokens >= 0
                )
                  usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
                onProgress('Проверка и сохранение ответа');
              } else if (event.type === 'turn.failed')
                fail('Codex сообщил об отказе. Проверьте вход и доступный лимит.', 'failed');
              else if (event.type === 'error')
                fail(
                  'Codex сообщил об ошибке. Подробности не копируются из CLI для защиты личных данных.',
                );
            } catch {
              fail('Codex вернул неподдерживаемый поток событий.');
            }
          }
        });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => fail('Не удалось передать контекст Codex.'));
        child.once('error', () => {
          failure ??= new CodexExecutionError('Не удалось запустить Codex CLI.', 'failed');
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (failure) reject(failure);
          else if (code !== 0 || !started || !threadId || !completed || !output || buffer.trim())
            reject(
              new CodexExecutionError(
                'Codex не вернул завершённый ответ. Автоматического повтора нет.',
                started ? 'unknown' : 'failed',
              ),
            );
          else resolve({ output, threadId, usage });
        });
        if (signal.aborted) abort();
        else {
          onProgress('Запуск Codex');
          child.stdin.end(prompt);
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
