import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from '../db.js';
import { dataDirectory } from '../storage.js';
import { createMcpServer } from './server.js';

// Same OS data directory as the HTTP app; no scan or UI is needed.
const store = new Store(path.join(dataDirectory(), 'control-center.sqlite'));
const server = createMcpServer(store);
let closed = false;
function close() {
  if (closed) return;
  closed = true;
  store.close();
}
server.server.onclose = close;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await server.close();
    close();
  });
try {
  await server.connect(new StdioServerTransport());
} catch {
  close();
  console.error('Не удалось запустить MCP Control Center. Проверьте доступ к общей базе.');
  process.exitCode = 1;
}
