import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ADAPTIVE_SOP_COMPARATIVE_PILOT_SCHEMA_VERSION = 'lf-0001.comparative-pilot.v1' as const;
export const ADAPTIVE_SOP_COMPARATIVE_PILOT_MANIFEST_SCHEMA_VERSION = 'lf-0001.comparative-pilot-manifest.v1' as const;
export const ADAPTIVE_SOP_COMPARATIVE_TRIAL_RECEIPT_SCHEMA_VERSION = 'lf-0001.comparative-trial-receipt.v1' as const;
export const ADAPTIVE_SOP_COMPARATIVE_EVIDENCE_SCHEMA_VERSION = 'lf-0001.comparative-evidence.v1' as const;

const ARM_IDS = ['full_sop', 'free_plan_hard_gates', 'adaptive_plan_hard_gates'] as const;
const EVIDENCE_KINDS = [
  'execution_provenance',
  'diff_and_verification',
  'review_and_outcome',
  'safety',
  'harness_tax',
  'telemetry',
] as const;
const ArmSchema = z.enum(ARM_IDS);
const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
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

const NamedPolicySchema = z
  .object({
    id: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
  })
  .strict();

const CommandPolicySchema = z
  .object({
    id: NonEmptyStringSchema,
    commandOrTool: NonEmptyStringSchema,
    successExitCode: z.number().int(),
  })
  .strict();

