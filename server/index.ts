import path from 'node:path';
import express from 'express';
import { Store } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT должен быть от 1024 до 65535.');
const store = new Store(
  path.resolve(process.env.CONTROL_CENTER_DATA_DIR ?? '.data', 'control-center.sqlite'),
);
const { app, projects } = createApp(store, port);
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
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Control Center: http://127.0.0.1:${port}`),
);
server.on('error', (error) => {
  console.error(error.message);
  store.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
