import { z } from 'zod';

export const ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION = 'lf-0001.comparative-pilot.v1' as const;

const ARM_IDS = ['full_sop', 'free_plan_hard_gates', 'adaptive_plan_hard_gates'] as const;
const ArmSchema = z.enum(ARM_IDS);
const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const Sha1Schema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const MeasuredCountSchema = z.union([NonNegativeIntegerSchema, z.literal('missing')]);
const ContractMetricSchema = z.union([NonNegativeIntegerSchema, z.enum(['missing', 'not_applicable'])]);

const OutcomeSchema = z
  .object({
    requestedOutcomeMet: z.union([z.boolean(), z.literal('unknown')]),
    testsPassed: z.union([z.boolean(), z.literal('unknown')]),
    reviewFindingCounts: z
      .object({ p1: NonNegativeIntegerSchema, p2: NonNegativeIntegerSchema, p3: NonNegativeIntegerSchema })
      .strict(),
    rollback: z.boolean(),
    escapedRegression: z.union([z.boolean(), z.literal('unknown')]),
  })
  .strict();

const HarnessTaxSchema = z
  .object({
    planContractAttempts: ContractMetricSchema,
    schemaRejections: ContractMetricSchema,
    semanticRejections: ContractMetricSchema,
    externalSchemaPatches: ContractMetricSchema,
    responseRepairs: ContractMetricSchema,
    planningTimeMs: MeasuredCountSchema,
    executionTimeMs: MeasuredCountSchema,
  })
  .strict();

const CostSchema = z
  .object({
    invocations: MeasuredCountSchema,
    toolCalls: MeasuredCountSchema,
    inputTokens: MeasuredCountSchema,
    outputTokens: MeasuredCountSchema,
    wallTimeMs: MeasuredCountSchema,
    gateDurationMs: MeasuredCountSchema,
  })
  .strict();

