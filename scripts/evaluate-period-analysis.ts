import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { evaluationCases } from '../tests/period-evaluation-fixture.js';
import { evaluationPacket } from '../tests/evaluation-packet.js';
import { periodAnalysisPrompt, validatePeriodReport } from '../server/analysis/period-analysis.js';
import { digest, periodPolicyVersion } from '../server/analysis/period-context.js';
import { maxInputBytes, maxOutputTokens } from '../server/analysis/openai.js';
import { periodReportSchema, type PeriodPayload } from '../shared/period-analysis.js';

// Intentionally offline. This command cannot dispatch, read real project storage,
// invoke Codex, or claim that schema validation establishes model quality.
const criteria = [
  'factuality',
  'specificity',
  'natural_language',
  'uncertainty',
  'independent_judgment',
  'no_invented_results',
  'useful_proposals',
  'no_cliches',
] as const;
const manifestSchema = z.object({
  version: z.literal(1),
  policyVersion: z.string(),
  createdAt: z.string(),
  cases: z
    .array(
      z.object({
        id: z.enum(evaluationCases.map((item) => item.id) as [string, ...string[]]),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .length(8),
});
const answerSchema = z
  .object({
    report: periodReportSchema,
    provenance: z.object({
      kind: z.enum(['live_api', 'codex_manual', 'fixture']),
      model: z.string().min(1),
      recordedAt: z.string().datetime(),
      responseId: z.string().nullable().optional(),
    }),
  })
  .strict();
const humanSchema = z.array(
  z.object({
    id: z.string(),
    reviewer: z.string(),
    notes: z.string(),
    criteria: z.record(z.enum(criteria), z.enum(['pass', 'fail']).nullable()),
  }),
);
async function json(file: string) {
  if ((await stat(file)).size > 512000) throw new Error('Evaluation file exceeds 512 KB');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function save(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function prepare(directory: string) {
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory); // Existing packets, answers and human reviews are never overwritten.
  await mkdir(path.join(directory, 'packets'));
  await mkdir(path.join(directory, 'responses'));
  const cases: { id: string; hash: string }[] = [];
  for (const example of evaluationCases) {
    const packet = await evaluationPacket(example);
    try {
      const input = {
        purpose: 'analysis_evaluation',
        instructions: periodAnalysisPrompt,
        payload: packet.run.payload,
        responseSchema: z.toJSONSchema(periodReportSchema),
        limits: { maxInputBytes, maxOutputTokens },
      };
      await save(path.join(directory, 'packets', `${example.id}.json`), input);
      cases.push({ id: example.id, hash: digest(input) });
      if (packet.calls()) throw new Error('Offline evaluation dispatched unexpectedly');
    } finally {
      await packet.cleanup();
    }
  }
  await save(path.join(directory, 'manifest.json'), {
    purpose: 'analysis_evaluation',
    version: 1,
    policyVersion: periodPolicyVersion,
    createdAt: new Date().toISOString(),
    cases,
  });
  await save(
    path.join(directory, 'rubric.json'),
    evaluationCases.map((example) => ({
      id: example.id,
      name: example.name,
      recognize: example.recognize,
      avoid: example.avoid,
    })),
  );
  await save(
    path.join(directory, 'human-review.json'),
    evaluationCases.map((example) => ({
      id: example.id,
      reviewer: '',
      notes: '',
      criteria: Object.fromEntries(criteria.map((key) => [key, null])),
    })),
  );
  await writeFile(
    path.join(directory, 'INSTRUCTIONS.txt'),
    'Offline synthetic evaluation; no paid calls were made. These fictional cases are not user project reviews and must not be imported into the application.\n' +
      'Use the same frozen packets for comparisons. Evaluator rubric must not be sent to the model.\n' +
      'Paid requests require separate owner permission, exact model and bounded budget.\n' +
      'Save each actual answer in responses/<case-id>.json as {report,provenance:{kind:"live_api"|"codex_manual"|"fixture",model,recordedAt,responseId?}}. Keep original receipts separately; provenance here is declared, not independently verified.\n' +
      'Read the answer against its packet and rubric, then fill human-review.json. A valid report alone is never a quality PASS.\n' +
      'Run eval:period -- review <directory>. Missing responses stay unverified.\n',
    'utf8',
  );
  console.log('Prepared 8 frozen synthetic packets. External calls: 0. Model quality: unverified.');
}
async function review(directory: string) {
  const manifest = manifestSchema.parse(await json(path.join(directory, 'manifest.json')));
  if (new Set(manifest.cases.map((item) => item.id)).size !== 8)
    throw new Error('Repeated evaluation case');
  const human = humanSchema.parse(await json(path.join(directory, 'human-review.json')));
  const results: unknown[] = [];
  for (const item of manifest.cases) {
    const input = await json(path.join(directory, 'packets', `${item.id}.json`));
    if (digest(input) !== item.hash) throw new Error(`Frozen packet changed: ${item.id}`);
    const answerFile = path.join(directory, 'responses', `${item.id}.json`);
    let answer: z.infer<typeof answerSchema>;
    try {
      answer = answerSchema.parse(await json(answerFile));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        results.push({ id: item.id, structure: 'missing', quality: 'unverified' });
      else results.push({ id: item.id, structure: 'rejected', quality: 'unverified' });
      continue;
    }
    try {
      validatePeriodReport(input.payload as PeriodPayload, answer.report);
    } catch {
      results.push({
        id: item.id,
        structure: 'rejected',
        quality: 'unverified',
        reason: 'Source, scope or privacy validation failed',
      });
      continue;
    }
    const judgment = human.find((value) => value.id === item.id);
    const reviewed =
      judgment &&
      judgment.reviewer.trim() &&
      judgment.notes.trim() &&
      criteria.every((key) => judgment.criteria[key] !== null);
    results.push({
      id: item.id,
      structure: 'valid',
      provenance: answer.provenance,
      quality: !reviewed
        ? 'requires_manual_review'
        : criteria.some((key) => judgment.criteria[key] === 'fail')
          ? 'human_fail'
          : 'human_pass',
      judgment: reviewed ? judgment : null,
    });
  }
  await save(path.join(directory, 'evaluation.json'), {
    purpose: 'analysis_evaluation',
    policyVersion: manifest.policyVersion,
    reviewedAt: new Date().toISOString(),
    provenanceIsDeclared: true,
    results,
  });
  console.log(
    'Evaluation saved. Structural validity and human quality judgments are reported separately.',
  );
}
const [mode, destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length || !['prepare', 'review'].includes(mode)) {
  console.error('Usage: npm run eval:period -- prepare|review <local-directory>. Offline only.');
  process.exitCode = 1;
} else {
  try {
    await (mode === 'prepare' ? prepare : review)(path.resolve(destination));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'Evaluation failed');
    process.exitCode = 1;
  }
}
