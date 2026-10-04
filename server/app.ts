import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
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

export function createApp(store: Store, port: number) {
  const app = express();
  const projects = new Projects(store);
  const records = new Records(store);
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
    }),
  );
  app.post('/api/scan', async (_req, res) => {
    await projects.scan();
    res.json(projects.scanInfo);
  });
  app.put('/api/settings', async (req, res) => {
    if (projects.scanInfo.running) throw new HttpError(409, 'Дождитесь завершения сканирования.');
    const settings = settingsSchema.parse(req.body);
    if (settings.roots.some((root) => !path.isAbsolute(root)))
      throw new HttpError(400, 'Укажите абсолютные пути каталогов.');
    settings.roots = [...new Set(settings.roots.map((root) => path.resolve(root)))];
    store.saveSettings(settings);
    await projects.scan();
    res.json(settings);
  });
  app.get('/api/projects/:id', async (req, res) => res.json(await projects.refresh(req.params.id)));
  app.put('/api/projects/:id', (req, res) => {
    const row = projects.require(req.params.id);
    const data = z
      .object({ metadata: metadataSchema, notes: z.string().max(20000) })
      .parse(req.body);
    store.saveMetadata(row.id, data.metadata, data.notes);
    res.json(projects.view(projects.require(row.id)));
  });
  app.post('/api/projects/:id/use-yaml', async (req, res) => {
    const row = projects.require(req.params.id);
    store.saveMetadata(row.id, null, row.notes);
    res.json(await projects.refresh(row.id));
  });
  app.post('/api/projects/:id/export', async (req, res) => {
    const row = projects.require(req.params.id);
    const body = z.object({ expectedHash: z.string().nullable() }).parse(req.body);
    await assertProjectAccess(row.path, store.settings().roots);
    await exportMetadata(row.path, projects.view(row).metadata, body.expectedHash);
    res.json(await projects.refresh(row.id));
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
