import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationCases } from './period-evaluation-fixture.js';
import { evaluationPacket } from './evaluation-packet.js';

// These tests establish what reaches the model, not the quality of an answer.
// No recorded or generated "ideal answer" is substituted for a live evaluation.
for (const example of evaluationCases) {
  test(`evaluation packet: ${example.id} preserves facts, scope and uncertainty without dispatch`, async (t) => {
    const { run, ids, calls, cleanup } = await evaluationPacket(example);
    t.after(cleanup);
    const observations = run.payload.sources.filter((s) => s.kind === 'observation');
    assert.deepEqual(
      observations.map((s) => s.text).sort(),
      example.projects.flatMap((p) => p.notes).sort(),
    );
    for (const source of run.payload.sources)
      assert.ok(source.projectId && ids.includes(source.projectId));
    const packet = JSON.stringify(run.payload);
    for (const project of example.projects) {
      assert.ok(packet.includes(project.name));
      assert.ok(packet.includes(project.stage));
      assert.ok(packet.includes(project.status));
    }
    assert.doesNotMatch(
      packet,
      /OUTSIDE_PERIOD_CANARY|UNSELECTED_PROJECT_CANARY|UNSELECTED_PRIVATE_NOTE/,
    );
    // Evaluator expectations must not become leading instructions in input.
    assert.ok(!packet.includes(example.recognize));
    assert.ok(!packet.includes(example.avoid));
    assert.equal(run.payload.period.incomplete, false);
    assert.ok(run.payload.limitations.length > 0);
    assert.equal(run.status, 'pending');
    assert.equal(run.approvedAt, null);
    assert.equal(run.report, null);
    assert.equal(calls(), 0);
  });
}
