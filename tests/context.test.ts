import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rename, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { Records } from '../server/records.js';
import { defaultSettings, type Workspace } from '../shared/contracts.js';
import { createApp } from '../server/app.js';
import { exportMetadata } from '../server/projects/metadata.js';

const decision = (id: string, title: string) => `---
schema_version: 1
id: ${id}
title: ${title}
date: "2026-10-05"
status: accepted
area: data
implementation: implemented
visibility: repository
---
Private body not for export.
`;

test('visibility is explicit; audit uses Git index, exact allowlist and local-only Kit', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('public-project');
  await mkdir(path.join(repo, '.ai-rules'));
  await mkdir(path.join(repo, '.local'));
  await mkdir(path.join(repo, 'decisions'));
  await writeFile(path.join(repo, '.ai-rules', 'RULESET.md'), '# Local runtime');
  await writeFile(path.join(repo, 'AGENTS.md'), '# Local routing');
  await writeFile(path.join(repo, '.local', 'notes.md'), '# Internal');
  await writeFile(path.join(repo, 'DECISIONS.md'), '# Public ADR map');
  await writeFile(path.join(repo, 'decisions', 'legacy.md'), '# Public ADR');
  f.git(repo, 'remote', 'add', 'origin', 'https://example.invalid/public-name.git');
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const id = projects.list()[0].id;
  assert.equal(projects.list()[0].context.visibility, 'unknown');
  await projects.context.save(id, { visibility: 'public', privateContextPath: null });
  let project = await projects.refresh(id);
  assert.equal(project.context.audit.kit, 'local');
  assert.deepEqual(project.context.audit.findings, []); // Existing untracked documents are not publication.
  f.git(repo, 'add', '.ai-rules', 'AGENTS.md', '.local', 'DECISIONS.md', 'decisions');
  project = await projects.refresh(id);
  assert.equal(project.context.audit.kit, 'tracked');
  assert.equal(
    project.context.audit.findings.filter((finding) => finding.kind === 'infrastructure').length,
    3,
  );
  assert.equal(
    project.context.audit.findings.filter((finding) => finding.kind === 'document').length,
    2,
  );
  assert.ok(project.signals.some((signal) => signal.code === 'publication-infrastructure'));
  await projects.context.allow(id, 'DECISIONS.md', true);
  project = await projects.refresh(id);
  assert.ok(!project.context.audit.findings.some((finding) => finding.path === 'DECISIONS.md'));
  assert.ok(
    project.context.audit.findings.some((finding) => finding.path === 'decisions/legacy.md'),
  );
  await assert.rejects(projects.context.allow(id, '../elsewhere', true));
  await projects.context.allow(id, 'DECISIONS.md', false);
  assert.ok(
    (await projects.refresh(id)).context.audit.findings.some(
      (finding) => finding.path === 'DECISIONS.md',
    ),
  );
  // A tracked file removed from disk is still in the index until staged for deletion.
  await rename(path.join(repo, '.local', 'notes.md'), path.join(repo, '.local', 'moved.md'));
  assert.ok(
    (await projects.refresh(id)).context.audit.findings.some(
      (finding) => finding.path === '.local/notes.md',
    ),
  );
  f.git(repo, 'rm', '--cached', '-r', '--', '.ai-rules', 'AGENTS.md');
  assert.equal((await projects.refresh(id)).context.audit.kit, 'local');
  for (const visibility of ['private', 'unknown']) {
    await projects.context.save(id, { visibility, privateContextPath: null });
    project = await projects.refresh(id);
    assert.equal(project.context.visibility, visibility);
    assert.deepEqual(project.context.audit.findings, []);
    assert.ok(!project.signals.some((signal) => signal.code.startsWith('publication-')));
  }
  await assert.rejects(
    projects.context.save(id, { visibility: 'invented', privateContextPath: null }),
  );
  await projects.context.save(id, { visibility: 'public', privateContextPath: null });
  await rename(path.join(repo, '.git'), path.join(repo, 'git-unavailable'));
  assert.equal((await projects.refresh(id)).context.audit.status, 'unavailable');
});

