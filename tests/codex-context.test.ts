import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { projectDirectories } from '../server/projects/resolve.js';
import { Reviews } from '../server/reviews.js';
import { History } from '../server/history.js';
import { CodexContext } from '../server/codex/context.js';
import { LocalCodex, type ReadMethod } from '../server/codex/rpc.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { AnalysisSchedules } from '../server/analysis/schedules.js';
import { createApp } from '../server/app.js';
import { snapshotDatabase } from '../server/storage.js';
import { codexFixture } from './codex-fixture.js';
import { HttpError } from '../server/errors.js';

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const f = await fixture();
  const repo = await f.repo('context-project');
  const file = path.join(f.root, 'context.sqlite');
  const store = new Store(file);
  const others: Store[] = [];
  t.after(async () => {
    for (const other of others) other.close();
    store.close();
    await f.cleanup();
  });
  store.saveSettings({ ...store.settings(), roots: [repo], timezone: 'UTC' });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  const review = new Reviews(store).create({
    projectId: project.id,
    kind: 'week',
    anchorDate: '2024-03-06',
  });
  const fake = codexFixture(repo);
  let now = Date.parse('2024-03-11T00:00:00Z');
  const context = new CodexContext(store, fake.transport, () => now);
  const enable = () =>
    context.configure(project.id, {
      revision: context.grant(project.id).revision,
      enabled: true,
      readConsent: true,
    });
  const capture = async () => {
    const grant = await enable();
    await context.threads(project.id, { revision: grant.revision });
    const preview = await context.preview(project.id, {
      revision: grant.revision,
      reviewId: review.id,
      threadId: fake.threadId,
    });
    return { grant, preview };
  };
  return {
    f,
    repo,
    file,
    store,
    others,
    projects,
    project,
    review,
    fake,
    context,
    enable,
    capture,
    setNow: (value: string) => {
      now = Date.parse(value);
    },
  };
}
test('opt-in → scoped metadata → bounded period text → selected digest; restart and retries preserve only chosen excerpts', async (t) => {
  const x = await setup(t);
  assert.equal(x.context.grant(x.project.id).enabled, false);
  await assert.rejects(() => x.context.threads(x.project.id, { revision: 1 }), /отключено/);
  assert.equal(x.fake.calls.length, 0);
  await assert.rejects(() => x.context.configure(x.project.id, { revision: null, enabled: true }));
  const grant = await x.enable();
  assert.equal(x.fake.calls.length, 0);
  const list = await x.context.threads(x.project.id, { revision: grant.revision });
  assert.equal(list.items[0].name, 'Содержательный диалог');
  assert.ok(!JSON.stringify(list).includes('DO_NOT_EXPOSE'));
  assert.deepEqual(x.fake.calls[0].params.cwd, [x.repo]);
  assert.equal(x.fake.calls[0].params.useStateDbOnly, true);
  const preview = await x.context.preview(x.project.id, {
    revision: grant.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  assert.equal(preview.excerpts.length, 2);
  assert.ok(preview.limitations.some((s) => s.includes('Turns без даты: 1')));
  assert.ok(
    x.fake.calls
      .filter((c) => c.method === 'thread/read')
      .every((c) => c.params.includeTurns === false),
  );
  const input = {
    previewId: preview.id,
    revision: null,
    summary: 'Мой итог: пока есть только намерение.',
    excerptIds: [preview.excerpts[0].id],
    confirm: true,
  };
  await assert.rejects(
    () => x.context.save(x.project.id, { ...input, excerptIds: ['foreign'] }),
    /не входит/,
  );
  const saved = await x.context.save(x.project.id, input);
  assert.equal(saved.eligible, true);
  const settings = x.store.settings();
  x.store.saveSettings({ ...settings, roots: [] });
  assert.equal(x.context.read(saved.id).eligible, false);
  x.store.saveSettings(settings);
  assert.equal(saved.excerpts.length, 1);
  assert.equal((await x.context.save(x.project.id, input)).id, saved.id);
  await assert.rejects(
    () => x.context.save(x.project.id, { ...input, summary: 'Другая редакция' }),
    /другой редакцией/,
  );
  const row = JSON.stringify(x.store.db.prepare('SELECT * FROM codex_digests').get());
  assert.ok(!row.includes('DO_NOT_PERSIST'));
  assert.ok(!row.includes('Предложение: сначала'));
  const reopened = new Store(x.file);
  x.others.push(reopened);
  assert.deepEqual(new CodexContext(reopened).read(saved.id), saved);
});
test('foreign cwd fails before history reads; expiry, changed access and revoked permission fail closed', async (t) => {
  const x = await setup(t);
  let grant = await x.enable();
  x.fake.state.foreign = true;
  await assert.rejects(
    () => x.context.threads(x.project.id, { revision: grant.revision }),
    /вне выбранного/,
  );
  await assert.rejects(
    () =>
      x.context.preview(x.project.id, {
        revision: grant.revision,
        reviewId: x.review.id,
        threadId: x.fake.threadId,
      }),
    /Сначала откройте/,
  );
  assert.equal(
    x.fake.calls.filter((c) => c.method.includes('turns') || c.method.includes('items')).length,
    0,
  );
  x.fake.state.foreign = false;
  await x.context.threads(x.project.id, { revision: grant.revision });
  const preview = await x.context.preview(x.project.id, {
    revision: grant.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  x.setNow('2024-03-11T00:16:00Z');
  await assert.rejects(
    () =>
      x.context.save(x.project.id, {
        previewId: preview.id,
        revision: null,
        summary: 'Итог',
        excerptIds: [],
        confirm: true,
      }),
    /истёк/,
  );
  x.store.db.prepare("UPDATE projects SET visibility='private' WHERE id=?").run(x.project.id);
  const count = x.fake.calls.length;
  await assert.rejects(
    () => x.context.threads(x.project.id, { revision: grant.revision }),
    /проект изменился/,
  );
  assert.equal(x.fake.calls.length, count);
  grant = await x.enable();
  await x.context.configure(x.project.id, { revision: grant.revision, enabled: false });
  await assert.rejects(
    () => x.context.threads(x.project.id, { revision: grant.revision }),
    /отключено/,
  );
});
test('source hashing notices edits beyond displayed excerpt; AI uses saved digest only and rechecks revocation before sending', async (t) => {
  const x = await setup(t);
  x.fake.state.text = 'a'.repeat(1600);
  const { grant, preview } = await x.capture();
  assert.equal(preview.excerpts[0].partial, true);
  assert.ok(Buffer.byteLength(preview.excerpts[0].text) <= 1000);
  assert.equal(preview.excerpts[0].timeBasis, 'turn_start');
  const saved = await x.context.save(x.project.id, {
    previewId: preview.id,
    revision: null,
    summary: 'Есть непроверенное намерение.',
    excerptIds: [preview.excerpts[0].id],
    confirm: true,
  });
  let sends = 0;
  const ai = new PeriodAnalysis(
    x.store,
    new History(x.store, x.projects.decisions),
    { key: 'fixture', model: 'fixture-model' },
    async () => {
      sends++;
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  narrative: 'Только намерение.',
                  findings: [],
                  uncertainties: [],
                  proposals: [],
                }),
              },
            ],
          },
        ],
      });
    },
  );
  const selection = {
    projectIds: [x.project.id],
    includeGeneral: false,
    sourceKinds: [],
    includeMetadata: false,
    includeOpenTasks: false,
    includeUserText: false,
    includeRelatedReviews: false,
    codexDigestIds: [saved.id],
  };
  const calls = x.fake.calls.length;
  const packet = ai.prepare({
    reviewId: x.review.id,
    requestKey: randomUUID(),
    selection,
    readConsent: true,
  });
  assert.equal(x.fake.calls.length, calls);
  assert.equal(packet.payload.sources[0].kind, 'codex_digest');
  assert.ok(packet.payload.sources[0].text.includes(x.fake.threadId));
  assert.ok(!JSON.stringify(packet.payload).includes(x.repo));
  const schedules = new AnalysisSchedules(x.store, ai);
  assert.throws(
    () =>
      schedules.enable({
        reviewId: x.review.id,
        revision: null,
        selection,
        expectedModel: 'fixture-model',
        readConsent: true,
        sendConsent: true,
      }),
    /только для ручного/,
  );
  x.fake.state.text = 'a'.repeat(1500) + 'changed';
  const checked = await x.context.check(saved.id, {
    revision: saved.revision,
    grantRevision: grant.revision,
  });
  assert.equal(checked.stale, true);
  assert.equal(
    (await ai.run(packet.id, { packetHash: packet.packetHash, consent: true })).status,
    'cancelled',
  );
  assert.equal(sends, 0);
  await assert.rejects(() =>
    x.context.check(saved.id, { revision: checked.revision, grantRevision: 999 }),
  );
  assert.equal(x.context.read(saved.id).stale, true);
});
test('verified worktrees are exact roots; replaced paths, subdirectories and new worktrees do not inherit an existing grant', async (t) => {
  const x = await setup(t);
  const work = path.join(x.f.root, 'external-work');
  x.f.git(x.repo, 'worktree', 'add', '-b', 'context-fixture', work);
  assert.deepEqual(
    new Set(await projectDirectories(x.store, x.project.id)),
    new Set([x.repo, work]),
  );
  const grant = await x.enable();
  x.fake.state.cwd = path.join(work, 'subdir');
  await mkdir(x.fake.state.cwd);
  await assert.rejects(
    () => x.context.threads(x.project.id, { revision: grant.revision }),
    /вне выбранного/,
  );
  x.fake.state.cwd = work;
  assert.equal(
    (await x.context.threads(x.project.id, { revision: grant.revision })).items.length,
    1,
  );
  await rename(work, path.join(x.f.root, 'moved-work'));
  await x.f.repo('external-work');
  assert.deepEqual(await projectDirectories(x.store, x.project.id), [x.repo]);
  await assert.rejects(
    () => x.context.threads(x.project.id, { revision: grant.revision }),
    /Набор каталогов/,
  );
});
test('backup disables grants only in copy; project deletion preserves local text while blocking later reuse', async (t) => {
  const x = await setup(t);
  const { preview } = await x.capture();
  const saved = await x.context.save(x.project.id, {
    previewId: preview.id,
    revision: null,
    summary: 'Сохранить основание',
    excerptIds: [],
    confirm: true,
  });
  const destination = path.join(x.f.root, 'backup.sqlite');
  snapshotDatabase(x.store.db, destination);
  const copy = new Store(destination);
  x.others.push(copy);
  assert.equal(new CodexContext(copy).read(saved.id).eligible, false);
  assert.equal(x.context.read(saved.id).eligible, true);
  await x.projects.forget(x.project.id);
  const retained = x.context.read(saved.id);
  assert.equal(retained.projectId, null);
  assert.equal(retained.scopeProjectId, x.project.id);
  assert.equal(retained.summary, saved.summary);
  assert.equal(retained.eligible, false);
});
test('actual HTTP composition enforces local consent and persists selected text through the injected read-only transport', async (t) => {
  const x = await setup(t);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const { app } = createApp(x.store, port, undefined, undefined, x.context);
  const server = app.listen(port, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const send = (
    suffix: string,
    data: unknown,
    method = 'POST',
    origin = `http://127.0.0.1:${port}`,
  ) =>
    fetch(`http://127.0.0.1:${port}/api/projects/${x.project.id}/codex-context${suffix}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1', Origin: origin },
      body: JSON.stringify(data),
    });
  assert.equal(
    (
      await send(
        '',
        { revision: null, enabled: true, readConsent: true },
        'PUT',
        'https://foreign.invalid',
      )
    ).status,
    403,
  );
  assert.equal((await send('', { revision: null, enabled: true }, 'PUT')).status, 400);
  const grant = await (
    await send('', { revision: null, enabled: true, readConsent: true }, 'PUT')
  ).json();
  assert.equal((await send('/threads', { revision: grant.revision })).status, 200);
  const previewResponse = await send('/preview', {
    revision: grant.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const response = await send('/digests', {
    previewId: preview.id,
    revision: null,
    summary: 'HTTP итог',
    excerptIds: [],
    confirm: true,
  });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(x.context.read(saved.id).summary, 'HTTP итог');
});
test('native CLI reads an empty isolated home; stdio rejects mutating methods, server approvals and incompatible versions', async (t) => {
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
  assert.match((await transport.probe()).version, /^0\.158\./);
  const result = await transport.read(new AbortController().signal, (rpc) =>
    rpc.request('thread/list', { cwd: [f.root], limit: 10, archived: false, useStateDbOnly: true }),
  );
  assert.deepEqual((result as { data: unknown[] }).data, []);
  await assert.rejects(() => access(marker), { code: 'ENOENT' });
  const script = path.join(f.root, 'rpc.cjs'),
    log = path.join(f.root, 'methods.log');
  await writeFile(
    script,
    `const fs=require('node:fs'),rl=require('node:readline');if(process.argv.includes('--version')){console.log('codex-cli 0.158.0');process.exit();}rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(m)+'\\n');if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}));console.log(JSON.stringify({id:999,method:'item/commandExecution/requestApproval',params:{}}));}else if(m.method==='thread/list')setTimeout(()=>console.log(JSON.stringify({id:m.id,result:{data:[],nextCursor:null}})),20);});`,
  );
  const fake = new LocalCodex(process.execPath, [script], { ...process.env, FIXTURE_LOG: log });
  await fake.read(new AbortController().signal, async (rpc) => {
    await assert.rejects(() => rpc.request('turn/start' as ReadMethod, {}), /только методы/);
    return rpc.request('thread/list', { cwd: [f.root] });
  });
  const lines = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.id === 999 && line.error?.code === -32601));
  assert.ok(!lines.some((line) => line.method === 'turn/start'));
  await writeFile(script, "console.log('codex-cli 99.0.0');");
  await assert.rejects(() => fake.probe(), /протокол/);
});
test('schema 10 upgrades with a verified copy and retained IDs; failed DDL leaves version 10 intact', async (t) => {
  const x = await setup(t);
  x.store.db.exec('DROP TABLE codex_digests;DROP TABLE codex_grants;PRAGMA user_version=10;');
  const upgraded = new Store(x.file);
  x.others.push(upgraded);
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 11);
  assert.ok(upgraded.project(x.project.id));
  const name = (await readdir(path.join(x.f.root, 'backups'))).find((name) =>
    name.startsWith('before-codex-v11'),
  );
  assert.ok(name);
  const backup = new DatabaseSync(path.join(x.f.root, 'backups', name), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 10);
  backup.close();
  const failed = path.join(x.f.root, 'failed.sqlite');
  const seed = new Store(failed);
  seed.db.exec('DROP TABLE codex_digests;DROP TABLE codex_grants;PRAGMA user_version=10;');
  seed.close();
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS codex_grants'))
      throw new Error('injected v11 failure');
    return exec.call(this, sql);
  };
  try {
    assert.throws(() => new Store(failed), /injected/);
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  const check = new DatabaseSync(failed);
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 10);
  check.close();
});

test('save rejects edits within the same timestamp; stale CAS cannot overwrite a newer local digest', async (t) => {
  const x = await setup(t);
  const { grant, preview } = await x.capture();
  x.fake.state.text = 'Changed without bumping updatedAt';
  await assert.rejects(
    () =>
      x.context.save(x.project.id, {
        previewId: preview.id,
        revision: null,
        summary: 'Old summary',
        excerptIds: [],
        confirm: true,
      }),
    /изменился после/,
  );
  assert.equal(x.context.list().items.length, 0);
  const fresh = await x.context.preview(x.project.id, {
    revision: grant.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  const input = {
    previewId: fresh.id,
    revision: null,
    summary: 'Fresh summary',
    excerptIds: [],
    confirm: true,
  };
  const saved = await x.context.save(x.project.id, input);
  assert.throws(() => x.context.delete(saved.id, { revision: saved.revision + 1, confirm: true }));
  const changed = await x.context.preview(x.project.id, {
    revision: grant.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  const next = await x.context.save(x.project.id, {
    ...input,
    previewId: changed.id,
    revision: saved.revision,
    summary: 'New local edit',
  });
  const stalePreview = await x.context.preview(x.project.id, {
    revision: grant.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  await assert.rejects(
    () =>
      x.context.save(x.project.id, {
        ...input,
        previewId: stalePreview.id,
        revision: saved.revision,
      }),
    /уже изменён/,
  );
  assert.equal(x.context.read(saved.id).summary, next.summary);
});

test('revocation aborts in-flight reads and shutdown waits for their owner before closing storage', async (t) => {
  const x = await setup(t);
  const grant = await x.enable();
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transport = {
    probe: x.fake.transport.probe,
    read: async <T>(signal: AbortSignal, _action: unknown): Promise<T> =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener('abort', () => reject(new HttpError(503, 'Fixture aborted')), {
          once: true,
        });
      }),
  };
  const context = new CodexContext(x.store, transport);
  const reading = context.threads(x.project.id, { revision: grant.revision });
  const rejected = assert.rejects(() => reading, /aborted/);
  await ready;
  await assert.rejects(
    () => context.threads(x.project.id, { revision: grant.revision }),
    /Дождитесь/,
  );
  await context.configure(x.project.id, { revision: grant.revision, enabled: false });
  await rejected;
  await context.stop();
  await assert.rejects(
    () => context.threads(x.project.id, { revision: grant.revision }),
    /остановлено/,
  );
});

test('oversized stdio output is discarded and closed without echoing content', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const script = path.join(f.root, 'large.cjs');
  await writeFile(
    script,
    "if(process.argv.includes('--version')){console.log('codex-cli 0.158.0');process.exit();}process.stdin.once('data',()=>process.stdout.write('DO_NOT_ECHO_PRIVATE_TEXT'+ 'x'.repeat(3*1024*1024)));process.stdin.resume();",
  );
  const transport = new LocalCodex(process.execPath, [script]);
  await assert.rejects(
    () => transport.read(new AbortController().signal, async () => null),
    (error) =>
      error instanceof HttpError && error.status === 503 && !error.message.includes('DO_NOT_ECHO'),
  );
});

test('a reader policy change cannot inherit consent or make an old digest eligible after re-enabling', async (t) => {
  const x = await setup(t);
  const { grant, preview } = await x.capture();
  const saved = await x.context.save(x.project.id, {
    previewId: preview.id,
    revision: null,
    summary: 'Мой итог',
    excerptIds: [],
    confirm: true,
  });
  x.store.db
    .prepare("UPDATE codex_grants SET policy_version='previous-policy' WHERE project_id=?")
    .run(x.project.id);
  assert.equal(x.context.grant(x.project.id).enabled, false);
  assert.equal(x.context.read(saved.id).eligible, false);
  await assert.rejects(
    () => x.context.threads(x.project.id, { revision: grant.revision }),
    /изменился/,
  );
  const renewed = await x.enable();
  assert.equal(x.context.read(saved.id).eligible, false);
  await x.context.threads(x.project.id, { revision: renewed.revision });
  const fresh = await x.context.preview(x.project.id, {
    revision: renewed.revision,
    reviewId: x.review.id,
    threadId: x.fake.threadId,
  });
  const recaptured = await x.context.save(x.project.id, {
    previewId: fresh.id,
    revision: saved.revision,
    summary: saved.summary,
    excerptIds: [],
    confirm: true,
  });
  assert.equal(recaptured.eligible, true);
  assert.equal(recaptured.id, saved.id);
  x.store.db.prepare('UPDATE projects SET available=0 WHERE id=?').run(x.project.id);
  const unavailable = x.context.grant(x.project.id);
  assert.equal(unavailable.enabled, false);
  assert.equal(unavailable.approved, true);
  await x.context.configure(x.project.id, { revision: unavailable.revision, enabled: false });
  x.store.db.prepare('UPDATE projects SET available=1 WHERE id=?').run(x.project.id);
  assert.equal(x.context.grant(x.project.id).approved, false);
  assert.equal(x.context.read(saved.id).eligible, false);
});
