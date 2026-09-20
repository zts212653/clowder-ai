import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { HarnessUnitDescriber } = await import('../dist/infrastructure/harness-eval/evaluation/HarnessUnitDescriber.js');
const { buildCycleAssignment } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationContent.js'
);
const { handleDescribeHarnessUnit, handleReadCycleTraces, handleSubmitCycleEvaluation, handleSubmitCycleGovernance } =
  await import('../dist/infrastructure/harness-eval/evaluation/cycle-evaluation-callbacks.js');

function describer() {
  const manifest = {
    id: 'S6',
    version: 1,
    enabled: true,
    disableable: true,
    safetyTier: 'editable',
    governanceTier: 'auto-evolve',
  };
  const registry = {
    getHook: (hookId) => (hookId === 'S6' ? { manifest } : undefined),
    isEnabled: () => false,
  };
  return new HarnessUnitDescriber({
    catalog: {
      manifest: {
        units: [
          {
            unitId: 'S6',
            hookId: 's6-different-asset-slug',
            unitState: 'evaluable',
            objectives: [{ objectiveId: 'workflow-discipline' }],
          },
        ],
      },
    },
    overrideStore: {
      async getActiveVersion() {
        return 3;
      },
      async listVersions() {
        return [
          { version: 2, contentPreview: 'v2' },
          { version: 3, contentPreview: 'v3' },
        ];
      },
    },
    getRegistry: () => registry,
  });
}

