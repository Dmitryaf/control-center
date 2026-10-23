import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.js';
import { codexFixture } from './codex-fixture.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Reviews } from '../server/reviews.js';
import { History } from '../server/history.js';
import { CodexContext } from '../server/codex/context.js';
import { PeriodAnalysis } from '../server/analysis/period-analysis.js';
import { AnalysisSchedules } from '../server/analysis/schedules.js';
import type { CodexTransport } from '../server/codex/rpc.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture();
  const roots = [await f.repo('one'), await f.repo('two')];
  const store = new Store(path.join(f.root, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  store.saveSettings({ ...store.settings(), roots, timezone: 'UTC' });
  const projects = new Projects(store);
  await projects.scan();
  const ids = roots.map((root) => projects.list().find((project) => project.path === root)!.id);
  const dialogs = roots.flatMap((root) => Array.from({ length: 3 }, () => codexFixture(root)));
  dialogs.forEach((dialog, index) => {
    dialog.state.updatedAt = Date.parse('2024-03-07T00:00:00Z') / 1000 + index;
    dialog.state.name = `Рабочий диалог ${index}`;
    dialog.state.text =
      `Цель обсуждения ${index}: проверить гипотезу на одном примере, потому что готовность ещё не подтверждена. `.repeat(
        15,
      );
  });
  let unavailable = false;
  const transport: CodexTransport = {
    probe: async () => ({ version: '2.42.7' }),
    read: (signal, action) =>
      action({
        request: async (method, params) => {
          const input = params as { cwd?: string[]; threadId?: string };
          if (unavailable) throw new Error('unavailable');
          if (method === 'thread/list') {
            const selected = dialogs.filter((dialog) => input.cwd?.includes(dialog.state.cwd));
            return {
              data: selected
                .map((dialog) => ({
                  id: dialog.threadId,
                  cwd: dialog.state.cwd,
                  name: dialog.state.name,
                  updatedAt: dialog.state.updatedAt,
                }))
                .reverse(),
              nextCursor: null,
            };
          }
          const dialog = dialogs.find((dialog) => dialog.threadId === input.threadId);
          assert.ok(dialog, 'Only a listed, scoped dialog can be read');
          return dialog.transport.read(signal, (rpc) => rpc.request(method, params));
        },
      }),
  };
  let now = Date.parse('2024-03-06T12:00:00Z');
  const context = new CodexContext(store, transport, () => now);
  const review = new Reviews(store).create({
    projectId: null,
    kind: 'week',
    anchorDate: '2024-03-06',
  });
  const permissions = [];
  for (const projectId of ids) {
    const grant = await context.configure(projectId, {
      revision: null,
      enabled: true,
      readConsent: true,
    });
    permissions.push({ projectId, revision: grant.revision! });
  }
  const prepare = () =>
    context.prepare({
      reviewId: review.id,
      projects: permissions,
      readConsent: true,
      saveConsent: true,
    });
  return {
    f,
    store,
    ids,
    dialogs,
    context,
    review,
    permissions,
    prepare,
    projects,
    clock: () => now,
    setNow: (value: string) => {
      now = Date.parse(value);
    },
    setUnavailable: () => {
      unavailable = true;
    },
  };
}

test('preparation saves two dialogs per project, bounded extracts, editable summaries and an idempotent repeat without paid calls', async (t) => {
  const x = await setup(t);
  await assert.rejects(
    () => x.context.prepare({ reviewId: x.review.id, projects: x.permissions, readConsent: true }),
    /true/,
  );
  const prepared = await x.prepare();
  assert.equal(prepared.items.length, 4);
  for (const id of x.ids)
    assert.equal(prepared.items.filter((item) => item.scopeProjectId === id).length, 2);
  for (const item of prepared.items) {
    assert.match(item.summary, /Автоматическая выборка/);
    assert.equal(item.excerpts.length, 2);
    assert.ok(item.excerpts.every((excerpt) => Buffer.byteLength(excerpt.text) <= 500));
    assert.ok(item.excerpts.some((excerpt) => excerpt.partial));
    assert.doesNotMatch(JSON.stringify(item), /DO_NOT_PERSIST|DO_NOT_EXPOSE/);
  }
  const edited = x.context.edit(prepared.items[0].id, {
    revision: prepared.items[0].revision,
    summary: 'Моя поправка: результат ещё неизвестен.',
    confirm: true,
  });
  const repeated = await x.prepare();
  assert.equal(repeated.items.find((item) => item.id === edited.id)?.summary, edited.summary);
  assert.equal(repeated.items.find((item) => item.id === edited.id)?.revision, edited.revision);
  const owner = new PeriodAnalysis(
    x.store,
    new History(x.store, x.projects.decisions),
    {},
    undefined,
    x.clock,
  );
  const run = owner.prepare({
    reviewId: x.review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: {
      projectIds: x.ids,
      includeGeneral: false,
      sourceKinds: [],
      includeMetadata: false,
      includeOpenTasks: false,
      includeUserText: false,
      includeRelatedReviews: false,
      codexDigestIds: prepared.items.map((item) => item.id),
    },
  });
  assert.equal(run.payload.sources.length, 4);
  assert.ok(run.payload.limitations.some((text) => text.includes('Включены только выбранные')));
  const reopened = new Store(x.store.path);
  try {
    assert.equal(new CodexContext(reopened).read(edited.id).summary, edited.summary);
  } finally {
    reopened.close();
  }
  await x.context.configure(x.ids[1], { revision: x.permissions[1].revision, enabled: false });
  await assert.rejects(x.prepare, /отключено/);
});

test('scheduled new dialogs require separate read/send permission, respect revocation and tolerate an unavailable optional reader', async (t) => {
  const x = await setup(t);
  let sends = 0;
  const owner = new PeriodAnalysis(
    x.store,
    new History(x.store, x.projects.decisions),
    { key: 'fixture', model: 'fixture-model' },
    async (_url, init) => {
      sends++;
      const request = JSON.parse(String(init!.body));
      assert.ok(request.input[0].content.includes('codex_digest'));
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  narrative: 'Итог по источникам.',
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
    x.clock,
  );
  const schedules = new AnalysisSchedules(x.store, owner, x.clock, x.context);
  const input = {
    reviewId: x.review.id,
    revision: null,
    expectedModel: 'fixture-model',
    readConsent: true,
    sendConsent: true,
    selection: {
      projectIds: x.ids,
      includeGeneral: false,
      sourceKinds: [],
      includeMetadata: true,
      includeOpenTasks: false,
      includeUserText: false,
      includeRelatedReviews: false,
    },
    codexProjectIds: x.ids,
  };
  assert.throws(() => schedules.enable(input), /отдельные согласия/);
  schedules.enable({ ...input, codexReadConsent: true, codexSendConsent: true });
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM codex_digests').get()?.n, 0);
  x.setNow('2024-03-11T00:00:01Z');
  await schedules.tick();
  assert.equal(sends, 1);
  assert.equal(owner.list(x.review.id).items[0].status, 'succeeded');
  await x.context.configure(x.ids[0], { revision: x.permissions[0].revision, enabled: false });
  x.setNow('2024-03-18T00:00:01Z');
  await schedules.tick();
  assert.equal(sends, 1);
  assert.equal(schedules.list().items[0].enabled, false);
  assert.throws(
    () =>
      schedules.resume(schedules.list().items[0].id, {
        revision: schedules.list().items[0].revision,
        confirm: true,
      }),
    /Codex изменился/,
  );

  const y = await setup(t);
  y.setUnavailable();
  const packets: { limitations: string[]; sources: { kind: string }[] }[] = [];
  const fallback = new PeriodAnalysis(
    y.store,
    new History(y.store, y.projects.decisions),
    { key: 'fixture', model: 'fixture-model' },
    async (_url, init) => {
      packets.push(JSON.parse(JSON.parse(String(init!.body)).input[0].content));
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  narrative: 'Только основные источники.',
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
    y.clock,
  );
  const fallbackSchedules = new AnalysisSchedules(y.store, fallback, y.clock, y.context);
  fallbackSchedules.enable({
    ...input,
    reviewId: y.review.id,
    selection: { ...input.selection, projectIds: y.ids },
    codexProjectIds: y.ids,
    codexReadConsent: true,
    codexSendConsent: true,
  });
  y.setNow('2024-03-11T00:00:01Z');
  await fallbackSchedules.tick();
  assert.equal(packets.length, 1);
  assert.ok(
    packets[0].limitations.some((text) => text.includes('Codex') && text.includes('недоступен')),
  );
  assert.ok(packets[0].sources.every((source) => source.kind !== 'codex_digest'));
});
