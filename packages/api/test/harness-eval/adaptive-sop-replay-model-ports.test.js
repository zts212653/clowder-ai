import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createStructuredReplayModelGrader,
  createStructuredReplayPlanner,
} from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-replay-model-ports.js';

const plannerIdentity = {
  adapterId: 'codex-structured-planner',
  provider: 'openai',
  modelId: 'gpt-test',
  family: 'openai',
};

const graderIdentity = {
  adapterId: 'claude-structured-grader',
  provider: 'anthropic',
  modelId: 'claude-test',
  family: 'anthropic',
};

function planBody() {
  return {
    taskUnderstanding: 'Change only what the sanitized task asks for.',
    desiredOutcome: ['The requested outcome is independently observable.'],
    repositoryFacts: {},
    risks: [
      {
        claim: 'A protected surface may be present.',
        evidence: [],
        uncertainty: ['Independent facts have not been evaluated yet.'],
      },
    ],
    decisions: [
      {
        stepId: 'inspect',
        action: 'include',
        reason: 'Ground the plan in visible evidence.',
        residualRisk: 'The hidden outcome remains unknown.',
      },
    ],
    executionOrder: ['inspect'],
    outcomeChecks: ['The requested outcome is independently observable.'],
    replanTriggers: ['Independent facts reveal a protected surface.'],
    rollbackPlan: 'Fall back to the full SOP before mutation.',
  };
}

