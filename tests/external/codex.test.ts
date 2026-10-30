import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, access, copyFile } from 'node:fs/promises';
import { fixture } from '../fixtures.js';
import { LocalCodex } from '../../server/codex/rpc.js';
import { createServer } from 'node:http';
import { LocalCodexExecutor } from '../../server/codex/execution.js';
import { analysisProfile } from '../../server/codex/analysis-profile.js';

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

test(
  'installed Codex exec uses a synthetic local Responses endpoint with commands/MCP/hooks disabled',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture();
    const home = path.join(f.root, 'isolated-exec-home');
    await mkdir(home);
    const privateGuidance = 'PRIVATE_GLOBAL_AGENT_GUIDANCE_DO_NOT_INCLUDE';
    await writeFile(path.join(home, 'AGENTS.md'), privateGuidance);
    const privateSkill = 'PRIVATE_SKILL_DESCRIPTION_DO_NOT_INCLUDE';
    const skill = path.join(home, 'skills', 'private-fixture');
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, 'SKILL.md'),
      `---\nname: private-fixture\ndescription: ${privateSkill}\n---\nPrivate synthetic instructions.`,
    );
    const privateMemory = 'PRIVATE_MEMORY_SUMMARY_DO_NOT_INCLUDE';
    await mkdir(path.join(home, 'memories'));
    await writeFile(path.join(home, 'memories', 'memory_summary.md'), privateMemory);
    const profile = analysisProfile({ ...process.env, CONTROL_CENTER_DATA_DIR: f.root });
    await mkdir(profile);
    await writeFile(
      path.join(profile, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-synthetic-local-fixture-only' }),
    );
    const marker = path.join(home, 'must-not-start.txt');
    const hook = path.join(home, 'marker.cjs');
    await writeFile(
      hook,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`,
    );
    await writeFile(
      path.join(home, 'config.toml'),
      `[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(hook)}]\nenabled=true\n[hooks]\nSessionStart=[{hooks=[{type="command",command="must-not-run"}]}]\n`,
    );
    await copyFile(path.join(home, 'config.toml'), path.join(profile, 'config.toml'));
    const requests: Record<string, unknown>[] = [];
    const report = {
      narrative: 'Synthetic protocol verification; no model was called.',
      findings: [],
      uncertainties: [],
      proposals: [],
    };
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          requests.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const message = {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [] }],
          };
          const response = {
            id: 'resp_fixture',
            object: 'response',
            created_at: 1700000000,
            model: 'fixture-model',
            status: 'completed',
            output: [message],
            usage: {
              input_tokens: 12,
              output_tokens: 8,
              total_tokens: 20,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          };
          const events = [
            {
              type: 'response.created',
              response: { ...response, status: 'in_progress', output: [] },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...message, status: 'in_progress', content: [] },
            },
            {
              type: 'response.content_part.added',
              item_id: message.id,
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            },
            {
              type: 'response.output_text.delta',
              item_id: message.id,
              output_index: 0,
              content_index: 0,
              delta: JSON.stringify(report),
            },
            {
              type: 'response.output_text.done',
              item_id: message.id,
              output_index: 0,
              content_index: 0,
              text: JSON.stringify(report),
            },
            { type: 'response.output_item.done', output_index: 0, item: message },
            { type: 'response.completed', response },
          ];
          events.forEach((event, sequence_number) =>
            res.write(`data: ${JSON.stringify({ ...event, sequence_number })}\n\n`),
          );
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const executor = new LocalCodexExecutor(
      undefined,
      [],
      {
        ...process.env,
        CONTROL_CENTER_DATA_DIR: f.root,
        CODEX_HOME: home,
        OPENAI_API_KEY: '',
        CODEX_API_KEY: '',
      },
      [
        '-c',
        'model_provider="fixture"',
        '-c',
        'model_providers.fixture.name="Synthetic fixture"',
        '-c',
        `model_providers.fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
        '-c',
        'model_providers.fixture.wire_api="responses"',
        '-c',
        'model_providers.fixture.requires_openai_auth=false',
        '-c',
        'model_providers.fixture.supports_websockets=false',
        '--disable',
        'enable_request_compression',
      ],
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    t.after(async () => {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.cleanup();
    });
    assert.equal((await executor.probe()).available, true);
    const result = await executor.execute({
      prompt: 'Return a report about this synthetic fixture. Do not use tools.',
      model: 'fixture-model',
      signal: controller.signal,
      onProgress() {},
    });
    assert.deepEqual(JSON.parse(result.output), report);
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(requests[0]).includes(privateGuidance));
    assert.ok(!JSON.stringify(requests[0]).includes(privateSkill));
    assert.ok(!JSON.stringify(requests[0]).includes(privateMemory));
    const names: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'name' && typeof child === 'string') names.push(child);
        else visit(child);
      }
    };
    visit(requests[0].tools);
    assert.ok(
      !JSON.stringify(requests[0].tools).match(
        /"type":"(?:web_search(?:_preview)?|computer_use(?:_preview)?|image_generation|mcp)"/,
      ),
    );
    assert.ok(
      !names.some((name) =>
        /exec|shell|mcp|browser|computer|patch|image|web|read_file|write_file/i.test(name),
      ),
      names.join(', '),
    );
    await assert.rejects(access(marker), { code: 'ENOENT' });
  },
);