describe('F257 harness unit and callback contracts', () => {
  test('carries prior skip and reject reasons without trace bodies', async () => {
    const assignment = await buildCycleAssignment(
      {
        catalog: {
          registry: {
            objectives: [{ id: 'obj', label: 'Objective', statement: 'Evaluate this.', evaluationModelId: 'model' }],
            evaluationModels: [
              {
                id: 'model',
                metrics: [{ id: 'metric', label: 'Metric', evaluator: { kind: 'code', ruleRef: 'rule' } }],
              },
            ],
          },
        },
        annotations: {
          async queryMetricWindow() {
            return [];
          },
        },
        history: [
          {
            cycleId: 'prior',
            evaluation: { overall: 'insufficient_evidence' },
            approval: { reason: 'collect more examples' },
          },
        ],
      },
      {
        cycleId: 'current',
        objectiveId: 'obj',
        version: 'v2',
        versionContentRef: 'hooks:S6@2',
        windows: [
          { start: 0, end: 10 },
          { start: 10, end: 20 },
        ],
        approval: { state: 'rejected', reason: 'wrong attribution' },
      },
    );
    assert.deepEqual(assignment.priorSkipReasons, [{ cycleId: 'prior', reason: 'collect more examples' }]);
    assert.deepEqual(assignment.rejectReasons, ['wrong attribution']);
    assert.equal(assignment.readPoolTool, 'cat_cafe_read_cycle_traces(objectiveId, cycleId, cursor?)');
  });

  test('describes action gates and the active immutable version pointer', async () => {
    const result = await describer().describe('S6');
    assert.deepEqual(result.allowedActions, { enable: true, disable: true, modify: true, add: true });
    assert.equal(result.hookId, 'S6', 'runtime actions use the canonical manifest id, not the directory slug');
    assert.deepEqual(result.current, { enabled: false, version: 3, contentRef: 'hook-content:S6@3' });
    assert.deepEqual(result.versionChain, [
      { version: 1, contentRef: 'hook-content:S6@1', current: false },
      { version: 2, contentRef: 'hook-content:S6@2', current: false },
      { version: 3, contentRef: 'hook-content:S6@3', current: true },
    ]);
  });

  test('maps unit absence and validates strict callback bodies', async () => {
    assert.deepEqual(await handleDescribeHarnessUnit(describer(), { unitId: 'missing' }), {
      status: 404,
      body: { error: 'harness_unit_not_found' },
    });
    const invalid = await handleReadCycleTraces(
      { readTraces: () => assert.fail('invalid body reached coordinator') },
      { userId: 'owner', catId: 'cat', threadId: 'thread' },
      { objectiveId: 'obj', cycleId: 'cycle', extra: true },
    );
    assert.equal(invalid.status, 400);
  });

  test('maps principal and state failures without leaking internal records', async () => {
    const principal = { userId: 'owner', catId: 'cat', threadId: 'wrong-thread' };
    const read = await handleReadCycleTraces(
      {
        async readTraces() {
          throw new Error('cycle_evaluation_principal_mismatch:cycle');
        },
      },
      principal,
      { objectiveId: 'obj', cycleId: 'cycle', cursor: 0, limit: 10 },
    );
    assert.deepEqual(read, { status: 403, body: { error: 'cycle_evaluation_principal_mismatch' } });

    const submit = await handleSubmitCycleEvaluation(
      {
        async submitEvaluation() {
          throw new Error('cycle_evaluation_conflict:cycle');
        },
      },
      principal,
      {
        objectiveId: 'obj',
        cycleId: 'cycle',
        metrics: [{ id: 'm', conclusion: { kind: 'count', value: 0, howCounted: 'checked' }, evidenceRefs: [] }],
        overall: 'complete',
        counterexampleRootCauses: { eventCount: 0, rootCauseCount: 0, howGrouped: 'No counterexamples.' },
        coverageAssessment: { status: 'adequate', rationale: 'No coverage gap observed.', findings: [] },
      },
    );
    assert.deepEqual(submit, { status: 409, body: { error: 'cycle_evaluation_conflict' } });

    const oversized = await handleSubmitCycleEvaluation(
      {
        async submitEvaluation() {
          throw new Error('cycle_record_too_large:cycle');
        },
      },
      principal,
      {
        objectiveId: 'obj',
        cycleId: 'cycle',
        metrics: [{ id: 'm', conclusion: { kind: 'count', value: 0, howCounted: 'checked' }, evidenceRefs: [] }],
        overall: 'complete',
        counterexampleRootCauses: { eventCount: 0, rootCauseCount: 0, howGrouped: 'No counterexamples.' },
        coverageAssessment: { status: 'adequate', rationale: 'No coverage gap observed.', findings: [] },
      },
    );
    assert.deepEqual(oversized, {
      status: 400,
      body: { error: 'invalid_cycle_evaluation', message: 'cycle_record_too_large:cycle' },
    });

    const missingCoverage = await handleSubmitCycleEvaluation(
      {
        async submitEvaluation() {
          assert.fail('missing coverage assessment reached coordinator');
        },
      },
      principal,
      {
        objectiveId: 'obj',
        cycleId: 'cycle',
        metrics: [{ id: 'm', conclusion: { kind: 'count', value: 0, howCounted: 'checked' }, evidenceRefs: [] }],
        overall: 'complete',
        counterexampleRootCauses: { eventCount: 0, rootCauseCount: 0, howGrouped: 'No counterexamples.' },
      },
    );
    assert.equal(missingCoverage.status, 400);
  });

  test('accepts the structured governance shape and rejects unknown mutation fields', async () => {
    const calls = [];
    const coordinator = {
      async submitGovernance(principal, input) {
        calls.push({ principal, input });
        return { outcome: 'written', proposalId: 'HGP-1' };
      },
    };
    const principal = { userId: 'owner', catId: 'cat', threadId: 'thread_eval_f257_obj' };
    const input = {
      objectiveId: 'obj',
      cycleId: 'cycle',
      decision: 'evolve',
      reason: 'The evidence supports a change.',
      v2Draft: {
        changes: [{ action: 'modify', unitId: 'D1', reason: 'Clarify.', proposedContent: 'new body' }],
      },
    };
    assert.equal((await handleSubmitCycleGovernance(coordinator, principal, input)).status, 200);
    assert.equal(calls.length, 1);

    const invalid = await handleSubmitCycleGovernance(coordinator, principal, {
      ...input,
      directApply: true,
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 1, 'invalid callback input must never reach the coordinator');
  });

  test('accepts a persistable new hook unit id and template in an evolve draft', async () => {
    const calls = [];
    const coordinator = {
      async submitGovernance(principal, input) {
        calls.push({ principal, input });
        return { outcome: 'written', proposalId: 'HGP-2' };
      },
    };
    const principal = { userId: 'owner', catId: 'cat', threadId: 'thread_eval_f257_obj' };
    const input = {
      objectiveId: 'engineering-quality-discipline',
      cycleId: 'cycle',
      decision: 'evolve',
      reason: 'The failed replay needs a dedicated merge-readiness guard.',
      v2Draft: {
        changes: [
          {
            action: 'add',
            reason: 'Consume exact-HEAD P1/P2 findings before declaring merge readiness.',
            unit: {
              unitId: 'L8',
              assetSlug: 'l8-merge-readiness-findings',
              manifest: {
                id: 'L8',
                name: 'Merge-readiness finding consumption',
                stage: 'per-turn',
                order: 8,
                version: 1,
                enabled: true,
                template: 'l8-merge-readiness-findings.md',
                inputs: [],
                disableable: true,
                safetyTier: 'readonly',
                transparencyTier: 'visible-by-default',
                governanceTier: 'human-gated',
              },
              content: 'Before declaring merge-ready, consume every current-HEAD P1/P2 finding.',
              objectives: [{ objectiveId: 'engineering-quality-discipline' }],
            },
          },
        ],
      },
    };

    assert.equal((await handleSubmitCycleGovernance(coordinator, principal, input)).status, 200);
    assert.equal(calls.length, 1, 'a writer-compatible add draft must reach the coordinator');
  });
});