describe('LF-0001 structured replay model ports', () => {
  it('projects only sanitized model input and stamps system-owned plan provenance', async () => {
    const requests = [];
    const completion = {
      identity: plannerIdentity,
      async complete(request) {
        requests.push(request);
        return {
          ...planBody(),
          schemaVersion: 'untrusted-version',
          episodeId: 'untrusted-episode',
          model: { provider: 'untrusted', modelId: 'untrusted', harnessVersion: 'untrusted' },
        };
      },
    };
    const planner = createStructuredReplayPlanner({ completion, harnessVersion: 'lf-0001.prompt-v1' });
    const modelInput = {
      taskPrompt: 'Update one documentation contract.',
      repositorySnapshot: { mode: 'base_commit_paths', visiblePaths: ['docs/contract.md'] },
    };
    const plan = await planner.generatePlan(modelInput, {
      runId: 'model-port-test',
      fixtureId: 'fixture-one',
      trialIndex: 2,
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(requests[0].payload).sort(), ['episodeId', 'modelInput']);
    assert.deepEqual(requests[0].payload.modelInput, modelInput);
    assert.equal(JSON.stringify(requests[0]).includes('graderOnly'), false);
    assert.equal(JSON.stringify(requests[0]).includes('outcomeCommit'), false);
    assert.deepEqual(requests[0].responseContract, {
      schemaVersion: 'lf-0001.plan-body-response.v2',
      format: 'json_schema',
      name: 'adaptive_sop_plan_body',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taskUnderstanding',
          'desiredOutcome',
          'repositoryFacts',
          'risks',
          'decisions',
          'executionOrder',
          'outcomeChecks',
          'replanTriggers',
          'rollbackPlan',
        ],
        properties: {
          taskUnderstanding: { type: 'string' },
          desiredOutcome: { type: 'array', items: { type: 'string' } },
          repositoryFacts: {
            type: 'object',
            additionalProperties: false,
            required: [],
            properties: {},
          },
          risks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'evidence', 'uncertainty'],
              properties: {
                claim: { type: 'string' },
                evidence: { type: 'array', items: { type: 'string' } },
                uncertainty: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['stepId', 'action', 'reason', 'residualRisk', 'replacementEvidence'],
              properties: {
                stepId: { type: 'string' },
                action: { type: 'string', enum: ['include', 'omit', 'replace'] },
                reason: { type: 'string' },
                residualRisk: { type: 'string' },
                replacementEvidence: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          executionOrder: { type: 'array', items: { type: 'string' } },
          outcomeChecks: { type: 'array', items: { type: 'string' } },
          replanTriggers: { type: 'array', items: { type: 'string' } },
          rollbackPlan: { type: 'string' },
        },
      },
      semanticInvariants: [
        'each risk has evidence or explicit uncertainty',
        'omit and replace decisions have non-empty replacementEvidence',
        'decision stepId values are unique',
        'executionOrder contains every non-omitted decision exactly once and no omitted or unknown stepId',
      ],
    });
    assert.match(requests[0].instructions, /Return repositoryFacts as an empty object/);
    assert.equal(plan.schemaVersion, 'adaptive-sop-plan.v1');
    assert.equal(plan.episodeId, 'fixture-one-trial-2');
    assert.deepEqual(plan.model, {
      provider: plannerIdentity.provider,
      modelId: plannerIdentity.modelId,
      harnessVersion: 'lf-0001.prompt-v1',
    });
    assert.deepEqual(planner.identity, { ...plannerIdentity, harnessVersion: 'lf-0001.prompt-v1' });
  });

  it('gives the independent grader trusted evidence without prescribing a canonical sequence', async () => {
    const requests = [];
    const completion = {
      identity: graderIdentity,
      async complete(request) {
        requests.push(request);
        return {
          dimensions: request.payload.rubric.dimensions.map((dimension) => ({
            id: dimension.id,
            score: 3,
            rationale: `Evidence-linked score for ${dimension.id}.`,
            evidenceRefs: [],
          })),
          unnecessaryProcess: [],
          missingEvidence: [],
        };
      },
    };
    const grader = createStructuredReplayModelGrader({ completion });
    const rubric = {
      dimensions: [{ id: 'goal', weight: 100, question: 'Does the plan meet the goal?' }],
      canonicalToolSequence: null,
    };
    const result = await grader.grade({
      runId: 'model-port-test',
      fixtureId: 'fixture-one',
      trialIndex: 0,
      trustedCandidate: {
        fixtureId: 'fixture-one',
        title: 'Fixture one',
        modelInput: { taskPrompt: 'Do the task.' },
        graderOnly: { provenance: { outcomeCommit: 'a'.repeat(40) } },
      },
      rubric,
      plan: { schemaVersion: 'adaptive-sop-plan.v1' },
      facts: { schemaVersion: 'sop-admission-facts.v1' },
      admission: {
        schemaVersion: 'sop-admission-decision.v1',
        status: 'blocked',
        episodeId: 'fixture-one-trial-0',
        envelopeFingerprint: 'b'.repeat(64),
        invariant: 'protected surface: effects.authDelta',
        fallback: 'operator',
      },
      deterministicGrade: { checks: [], hardInvariantMisses: [] },
      environment: { runnerVersion: 'test' },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].payload.graderEvidence.provenance.outcomeCommit, 'a'.repeat(40));
    assert.equal(requests[0].payload.modelInput.taskPrompt, 'Do the task.');
    assert.equal(requests[0].instructions.includes('canonical tool sequence'), true);
    assert.equal(requests[0].instructions.includes('Small score differences'), true);
    assert.deepEqual(requests[0].responseContract, {
      schemaVersion: 'lf-0001.model-grade-response.v2',
      format: 'json_schema',
      name: 'adaptive_sop_model_grade',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dimensions', 'unnecessaryProcess', 'missingEvidence'],
        properties: {
          dimensions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'score', 'rationale', 'evidenceRefs'],
              properties: {
                id: { type: 'string', enum: ['goal'] },
                score: { type: 'integer' },
                rationale: { type: 'string' },
                evidenceRefs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          unnecessaryProcess: { type: 'array', items: { type: 'string' } },
          missingEvidence: { type: 'array', items: { type: 'string' } },
        },
      },
      semanticInvariants: ['return every rubric dimension exactly once', 'dimension scores are integers from 0 to 4'],
    });
    assert.deepEqual(result.dimensions[0], {
      id: 'goal',
      score: 3,
      rationale: 'Evidence-linked score for goal.',
      evidenceRefs: [],
    });
    assert.deepEqual(grader.identity, graderIdentity);
  });
});
