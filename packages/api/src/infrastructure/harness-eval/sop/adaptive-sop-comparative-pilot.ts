import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION = 'lf-0001.comparative-pilot.v1' as const;
export const ADAPTIVE_SOP_COMPARATIVE_PILOT_MANIFEST_SCHEMA_VERSION =
  'lf-0001.comparative-pilot-manifest.v1' as const;
export const ADAPTIVE_SOP_COMPARATIVE_TRIAL_RECEIPT_SCHEMA_VERSION =
  'lf-0001.comparative-trial-receipt.v1' as const;

const ARM_IDS = ['full_sop', 'free_plan_hard_gates', 'adaptive_plan_hard_gates'] as const;
const ArmSchema = z.enum(ARM_IDS);
const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const Sha1Schema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const MeasuredCountSchema = z.union([NonNegativeIntegerSchema, z.literal('missing')]);
const ContractMetricSchema = z.union([NonNegativeIntegerSchema, z.enum(['missing', 'not_applicable'])]);

const ControlsSchema = z
  .object({
    trustedOutcomeHiddenFromExecutors: z.literal(true),
    sameToolPermissions: z.literal(true),
    sameHardGates: z.literal(true),
    sameDataIsolation: z.literal(true),
    sameReviewBoundary: z.literal(true),
  })
  .strict();

const ComparativePilotManifestSchema = z
  .object({
    schemaVersion: z.literal(ADAPTIVE_SOP_COMPARATIVE_PILOT_MANIFEST_SCHEMA_VERSION),
    pilotId: NonEmptyStringSchema,
    fixtureId: NonEmptyStringSchema,
    sourcePullRequest: z.number().int().positive(),
    baseCommit: Sha1Schema,
    modelInputSha256: Sha256Schema,
    model: z.object({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }).strict(),
    fixture: z
      .object({
        mutatingWork: z.literal(true),
        protectedSurface: z.literal(false),
        objectiveOutcomeCheck: z.literal(true),
      })
      .strict(),
    trialsPerArm: z.number().int().min(3),
    arms: z
      .array(
        z
          .object({
            id: ArmSchema,
            harnessVersion: NonEmptyStringSchema,
            planContract: NonEmptyStringSchema,
            executionPolicy: NonEmptyStringSchema,
          })
          .strict(),
      )
      .length(ARM_IDS.length),
    controls: ControlsSchema.extend({ projection: NonEmptyStringSchema }),
    requiredTrialEvidence: z.array(NonEmptyStringSchema).min(1),
    stopConditions: z.array(NonEmptyStringSchema).min(1),
    notClaimed: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

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

const TrialEvidencePayloadSchema = z
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
  })
  .strict();

