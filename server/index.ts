import path from 'node:path';
import express from 'express';
import { Store } from './db.js';
import { createApp } from './app.js';
import { dataDirectory } from './storage.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT должен быть от 1024 до 65535.');
const store = new Store(path.join(dataDirectory(), 'control-center.sqlite'));
const { app, projects, refresh, analysis } = createApp(store, port);
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const client = path.resolve('dist/client');
  app.use(express.static(client));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(client, 'index.html')));
}
await projects.scan();
const server = app.listen(port, '127.0.0.1', () => {
  refresh.start();
  console.log(`Control Center: http://127.0.0.1:${port}`);
});
let closing: Promise<void> | null = null;
function close(exitCode: number) {
  if (closing) return closing;
  closing = (async () => {
    analysis.stop();
    await Promise.all([
      refresh.stop(),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    store.close();
    process.exitCode = exitCode;
  })();
  return closing;
}
server.on('error', (error) => {
  console.error(error.message);
  void close(1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => void close(0).then(() => process.exit(0)));
