import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  codexGrantSchema,
  codexThreadsSchema,
  codexPreviewSchema,
  codexSaveSchema,
  codexPrepareSchema,
  type CodexGrant,
  type CodexThread,
  type CodexPreview,
  type CodexDigest,
  type CodexExcerpt,
} from '../../shared/codex-context.js';
import type { Store } from '../db.js';
import { HttpError } from '../errors.js';
import { Reviews } from '../reviews.js';
import { within } from '../filesystem/access.js';
import { projectDirectories } from '../projects/resolve.js';
import { digest, projectStamp } from '../analysis/privacy.js';
import { LocalCodex, type CodexTransport, type CodexReader } from './rpc.js';
import { extractContext } from './extract.js';

export const codexReadPolicy = 'codex-dialog-v1';
const metadata = z.object({
  id: z.string().min(1).max(100),
  cwd: z.string().max(4000),
  name: z.string().max(1000).nullable().optional(),
  updatedAt: z.number().int(),
});
const pageCursor = z.string().max(4096).nullable().optional().default(null);
const threadPage = z.object({ data: z.array(metadata).max(10), nextCursor: pageCursor });
const turnsPage = z.object({
  data: z
    .array(
      z.object({
        id: z.string().max(100),
        status: z.string().max(40),
        startedAt: z.number().nullable().optional(),
      }),
    )
    .max(10),
  nextCursor: pageCursor,
});
const itemPage = z.object({
  data: z
    .array(
      z.object({
        turnId: z.string().max(100),
        startedAtMs: z.number().nullable().optional(),
        item: z.record(z.string(), z.unknown()),
      }),
    )
    .max(50),
  nextCursor: pageCursor,
});
type Access = {
  revision: number;
  access_stamp: string;
  roots_json: string;
  enabled: number;
  policy_version: string;
};
type Cached = {
  dto: CodexPreview;
  revision: number;
  accessStamp: string;
  roots: string[];
  period: { from: string; to: string; timezone: string };
};
const same = (a: string, b: string) => path.isAbsolute(b) && path.relative(a, b) === '';
const threadDto = (row: z.infer<typeof metadata>): CodexThread => ({
  id: row.id,
  name: row.name?.trim() || `Диалог ${row.id}`,
  updatedAt: row.updatedAt,
});
export class CodexContext {
  private previews = new Map<string, Cached>();
  private selections = new Map<string, { revision: number; expiresAt: number }>();
  private active = new Map<string, Set<AbortController>>();
  private pending = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(
    private store: Store,
    private transport: CodexTransport = new LocalCodex(),
    private now: () => number = Date.now,
  ) {}
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private permitted(projectId: string, row: Access | undefined) {
    const project = this.store.project(projectId);
    if (
      !row?.enabled ||
      row.policy_version !== codexReadPolicy ||
      !project?.available ||
      row.access_stamp !== projectStamp(project)
    )
      return false;
    if (
      !this.store
        .settings()
        .roots.some((root) => within(path.resolve(root), path.resolve(project.path)))
    )
      return false;
    try {
      return (JSON.parse(row.roots_json) as string[]).some((root) =>
        same(root, path.resolve(project.path)),
      );
    } catch {
      return false;
    }
  }
  grant(projectId: string): CodexGrant {
    z.string().uuid().parse(projectId);
    if (!this.store.project(projectId)) throw new HttpError(404, 'Проект не найден.');
    const row = this.store.db
      .prepare('SELECT * FROM codex_grants WHERE project_id=?')
      .get(projectId) as unknown as Access | undefined;
    return {
      projectId,
      approved: !!row?.enabled,
      enabled: this.permitted(projectId, row),
      revision: row ? Number(row.revision) : null,
    };
  }
  async configure(projectId: string, input: unknown) {
    const data = codexGrantSchema.parse(input);
    const prior = this.grant(projectId);
    const project = this.store.project(projectId)!;
    const stamp = projectStamp(project);
    const roots = data.enabled ? await projectDirectories(this.store, projectId) : [];
    this.store.transaction(() => {
      const current = this.grant(projectId);
      const live = this.store.project(projectId)!;
      if (
        data.enabled &&
        (!live.available ||
          !this.store
            .settings()
            .roots.some((root) => within(path.resolve(root), path.resolve(live.path))))
      )
        throw new HttpError(409, 'Сначала обновите доступность проекта и его каталоги.');
      if (
        current.revision !== data.revision ||
        current.revision !== prior.revision ||
        projectStamp(this.store.project(projectId)!) !== stamp
      )
        throw new HttpError(409, 'Проект или разрешение изменены. Обновите страницу.');
      this.store.db
        .prepare(
          `INSERT INTO codex_grants(project_id,revision,enabled,access_stamp,roots_json,updated_at,policy_version) VALUES(?,?,?,?,?,?,'${codexReadPolicy}') ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,access_stamp=excluded.access_stamp,roots_json=excluded.roots_json,updated_at=excluded.updated_at,policy_version=excluded.policy_version`,
        )
        .run(
          projectId,
          (current.revision ?? 0) + 1,
          data.enabled ? 1 : 0,
          stamp,
          JSON.stringify(roots),
          this.timestamp(),
        );
    });
    this.abort(projectId);
    return this.grant(projectId);
  }
  private access(projectId: string, revision: number): Access {
    const row = this.store.db
      .prepare('SELECT * FROM codex_grants WHERE project_id=?')
      .get(projectId) as unknown as Access | undefined;
    if (!this.permitted(projectId, row) || row!.revision !== revision)
      throw new HttpError(
        410,
        'Разрешение чтения Codex отключено или проект изменился. Подтвердите доступ заново.',
      );
    return row!;
  }
  private async roots(projectId: string, revision: number) {
    const access = this.access(projectId, revision);
    const roots = await projectDirectories(this.store, projectId);
    this.access(projectId, revision);
    if (digest(roots) !== digest(JSON.parse(access.roots_json)))
      throw new HttpError(410, 'Набор каталогов проекта изменился. Подтвердите разрешение заново.');
    return roots;
  }
  private async operation<T>(
    projectId: string,
    revision: number,
    action: (rpc: CodexReader, roots: string[]) => Promise<T>,
  ): Promise<T> {
    if (this.stopping) throw new HttpError(503, 'Чтение Codex остановлено.');
    const promise = this.readOperation(projectId, revision, action);
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }
  private async readOperation<T>(
    projectId: string,
    revision: number,
    action: (rpc: CodexReader, roots: string[]) => Promise<T>,
  ) {
    const roots = await this.roots(projectId, revision);
    if (this.stopping) throw new HttpError(503, 'Чтение Codex остановлено.');
    const controller = new AbortController();
    const jobs = this.active.get(projectId) ?? new Set<AbortController>();
    if (jobs.size || [...this.active.values()].reduce((n, jobs) => n + jobs.size, 0) >= 2)
      throw new HttpError(429, 'Дождитесь завершения предыдущего чтения Codex.');
    jobs.add(controller);
    this.active.set(projectId, jobs);
    try {
      const result = await this.transport.read(controller.signal, (rpc) =>
        action(
          {
            request: async (method, params) => {
              this.access(projectId, revision);
              const value = await rpc.request(method, params);
              this.access(projectId, revision);
              return value;
            },
          },
          roots,
        ),
      );
      this.access(projectId, revision);
      return result;
    } catch (cause) {
      if (cause instanceof z.ZodError)
        throw new HttpError(
          503,
          'Формат ответа Codex не поддерживается. Диалоги не подключены; остальные источники доступны.',
        );
      throw cause;
    } finally {
      jobs.delete(controller);
      if (!jobs.size) this.active.delete(projectId);
    }
  }
  private remember(projectId: string, threadId: string, revision: number) {
    for (const [key, value] of this.selections)
      if (value.expiresAt <= this.now()) this.selections.delete(key);
    const key = `${projectId}:${threadId}`;
    if (!this.selections.has(key) && this.selections.size >= 200)
      throw new HttpError(
        429,
        'Слишком много открытых списков диалогов. Дождитесь истечения просмотров.',
      );
    this.selections.set(key, { revision, expiresAt: this.now() + 15 * 60000 });
  }
  private async thread(rpc: CodexReader, id: string, roots: string[]) {
    const value = z
      .object({ thread: metadata })
      .parse(await rpc.request('thread/read', { threadId: id, includeTurns: false })).thread;
    if (value.id !== id || !roots.some((root) => same(root, value.cwd)))
      throw new HttpError(403, 'Диалог не принадлежит разрешённому каталогу проекта.');
    return value;
  }
  async probe(projectId: string, revision: number) {
    this.access(projectId, revision);
    return this.transport.probe();
  }
  async threads(projectId: string, input: unknown) {
    const query = codexThreadsSchema.parse(input);
    return this.operation(projectId, query.revision, async (rpc, roots) => {
      const page = threadPage.parse(
        await rpc.request('thread/list', {
          cwd: roots,
          limit: 10,
          cursor: query.cursor ?? null,
          archived: query.archived,
          useStateDbOnly: true,
          sortKey: 'updated_at',
          sortDirection: 'desc',
        }),
      );
      if (page.data.some((thread) => !roots.some((root) => same(root, thread.cwd))))
        throw new HttpError(403, 'Codex вернул диалог вне выбранного проекта; список отклонён.');
      for (const thread of page.data) this.remember(projectId, thread.id, query.revision);
      return { items: page.data.map(threadDto), nextCursor: page.nextCursor };
    });
  }
  async preview(projectId: string, input: unknown) {
    const data = codexPreviewSchema.parse(input);
    const review = new Reviews(this.store).read(data.reviewId);
    if (review.scopeKey !== 'general' && review.scopeKey !== `project:${projectId}`)
      throw new HttpError(403, 'Для обзора другого проекта этот диалог недоступен.');
    const access = this.access(projectId, data.revision);
    const selected = this.selections.get(`${projectId}:${data.threadId}`);
    if (!selected || selected.revision !== data.revision || selected.expiresAt <= this.now())
      throw new HttpError(
        410,
        'Сначала откройте список диалогов выбранного проекта и выберите диалог заново.',
      );
    return this.operation(projectId, data.revision, async (rpc, roots) => {
      const thread = await this.thread(rpc, data.threadId, roots);
      const excerpts: CodexExcerpt[] = [];
      const fingerprints: unknown[] = [];
      const itemIds = new Set<string>();
      let cursor: string | null = null,
        partial = false,
        unknown = 0,
        omitted = 0,
        itemRequests = 0;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = turnsPage.parse(
          await rpc.request('thread/turns/list', {
            threadId: thread.id,
            limit: 10,
            cursor,
            sortDirection: 'desc',
            itemsView: 'notLoaded',
          }),
        );
        for (const turn of page.data) {
          if (seen.has(turn.id))
            throw new HttpError(503, 'Codex повторил страницу истории. Чтение остановлено.');
          seen.add(turn.id);
          if (turn.startedAt == null) {
            unknown++;
            continue;
          }
          const at = new Date(turn.startedAt * 1000).toISOString();
          if (at < review.startAt) {
            continue;
          }
          if (at >= review.nextStartAt) continue;
          if (++itemRequests > 8) {
            partial = true;
            break;
          }
          const items = itemPage.parse(
            await rpc.request('thread/items/list', {
              threadId: thread.id,
              turnId: turn.id,
              limit: 50,
              sortDirection: 'asc',
            }),
          );
          if (items.nextCursor) partial = true;
          for (const entry of items.data) {
            if (entry.turnId !== turn.id)
              throw new HttpError(503, 'Ответ Codex не соответствует выбранному turn.');
            const item = entry.item;
            let text = '';
            let role: 'user' | 'assistant';
            if (item.type === 'userMessage') {
              role = 'user';
              const content = z.array(z.record(z.string(), z.unknown())).parse(item.content);
              text = content
                .filter((c) => c.type === 'text')
                .map((c) => z.string().parse(c.text))
                .join('\n');
              omitted += content.filter((c) => c.type !== 'text').length;
            } else if (item.type === 'agentMessage') {
              if (item.phase === 'commentary') {
                omitted++;
                continue;
              }
              role = 'assistant';
              text = z.string().parse(item.text);
            } else {
              omitted++;
              continue;
            }
            if (!text.trim()) continue;
            if (excerpts.length === 40) {
              partial = true;
              break;
            }
            const id = z.string().min(1).max(100).parse(item.id);
            if (itemIds.has(`${turn.id}:${id}`))
              throw new HttpError(503, 'Codex повторил элемент истории.');
            itemIds.add(`${turn.id}:${id}`);
            fingerprints.push([turn.id, id, role, turn.status, at, digest(text)]);
            let visible = '',
              size = 0;
            for (const char of text) {
              const next = Buffer.byteLength(char);
              if (size + next > 1000) break;
              visible += char;
              size += next;
            }
            excerpts.push({
              id: `${turn.id}:${id}`,
              turnId: turn.id,
              itemId: id,
              role,
              timeBasis: 'turn_start',
              turnStatus: turn.status,
              at,
              text: visible,
              partial: visible !== text,
            });
          }
          if (excerpts.length === 40) break;
        }
        cursor = page.nextCursor;
        if (partial || excerpts.length === 40 || !cursor) break;
        if (pageNumber === 4) partial = true;
      }
      const latest = await this.thread(rpc, thread.id, roots);
      if (latest.updatedAt !== thread.updatedAt)
        throw new HttpError(409, 'Диалог изменился во время чтения. Повторите просмотр.');
      if (!excerpts.length)
        throw new HttpError(
          400,
          'В ограниченной выборке не найден текст за этот период. Проверяются до 50 последних обращений; записи без даты и команды исключаются.',
        );
      if (Buffer.byteLength(JSON.stringify(excerpts)) > 64000)
        throw new HttpError(400, 'Текст превышает лимит просмотра. Выберите другой диалог.');
      for (const [id, value] of this.previews)
        if (Date.parse(value.dto.expiresAt) <= this.now()) this.previews.delete(id);
      if (this.previews.size >= 20)
        throw new HttpError(429, 'Слишком много открытых просмотров. Дождитесь их истечения.');
      const dto: CodexPreview = {
        id: randomUUID(),
        projectId,
        reviewId: review.id,
        thread: threadDto(thread),
        expiresAt: new Date(this.now() + 15 * 60000).toISOString(),
        sourceHash: digest(fingerprints),
        excerpts,
        limitations: [
          'Отбор по времени начала обращения. Отдельные ответы могли появиться позже; Показанная дата — начало обращения, не точное время отдельного сообщения.',
          'Только текст user/assistant. Предложения и сообщения о выполнении не являются подтверждением работы.',
          'Проверены до 50 последних turns, не более 8 turns с текстом и 40 сообщений; выдержка показана до 1000 байт с отметкой сокращения.',
          `Сокращённая выборка: ${partial ? 'да' : 'нет'}. Turns без даты: ${unknown}. Исключённые нетекстовые элементы: ${omitted}.`,
          'Команды, tool output, вложения и reasoning не сохраняются. Ассистентский текст всё равно может содержать пересказ команд или личные сведения; проверьте его вручную.',
        ],
      };
      const suggestion = extractContext(dto);
      if (suggestion)
        dto.suggested = {
          summary: suggestion.summary,
          excerptIds: suggestion.excerpts.map((item) => item.id),
        };
      this.access(projectId, data.revision);
      this.previews.set(dto.id, {
        dto,
        revision: data.revision,
        accessStamp: access.access_stamp,
        roots,
        period: { from: review.periodStart, to: review.periodEnd, timezone: review.timezone },
      });
      return structuredClone(dto);
    });
  }
  async prepare(input: unknown) {
    const data = codexPrepareSchema.parse(input);
    const review = new Reviews(this.store).read(data.reviewId);
    if (new Set(data.projects.map((item) => item.projectId)).size !== data.projects.length)
      throw new HttpError(400, 'Проект выбран несколько раз.');
    // Validate the entire scope before the first read, not after reading another project.
    for (const item of data.projects) {
      if (review.scopeKey !== 'general' && review.scopeKey !== `project:${item.projectId}`)
        throw new HttpError(403, 'Выберите только проект этого обзора.');
      this.access(item.projectId, item.revision);
    }
    const items: CodexDigest[] = [],
      limitations: string[] = [];
    for (const project of data.projects) {
      try {
        const page = await this.threads(project.projectId, { revision: project.revision });
        let selected = 0;
        const candidates = page.items
          .filter((thread) => thread.updatedAt * 1000 >= Date.parse(review.startAt))
          .slice(0, 4);
        for (const thread of candidates) {
          if (selected === 2) break;
          let preview: CodexPreview;
          try {
            preview = await this.preview(project.projectId, {
              revision: project.revision,
              reviewId: review.id,
              threadId: thread.id,
            });
          } catch (cause) {
            if (cause instanceof HttpError && cause.status === 400) continue;
            throw cause;
          }
          const extraction = extractContext(preview);
          if (!extraction) {
            this.previews.delete(preview.id);
            continue;
          }
          const cached = this.previews.get(preview.id)!;
          // Only the selected small excerpts are stored. The full bounded projection hash
          // still detects source edits before saving; source text is never treated as fact.
          cached.dto.excerpts = cached.dto.excerpts.map(
            (item) => extraction.excerpts.find((e) => e.id === item.id) ?? item,
          );
          const old = this.store.db
            .prepare(
              'SELECT id FROM codex_digests WHERE review_key=? AND scope_project_id=? AND thread_id=?',
            )
            .get(review.id, project.projectId, thread.id);
          const previous = old ? this.read(String(old.id)) : null;
          try {
            if (
              previous?.eligible &&
              previous.sourceHash === preview.sourceHash &&
              digest(previous.excerpts) === digest(extraction.excerpts)
            ) {
              items.push(previous);
              selected++;
              continue;
            }
            const saved = await this.save(project.projectId, {
              previewId: preview.id,
              revision: previous?.revision ?? null,
              summary: previous?.summary ?? extraction.summary,
              excerptIds: extraction.excerpts.map((item) => item.id),
              confirm: true,
            });
            items.push(saved);
            selected++;
          } finally {
            this.previews.delete(preview.id);
          }
        }
        limitations.push(
          `Проект ${project.projectId}: выбрано ${selected} диалогов; проверены до четырёх недавних диалогов из первой страницы. Это ограниченный отбор, не полный архив.`,
        );
      } catch (cause) {
        if (cause instanceof HttpError && [403, 409, 410].includes(cause.status)) throw cause;
        limitations.push(
          `Контекст Codex проекта ${project.projectId} недоступен. Основные источники можно использовать без него.`,
        );
      }
    }
    return { items, limitations };
  }
  async save(projectId: string, input: unknown) {
    const data = codexSaveSchema.parse(input);
    const requestHash = digest({
      summary: data.summary,
      excerptIds: [...new Set(data.excerptIds)].sort(),
    });
    const repeated = this.store.db
      .prepare('SELECT id,request_hash FROM codex_digests WHERE preview_id=?')
      .get(data.previewId);
    if (repeated) {
      if (repeated.request_hash !== requestHash)
        throw new HttpError(
          409,
          'Этот просмотр уже сохранён с другой редакцией. Откройте сохранённый итог.',
        );
      const saved = this.read(String(repeated.id));
      if (saved.scopeProjectId !== projectId) throw new HttpError(403, 'Другой проект.');
      return saved;
    }
    const cached = this.previews.get(data.previewId);
    if (
      !cached ||
      cached.dto.projectId !== projectId ||
      Date.parse(cached.dto.expiresAt) <= this.now()
    )
      throw new HttpError(410, 'Просмотр истёк. Прочитайте диалог заново.');
    const excerpts = data.excerptIds.map((id) =>
      cached.dto.excerpts.find((item) => item.id === id),
    );
    if (new Set(data.excerptIds).size !== data.excerptIds.length || excerpts.some((item) => !item))
      throw new HttpError(400, 'Выдержка не входит в просмотренный пакет.');
    this.remember(projectId, cached.dto.thread.id, cached.revision);
    const fresh = await this.preview(projectId, {
      revision: cached.revision,
      reviewId: cached.dto.reviewId,
      threadId: cached.dto.thread.id,
    });
    this.previews.delete(fresh.id);
    this.previews.delete(fresh.id);
    if (
      fresh.sourceHash !== cached.dto.sourceHash ||
      fresh.thread.updatedAt !== cached.dto.thread.updatedAt
    )
      throw new HttpError(409, 'Диалог изменился после просмотра. Подготовьте новый итог.');
    const thread = fresh.thread;
    return this.store.transaction(() => {
      this.access(projectId, cached.revision);
      new Reviews(this.store).read(cached.dto.reviewId);
      const old = this.store.db
        .prepare(
          'SELECT id,revision,scope_project_id FROM codex_digests WHERE review_key=? AND thread_id=?',
        )
        .get(cached.dto.reviewId, thread.id);
      if (old && old.scope_project_id !== projectId)
        throw new HttpError(
          409,
          'Диалог раньше был сохранён для другого проекта. Удалите прежний итог перед переносом.',
        );
      if ((old ? Number(old.revision) : null) !== data.revision)
        throw new HttpError(409, 'Итог уже изменён. Обновите страницу.');
      if (
        !old &&
        Number(
          this.store.db
            .prepare(
              'SELECT count(*) AS n FROM codex_digests WHERE review_key=? AND scope_project_id=?',
            )
            .get(cached.dto.reviewId, projectId)?.n,
        ) >= 2
      )
        throw new HttpError(
          400,
          'Для одного обзора сохраняются максимум два диалога каждого проекта. Удалите ненужный итог.',
        );
      const project = this.store.project(projectId)!;
      const snapshot = JSON.parse(project.snapshot);
      const name = project.metadata
        ? JSON.parse(project.metadata).name
        : (snapshot.yaml.metadata?.name ?? snapshot.directoryName);
      const id = old ? String(old.id) : randomUUID();
      const now = this.timestamp();
      this.store.db
        .prepare(
          `INSERT INTO codex_digests(id,project_id,scope_project_id,project_name,review_key,period_json,thread_id,thread_name,thread_updated_at,summary,excerpts_json,source_hash,access_stamp,grant_revision,captured_at,checked_at,revision,preview_id,request_hash,policy_version)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'${codexReadPolicy}') ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,excerpts_json=excluded.excerpts_json,source_hash=excluded.source_hash,access_stamp=excluded.access_stamp,grant_revision=excluded.grant_revision,thread_name=excluded.thread_name,thread_updated_at=excluded.thread_updated_at,captured_at=excluded.captured_at,checked_at=excluded.checked_at,stale=0,revision=excluded.revision,preview_id=excluded.preview_id,request_hash=excluded.request_hash,policy_version=excluded.policy_version`,
        )
        .run(
          id,
          projectId,
          projectId,
          name,
          cached.dto.reviewId,
          JSON.stringify(cached.period),
          thread.id,
          fresh.thread.name,
          thread.updatedAt,
          data.summary,
          JSON.stringify(excerpts),
          cached.dto.sourceHash,
          cached.accessStamp,
          cached.revision,
          now,
          now,
          (old ? Number(old.revision) : 0) + 1,
          data.previewId,
          requestHash,
        );
      return this.read(id);
    });
  }
  read(id: string): CodexDigest {
    z.string().uuid().parse(id);
    const row = this.store.db.prepare('SELECT * FROM codex_digests WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'Итог диалога не найден.');
    const grant = row.project_id
      ? (this.store.db
          .prepare('SELECT * FROM codex_grants WHERE project_id=?')
          .get(String(row.project_id)) as unknown as Access | undefined)
      : undefined;
    return {
      id,
      reviewKey: String(row.review_key),
      projectId: row.project_id as string | null,
      scopeProjectId: String(row.scope_project_id),
      projectName: String(row.project_name),
      period: JSON.parse(String(row.period_json)),
      thread: {
        id: String(row.thread_id),
        name: String(row.thread_name),
        updatedAt: Number(row.thread_updated_at),
      },
      summary: String(row.summary),
      excerpts: JSON.parse(String(row.excerpts_json)),
      sourceHash: String(row.source_hash),
      policyVersion: String(row.policy_version),
      capturedAt: String(row.captured_at),
      checkedAt: String(row.checked_at),
      stale: !!row.stale,
      revision: Number(row.revision),
      eligible:
        row.policy_version === codexReadPolicy &&
        !!row.project_id &&
        this.permitted(String(row.project_id), grant) &&
        grant!.revision === row.grant_revision &&
        grant!.access_stamp === row.access_stamp &&
        !row.stale,
    };
  }
  edit(id: string, input: unknown) {
    const data = z
      .object({
        revision: z.number().int().positive(),
        summary: z.string().trim().min(1).max(6000),
        confirm: z.literal(true),
      })
      .strict()
      .parse(input);
    const previous = this.read(id);
    if (previous.revision !== data.revision)
      throw new HttpError(409, 'Итог изменён. Обновите страницу.');
    const changed = this.store.db
      .prepare('UPDATE codex_digests SET summary=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(data.summary, id, data.revision);
    if (!changed.changes) throw new HttpError(409, 'Итог изменён. Обновите страницу.');
    return this.read(id);
  }
  list(input: unknown = {}) {
    const query = z
      .object({
        reviewId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        cursor: z.string().uuid().optional(),
      })
      .strict()
      .parse(input);
    const where: string[] = [],
      values: string[] = [];
    if (query.reviewId) {
      where.push('review_key=?');
      values.push(query.reviewId);
    }
    if (query.projectId) {
      where.push('scope_project_id=?');
      values.push(query.projectId);
    }
    if (query.cursor) {
      where.push('id>?');
      values.push(query.cursor);
    }
    const rows = this.store.db
      .prepare(
        `SELECT id FROM codex_digests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id LIMIT 21`,
      )
      .all(...values);
    return {
      items: rows.slice(0, 20).map((row) => this.read(String(row.id))),
      nextCursor: rows.length > 20 ? String(rows[19].id) : null,
    };
  }
  async check(id: string, input: unknown) {
    const data = z
      .object({ revision: z.number().int().positive(), grantRevision: z.number().int().positive() })
      .strict()
      .parse(input);
    const saved = this.read(id);
    if (!saved.projectId)
      throw new HttpError(410, 'Проект удалён. Сохранённые выдержки остаются доступны.');
    if (saved.revision !== data.revision)
      throw new HttpError(409, 'Итог изменён. Обновите страницу.');
    try {
      this.access(saved.projectId, data.grantRevision);
      this.remember(saved.projectId, saved.thread.id, data.grantRevision);
      const fresh = await this.preview(saved.projectId, {
        revision: data.grantRevision,
        reviewId: saved.reviewKey,
        threadId: saved.thread.id,
      });
      this.previews.delete(fresh.id);
      const updated = this.store.db
        .prepare(
          'UPDATE codex_digests SET stale=?,checked_at=?,revision=revision+1 WHERE id=? AND revision=?',
        )
        .run(
          fresh.sourceHash !== saved.sourceHash || fresh.thread.updatedAt !== saved.thread.updatedAt
            ? 1
            : 0,
          this.timestamp(),
          id,
          data.revision,
        );
      if (!updated.changes)
        throw new HttpError(409, 'Итог изменён во время проверки. Обновите страницу.');
      return this.read(id);
    } catch (cause) {
      this.store.db
        .prepare('UPDATE codex_digests SET stale=1,revision=revision+1 WHERE id=? AND revision=?')
        .run(id, data.revision);
      throw cause;
    }
  }

  delete(id: string, input: unknown) {
    const data = z
      .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
      .strict()
      .parse(input);
    const row = this.read(id);
    if (row.revision !== data.revision) throw new HttpError(409, 'Итог изменён.');
    const deleted = this.store.db
      .prepare('DELETE FROM codex_digests WHERE id=? AND revision=?')
      .run(id, data.revision);
    if (!deleted.changes) throw new HttpError(409, 'Итог изменён. Обновите страницу.');
  }
  private abort(projectId: string) {
    for (const key of this.selections.keys())
      if (key.startsWith(`${projectId}:`)) this.selections.delete(key);
    for (const job of this.active.get(projectId) ?? []) job.abort();
    for (const [id, preview] of this.previews)
      if (preview.dto.projectId === projectId) this.previews.delete(id);
  }
  async stop() {
    this.stopping = true;
    for (const project of this.active.keys()) this.abort(project);
    this.previews.clear();
    this.selections.clear();
    await Promise.allSettled([...this.pending]);
  }
}
