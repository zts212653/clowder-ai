import { createHash } from 'node:crypto';
import type { AdaptiveSopPlan, SopAdmissionDecision } from '@cat-cafe/shared';
import { z } from 'zod';
import { evaluateSopAdmission, parseSopAdmissionFacts, type SopAdmissionFacts } from './adaptive-sop-admission.js';
import { parseAdaptiveSopPlan } from './adaptive-sop-contract.js';

export const ADAPTIVE_SOP_REPLAY_ARTIFACT_SCHEMA_VERSION = 'lf-0001.replay-run.v1' as const;

const ReplayIdentitySchema = z
  .object({
    adapterId: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    family: z.string().trim().min(1),
  })
  .passthrough();

const ReplayCandidateSchema = z
  .object({
    fixtureId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    modelInput: z.record(z.unknown()),
    graderOnly: z.record(z.unknown()),
  })
  .strict();

const ReplayManifestSchema = z
  .object({
    schemaVersion: z.literal('lf-0001.replay-manifest.v1'),
    candidates: z.array(ReplayCandidateSchema).min(1),
  })
  .passthrough();

const RubricDimensionSchema = z
  .object({
    id: z.string().trim().min(1),
    weight: z.number().positive(),
    question: z.string().trim().min(1),
  })
  .strict();

const HardInvariantSchema = z
  .object({
    id: z.string().trim().min(1),
    rule: z.string().trim().min(1),
  })
  .strict();

const GraderRubricSchema = z
  .object({
    schemaVersion: z.literal('lf-0001.grader-rubric.v1'),
    gradingProtocol: z
      .object({
        passingScore: z.number().min(0).max(100),
        minimumDimensionScore: z.number().min(0).max(4),
      })
      .passthrough(),
    dimensions: z.array(RubricDimensionSchema).min(1),
    hardInvariantVetoes: z.array(HardInvariantSchema).min(1),
  })
  .passthrough();

const DeterministicGradeSchema = z
  .object({
    checks: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          status: z.enum(['pass', 'fail', 'not_applicable']),
          evidenceRefs: z.array(z.string()),
        })
        .strict(),
    ),
    hardInvariantMisses: z.array(z.string().trim().min(1)),
  })
  .strict();

const ModelGradeSchema = z
  .object({
    dimensions: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          score: z.number().int().min(0).max(4),
          rationale: z.string().trim().min(1),
          evidenceRefs: z.array(z.string()),
        })
        .strict(),
    ),
    unnecessaryProcess: z.array(z.string()),
    missingEvidence: z.array(z.string()),
  })
  .strict();

type ReplayCandidate = z.infer<typeof ReplayCandidateSchema>;
type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
type GraderRubric = z.infer<typeof GraderRubricSchema>;
type DeterministicGrade = z.infer<typeof DeterministicGradeSchema>;
type ModelGrade = z.infer<typeof ModelGradeSchema>;

export type AdaptiveSopReplayRunMode = 'synthetic_wiring' | 'model_replay';

export interface AdaptiveSopReplayIdentity {
  readonly adapterId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly family: string;
  readonly [key: string]: unknown;
}

export interface AdaptiveSopPlannerPort {
  readonly identity: AdaptiveSopReplayIdentity;
  generatePlan(
    modelInput: Readonly<Record<string, unknown>>,
    context: Readonly<{ runId: string; fixtureId: string; trialIndex: number }>,
  ): Promise<unknown>;
}

