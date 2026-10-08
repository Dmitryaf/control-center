import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  metadataSchema,
  settingsSchema,
  relationSchema,
  type RecordKind,
} from '../shared/contracts.js';
import { Store } from './db.js';
import { HttpError } from './errors.js';
import { Projects } from './projects/projects.js';
import { exportMetadata } from './projects/metadata.js';
import { assertProjectAccess } from './filesystem/access.js';
import { Records } from './records.js';
import { Checks } from './checks/checks.js';
import { Tasks } from './tasks.js';

export function createApp(store: Store, port: number) {
  const app = express();
  const projects = new Projects(store);
  const records = new Records(store);
  const checks = new Checks(store);
  const tasks = new Tasks(store);
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!hosts.includes(req.headers.host ?? ''))
      return res.status(403).json({ error: 'Допустим только локальный адрес Control Center.' });
    if (req.headers.origin && !hosts.some((host) => req.headers.origin === `http://${host}`))
      return res.status(403).json({ error: 'Запрос с другого сайта запрещён.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        (req.headers['x-control-center'] !== '1' || !req.is('application/json'))
      ) {
        return res.status(403).json({ error: 'Для изменения нужен локальный JSON-запрос.' });
      }
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/workspace', (_req, res) =>
    res.json({
      projects: projects.list(),
      tasks: records.list('tasks'),
      ideas: records.list('ideas'),
      decisions: records.list('decisions'),
      relations: records.relations(),
      settings: store.settings(),
      scan: projects.scanInfo,
      checks: checks.views(),
      checkEntries: checks.entries(),
      fileDecisions: projects.decisions.list(),
      storage: { databasePath: store.path },
    }),
  );
  app.post('/api/scan', async (_req, res) => {
    await projects.scan();
    res.json(projects.scanInfo);
  });
  app.put('/api/settings', async (req, res) => {
    if (projects.scanInfo.running) throw new HttpError(409, 'Дождитесь завершения сканирования.');
    const settings = settingsSchema.parse(req.body);
    if (req.body.excludedProjectPaths === undefined)
      settings.excludedProjectPaths = store.settings().excludedProjectPaths;
    if (
      [...settings.roots, ...settings.excludedProjectPaths].some((root) => !path.isAbsolute(root))
    )
      throw new HttpError(400, 'Укажите абсолютные пути каталогов.');
    settings.roots = [...new Set(settings.roots.map((root) => path.resolve(root)))];
    settings.excludedProjectPaths = [
      ...new Set(settings.excludedProjectPaths.map((directory) => path.resolve(directory))),
    ];
    store.saveSettings(settings);
    await projects.scan();
    res.json(settings);
  });
  app.get('/api/projects/:id', async (req, res) => res.json(await projects.refresh(req.params.id)));
  app.put('/api/projects/:id', async (req, res) => {
    const row = projects.require(req.params.id);
    const data = z
      .object({
        metadata: metadataSchema,
        notes: z.string().max(20000),
        expectedHash: z.string().nullable().optional(),
      })
      .parse(req.body);
    const current = await projects.refresh(row.id);
    if (data.expectedHash !== undefined && data.expectedHash !== current.snapshot.yaml.hash)
      throw new HttpError(409, 'PROJECT.yaml изменился. Обновите страницу и сравните версии.');
    store.saveMetadata(row.id, data.metadata, data.notes);
    res.json(projects.view(projects.require(row.id)));
  });
  app.post('/api/projects/:id/use-yaml', async (req, res) => {
    const row = projects.require(req.params.id);
    const body = z.object({ expectedHash: z.string().nullable() }).parse(req.body);
    const current = await projects.refresh(row.id);
    if (
      !current.available ||
      current.snapshot.yaml.error ||
      body.expectedHash !== current.snapshot.yaml.hash
    )
      throw new HttpError(
        409,
        'PROJECT.yaml изменился или недоступен. Обновите страницу и сравните версии. Локальная версия сохранена.',
      );
    store.saveMetadata(row.id, null, row.notes);
    res.json(await projects.refresh(row.id));
  });
  app.post('/api/projects/:id/export', async (req, res) => {
    const row = projects.require(req.params.id);
    const body = z.object({ expectedHash: z.string().nullable() }).parse(req.body);
    await assertProjectAccess(row.path, store.settings().roots);
    if ((await projects.refresh(row.id)).yamlConflict)
      throw new HttpError(409, 'Сначала выберите, какую версию сводки оставить.');
    await exportMetadata(row.path, projects.view(row).metadata, body.expectedHash);
    const updated = await projects.refresh(row.id);
    if (row.metadata)
      store.saveMetadata(row.id, updated.metadata, row.notes, updated.snapshot.yaml.hash);
    res.json(projects.view(projects.require(row.id)));
  });
  app.post('/api/projects/:id/keep-local', async (req, res) => {
    const data = z.object({ expectedHash: z.string().nullable() }).parse(req.body);
    const current = await projects.refresh(req.params.id);
    if (
      !current.available ||
      current.snapshot.yaml.error ||
      data.expectedHash !== current.snapshot.yaml.hash
    )
      throw new HttpError(409, 'Файл изменился или недоступен. Обновите страницу.');
    store.saveMetadata(current.id, current.metadata, current.notes, data.expectedHash);
    res.json(projects.view(projects.require(current.id)));
  });
  app.post('/api/projects/:id/rebind', async (req, res) => {
    const body = z.object({ targetId: z.string().uuid() }).parse(req.body);
    res.json(await projects.rebind(req.params.id, body.targetId));
  });
  app.delete('/api/projects/:id', async (req, res) => {
    await projects.forget(req.params.id);
    res.json({ ok: true });
  });
  app.put('/api/projects/:id/decision-sources', async (req, res) => {
    const row = projects.require(req.params.id);
    const body = z
      .object({ paths: z.array(z.string().trim().min(1).max(2000)).max(20) })
      .parse(req.body);
    if (body.paths.some((p) => !path.isAbsolute(p)))
      throw new HttpError(400, 'Нужны абсолютные пути каталогов.');
    store.db
      .prepare('UPDATE projects SET decision_sources=? WHERE id=?')
      .run(JSON.stringify([...new Set(body.paths.map((p) => path.resolve(p)))]), row.id);
    await projects.decisions.refresh(row.id);
    res.json(projects.view(projects.require(row.id)));
  });
  app.put('/api/projects/:id/context', async (req, res) => {
    projects.require(req.params.id);
    await projects.context.save(req.params.id, req.body);
    res.json(await projects.refresh(req.params.id));
  });
  app.put('/api/projects/:id/publication-allowlist', async (req, res) => {
    projects.require(req.params.id);
    const body = z
      .object({ path: z.string().min(1).max(4000), allowed: z.boolean() })
      .parse(req.body);
    await projects.context.allow(req.params.id, body.path, body.allowed);
    res.json(await projects.refresh(req.params.id));
  });
  app.post('/api/projects/:id/decision-content', async (req, res) => {
    projects.require(req.params.id);
    const body = z.object({ key: z.string().min(1).max(6000) }).parse(req.body);
    res.json(await projects.decisions.content(req.params.id, body.key));
  });
  app.post('/api/backup', (_req, res) => {
    const directory = path.join(path.dirname(store.path), 'backups');
    mkdirSync(directory, { recursive: true });
    const file = path.join(
      directory,
      `control-center-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`,
    );
    store.backup(file);
    res.json({ path: file });
  });
  app.post('/api/checks', (req, res) => {
    const body = z
      .object({ check: z.unknown(), allowParallel: z.boolean().default(false) })
      .parse(req.body);
    res.status(201).json(checks.save(body.check, undefined, body.allowParallel));
  });
  app.put('/api/checks/:id', (req, res) => {
    const body = z
      .object({ check: z.unknown(), allowParallel: z.boolean().default(false) })
      .parse(req.body);
    res.json(checks.save(body.check, req.params.id, body.allowParallel));
  });
  app.post('/api/checks/:id/complete', (req, res) =>
    res.json(checks.complete(req.params.id, req.body)),
  );
  app.post('/api/checks/:id/entries', (req, res) =>
    res.status(201).json(checks.saveEntry(req.params.id, req.body)),
  );
  app.put('/api/checks/:id/entries/:entryId', (req, res) =>
    res.json(checks.saveEntry(req.params.id, req.body, req.params.entryId)),
  );
  app.delete('/api/checks/:id/entries/:entryId', (req, res) => {
    checks.deleteEntry(req.params.id, req.params.entryId);
    res.json({ ok: true });
  });
  app.get('/api/tasks/:id', (req, res) => res.json(tasks.read(req.params.id)));
  app.post('/api/projects/:id/import-plan', (req, res) => {
    const project = projects.view(projects.require(req.params.id));
    res.json(tasks.importPlan(project.id, project.metadata.next));
  });
  app.post('/api/tasks/:id/complete', (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive(), result: z.unknown() })
      .parse(req.body);
    res.json(tasks.complete(req.params.id, body.revision, body.result));
  });
  for (const kind of ['tasks', 'ideas', 'decisions'] satisfies RecordKind[]) {
    app.post(`/api/${kind}`, (req, res) => res.status(201).json(records.save(kind, req.body)));
    app.put(`/api/${kind}/:id`, (req, res) =>
      res.json(records.save(kind, req.body, req.params.id, true)),
    );
    app.delete(`/api/${kind}/:id`, (req, res) => {
      records.delete(kind, req.params.id);
      res.json({ ok: true });
    });
  }
  app.post('/api/relations', (req, res) =>
    res.status(201).json(records.relate(relationSchema.parse(req.body))),
  );
  app.delete('/api/relations/:id', (req, res) => {
    store.db.prepare('DELETE FROM relations WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Маршрут не найден.' }));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Проверьте поля: ' + error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
    } else if (error instanceof HttpError) res.status(error.status).json({ error: error.message });
    else if (error instanceof SyntaxError) res.status(400).json({ error: 'Некорректный JSON.' });
    else
      res
        .status(500)
        .json({ error: 'Операция не выполнена. Проверьте доступ к файлам и повторите.' });
  };
  app.use(onError);
  return { app, projects };
}