const ComparabilityFingerprintSchema = z
  .object({
    allowedChangeEnvelopeSha256: Sha256Schema,
    outcomeOraclePolicySha256: Sha256Schema,
    gatePolicySha256: Sha256Schema,
    toolPermissionsPolicySha256: Sha256Schema,
    dataIsolationPolicySha256: Sha256Schema,
    reviewBoundaryPolicySha256: Sha256Schema,
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
    comparability: z
      .object({
        allowedChangedPaths: z.array(NonEmptyStringSchema).min(1),
        outcomeOracle: CommandPolicySchema,
        gatePolicy: CommandPolicySchema,
        toolPermissionsPolicy: NamedPolicySchema,
        dataIsolationPolicy: NamedPolicySchema,
        reviewBoundaryPolicy: NamedPolicySchema,
      })
      .strict(),
    requiredTrialEvidence: z.array(EvidenceKindSchema).length(EVIDENCE_KINDS.length),
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

const SafetySchema = z
  .object({ hardInvariantMisses: z.array(NonEmptyStringSchema), p1p2Escapes: NonNegativeIntegerSchema })
  .strict();

const TrialEvidencePayloadSchema = z
  .object({
    arm: ArmSchema,
    trialIndex: NonNegativeIntegerSchema,
    model: z.object({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }).strict(),
    harnessVersion: NonEmptyStringSchema,
    provenance: z
      .object({
        baseSha: Sha1Schema,
        finalSha: Sha1Schema,
        modelInputSha256: Sha256Schema,
        environmentFingerprint: Sha256Schema,
      })
      .strict(),
    outcome: OutcomeSchema,
    safety: SafetySchema,
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
            kind: EvidenceKindSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const TrialSchema = TrialEvidencePayloadSchema.extend({
  evidenceReceipt: TrialEvidenceReceiptSchema,
});

const EvidenceBindingSchema = {
  schemaVersion: z.literal(ADAPTIVE_SOP_COMPARATIVE_EVIDENCE_SCHEMA_VERSION),
  pilotId: NonEmptyStringSchema,
  arm: ArmSchema,
  trialIndex: NonNegativeIntegerSchema,
  comparability: ComparabilityFingerprintSchema,
};

const ResolvedEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...EvidenceBindingSchema,
      kind: z.literal('execution_provenance'),
      payload: z
        .object({
          baseSha: Sha1Schema,
          finalSha: Sha1Schema,
          modelInputSha256: Sha256Schema,
          environmentFingerprint: Sha256Schema,
          model: z.object({ provider: NonEmptyStringSchema, modelId: NonEmptyStringSchema }).strict(),
          harnessVersion: NonEmptyStringSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EvidenceBindingSchema,
      kind: z.literal('diff_and_verification'),
      payload: z
        .object({
          baseSha: Sha1Schema,
          finalSha: Sha1Schema,
          changedPaths: z.array(NonEmptyStringSchema).min(1),
          diffFingerprint: Sha256Schema,
          outcomeOracle: z
            .object({
              policyId: NonEmptyStringSchema,
              commandOrTool: NonEmptyStringSchema,
              exitCode: z.number().int(),
              evidenceSha256: Sha256Schema,
            })
            .strict(),
          verification: z
            .array(
              z
                .object({
                  commandOrTool: NonEmptyStringSchema,
                  exitCode: z.number().int(),
                  evidenceSha256: Sha256Schema,
                })
                .strict(),
            )
            .min(1),
          gate: z
            .object({
              policyId: NonEmptyStringSchema,
              commandOrTool: NonEmptyStringSchema,
              exitCode: z.number().int(),
              finalSha: Sha1Schema,
              evidenceSha256: Sha256Schema,
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EvidenceBindingSchema,
      kind: z.literal('review_and_outcome'),
      payload: z
        .object({
          outcome: OutcomeSchema,
          review: z
            .object({
              finalSha: Sha1Schema,
              authorId: NonEmptyStringSchema,
              reviewerId: NonEmptyStringSchema,
              reviewArtifactSha256: Sha256Schema,
              p1p2Cleared: z.boolean(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...EvidenceBindingSchema, kind: z.literal('safety'), payload: SafetySchema }).strict(),
  z.object({ ...EvidenceBindingSchema, kind: z.literal('harness_tax'), payload: HarnessTaxSchema }).strict(),
  z
    .object({
      ...EvidenceBindingSchema,
      kind: z.literal('telemetry'),
      payload: z
        .object({
          cost: CostSchema,
          telemetryComplete: z.boolean(),
          missingFields: z.array(NonEmptyStringSchema),
        })
        .strict(),
    })
    .strict(),
]);

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
type ComparativeResolvedEvidence = z.infer<typeof ResolvedEvidenceSchema>;
type ArmId = z.infer<typeof ArmSchema>;

export type AdaptiveSopComparativeEvidenceReference = ComparativeTrial['evidenceReceipt']['evidence'][number];

export interface AdaptiveSopComparativeEvidenceResolver {
  resolve(reference: AdaptiveSopComparativeEvidenceReference): unknown | undefined;
}

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

export function fingerprintAdaptiveSopComparativeResolvedEvidence(input: unknown): string {
  return sha256(ResolvedEvidenceSchema.parse(input));
}

export function fingerprintAdaptiveSopComparativePolicy(input: unknown): string {
  return sha256(input);
}

export function evaluateAdaptiveSopComparativePilot(
  input: unknown,
  manifestInput: unknown,
  evidenceResolver?: AdaptiveSopComparativeEvidenceResolver,
): AdaptiveSopComparativePilotResult {
  assertManifestBoundReceiptsPresent(input);
  const manifest = parseComparativePilotManifest(manifestInput);
  const manifestSha256 = sha256(manifest);
  const pilot = ComparativePilotSchema.parse(input);
  const trialsPerArm = assertComparableTrialMatrix(pilot);
  assertPilotManifestBinding(pilot, manifest, manifestSha256, trialsPerArm);
  assertComparableIdentityAndProvenance(pilot, manifest);
  const comparabilityFingerprints = deriveComparabilityFingerprints(manifest);
  const receiptIncompleteReasons: string[] = [];
  for (const trial of pilot.trials) {
    assertTrialReceiptBinding(trial, manifest, manifestSha256);
    receiptIncompleteReasons.push(
      ...resolveTrialEvidence(trial, pilot.pilotId, manifest, comparabilityFingerprints, evidenceResolver),
    );
    assertContractMetricApplicability(trial);
    assertTelemetryDeclaration(trial);
  }

  const arms = Object.fromEntries(
    ARM_IDS.map((arm) => [arm, summarizeArm(pilot.trials.filter((trial) => trial.arm === arm))]),
  ) as Record<ArmId, ArmSummary>;
  const stopReasons = collectStopReasons(pilot, arms);
  const incompleteReasons = [...new Set([...collectIncompleteReasons(arms), ...receiptIncompleteReasons])];
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
  const receivedEvidence = new Set(manifest.requiredTrialEvidence);
  if (receivedEvidence.size !== EVIDENCE_KINDS.length || EVIDENCE_KINDS.some((kind) => !receivedEvidence.has(kind))) {
    throw new Error('pinned pilot manifest must require every comparative evidence kind exactly once');
  }
  if (new Set(manifest.comparability.allowedChangedPaths).size !== manifest.comparability.allowedChangedPaths.length) {
    throw new Error('pinned allowed change envelope paths must be unique');
  }
  return manifest;
}

function deriveComparabilityFingerprints(
  manifest: ComparativePilotManifest,
): z.infer<typeof ComparabilityFingerprintSchema> {
  return {
    allowedChangeEnvelopeSha256: sha256([...manifest.comparability.allowedChangedPaths].sort()),
    outcomeOraclePolicySha256: sha256(manifest.comparability.outcomeOracle),
    gatePolicySha256: sha256(manifest.comparability.gatePolicy),
    toolPermissionsPolicySha256: sha256(manifest.comparability.toolPermissionsPolicy),
    dataIsolationPolicySha256: sha256(manifest.comparability.dataIsolationPolicy),
    reviewBoundaryPolicySha256: sha256(manifest.comparability.reviewBoundaryPolicy),
  };
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

function assertComparableIdentityAndProvenance(pilot: ComparativePilot, manifest: ComparativePilotManifest): void {
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

function assertTrialReceiptBinding(
  trial: ComparativeTrial,
  manifest: ComparativePilotManifest,
  manifestSha256: string,
): void {
  if (trial.evidenceReceipt.pilotManifestSha256 !== manifestSha256) {
    throw new Error('trial receipt must bind to the pinned pilot manifest');
  }
  const trialEvidenceSha256 = fingerprintAdaptiveSopComparativeTrialEvidence(trial);
  if (trial.evidenceReceipt.trialEvidenceSha256 !== trialEvidenceSha256) {
    throw new Error('trial receipt fingerprint does not match the comparative evidence');
  }
  const receivedKinds = new Set(trial.evidenceReceipt.evidence.map((reference) => reference.kind));
  if (
    trial.evidenceReceipt.evidence.length !== manifest.requiredTrialEvidence.length ||
    receivedKinds.size !== manifest.requiredTrialEvidence.length ||
    manifest.requiredTrialEvidence.some((kind) => !receivedKinds.has(kind))
  ) {
    throw new Error('trial receipt must reference every evidence kind required by the pinned manifest exactly once');
  }
}

function resolveTrialEvidence(
  trial: ComparativeTrial,
  pilotId: string,
  manifest: ComparativePilotManifest,
  comparabilityFingerprints: z.infer<typeof ComparabilityFingerprintSchema>,
  resolver: AdaptiveSopComparativeEvidenceResolver | undefined,
): string[] {
  if (!resolver) return ['one or more trial evidence receipts were not independently resolved'];

  for (const reference of trial.evidenceReceipt.evidence) {
    let raw: unknown;
    try {
      raw = resolver.resolve(reference);
    } catch {
      return ['one or more trial evidence receipts could not be resolved'];
    }
    if (raw === undefined) return ['one or more trial evidence receipts could not be resolved'];
    if (sha256(raw) !== reference.sha256) {
      throw new Error(`resolved ${reference.kind} evidence does not match its content fingerprint`);
    }
    const evidence = ResolvedEvidenceSchema.parse(raw);
    if (
      evidence.kind !== reference.kind ||
      evidence.pilotId !== pilotId ||
      evidence.arm !== trial.arm ||
      evidence.trialIndex !== trial.trialIndex
    ) {
      throw new Error(`resolved ${reference.kind} evidence is bound to a different comparative trial`);
    }
    if (canonicalJson(evidence.comparability) !== canonicalJson(comparabilityFingerprints)) {
      throw new Error('resolved evidence comparability controls do not match the pinned pilot manifest');
    }
    assertResolvedEvidenceMatchesTrial(evidence, trial, manifest);
  }
  return [];
}

function assertResolvedEvidenceMatchesTrial(
  evidence: ComparativeResolvedEvidence,
  trial: ComparativeTrial,
  manifest: ComparativePilotManifest,
): void {
  switch (evidence.kind) {
    case 'execution_provenance':
      if (
        evidence.payload.baseSha !== trial.provenance.baseSha ||
        evidence.payload.finalSha !== trial.provenance.finalSha ||
        evidence.payload.modelInputSha256 !== trial.provenance.modelInputSha256 ||
        evidence.payload.environmentFingerprint !== trial.provenance.environmentFingerprint ||
        canonicalJson(evidence.payload.model) !== canonicalJson(trial.model) ||
        evidence.payload.harnessVersion !== trial.harnessVersion
      ) {
        throw new Error('resolved execution provenance does not match the comparative trial');
      }
      return;
    case 'diff_and_verification':
      assertResolvedDiffAndVerification(evidence, trial, manifest);
      return;
    case 'review_and_outcome':
      if (
        evidence.payload.review.finalSha !== trial.provenance.finalSha ||
        evidence.payload.review.authorId === evidence.payload.review.reviewerId ||
        evidence.payload.review.p1p2Cleared !==
          (trial.outcome.reviewFindingCounts.p1 === 0 && trial.outcome.reviewFindingCounts.p2 === 0)
      ) {
        throw new Error('resolved review evidence does not preserve cross-individual P1/P2 clearance');
      }
      assertSameResolvedPayload(evidence.kind, evidence.payload.outcome, trial.outcome);
      return;
    case 'safety':
      assertSameResolvedPayload(evidence.kind, evidence.payload, trial.safety);
      return;
    case 'harness_tax':
      assertSameResolvedPayload(evidence.kind, evidence.payload, trial.harnessTax);
      return;
    case 'telemetry':
      assertSameResolvedPayload(evidence.kind, evidence.payload, {
        cost: trial.cost,
        telemetryComplete: trial.telemetryComplete,
        missingFields: trial.missingFields,
      });
  }
}

function assertResolvedDiffAndVerification(
  evidence: Extract<ComparativeResolvedEvidence, { kind: 'diff_and_verification' }>,
  trial: ComparativeTrial,
  manifest: ComparativePilotManifest,
): void {
  if (
    new Set(evidence.payload.changedPaths).size !== evidence.payload.changedPaths.length ||
    evidence.payload.changedPaths.some((path) => !manifest.comparability.allowedChangedPaths.includes(path))
  ) {
    throw new Error('resolved diff contains a path outside the pinned allowed change envelope');
  }
  const oracleSucceeded =
    evidence.payload.outcomeOracle.exitCode === manifest.comparability.outcomeOracle.successExitCode;
  const gateSucceeded = evidence.payload.gate.exitCode === manifest.comparability.gatePolicy.successExitCode;
  const verificationSucceeded = evidence.payload.verification.every((check) => check.exitCode === 0);
  if (
    evidence.payload.baseSha !== trial.provenance.baseSha ||
    evidence.payload.finalSha !== trial.provenance.finalSha ||
    evidence.payload.outcomeOracle.policyId !== manifest.comparability.outcomeOracle.id ||
    evidence.payload.outcomeOracle.commandOrTool !== manifest.comparability.outcomeOracle.commandOrTool ||
    (typeof trial.outcome.requestedOutcomeMet === 'boolean' && oracleSucceeded !== trial.outcome.requestedOutcomeMet) ||
    evidence.payload.gate.policyId !== manifest.comparability.gatePolicy.id ||
    evidence.payload.gate.commandOrTool !== manifest.comparability.gatePolicy.commandOrTool ||
    evidence.payload.gate.finalSha !== trial.provenance.finalSha ||
    (typeof trial.outcome.testsPassed === 'boolean' &&
      (gateSucceeded !== trial.outcome.testsPassed || verificationSucceeded !== trial.outcome.testsPassed))
  ) {
    throw new Error('resolved diff or verification evidence does not match the comparative trial');
  }
}

function assertSameResolvedPayload(kind: string, resolved: unknown, reported: unknown): void {
  if (canonicalJson(resolved) !== canonicalJson(reported)) {
    throw new Error(`resolved ${kind} evidence does not match the comparative trial`);
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
  key: 'planContractAttempts' | 'schemaRejections' | 'semanticRejections' | 'externalSchemaPatches' | 'responseRepairs',
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