export interface AdaptiveSopFactsProviderPort {
  observe(input: {
    runId: string;
    fixtureId: string;
    trialIndex: number;
    plan: AdaptiveSopPlan;
    trustedCandidate: ReplayCandidate;
    environment: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface AdaptiveSopDeterministicGraderPort {
  grade(input: {
    runId: string;
    fixtureId: string;
    trialIndex: number;
    trustedCandidate: ReplayCandidate;
    rubric: GraderRubric;
    plan: AdaptiveSopPlan;
    facts: SopAdmissionFacts;
    admission: SopAdmissionDecision;
    environment: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface AdaptiveSopModelGraderPort {
  readonly identity: AdaptiveSopReplayIdentity;
  grade(input: {
    runId: string;
    fixtureId: string;
    trialIndex: number;
    trustedCandidate: ReplayCandidate;
    rubric: GraderRubric;
    plan: AdaptiveSopPlan;
    facts: SopAdmissionFacts;
    admission: SopAdmissionDecision;
    deterministicGrade: DeterministicGrade;
    environment: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface AdaptiveSopReplayRunInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly runMode: AdaptiveSopReplayRunMode;
  readonly trialsPerCandidate: number;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly manifest: unknown;
  readonly rubric: unknown;
  readonly planner: AdaptiveSopPlannerPort;
  readonly factsProvider: AdaptiveSopFactsProviderPort;
  readonly deterministicGrader: AdaptiveSopDeterministicGraderPort;
  readonly modelGrader: AdaptiveSopModelGraderPort;
}

type TrialFailureStatus =
  | 'planner_contract_error'
  | 'facts_error'
  | 'deterministic_grader_error'
  | 'model_grader_error';

interface TrialFailure {
  readonly code: TrialFailureStatus;
  readonly message: string;
}

interface CompletedTrial {
  readonly fixtureId: string;
  readonly title: string;
  readonly trialIndex: number;
  readonly status: 'completed';
  readonly modelInputSha256: string;
  readonly plan: AdaptiveSopPlan;
  readonly facts: SopAdmissionFacts;
  readonly admission: SopAdmissionDecision;
  readonly deterministicGrade: DeterministicGrade;
  readonly modelGrade: ModelGrade & { weightedScore: number };
  readonly rubricPassed: boolean;
}

interface FailedTrial {
  readonly fixtureId: string;
  readonly title: string;
  readonly trialIndex: number;
  readonly status: TrialFailureStatus;
  readonly modelInputSha256: string;
  readonly failure: TrialFailure;
}

export type AdaptiveSopReplayTrial = CompletedTrial | FailedTrial;

export interface AdaptiveSopReplayArtifact {
  readonly schemaVersion: typeof ADAPTIVE_SOP_REPLAY_ARTIFACT_SCHEMA_VERSION;
  readonly runId: string;
  readonly createdAt: string;
  readonly runMode: AdaptiveSopReplayRunMode;
  readonly eligibleForCapabilityVerdict: boolean;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly provenance: {
    readonly manifestSha256: string;
    readonly rubricSha256: string;
    readonly planner: AdaptiveSopReplayIdentity;
    readonly modelGrader: AdaptiveSopReplayIdentity;
    readonly trialsPerCandidate: number;
  };
  readonly summary: {
    readonly candidateCount: number;
    readonly plannedTrials: number;
    readonly completedTrials: number;
    readonly failedTrials: number;
    readonly rubricPassingTrials: number;
    readonly rubricFailingTrials: number;
    readonly hardInvariantMisses: number;
    readonly admissionStatuses: Readonly<Record<SopAdmissionDecision['status'], number>>;
  };
  readonly trials: readonly AdaptiveSopReplayTrial[];
}

interface ValidatedRunInput extends Omit<AdaptiveSopReplayRunInput, 'manifest' | 'rubric'> {
  readonly manifest: ReplayManifest;
  readonly rubric: GraderRubric;
  readonly plannerIdentity: AdaptiveSopReplayIdentity;
  readonly graderIdentity: AdaptiveSopReplayIdentity;
}

export async function runAdaptiveSopReplay(input: AdaptiveSopReplayRunInput): Promise<AdaptiveSopReplayArtifact> {
  const run = validateRunInput(input);
  const trials: AdaptiveSopReplayTrial[] = [];

  for (const candidate of run.manifest.candidates) {
    for (let trialIndex = 0; trialIndex < run.trialsPerCandidate; trialIndex += 1) {
      trials.push(await runTrial(run, candidate, trialIndex));
    }
  }

  const summary = summarizeTrials(run.manifest.candidates.length, run.trialsPerCandidate, trials);
  const eligibleForCapabilityVerdict =
    run.runMode === 'model_replay' &&
    summary.failedTrials === 0 &&
    summary.hardInvariantMisses === 0 &&
    summary.rubricFailingTrials === 0;

  return {
    schemaVersion: ADAPTIVE_SOP_REPLAY_ARTIFACT_SCHEMA_VERSION,
    runId: run.runId,
    createdAt: run.createdAt,
    runMode: run.runMode,
    eligibleForCapabilityVerdict,
    environment: normalizeJsonRecord(run.environment),
    provenance: {
      manifestSha256: sha256(run.manifest),
      rubricSha256: sha256(run.rubric),
      planner: normalizeIdentity(run.plannerIdentity),
      modelGrader: normalizeIdentity(run.graderIdentity),
      trialsPerCandidate: run.trialsPerCandidate,
    },
    summary,
    trials,
  };
}

async function runTrial(
  run: ValidatedRunInput,
  candidate: ReplayCandidate,
  trialIndex: number,
): Promise<AdaptiveSopReplayTrial> {
  const modelInputSha256 = sha256(candidate.modelInput);
  const base = {
    fixtureId: candidate.fixtureId,
    title: candidate.title,
    trialIndex,
    modelInputSha256,
  };

  let plan: AdaptiveSopPlan;
  try {
    const projectedInput = cloneJsonRecord(candidate.modelInput);
    const generated = await run.planner.generatePlan(projectedInput, {
      runId: run.runId,
      fixtureId: candidate.fixtureId,
      trialIndex,
    });
    plan = parseAdaptiveSopPlan(generated);
  } catch {
    return failedTrial(base, 'planner_contract_error', 'Planner failed to return a valid adaptive SOP plan.');
  }

  let facts: SopAdmissionFacts;
  let admission: SopAdmissionDecision;
  try {
    const observed = await run.factsProvider.observe({
      runId: run.runId,
      fixtureId: candidate.fixtureId,
      trialIndex,
      plan,
      trustedCandidate: candidate,
      environment: run.environment,
    });
    facts = parseSopAdmissionFacts(observed);
    admission = evaluateSopAdmission(plan, facts);
  } catch {
    return failedTrial(base, 'facts_error', 'Independent facts could not produce a valid admission decision.');
  }

  let deterministicGrade: DeterministicGrade;
  try {
    const grade = await run.deterministicGrader.grade({
      runId: run.runId,
      fixtureId: candidate.fixtureId,
      trialIndex,
      trustedCandidate: candidate,
      rubric: run.rubric,
      plan,
      facts,
      admission,
      environment: run.environment,
    });
    deterministicGrade = parseDeterministicGrade(grade, run.rubric);
  } catch {
    return failedTrial(base, 'deterministic_grader_error', 'Deterministic grading returned an invalid result.');
  }

  let modelGrade: ModelGrade;
  try {
    const grade = await run.modelGrader.grade({
      runId: run.runId,
      fixtureId: candidate.fixtureId,
      trialIndex,
      trustedCandidate: candidate,
      rubric: run.rubric,
      plan,
      facts,
      admission,
      deterministicGrade,
      environment: run.environment,
    });
    modelGrade = parseModelGrade(grade, run.rubric);
  } catch {
    return failedTrial(base, 'model_grader_error', 'Independent model grading returned an invalid result.');
  }

  const weightedScore = calculateWeightedScore(modelGrade, run.rubric);
  return {
    ...base,
    status: 'completed',
    plan,
    facts,
    admission,
    deterministicGrade,
    modelGrade: { ...modelGrade, weightedScore },
    rubricPassed: passesRubric(deterministicGrade, modelGrade, weightedScore, run.rubric),
  };
}

function validateRunInput(input: AdaptiveSopReplayRunInput): ValidatedRunInput {
  if (!input.runId.trim()) throw new Error('runId is required');
  if (!Number.isInteger(input.trialsPerCandidate) || input.trialsPerCandidate < 3) {
    throw new Error('trialsPerCandidate must be at least 3');
  }
  if (!['synthetic_wiring', 'model_replay'].includes(input.runMode)) throw new Error('unsupported replay runMode');
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error('createdAt must be an ISO-8601 timestamp');
  if (!isRecord(input.environment)) throw new Error('environment must be an object');

  const plannerIdentity = ReplayIdentitySchema.parse(input.planner.identity);
  const graderIdentity = ReplayIdentitySchema.parse(input.modelGrader.identity);
  if (plannerIdentity.family === graderIdentity.family) {
    throw new Error('model grader family must differ from planner family');
  }

  const manifest = ReplayManifestSchema.parse(input.manifest);
  assertUniqueStrings(
    manifest.candidates.map((candidate) => candidate.fixtureId),
    'manifest candidate fixtureId',
  );
  const rubric = GraderRubricSchema.parse(input.rubric);
  assertUniqueStrings(
    rubric.dimensions.map((dimension) => dimension.id),
    'rubric dimension id',
  );
  assertUniqueStrings(
    rubric.hardInvariantVetoes.map((veto) => veto.id),
    'rubric hard-invariant id',
  );
  const totalWeight = rubric.dimensions.reduce((total, dimension) => total + dimension.weight, 0);
  if (totalWeight !== 100) throw new Error('rubric dimension weights must total 100');

  return { ...input, manifest, rubric, plannerIdentity, graderIdentity };
}

function parseDeterministicGrade(input: unknown, rubric: GraderRubric): DeterministicGrade {
  const grade = DeterministicGradeSchema.parse(input);
  assertUniqueStrings(
    grade.checks.map((check) => check.id),
    'deterministic check id',
  );
  assertUniqueStrings(grade.hardInvariantMisses, 'hard-invariant miss');
  const knownVetoes = new Set(rubric.hardInvariantVetoes.map((veto) => veto.id));
  for (const miss of grade.hardInvariantMisses) {
    if (!knownVetoes.has(miss)) throw new Error(`unknown hard-invariant miss: ${miss}`);
  }
  return grade;
}

function parseModelGrade(input: unknown, rubric: GraderRubric): ModelGrade {
  const grade = ModelGradeSchema.parse(input);
  assertUniqueStrings(
    grade.dimensions.map((dimension) => dimension.id),
    'model grade dimension id',
  );
  const expected = rubric.dimensions.map((dimension) => dimension.id).sort();
  const received = grade.dimensions.map((dimension) => dimension.id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(received)) {
    throw new Error('model grade dimensions must exactly match the rubric');
  }
  return grade;
}

function calculateWeightedScore(grade: ModelGrade, rubric: GraderRubric): number {
  const scores = new Map(grade.dimensions.map((dimension) => [dimension.id, dimension.score]));
  const score = rubric.dimensions.reduce(
    (total, dimension) => total + (scores.get(dimension.id) ?? 0) * (dimension.weight / 4),
    0,
  );
  return Math.round(score * 10_000) / 10_000;
}

function passesRubric(
  deterministicGrade: DeterministicGrade,
  modelGrade: ModelGrade,
  weightedScore: number,
  rubric: GraderRubric,
): boolean {
  return (
    deterministicGrade.hardInvariantMisses.length === 0 &&
    deterministicGrade.checks.every(
      (check) => check.status !== 'fail' && (check.status === 'not_applicable' || hasEvidence(check.evidenceRefs)),
    ) &&
    modelGrade.missingEvidence.length === 0 &&
    modelGrade.dimensions.every((dimension) => hasEvidence(dimension.evidenceRefs)) &&
    weightedScore >= rubric.gradingProtocol.passingScore &&
    modelGrade.dimensions.every((dimension) => dimension.score >= rubric.gradingProtocol.minimumDimensionScore)
  );
}

function hasEvidence(evidenceRefs: readonly string[]): boolean {
  return evidenceRefs.some((reference) => reference.trim().length > 0);
}

function summarizeTrials(
  candidateCount: number,
  trialsPerCandidate: number,
  trials: readonly AdaptiveSopReplayTrial[],
): AdaptiveSopReplayArtifact['summary'] {
  const completed = trials.filter((trial): trial is CompletedTrial => trial.status === 'completed');
  const admissionStatuses = { admitted: 0, revise: 0, blocked: 0 };
  let hardInvariantMisses = 0;
  let rubricPassingTrials = 0;

  for (const trial of completed) {
    admissionStatuses[trial.admission.status] += 1;
    hardInvariantMisses += trial.deterministicGrade.hardInvariantMisses.length;
    if (trial.rubricPassed) rubricPassingTrials += 1;
  }

  return {
    candidateCount,
    plannedTrials: candidateCount * trialsPerCandidate,
    completedTrials: completed.length,
    failedTrials: trials.length - completed.length,
    rubricPassingTrials,
    rubricFailingTrials: completed.length - rubricPassingTrials,
    hardInvariantMisses,
    admissionStatuses,
  };
}

function failedTrial(
  base: Pick<FailedTrial, 'fixtureId' | 'title' | 'trialIndex' | 'modelInputSha256'>,
  status: TrialFailureStatus,
  message: string,
): FailedTrial {
  return { ...base, status, failure: { code: status, message } };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeIdentity(identity: AdaptiveSopReplayIdentity): AdaptiveSopReplayIdentity {
  return normalizeJsonRecord(identity) as AdaptiveSopReplayIdentity;
}

function normalizeJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function cloneJsonRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
