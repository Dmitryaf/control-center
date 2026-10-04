import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture } from '../tests/fixtures.js';
import type { Workspace } from '../shared/contracts.js';

const fixtureData = await fixture();
const repo = await fixtureData.repo('production-project');
const base = 'http://127.0.0.1:4321';
let processHandle: ChildProcess | null = null;
let output = '';
async function start() {
  output = '';
  processHandle = spawn(process.execPath, ['dist/server/server/index.js'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '4321',
      CONTROL_CENTER_DATA_DIR: path.join(fixtureData.root, 'data'),
    },
  });
  processHandle.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  processHandle.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  await Promise.race([
    once(processHandle, 'error').then(([error]) => {
      throw error;
    }),
    (async () => {
      for (let i = 0; i < 100; i++) {
        if (processHandle?.exitCode !== null) throw new Error(output);
        if (output.includes('Control Center:')) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Server did not start: ${output}`);
    })(),
  ]);
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = once(processHandle, 'exit');
  processHandle.kill();
  await exited;
  processHandle = null;
}
const request = (url: string, method = 'GET', data?: unknown) =>
  fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(data),
  });
try {
  await start();
  const html = await (await request('/')).text();
  assert.match(html, /Control Center/);
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.match((await request(asset)).headers.get('content-type')!, /javascript/);
  assert.match((await request('/favicon.svg')).headers.get('content-type')!, /image\/svg/);
  const empty = (await (await request('/api/workspace')).json()) as Workspace;
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.tasks.length, 0);
  assert.equal(
    (await request('/api/settings', 'PUT', { ...empty.settings, roots: [repo] })).status,
    200,
  );
  const workspace = (await (await request('/api/workspace')).json()) as Workspace;
  assert.equal(workspace.projects.length, 1);
  const id = workspace.projects[0].id;
  assert.equal(workspace.projects[0].snapshot.yaml.exists, false);
  const created = await request('/api/tasks', 'POST', {
    title: 'Persists across restart',
    projectId: id,
  });
  assert.equal(created.status, 201);
  assert.match(await (await request(`/projects/${id}`)).text(), /Control Center/);
  await stop();
  await start();
  const restarted = (await (await request('/api/workspace')).json()) as Workspace;
  assert.equal(restarted.tasks[0].title, 'Persists across restart');
  assert.equal(restarted.projects[0].id, id);
  assert.equal(restarted.projects[0].available, true);
  assert.ok(restarted.scan.scannedAt);
  console.log(
    'Production smoke passed: empty configuration, assets, scan, task, restart persistence, deep link.',
  );
} finally {
  await stop();
  await fixtureData.cleanup();
}