test('private context combines canonical sources, fresh content, persistent loss signal and safe disconnect', async (t) => {
  const f = await fixture();
  const dbPath = path.join(f.root, 'state.sqlite');
  let store = new Store(dbPath);
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('project');
  const privateRoot = path.join(f.root, 'private-context');
  await mkdir(path.join(privateRoot, 'decisions'), { recursive: true });
  await mkdir(path.join(repo, 'decisions'));
  const publicFile = path.join(repo, 'decisions', 'one.md');
  const privateFile = path.join(privateRoot, 'decisions', 'two.md');
  await writeFile(publicFile, decision('D-0001', 'Public choice'));
  await writeFile(privateFile, decision('D-0002', 'Private choice'));
  await writeFile(path.join(privateRoot, 'DECISIONS.md'), '# Navigation');
  await writeFile(path.join(privateRoot, 'PROJECT_MAP.md'), '# Map');
  await writeFile(
    path.join(privateRoot, 'decisions', 'old.md'),
    '# Legacy private\nHistorical body',
  );
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  let projects = new Projects(store);
  await projects.scan();
  const id = projects.list()[0].id;
  new Records(store).save('decisions', {
    title: 'Local decision',
    decision: 'Preserved',
    date: '2026-10-05',
    projectId: id,
  });
  await projects.context.save(id, { visibility: 'public', privateContextPath: privateRoot });
  let project = await projects.refresh(id);
  assert.equal(project.context.privateStatus, 'connected');
  assert.equal(project.context.hasPrivateMap, true);
  assert.equal(project.context.hadPrivateRecords, true);
  const files = projects.decisions.list();
  assert.equal(files.length, 3);
  assert.equal(files.filter((file) => file.source === 'private_context').length, 2);
  assert.ok(files.every((file) => file.body === ''));
  assert.equal(new Records(store).list('decisions').length, 1);
  const selected = files.find((file) => file.metadata?.id === 'D-0002')!;
  await writeFile(
    privateFile,
    decision('D-0002', 'Private choice').replace(
      'Private body not for export.',
      'Fresh canonical body',
    ),
  );
  assert.equal((await projects.decisions.content(id, selected.key)).body, 'Fresh canonical body');
  await assert.rejects(projects.decisions.content(id, 'unindexed-path'));
  await writeFile(privateFile, decision('D-0001', 'Conflicting choice'));
  await projects.refresh(id);
  assert.equal(
    projects.decisions.list().filter((file) => file.error?.includes('Конфликт ID решений: D-0001'))
      .length,
    2,
  );
  await exportMetadata(repo, project.metadata, null);
  const yaml = await readFile(path.join(repo, 'PROJECT.yaml'), 'utf8');
  assert.ok(!yaml.includes(privateRoot));
  assert.ok(!yaml.includes('private_context'));
  assert.ok(!yaml.includes('Private body'));
  assert.equal(await readFile(publicFile, 'utf8'), decision('D-0001', 'Public choice'));
  const rows = JSON.stringify(
    store.db.prepare('SELECT snapshot, metadata, notes FROM projects').all(),
  );
  assert.ok(!rows.includes('Private body'));
  assert.ok(!rows.includes('Conflicting choice'));
  const moved = path.join(f.root, 'private-moved');
  await rename(privateRoot, moved);
  store.close();
  store = new Store(dbPath);
  projects = new Projects(store);
  await projects.scan();
  project = projects.list()[0];
  assert.equal(project.context.privateStatus, 'unavailable');
  assert.ok(project.signals.some((signal) => signal.code === 'private-context-unavailable'));
  assert.ok(!projects.decisions.list().some((file) => file.source === 'private_context'));
  await assert.rejects(projects.decisions.content(id, selected.key));
  await projects.context.save(id, { visibility: 'private', privateContextPath: privateRoot });
  assert.ok(
    !(await projects.refresh(id)).signals.some(
      (signal) => signal.code === 'private-context-unavailable',
    ),
  );
  await projects.context.save(id, { visibility: 'public', privateContextPath: moved });
  assert.equal((await projects.refresh(id)).context.privateStatus, 'connected');
  await projects.context.save(id, { visibility: 'public', privateContextPath: null });
  project = await projects.refresh(id);
  assert.equal(project.context.privateStatus, 'disconnected');
  assert.equal(project.context.hadPrivateRecords, false);
  await access(path.join(moved, 'decisions', 'two.md'));
  assert.ok(!projects.decisions.list().some((file) => file.source === 'private_context'));
  await assert.rejects(
    projects.context.save(id, { visibility: 'public', privateContextPath: repo }),
  );
  await assert.rejects(
    projects.context.save(id, {
      visibility: 'public',
      privateContextPath: path.join(repo, 'decisions'),
    }),
  );
  const link = path.join(f.root, 'linked');
  await symlink(moved, link, 'junction');
  await assert.rejects(
    projects.context.save(id, { visibility: 'public', privateContextPath: link }),
  );
});

