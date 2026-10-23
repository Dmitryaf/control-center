import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.js';

test('offline evaluation entrypoint freezes eight packets, distinguishes missing/valid/invalid answers and never infers prose quality', async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const directory = path.join(f.root, 'evaluation');
  const command = async (mode: string) =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/evaluate-period-analysis.ts', mode, directory],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          CONTROL_CENTER_OPENAI_MODEL: '',
          CONTROL_CENTER_CODEX_PATH: path.join(f.root, 'codex-not-installed'),
        },
        timeout: 60000,
        maxBuffer: 100000,
      },
    );
  await command('prepare');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.cases.length, 8);
  assert.equal(manifest.purpose, 'analysis_evaluation');
  await command('review');
  const results = async () =>
    JSON.parse(await readFile(path.join(directory, 'evaluation.json'), 'utf8')).results as {
      id: string;
      structure: string;
      quality: string;
    }[];
  assert.ok(
    (await results()).every(
      (item) => item.structure === 'missing' && item.quality === 'unverified',
    ),
  );
  const id = manifest.cases[0].id;
  const file = path.join(directory, 'packets', `${id}.json`);
  const input = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(input.purpose, 'analysis_evaluation');
  assert.ok(input.instructions.includes('Тихий период'));
  assert.ok(!input.instructions.includes('recognize'));
  const answerFile = path.join(directory, 'responses', `${id}.json`);
  const answer = {
    report: {
      narrative: 'Синтетический ответ теста, не ответ модели.',
      findings: [],
      uncertainties: [],
      proposals: [],
    },
    provenance: { kind: 'fixture', model: 'fixture', recordedAt: new Date().toISOString() },
  };
  await writeFile(answerFile, JSON.stringify(answer));
  await command('review');
  assert.equal((await results())[0].structure, 'valid');
  assert.equal((await results())[0].quality, 'requires_manual_review');
  await writeFile(
    answerFile,
    JSON.stringify({
      ...answer,
      report: {
        ...answer.report,
        findings: [{ statement: 'Чужое утверждение', sources: ['outside-packet'] }],
      },
    }),
  );
  await command('review');
  assert.equal((await results())[0].structure, 'rejected');
  assert.equal((await results())[0].quality, 'unverified');
  await writeFile(file, JSON.stringify({ ...input, instructions: 'changed' }));
  await assert.rejects(() => command('review'), /Frozen packet changed/);
  await assert.rejects(() => command('prepare'), /EEXIST/);
});
