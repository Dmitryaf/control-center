import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fixture } from '../fixtures.js';
import { LocalCodex } from '../../server/codex/rpc.js';

test('installed Codex reads an empty isolated home without starting MCP', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const home = path.join(f.root, 'isolated-home');
  await mkdir(home);
  const marker = path.join(home, 'mcp-must-not-start.txt');
  const hook = path.join(home, 'mcp-marker.cjs');
  await writeFile(
    hook,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`,
  );
  await writeFile(
    path.join(home, 'config.toml'),
    `[mcp_servers.readonly_guard_fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(hook)}]\nenabled=true\nstartup_timeout_sec=1\n`,
  );
  const transport = new LocalCodex(undefined, [], {
    ...process.env,
    CODEX_HOME: home,
    OPENAI_API_KEY: '',
    CODEX_API_KEY: '',
  });
  assert.match((await transport.probe()).version, /^\d+\.\d+\.\d+/);
  const result = await transport.read(new AbortController().signal, (rpc) =>
    rpc.request('thread/list', { cwd: [f.root], limit: 10, archived: false, useStateDbOnly: true }),
  );
  assert.deepEqual((result as { data: unknown[] }).data, []);
  await assert.rejects(() => access(marker), { code: 'ENOENT' });
});
