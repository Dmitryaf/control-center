import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';
import { Store } from '../server/db.js';
import { Projects } from '../server/projects/projects.js';
import { defaultSettings } from '../shared/contracts.js';
import { parseDecision, decisionSignals } from '../server/decisions/index.js';

const decisionText = (id = 'D-0001') => `---
schema_version: 1
id: ${id}
title: Canonical choice
date: 2026-10-01
status: accepted
area: local_data
implementation: not_implemented
review_after: 2026-10-05
supersedes: []
superseded_by: null
visibility: repository
---
# Choice
Keep the rationale in its source.
`;

test('structured decisions, legacy text, invalid metadata and exact review boundary', () => {
  const parsed = parseDecision(decisionText(), 'project', '/decisions/D-0001.md', 'repository');
  assert.equal(parsed.error, null);
  assert.equal(parsed.metadata?.area, 'local_data');
  assert.equal(parsed.metadata?.superseded_by, null);
  assert.deepEqual(
    decisionSignals(parsed, '2026-10-04').map((s) => s.code),
    ['not-implemented'],
  );
  assert.deepEqual(
    decisionSignals(parsed, '2026-10-05').map((s) => s.code),
    ['decision-review', 'not-implemented'],
  );
  parsed.metadata!.status = 'superseded';
  assert.deepEqual(decisionSignals(parsed, '2026-10-06'), []);
  const legacy = parseDecision(
    '# Old decision\nPreserved rationale',
    'p',
    '/DECISIONS.md',
    'repository',
  );
  assert.equal(legacy.title, 'Old decision');
  assert.equal(legacy.metadata, null);
  assert.equal(legacy.error, null);
  const invalid = parseDecision(
    decisionText().replace('accepted', 'invented'),
    'p',
    'bad.md',
    'repository',
  );
  assert.match(invalid.error!, /status/);
  assert.deepEqual(decisionSignals(invalid), []);
});

test('repository and private sources remain read-only, preserve legacy and report duplicates and unavailable sources', async (t) => {
  const f = await fixture();
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await f.cleanup();
  });
  const repo = await f.repo('project');
  const publicDir = path.join(repo, 'decisions');
  const privateDir = path.join(f.root, 'private');
  await mkdir(publicDir);
  await mkdir(privateDir);
  await writeFile(path.join(repo, 'DECISIONS.md'), '# Decisions\nNavigation index');
  await writeFile(path.join(repo, 'PROJECT.yaml'), 'name: Project\n');
  await writeFile(path.join(publicDir, 'D-0001.md'), decisionText());
  await writeFile(path.join(publicDir, 'legacy.md'), '# Legacy\nStill valid');
  await writeFile(
    path.join(privateDir, 'D-0002.md'),
    decisionText('D-0002').replace('repository', 'private'),
  );
  store.saveSettings({ ...defaultSettings, roots: [repo] });
  const projects = new Projects(store);
  await projects.scan();
  const id = projects.list()[0].id;
  const sources = async (paths: string[]) => {
    store.db
      .prepare('UPDATE projects SET decision_sources=? WHERE id=?')
      .run(JSON.stringify(paths), id);
    await projects.refresh(id);
  };
  await sources([privateDir]);
  const records = projects.decisions.list();
  assert.equal(records.length, 3);
  assert.equal(records.filter((r) => r.source === 'private').length, 1);
  assert.equal(records.find((r) => r.title === 'Legacy')?.error, null);
  assert.equal(
    (store.db.prepare('SELECT COUNT(*) AS count FROM records').get() as { count: number }).count,
    0,
  );
  assert.equal(await readFile(path.join(repo, 'PROJECT.yaml'), 'utf8'), 'name: Project\n');
  assert.equal(
    await readFile(path.join(repo, 'DECISIONS.md'), 'utf8'),
    '# Decisions\nNavigation index',
  );
  assert.equal(await readFile(path.join(publicDir, 'D-0001.md'), 'utf8'), decisionText());
  assert.equal(
    await readFile(path.join(privateDir, 'D-0002.md'), 'utf8'),
    decisionText('D-0002').replace('repository', 'private'),
  );
  await writeFile(path.join(privateDir, 'duplicate.md'), decisionText());
  await projects.refresh(id);
  assert.equal(projects.decisions.list().filter((r) => r.error?.includes('повторяется')).length, 2);
  await sources([path.join(f.root, 'missing')]);
  assert.ok(projects.decisions.list().some((r) => r.error?.includes('недоступен')));
  const link = path.join(f.root, 'linked');
  await symlink(privateDir, link, 'junction');
  await sources([link]);
  assert.ok(projects.decisions.list().some((r) => r.source === 'private' && r.error));
  assert.equal(
    projects.decisions.list().filter((r) => r.source === 'private' && r.metadata).length,
    0,
  );
});
