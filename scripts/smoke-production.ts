import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fixture } from '../tests/fixtures.js';
import type { Workspace, Task, TaskHistoryPage } from '../shared/contracts.js';
import type { Observation } from '../shared/observations.js';
import type { Review } from '../shared/reviews.js';
import type { PeriodRun } from '../shared/period-analysis.js';

const fixtureData = await fixture();
const repo = await fixtureData.repo('production-project');
const base = 'http://127.0.0.1:4321';
let processHandle: ChildProcess | null = null;
let output = '';
const dataDirectory = path.join(fixtureData.root, 'data');
async function start() {
  output = '';
  processHandle = spawn(process.execPath, ['dist/server/server/index.js'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '4321',
      CONTROL_CENTER_DATA_DIR: dataDirectory,
      OPENAI_API_KEY: '',
      CONTROL_CENTER_OPENAI_MODEL: '',
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
  const analysisStatus = await (await request('/api/analysis/status')).json();
  assert.equal(analysisStatus.ready, false);
  assert.equal(analysisStatus.model, null);
  const previewResponse = await request('/api/analysis/prepare', 'POST', { projectIds: [id] });
  assert.equal(previewResponse.status, 200);
  const analysisPreview = await previewResponse.json();
  assert.ok(!JSON.stringify(analysisPreview).includes(repo));
  assert.equal(
    (await request('/api/analysis/run', 'POST', { previewId: analysisPreview.id, consent: true }))
      .status,
    503,
  );
  assert.match(await (await request('/analysis')).text(), /Control Center/);
  const privateRoot = path.join(fixtureData.root, 'private-context');
  await mkdir(privateRoot);
  await writeFile(
    path.join(privateRoot, 'DECISIONS.md'),
    '# Private production choice\nCanonical private body',
  );
  await writeFile(path.join(repo, 'DECISIONS.md'), '# Public production choice');
  fixtureData.git(repo, 'add', 'DECISIONS.md');
  assert.equal(
    (
      await request(`/api/projects/${id}/context`, 'PUT', {
        visibility: 'public',
        privateContextPath: privateRoot,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/projects/${id}/publication-allowlist`, 'PUT', {
        path: 'DECISIONS.md',
        allowed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/api/projects/${id}/export`, 'POST', { expectedHash: null })).status,
    200,
  );
  assert.ok(!(await readFile(path.join(repo, 'PROJECT.yaml'), 'utf8')).includes(privateRoot));
  assert.equal(workspace.projects[0].snapshot.yaml.exists, false);
  const created = await request('/api/tasks', 'POST', {
    title: 'Persists across restart',
    projectId: id,
  });
  assert.equal(created.status, 201);
  const task = (await created.json()) as Task;
  const completedResponse = await request(`/api/tasks/${task.id}/complete`, 'POST', {
    revision: task.revision,
    result: { summary: 'Production result', verified: 'Production HTTP' },
  });
  assert.equal(completedResponse.status, 200);
  const history = (await (
    await request(`/api/task-history?identifier=${task.code}`)
  ).json()) as TaskHistoryPage;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].task.result?.summary, 'Production result');
  const checkResponse = await request('/api/checks', 'POST', {
    check: {
      title: 'Production check',
      projectId: id,
      question: 'Question',
      assumption: 'Assumption',
      expectedExternalResult: 'Result',
      startedAt: '2020-01-01',
      continueIf: 'Yes',
      stopIf: 'No',
      nextExternalAction: 'Ask',
    },
  });
  assert.equal(checkResponse.status, 201);
  const check = (await checkResponse.json()) as { id: string };
  assert.equal(
    (
      await request(`/api/checks/${check.id}/entries`, 'POST', {
        kind: 'evidence',
        text: 'Preserve evidence',
        occurredAt: '2020-01-02',
        type: 'fact',
        numericValue: 2,
      })
    ).status,
    201,
  );
  const observationResponse = await request('/api/observations', 'POST', {
    body: 'Production observation',
    occurredOn: '2020-01-02',
    projectId: id,
  });
  assert.equal(observationResponse.status, 201);
  const observation = (await observationResponse.json()) as Observation;
  const reviewResponse = await request('/api/reviews', 'POST', {
    projectId: id,
    kind: 'week',
    anchorDate: '2020-01-02',
  });
  assert.equal(reviewResponse.status, 201);
  const createdReview = (await reviewResponse.json()) as Review;
  const editedReview = await request(`/api/reviews/${createdReview.id}`, 'PATCH', {
    revision: createdReview.revision,
    userText: 'Production review',
  });
  assert.equal(editedReview.status, 200);
  const review = (await editedReview.json()) as Review;
  const periodPreviewResponse = await request('/api/period-analysis/prepare', 'POST', {
    reviewId: review.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: {
      projectIds: [id],
      includeGeneral: false,
      sourceKinds: [],
      includeMetadata: false,
      includeOpenTasks: false,
      includeUserText: true,
      includeRelatedReviews: false,
    },
  });
  assert.equal(periodPreviewResponse.status, 201);
  const periodPreview = (await periodPreviewResponse.json()) as PeriodRun;
  assert.equal(periodPreview.status, 'pending');
  assert.equal(periodPreview.approvedAt, null);
  const codexGrantResponse = await request(`/api/projects/${id}/codex-context`, 'PUT', {
    revision: null,
    enabled: true,
    readConsent: true,
  });
  assert.equal(codexGrantResponse.status, 200);
  const codexGrant = await codexGrantResponse.json();
  const importedResponse = await request('/api/period-analysis/import-codex', 'POST', {
    projectId: id,
    reviewId: review.id,
    requestKey: randomUUID(),
    context: 'Synthetic operator context, not a real dialog.',
    confirm: true,
    report: {
      narrative: 'Production imported analysis',
      findings: [],
      uncertainties: [],
      proposals: [],
    },
  });
  assert.equal(importedResponse.status, 201);
  const imported = (await importedResponse.json()) as PeriodRun;
  const backupResponse = await request('/api/backup', 'POST', {});
  assert.equal(backupResponse.status, 200);
  const backup = (await backupResponse.json()) as { path: string };
  const backupDb = new DatabaseSync(backup.path, { readOnly: true });
  assert.equal(
    (backupDb.prepare('SELECT COUNT(*) AS n FROM check_entries').get() as { n: number }).n,
    1,
  );
  assert.equal(backupDb.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  assert.equal(
    backupDb.prepare('SELECT enabled FROM codex_grants WHERE project_id=?').get(id)?.enabled,
    0,
  );
  assert.equal(
    backupDb.prepare('SELECT status FROM analysis_runs WHERE id=?').get(imported.id)?.status,
    'succeeded',
  );
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS n FROM task_history').get()?.n, 1);
  assert.equal(
    backupDb.prepare('SELECT status FROM analysis_runs WHERE id=?').get(periodPreview.id)?.status,
    'cancelled',
  );
  assert.equal(
    backupDb.prepare('SELECT user_text FROM reviews WHERE id=?').get(review.id)?.user_text,
    'Production review',
  );
  assert.equal(
    backupDb.prepare('SELECT body FROM observations WHERE id=?').get(observation.id)?.body,
    'Production observation',
  );
  assert.equal(
    backupDb.prepare('SELECT private_context_path FROM projects WHERE id=?').get(id)
      ?.private_context_path,
    privateRoot,
  );
  backupDb.close();
  assert.match(await (await request(`/projects/${id}`)).text(), /Control Center/);
  await stop();
  await start();
  const restarted = (await (await request('/api/workspace')).json()) as Workspace;
  assert.deepEqual(await (await request(`/api/projects/${id}/codex-context`)).json(), codexGrant);
  assert.deepEqual(await (await request(`/api/period-analysis/${imported.id}`)).json(), imported);
  assert.deepEqual(
    await (await request(`/api/period-analysis/${periodPreview.id}`)).json(),
    periodPreview,
  );
  assert.match(
    await (await request(`/period-analysis?review=${review.id}&run=${periodPreview.id}`)).text(),
    /Control Center/,
  );
  assert.deepEqual(await (await request(`/api/reviews/${review.id}`)).json(), review);
  const monthResponse = await request('/api/reviews', 'POST', {
    projectId: id,
    kind: 'month',
    anchorDate: '2020-01-02',
  });
  assert.equal(monthResponse.status, 201);
  const month = (await monthResponse.json()) as Review;
  const monthPacketResponse = await request('/api/period-analysis/prepare', 'POST', {
    reviewId: month.id,
    requestKey: randomUUID(),
    readConsent: true,
    selection: {
      projectIds: [id],
      includeGeneral: false,
      sourceKinds: ['observation'],
      includeMetadata: false,
      includeOpenTasks: false,
      includeUserText: false,
      includeRelatedReviews: true,
      includeRelatedAnalyses: true,
    },
  });
  assert.equal(monthPacketResponse.status, 201);
  const monthPacket = (await monthPacketResponse.json()) as PeriodRun;
  assert.ok(
    monthPacket.payload.sources.some((source) => source.text.includes('Production observation')),
  );
  assert.ok(
    monthPacket.payload.sources.some((source) => source.text.includes('Production review')),
  );
  assert.ok(
    monthPacket.payload.sources.some((source) =>
      source.text.includes('Production imported analysis'),
    ),
  );
  const reviewSources = await (await request(`/api/reviews/${review.id}/history`)).json();
  assert.ok(
    reviewSources.items.some((entry: { sourceId: string }) => entry.sourceId === observation.id),
  );
  assert.ok(reviewSources.items.every((entry: { kind: string }) => entry.kind !== 'review'));
  assert.match(await (await request(`/reviews?id=${review.id}`)).text(), /Control Center/);
  assert.equal(
    (await request('/api/analysis/run', 'POST', { previewId: analysisPreview.id, consent: true }))
      .status,
    410,
  );
  assert.equal(restarted.tasks[0].title, 'Persists across restart');
  assert.deepEqual(
    await (await request(`/api/task-history?identifier=${task.code}`)).json(),
    history,
  );
  assert.match(await (await request(`/history?task=${task.code}`)).text(), /Control Center/);
  assert.match(await (await request('/timeline')).text(), /Control Center/);
  assert.match(
    await (await request(`/observations?id=${observation.id}`)).text(),
    /Control Center/,
  );
  assert.deepEqual(
    await (await request(`/api/observations/${observation.id}`)).json(),
    observation,
  );
  const unified = await (await request(`/api/history?projectId=${id}`)).json();
  assert.ok(
    unified.items.some(
      (entry: { event: string; excerpt: string }) =>
        entry.event === 'task_completed' && entry.excerpt === 'Production result',
    ),
  );
  assert.ok(unified.items.some((entry: { event: string }) => entry.event === 'check_started'));
  assert.ok(
    unified.items.some(
      (entry: { event: string; excerpt: string }) =>
        entry.event === 'observation' && entry.excerpt === 'Production observation',
    ),
  );
  assert.equal(restarted.projects[0].id, id);
  assert.equal(restarted.projects[0].available, true);
  assert.ok(restarted.scan.scannedAt);
  assert.equal(restarted.checks[0].id, check.id);
  assert.equal(restarted.checkEntries[0].numericValue, 2);
  assert.equal(restarted.projects[0].context.visibility, 'public');
  assert.equal(restarted.projects[0].context.privateStatus, 'connected');
  assert.deepEqual(restarted.projects[0].context.allowlist, ['DECISIONS.md']);
  assert.deepEqual(restarted.projects[0].context.audit.findings, []);
  const privateDecision = restarted.fileDecisions.find(
    (record) => record.source === 'private_context',
  )!;
  assert.equal(privateDecision.body, '');
  const content = await request(`/api/projects/${id}/decision-content`, 'POST', {
    key: privateDecision.key,
  });
  assert.match((await content.json()).body, /Canonical private body/);
  await stop();
  console.log(
    'Production smoke passed: assets, scan, tasks, work history, optional analysis configuration/expiry, checks, private context, audit allowlist, canonical text, safe export, backup, restart, deep links.',
  );
} finally {
  await stop();
  await fixtureData.cleanup();
}