test('empty canonical body stays indexed; losing an unused context does not invent missing records', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('empty-body');
  await writeFile(
    path.join(repo, 'DECISIONS.md'),
    decision('D-0009', 'Metadata only').replace('Private body not for export.', ''),
  );
  const root = path.join(f.root, 'unused-context');
  await mkdir(root);
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const id = projects.list()[0].id;
  const record = projects.decisions.list()[0];
  assert.equal(record.hasContent, true);
  assert.equal((await projects.decisions.content(id, record.key)).body, '');
  await projects.context.save(id, { visibility: 'public', privateContextPath: root });
  assert.equal((await projects.refresh(id)).context.hadPrivateRecords, false);
  await rename(root, path.join(f.root, 'moved-unused'));
  const project = await projects.refresh(id);
  assert.equal(project.context.privateStatus, 'unavailable');
  assert.ok(!project.signals.some((signal) => signal.code === 'private-context-unavailable'));
});

test('old SQLite v2 migrates without moving local decisions, legacy paths or checks; reopening is idempotent', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const dbPath = path.join(f.root, 'old.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, metadata TEXT, notes TEXT NOT NULL DEFAULT '', available INTEGER NOT NULL DEFAULT 1, yaml_base_hash TEXT, decision_sources TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT REFERENCES projects(id), data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE checks(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), idea_id TEXT REFERENCES records(id), data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    PRAGMA user_version=2;
  `);
  old
    .prepare('INSERT INTO projects(id,path,snapshot,notes,decision_sources) VALUES(?,?,?,?,?)')
    .run('project-id', 'old-path', '{}', 'Owner note', '["old-private-directory"]');
  old.exec(
    `INSERT INTO records VALUES('decision-id','decisions','project-id','{"title":"Local choice"}','before','before'); INSERT INTO checks VALUES('check-id','project-id',NULL,'{"title":"Keep check"}','before','before');`,
  );
  old.close();
  for (let i = 0; i < 2; i++) {
    const store = new Store(dbPath);
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 4);
      const row = store.project('project-id')!;
      assert.equal(row.visibility, 'unknown');
      assert.equal(row.private_context_path, null);
      assert.equal(row.decision_sources, '["old-private-directory"]');
      assert.equal(row.notes, 'Owner note');
      assert.equal(store.db.prepare('SELECT id FROM records').get()?.id, 'decision-id');
      assert.equal(store.db.prepare('SELECT id FROM checks').get()?.id, 'check-id');
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      store.close();
    }
  }
});

test('context API validates writes and serves current canonical text without exporting private settings', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  });
  const port = (server.address() as { port: number }).port;
  server.on('request', createApp(store, port).app);
  const request = (url: string, method = 'GET', data?: unknown) =>
    fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(data),
    });
  const repo = await f.repo('api-project');
  const privateRoot = path.join(f.root, 'private');
  await mkdir(privateRoot);
  await writeFile(
    path.join(privateRoot, 'DECISIONS.md'),
    '# Standalone private\nCanonical private body',
  );
  assert.equal(
    (await request('/settings', 'PUT', { ...defaultSettings, roots: [repo] })).status,
    200,
  );
  let workspace = (await (await request('/workspace')).json()) as Workspace;
  const id = workspace.projects[0].id;
  assert.equal(
    (
      await request(`/projects/${id}/context`, 'PUT', {
        visibility: 'invalid',
        privateContextPath: null,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/projects/${id}/context`, 'PUT', {
        visibility: 'public',
        privateContextPath: privateRoot,
      })
    ).status,
    200,
  );
  workspace = (await (await request('/workspace')).json()) as Workspace;
  const file = workspace.fileDecisions[0];
  assert.equal(file.source, 'private_context');
  assert.equal(file.body, '');
  const response = await request(`/projects/${id}/decision-content`, 'POST', { key: file.key });
  assert.equal(response.status, 200);
  assert.match((await response.json()).body, /Canonical private body/);
  assert.equal(
    (await request(`/projects/${id}/decision-content`, 'POST', { key: privateRoot })).status,
    404,
  );
  assert.equal(
    (
      await request(`/projects/${id}/publication-allowlist`, 'PUT', {
        path: '../unknown',
        allowed: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/projects/${id}/export`, 'POST', { expectedHash: null })).status,
    200,
  );
  const yaml = await readFile(path.join(repo, 'PROJECT.yaml'), 'utf8');
  assert.ok(!yaml.includes(privateRoot));
  assert.ok(!yaml.includes('Canonical private body'));
});
