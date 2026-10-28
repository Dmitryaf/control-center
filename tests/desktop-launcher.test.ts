import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test(
  'Windows desktop launcher: cold start, repeated/concurrent clicks, foreign port and recovery',
  {
    skip: process.platform !== 'win32',
    timeout: 120_000,
  },
  async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'cc-launch-'));
    const foreign = createServer((_req, res) => res.end('foreign service'));
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const address = foreign.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    const base = `http://127.0.0.1:${port}`;
    let serverPid: number | undefined;
    const launch = (dataDirectory = data) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'scripts/launch.ps1',
            '-NoBrowser',
            '-NoDialog',
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              PORT: String(port),
              CONTROL_CENTER_DATA_DIR: dataDirectory,
              OPENAI_API_KEY: '',
              CONTROL_CENTER_OPENAI_MODEL: '',
            },
          },
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, output }));
      });
    try {
      const occupied = await launch();
      assert.equal(occupied.code, 1);
      assert.ok(occupied.output.includes(String(port)));
      assert.equal(await (await fetch(base)).text(), 'foreign service');
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
      const results = await Promise.all([launch(), launch()]);
      const health = await (await fetch(`${base}/api/health`)).json();
      serverPid = health.pid;
      for (const result of results) assert.equal(result.code, 0, result.output);
      assert.equal(health.application, 'control-center');
      assert.match(health.instance, /^[a-f0-9]{64}$/);
      const html = await (await fetch(base)).text();
      assert.match(html, /<title>Control Center<\/title>/);
      assert.equal((await fetch(`${base}/src/main.tsx`)).status, 200);
      const repeated = await launch();
      assert.equal(repeated.code, 0, repeated.output);
      assert.equal((await (await fetch(`${base}/api/health`)).json()).pid, serverPid);
      const otherData = await launch(path.join(data, 'other'));
      assert.equal(otherData.code, 1, 'A different database must not reuse this server');
      assert.equal((await (await fetch(`${base}/api/health`)).json()).pid, serverPid);
      assert.equal(
        (await fetch(`${base}/api/health`, { headers: { Origin: 'https://example.com' } })).status,
        403,
      );
      const taskResponse = await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
        body: JSON.stringify({ title: 'Launcher restart check' }),
      });
      assert.equal(taskResponse.status, 201);
      const task = await taskResponse.json();
      process.kill(serverPid!);
      serverPid = undefined;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const restarted = await launch();
      const afterRestart = await (await fetch(`${base}/api/health`)).json();
      serverPid = afterRestart.pid;
      assert.equal(restarted.code, 0, restarted.output);
      const workspace = await (await fetch(`${base}/api/workspace`)).json();
      assert.ok(workspace.tasks.some((saved: { id: string }) => saved.id === task.id));
    } finally {
      foreign.closeAllConnections();
      foreign.close();
      if (serverPid) process.kill(serverPid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  },
);