const TrialEvidenceReceiptSchema = z
  .object({
    schemaVersion: z.literal(ADAPTIVE_SOP_COMPARATIVE_TRIAL_RECEIPT_SCHEMA_VERSION),
    pilotManifestSha256: Sha256Schema,
    trialEvidenceSha256: Sha256Schema,
    evidence: z
      .array(
        z
          .object({
            uri: z.string().url(),
            sha256: Sha256Schema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const TrialSchema = TrialEvidencePayloadSchema.extend({
  evidenceReceipt: TrialEvidenceReceiptSchema,
});

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
    pilotManifestSha256: Sha256Schema,
    controls: ControlsSchema,
    trials: z.array(TrialSchema).min(1),
  })
  .strict();

type ComparativePilot = z.infer<typeof ComparativePilotSchema>;
type ComparativePilotManifest = z.infer<typeof ComparativePilotManifestSchema>;
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
  readonly planContractAttemptCount: number;
  readonly reviewFindingCounts: Readonly<{ p1: number; p2: number; p3: number }>;
  readonly rollbackCount: number;
  readonly escapedRegressionCount: number;
  readonly schemaRejectionCount: number;
  readonly semanticRejectionCount: number;
  readonly knownPlanningTimeMs: number;
  readonly knownExecutionTimeMs: number;
  readonly knownCost: Readonly<{
    invocations: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    wallTimeMs: number;
    gateDurationMs: number;
  }>;
  readonly incompleteTrialCount: number;
}

export interface AdaptiveSopComparativePilotResult {
  readonly schemaVersion: typeof ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION;
  readonly pilotId: string;
  readonly fixtureId: string;
  readonly pilotManifestSha256: string;
  readonly status: 'stop' | 'insufficient_evidence' | 'ready_for_operator_comparison';
  readonly trialsPerArm: number;
  readonly stopReasons: readonly string[];
  readonly incompleteReasons: readonly string[];
  readonly arms: Readonly<Record<ArmId, ArmSummary>>;
}

export function fingerprintAdaptiveSopComparativePilotManifest(input: unknown): string {
  return sha256(parseComparativePilotManifest(input));
}

export function fingerprintAdaptiveSopComparativeTrialEvidence(input: unknown): string {
  if (!isRecord(input)) return sha256(TrialEvidencePayloadSchema.parse(input));
  const { evidenceReceipt: _evidenceReceipt, evidenceRefs: _legacyEvidenceRefs, ...payload } = input;
  return sha256(TrialEvidencePayloadSchema.parse(payload));
}

export function evaluateAdaptiveSopComparativePilot(
  input: unknown,
  manifestInput: unknown,
): AdaptiveSopComparativePilotResult {
  assertManifestBoundReceiptsPresent(input);
  const manifest = parseComparativePilotManifest(manifestInput);
  const manifestSha256 = sha256(manifest);
  const pilot = ComparativePilotSchema.parse(input);
  const trialsPerArm = assertComparableTrialMatrix(pilot);
  assertPilotManifestBinding(pilot, manifest, manifestSha256, trialsPerArm);
  assertComparableIdentityAndProvenance(pilot, manifest);
  for (const trial of pilot.trials) {
    assertTrialReceiptBinding(trial, manifestSha256);
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
    pilotManifestSha256: manifestSha256,
    status,
    trialsPerArm,
    stopReasons,
    incompleteReasons,
    arms,
  };
}

function assertManifestBoundReceiptsPresent(input: unknown): void {
  if (!isRecord(input) || !Array.isArray(input.trials)) return;
  if (input.trials.some((trial) => !isRecord(trial) || !isRecord(trial.evidenceReceipt))) {
    throw new Error('every comparative trial requires a manifest-bound content receipt');
  }
}

function parseComparativePilotManifest(input: unknown): ComparativePilotManifest {
  const manifest = ComparativePilotManifestSchema.parse(input);
  const receivedArms = new Set(manifest.arms.map((arm) => arm.id));
  if (receivedArms.size !== ARM_IDS.length || ARM_IDS.some((arm) => !receivedArms.has(arm))) {
    throw new Error('pinned pilot manifest must define every comparative arm exactly once');
  }
  return manifest;
}

function assertPilotManifestBinding(
  pilot: ComparativePilot,
  manifest: ComparativePilotManifest,
  manifestSha256: string,
  trialsPerArm: number,
): void {
  if (pilot.pilotManifestSha256 !== manifestSha256) {
    throw new Error('pilot manifest fingerprint does not match the pinned pilot manifest');
  }
  if (pilot.pilotId !== manifest.pilotId) throw new Error('pilot id must match the pinned pilot manifest');
  if (pilot.fixture.fixtureId !== manifest.fixtureId) {
    throw new Error('fixture id must match the pinned pilot manifest');
  }
  if (pilot.fixture.sourcePullRequest !== manifest.sourcePullRequest) {
    throw new Error('source pull request must match the pinned pilot manifest');
  }
  if (pilot.fixture.baseSha !== manifest.baseCommit) {
    throw new Error('fixture base must match the pinned pilot manifest');
  }
  if (pilot.fixture.modelInputSha256 !== manifest.modelInputSha256) {
    throw new Error('model input must match the pinned pilot manifest');
  }
  if (
    pilot.fixture.mutatingWork !== manifest.fixture.mutatingWork ||
    pilot.fixture.protectedSurface !== manifest.fixture.protectedSurface ||
    pilot.fixture.objectiveOutcomeCheck !== manifest.fixture.objectiveOutcomeCheck
  ) {
    throw new Error('fixture controls must match the pinned pilot manifest');
  }
  for (const key of Object.keys(pilot.controls) as Array<keyof ComparativePilot['controls']>) {
    if (pilot.controls[key] !== manifest.controls[key]) {
      throw new Error(`control ${key} must match the pinned pilot manifest`);
    }
  }
  if (trialsPerArm !== manifest.trialsPerArm) {
    throw new Error('trial count per arm must match the pinned pilot manifest');
  }
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

function assertComparableIdentityAndProvenance(
  pilot: ComparativePilot,
  manifest: ComparativePilotManifest,
): void {
  const modelIdentities = new Set(pilot.trials.map((trial) => `${trial.model.provider}:${trial.model.modelId}`));
  if (modelIdentities.size !== 1) throw new Error('every arm must use the same model identity');
  if (![...modelIdentities][0] || [...modelIdentities][0] !== `${manifest.model.provider}:${manifest.model.modelId}`) {
    throw new Error('trial model identity must match the pinned pilot manifest');
  }

  for (const arm of ARM_IDS) {
    const manifestArm = manifest.arms.find((candidate) => candidate.id === arm);
    if (!manifestArm) throw new Error(`pinned pilot manifest is missing arm ${arm}`);
    const harnessVersions = new Set(
      pilot.trials.filter((trial) => trial.arm === arm).map((trial) => trial.harnessVersion),
    );
    if (harnessVersions.size !== 1) {
      throw new Error('every trial within an arm must use the same harness version');
    }
    if ([...harnessVersions][0] !== manifestArm.harnessVersion) {
      throw new Error(`harness version for ${arm} must match the pinned pilot manifest`);
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

function assertTrialReceiptBinding(trial: ComparativeTrial, manifestSha256: string): void {
  if (trial.evidenceReceipt.pilotManifestSha256 !== manifestSha256) {
    throw new Error('trial receipt must bind to the pinned pilot manifest');
  }
  const trialEvidenceSha256 = fingerprintAdaptiveSopComparativeTrialEvidence(trial);
  if (trial.evidenceReceipt.trialEvidenceSha256 !== trialEvidenceSha256) {
    throw new Error('trial receipt fingerprint does not match the comparative evidence');
  }
  if (!trial.evidenceReceipt.evidence.some((reference) => reference.sha256 === trialEvidenceSha256)) {
    throw new Error('trial receipt must contain a content-addressed reference to the comparative evidence');
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
    planContractAttemptCount: sumKnownContractMetric(trials, 'planContractAttempts'),
    reviewFindingCounts: {
      p1: trials.reduce((total, trial) => total + trial.outcome.reviewFindingCounts.p1, 0),
      p2: trials.reduce((total, trial) => total + trial.outcome.reviewFindingCounts.p2, 0),
      p3: trials.reduce((total, trial) => total + trial.outcome.reviewFindingCounts.p3, 0),
    },
    rollbackCount: trials.filter((trial) => trial.outcome.rollback).length,
    escapedRegressionCount: trials.filter((trial) => trial.outcome.escapedRegression === true).length,
    schemaRejectionCount: sumKnownContractMetric(trials, 'schemaRejections'),
    semanticRejectionCount: sumKnownContractMetric(trials, 'semanticRejections'),
    knownPlanningTimeMs: sumKnownMetric(trials, (trial) => trial.harnessTax.planningTimeMs),
    knownExecutionTimeMs: sumKnownMetric(trials, (trial) => trial.harnessTax.executionTimeMs),
    knownCost: {
      invocations: sumKnownMetric(trials, (trial) => trial.cost.invocations),
      toolCalls: sumKnownMetric(trials, (trial) => trial.cost.toolCalls),
      inputTokens: sumKnownMetric(trials, (trial) => trial.cost.inputTokens),
      outputTokens: sumKnownMetric(trials, (trial) => trial.cost.outputTokens),
      wallTimeMs: sumKnownMetric(trials, (trial) => trial.cost.wallTimeMs),
      gateDurationMs: sumKnownMetric(trials, (trial) => trial.cost.gateDurationMs),
    },
    incompleteTrialCount: trials.filter(
      (trial) => !trial.telemetryComplete || collectObservedMissingFields(trial).length > 0,
    ).length,
  };
}

function sumKnownContractMetric(
  trials: readonly ComparativeTrial[],
  key:
    | 'planContractAttempts'
    | 'schemaRejections'
    | 'semanticRejections'
    | 'externalSchemaPatches'
    | 'responseRepairs',
): number {
  return trials.reduce((total, trial) => {
    const value = trial.harnessTax[key];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
}

function sumKnownMetric(trials: readonly ComparativeTrial[], select: (trial: ComparativeTrial) => unknown): number {
  return trials.reduce((total, trial) => {
    const value = select(trial);
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

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
