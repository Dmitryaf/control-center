import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpError } from '../errors.js';

export type ReadMethod = 'thread/list' | 'thread/read' | 'thread/turns/list' | 'thread/items/list';
export interface CodexReader {
  request(method: ReadMethod, params: unknown): Promise<unknown>;
}
export interface CodexTransport {
  probe(): Promise<{ version: string }>;
  read<T>(signal: AbortSignal, action: (rpc: CodexReader) => Promise<T>): Promise<T>;
}
const methods = new Set([
  'initialize',
  'thread/list',
  'thread/read',
  'thread/turns/list',
  'thread/items/list',
]);
const failure = () =>
  new HttpError(
    503,
    'Codex недоступен, ответ слишком велик или протокол не поддерживается. Данные не сохранены; остальные функции приложения доступны.',
  );
export class LocalCodex implements CodexTransport {
  private checkedVersion: string | null = null;
  constructor(
    private program = process.env.CONTROL_CENTER_CODEX_PATH ||
      (process.platform === 'win32' ? 'codex.exe' : 'codex'),
    private args: string[] = [],
    private env: NodeJS.ProcessEnv = process.env,
  ) {}
  async probe() {
    try {
      const { stdout } = await promisify(execFile)(this.program, [...this.args, '--version'], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 8192,
        env: this.env,
      });
      const match = /^codex-cli ([^\r\n]{1,100})$/.exec(stdout.trim());
      if (!match) throw failure();
      if (this.checkedVersion !== match[1]) {
        const root = path.resolve(tmpdir());
        const directory = await mkdtemp(path.join(root, 'control-center-codex-schema-'));
        const relative = path.relative(root, path.resolve(directory));
        if (
          !relative ||
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !path.basename(directory).startsWith('control-center-codex-schema-')
        )
          throw failure();
        try {
          // Schema generation reads no dialog content. Check safety-critical support before
          // thread/list: older servers may silently ignore an unknown useStateDbOnly field.
          await promisify(execFile)(
            this.program,
            [...this.args, 'app-server', 'generate-json-schema', '--out', directory],
            {
              windowsHide: true,
              timeout: 10000,
              maxBuffer: 8192,
              env: this.env,
            },
          );
          const requests = JSON.parse(
            await readFile(path.join(directory, 'ClientRequest.json'), 'utf8'),
          );
          const methodNames = new Set<string>();
          const visit = (node: unknown) => {
            if (!node || typeof node !== 'object') return;
            const object = node as Record<string, unknown>;
            const properties = object.properties as { method?: { enum?: unknown[] } } | undefined;
            for (const name of properties?.method?.enum ?? [])
              if (typeof name === 'string') methodNames.add(name);
            for (const value of Object.values(object)) visit(value);
          };
          visit(requests);
          for (const method of methods) if (!methodNames.has(method)) throw failure();
          const required = {
            ThreadListParams: ['cwd', 'useStateDbOnly', 'cursor', 'limit'],
            ThreadReadParams: ['threadId', 'includeTurns'],
            ThreadTurnsListParams: ['threadId', 'itemsView', 'sortDirection', 'cursor'],
            ThreadItemsListParams: ['threadId', 'turnId', 'cursor'],
          };
          for (const [name, fields] of Object.entries(required)) {
            const schema = JSON.parse(
              await readFile(path.join(directory, 'v2', `${name}.json`), 'utf8'),
            );
            if (fields.some((field) => !Object.hasOwn(schema.properties ?? {}, field)))
              throw failure();
          }
          this.checkedVersion = match[1];
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      return { version: match[1] };
    } catch {
      throw failure();
    }
  }
  async read<T>(signal: AbortSignal, action: (rpc: CodexReader) => Promise<T>): Promise<T> {
    await this.probe();
    if (signal.aborted) throw failure();
    const child = spawn(this.program, [...this.args, 'app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = new ReadSession(child, signal);
    try {
      const initialized = (await session.requestInternal('initialize', {
        clientInfo: {
          name: 'control_center_reader',
          title: 'Control Center reader',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: false },
      })) as { userAgent?: unknown };
      if (typeof initialized?.userAgent !== 'string') throw failure();
      session.notifyInitialized();
      return await action(session);
    } finally {
      await session.dispose();
    }
  }
}
export class ReadSession implements CodexReader {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();
  private buffer = '';
  private bytes = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout>;
  private abort = () => this.close();
  private exited = false;
  private exitPromise: Promise<void>;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private signal: AbortSignal,
  ) {
    this.exitPromise = new Promise((resolve) =>
      child.once('close', () => {
        this.exited = true;
        clearTimeout(this.killTimer);
        resolve();
      }),
    );
    this.timer = setTimeout(() => this.close(), 20000);
    signal.addEventListener('abort', this.abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (this.closed) return;
      this.bytes += Buffer.byteLength(data);
      this.buffer += data;
      if (this.bytes > 2 * 1024 * 1024 || Buffer.byteLength(this.buffer) > 1024 * 1024) {
        this.close();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.method) {
            if (value.id !== undefined)
              child.stdin.write(
                JSON.stringify({
                  id: value.id,
                  error: { code: -32601, message: 'Read-only client' },
                }) + '\n',
              );
            continue;
          }
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          this.pending.delete(value.id);
          if (value.error) pending.reject(failure());
          else if ('result' in value) pending.resolve(value.result);
          else pending.reject(failure());
        } catch {
          this.close();
          return;
        }
      }
    });
    // Never copy CLI diagnostics (which may contain paths or content) into HTTP/logs.
    child.stderr.on('data', () => {});
    child.on('error', () => this.close());
    child.on('exit', () => this.close());
    child.stdin.on('error', () => this.close());
    if (signal.aborted) this.close();
  }
  notifyInitialized() {
    if (this.closed) throw failure();
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  request(method: ReadMethod, params: unknown) {
    return this.requestInternal(method, params);
  }
  requestInternal(method: string, params: unknown): Promise<unknown> {
    if (!methods.has(method))
      return Promise.reject(new HttpError(403, 'Разрешены только методы чтения Codex.'));
    if (this.closed) return Promise.reject(failure());
    const id = ++this.sequence;
    const body = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(body) > 16384) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(body + '\n');
    });
  }
  async dispose() {
    this.close();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(failure()), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.signal.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) pending.reject(failure());
    this.pending.clear();
    this.buffer = '';
    this.child.stdin.end();
    if (!this.exited) this.killTimer = setTimeout(() => this.child.kill(), 500);
  }
}
