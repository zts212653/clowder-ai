import type {
  AdaptiveSopModelGraderPort,
  AdaptiveSopPlannerPort,
  AdaptiveSopReplayIdentity,
} from './adaptive-sop-replay-runner.js';

export interface StructuredReplayCompletionRequest {
  readonly purpose: 'adaptive_sop_plan' | 'adaptive_sop_model_grade';
  readonly instructions: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly responseContract: Readonly<Record<string, unknown>>;
}

export interface StructuredReplayCompletionPort {
  readonly identity: AdaptiveSopReplayIdentity;
  complete(request: StructuredReplayCompletionRequest): Promise<unknown>;
}

const PLAN_BODY_RESPONSE_CONTRACT = {
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
} as const;

const PLANNER_INSTRUCTIONS = [
  'Author a proportional development plan from only the supplied sanitized modelInput.',
  'Treat missing repository facts as uncertainty. Do not infer safety from missing facts.',
  'Return repositoryFacts as an empty object; a separate observer supplies repository and risk facts.',
  'Choose include, omit, or replace per step based on outcome and risk; do not reproduce a fixed SOP.',
  'Every risk needs evidence or explicit uncertainty. Return replacementEvidence for every decision; it must be non-empty for omit or replace.',
  'executionOrder must contain each non-omitted decision stepId exactly once and must not contain omitted or unknown stepIds.',
  'Return only the response-contract JSON body. The adapter supplies schema, episode, and model provenance.',
].join(' ');

const MODEL_GRADER_INSTRUCTIONS = [
  'Grade the proposed plan against the supplied outcome rubric, independent facts, admission, and trusted evidence.',
  'Do not reward reproduction of a canonical tool sequence or the historical implementation path.',
  'Use the full 0-4 scale and cite evidence. Identify unnecessary process and missing evidence explicitly.',
  'Small score differences are not capability improvement; report qualitative evidence without promotion claims.',
  'Return only the response-contract JSON body.',
].join(' ');

export function createStructuredReplayPlanner(input: {
  completion: StructuredReplayCompletionPort;
  harnessVersion: string;
}): AdaptiveSopPlannerPort {
  if (!input.harnessVersion.trim()) throw new Error('planner harnessVersion is required');
  const identity = { ...input.completion.identity, harnessVersion: input.harnessVersion };

  return {
    identity,
    async generatePlan(modelInput, context) {
      const episodeId = `${context.fixtureId}-trial-${context.trialIndex}`;
      const response = await input.completion.complete({
        purpose: 'adaptive_sop_plan',
        instructions: PLANNER_INSTRUCTIONS,
        payload: { episodeId, modelInput },
        responseContract: PLAN_BODY_RESPONSE_CONTRACT,
      });
      if (!isRecord(response)) return response;
      return {
        ...response,
        schemaVersion: 'adaptive-sop-plan.v1',
        episodeId,
        model: {
          provider: input.completion.identity.provider,
          modelId: input.completion.identity.modelId,
          harnessVersion: input.harnessVersion,
        },
      };
    },
  };
}

export function createStructuredReplayModelGrader(input: {
  completion: StructuredReplayCompletionPort;
}): AdaptiveSopModelGraderPort {
  return {
    identity: input.completion.identity,
    async grade(gradeInput) {
      return input.completion.complete({
        purpose: 'adaptive_sop_model_grade',
        instructions: MODEL_GRADER_INSTRUCTIONS,
        payload: {
          fixtureId: gradeInput.fixtureId,
          trialIndex: gradeInput.trialIndex,
          modelInput: gradeInput.trustedCandidate.modelInput,
          graderEvidence: gradeInput.trustedCandidate.graderOnly,
          rubric: gradeInput.rubric,
          plan: gradeInput.plan,
          facts: gradeInput.facts,
          admission: gradeInput.admission,
          deterministicGrade: gradeInput.deterministicGrade,
          environment: gradeInput.environment,
        },
        responseContract: buildModelGradeResponseContract(gradeInput.rubric),
      });
    },
  };
}

function buildModelGradeResponseContract(rubric: Readonly<{ dimensions: readonly { id: string }[] }>) {
  return {
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
              id: { type: 'string', enum: rubric.dimensions.map((dimension) => dimension.id) },
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
  } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