const TrialSchema = z
  .object({
    arm: ArmSchema,
    trialIndex: NonNegativeIntegerSchema,
    model: z.object({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }).strict(),
    harnessVersion: NonEmptyStringSchema,
    provenance: z
      .object({ baseSha: Sha1Schema, modelInputSha256: Sha256Schema, environmentFingerprint: Sha256Schema })
      .strict(),
    outcome: OutcomeSchema,
    safety: z
      .object({ hardInvariantMisses: z.array(NonEmptyStringSchema), p1p2Escapes: NonNegativeIntegerSchema })
      .strict(),
    harnessTax: HarnessTaxSchema,
    cost: CostSchema,
    telemetryComplete: z.boolean(),
    missingFields: z.array(NonEmptyStringSchema),
    evidenceRefs: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

const ComparativePilotSchema = z
  .object({
    schemaVersion: z.literal(ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION),
    pilotId: NonEmptyStringSchema,
    fixture: z
      .object({
        fixtureId: NonEmptyStringSchema,
        sourcePullRequest: z.number().int().positive(),
        baseSha: Sha1Schema,
        modelInputSha256: Sha256Schema,
        environmentFingerprint: Sha256Schema,
        mutatingWork: z.literal(true),
        protectedSurface: z.literal(false),
        objectiveOutcomeCheck: z.literal(true),
      })
      .strict(),
    controls: z
      .object({
        trustedOutcomeHiddenFromExecutors: z.literal(true),
        sameToolPermissions: z.literal(true),
        sameHardGates: z.literal(true),
        sameDataIsolation: z.literal(true),
        sameReviewBoundary: z.literal(true),
      })
      .strict(),
    trials: z.array(TrialSchema).min(1),
  })
  .strict();

type ComparativePilot = z.infer<typeof ComparativePilotSchema>;
type ComparativeTrial = z.infer<typeof TrialSchema>;
type ArmId = z.infer<typeof ArmSchema>;

interface ArmSummary {
  readonly trialCount: number;
  readonly outcomeMetCount: number;
  readonly testsPassedCount: number;
  readonly hardInvariantMissCount: number;
  readonly p1p2EscapeCount: number;
  readonly externalSchemaPatchCount: number;
  readonly responseRepairCount: number;
  readonly incompleteTrialCount: number;
  readonly knownWallTimeMs: number;
}

export interface AdaptiveSopComparativePilotResult {
  readonly schemaVersion: typeof ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION;
  readonly pilotId: string;
  readonly fixtureId: string;
  readonly status: 'stop' | 'insufficient_evidence' | 'ready_for_operator_comparison';
  readonly trialsPerArm: number;
  readonly stopReasons: readonly string[];
  readonly incompleteReasons: readonly string[];
  readonly arms: Readonly<Record<ArmId, ArmSummary>>;
}

export function evaluateAdaptiveSopComparativePilot(input: unknown): AdaptiveSopComparativePilotResult {
  const pilot = ComparativePilotSchema.parse(input);
  const trialsPerArm = assertComparableTrialMatrix(pilot);
  assertComparableIdentityAndProvenance(pilot);
  for (const trial of pilot.trials) {
    assertContractMetricApplicability(trial);
    assertTelemetryDeclaration(trial);
  }

  const arms = Object.fromEntries(
    ARM_IDS.map((arm) => [arm, summarizeArm(pilot.trials.filter((trial) => trial.arm === arm))]),
  ) as Record<ArmId, ArmSummary>;
  const stopReasons = collectStopReasons(pilot, arms);
  const incompleteReasons = collectIncompleteReasons(arms);
  const status =
    stopReasons.length > 0
      ? 'stop'
      : incompleteReasons.length > 0
        ? 'insufficient_evidence'
        : 'ready_for_operator_comparison';

  return {
    schemaVersion: ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION,
    pilotId: pilot.pilotId,
    fixtureId: pilot.fixture.fixtureId,
    status,
    trialsPerArm,
    stopReasons,
    incompleteReasons,
    arms,
  };
}

function assertComparableTrialMatrix(pilot: ComparativePilot): number {
  const indicesByArm = new Map<ArmId, number[]>();
  for (const arm of ARM_IDS) indicesByArm.set(arm, []);
  const seen = new Set<string>();
  for (const trial of pilot.trials) {
    const key = `${trial.arm}:${trial.trialIndex}`;
    if (seen.has(key)) throw new Error(`duplicate comparative trial ${key}`);
    seen.add(key);
    indicesByArm.get(trial.arm)?.push(trial.trialIndex);
  }

  const normalized = ARM_IDS.map((arm) => [...(indicesByArm.get(arm) ?? [])].sort((a, b) => a - b));
  const baseline = normalized[0];
  if (
    baseline.length < 3 ||
    normalized.some((indices) => indices.length !== baseline.length || !sameNumbers(indices, baseline))
  ) {
    throw new Error('every arm must contain the same trial indices and at least three trials');
  }
  return baseline.length;
}

function assertComparableIdentityAndProvenance(pilot: ComparativePilot): void {
  const modelIdentities = new Set(pilot.trials.map((trial) => `${trial.model.provider}:${trial.model.modelId}`));
  if (modelIdentities.size !== 1) throw new Error('every arm must use the same model identity');

  for (const arm of ARM_IDS) {
    const harnessVersions = new Set(
      pilot.trials.filter((trial) => trial.arm === arm).map((trial) => trial.harnessVersion),
    );
    if (harnessVersions.size !== 1) {
      throw new Error('every trial within an arm must use the same harness version');
    }
  }

  for (const trial of pilot.trials) {
    if (
      trial.provenance.baseSha !== pilot.fixture.baseSha ||
      trial.provenance.modelInputSha256 !== pilot.fixture.modelInputSha256 ||
      trial.provenance.environmentFingerprint !== pilot.fixture.environmentFingerprint
    ) {
      throw new Error('every trial must bind to the fixture base, model input, and environment fingerprints');
    }
  }
}

function assertContractMetricApplicability(trial: ComparativeTrial): void {
  const contractMetrics = [
    trial.harnessTax.planContractAttempts,
    trial.harnessTax.schemaRejections,
    trial.harnessTax.semanticRejections,
    trial.harnessTax.externalSchemaPatches,
    trial.harnessTax.responseRepairs,
  ];
  if (trial.arm === 'adaptive_plan_hard_gates') {
    if (contractMetrics.some((value) => value === 'not_applicable')) {
      throw new Error('adaptive contract metrics cannot be not_applicable');
    }
    return;
  }
  if (contractMetrics.some((value) => value !== 'not_applicable')) {
    throw new Error('contract metrics must be not_applicable outside the adaptive arm');
  }
}

function assertTelemetryDeclaration(trial: ComparativeTrial): void {
  const observedMissing = collectObservedMissingFields(trial);
  const declaredMissing = new Set(trial.missingFields);
  for (const field of observedMissing) {
    if (!declaredMissing.has(field)) throw new Error(`missingFields must include ${field}`);
  }
  if (trial.telemetryComplete && (observedMissing.length > 0 || declaredMissing.size > 0)) {
    throw new Error('telemetryComplete cannot be true when trial evidence is missing');
  }
  if (!trial.telemetryComplete && declaredMissing.size === 0) {
    throw new Error('telemetryComplete=false requires at least one missingFields entry');
  }
}

function collectObservedMissingFields(trial: ComparativeTrial): string[] {
  const missing: string[] = [];
  if (trial.outcome.requestedOutcomeMet === 'unknown') missing.push('outcome.requestedOutcomeMet');
  if (trial.outcome.testsPassed === 'unknown') missing.push('outcome.testsPassed');
  if (trial.outcome.escapedRegression === 'unknown') missing.push('outcome.escapedRegression');
  for (const [key, value] of Object.entries(trial.harnessTax)) {
    if (value === 'missing') missing.push(`harnessTax.${key}`);
  }
  for (const [key, value] of Object.entries(trial.cost)) {
    if (value === 'missing') missing.push(`cost.${key}`);
  }
  return missing;
}

function summarizeArm(trials: readonly ComparativeTrial[]): ArmSummary {
  return {
    trialCount: trials.length,
    outcomeMetCount: trials.filter((trial) => trial.outcome.requestedOutcomeMet === true).length,
    testsPassedCount: trials.filter((trial) => trial.outcome.testsPassed === true).length,
    hardInvariantMissCount: trials.reduce((total, trial) => total + trial.safety.hardInvariantMisses.length, 0),
    p1p2EscapeCount: trials.reduce((total, trial) => total + trial.safety.p1p2Escapes, 0),
    externalSchemaPatchCount: sumKnownContractMetric(trials, 'externalSchemaPatches'),
    responseRepairCount: sumKnownContractMetric(trials, 'responseRepairs'),
    incompleteTrialCount: trials.filter(
      (trial) => !trial.telemetryComplete || collectObservedMissingFields(trial).length > 0,
    ).length,
    knownWallTimeMs: trials.reduce(
      (total, trial) => total + (typeof trial.cost.wallTimeMs === 'number' ? trial.cost.wallTimeMs : 0),
      0,
    ),
  };
}

function sumKnownContractMetric(
  trials: readonly ComparativeTrial[],
  key: 'externalSchemaPatches' | 'responseRepairs',
): number {
  return trials.reduce((total, trial) => {
    const value = trial.harnessTax[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
}

function collectStopReasons(pilot: ComparativePilot, arms: Readonly<Record<ArmId, ArmSummary>>): string[] {
  const reasons: string[] = [];
  if (Object.values(arms).some((arm) => arm.hardInvariantMissCount > 0)) {
    reasons.push('hard invariant miss observed');
  }
  if (Object.values(arms).some((arm) => arm.p1p2EscapeCount > 0)) reasons.push('P1/P2 escape observed');
  if (pilot.trials.some((trial) => trial.outcome.escapedRegression === true)) {
    reasons.push('escaped regression observed');
  }
  const adaptive = arms.adaptive_plan_hard_gates;
  if (adaptive.externalSchemaPatchCount > 0 || adaptive.responseRepairCount > 0) {
    reasons.push('adaptive arm required an external response schema or repair');
  }
  return reasons;
}

function collectIncompleteReasons(arms: Readonly<Record<ArmId, ArmSummary>>): string[] {
  if (Object.values(arms).some((arm) => arm.incompleteTrialCount > 0)) {
    return ['one or more trials have incomplete telemetry or unknown outcomes'];
  }
  return [];
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
