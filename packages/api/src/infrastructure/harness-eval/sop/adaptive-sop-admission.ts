import { createHash } from 'node:crypto';
import {
  type AdaptiveSopPlan,
  SOP_ADMISSION_DECISION_SCHEMA_VERSION,
  type SopAdmissionDecision,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { AdaptiveSopContractError, parseAdaptiveSopPlan } from './adaptive-sop-contract.js';

export const SOP_ADMISSION_FACTS_SCHEMA_VERSION = 'sop-admission-facts.v1' as const;

const NonEmptyStringSchema = z.string().trim().min(1);
const KnownBooleanSchema = z.union([z.boolean(), z.literal('unknown')]);
const KnownStringSchema = z.union([NonEmptyStringSchema, z.literal('unknown')]);
const KnownSha1Schema = z.union([z.string().regex(/^[0-9a-f]{40}$/), z.literal('unknown')]);
const KnownSha256Schema = z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal('unknown')]);
const KnownChangedFilesSchema = z.union([z.array(NonEmptyStringSchema), z.literal('unknown')]);

export const SopAdmissionFactsSchema = z
  .object({
    schemaVersion: z.literal(SOP_ADMISSION_FACTS_SCHEMA_VERSION),
    episodeId: NonEmptyStringSchema,
    observedAt: z.string().datetime({ offset: true }),
    repository: z
      .object({
        worktreeRoot: KnownStringSchema,
        branch: KnownStringSchema,
        baseSha: KnownSha1Schema,
        changedFiles: KnownChangedFilesSchema,
        diffFingerprint: KnownSha256Schema,
        isolatedWorktree: KnownBooleanSchema,
        recoveryWithinOneCommit: KnownBooleanSchema,
      })
      .strict(),
    data: z
      .object({
        testDataIsolated: z.union([z.boolean(), z.enum(['unknown', 'not_applicable'])]),
        productionUserDataInScope: KnownBooleanSchema,
      })
      .strict(),
    effects: z
      .object({
        externalUserEffect: KnownBooleanSchema,
        destructiveOrIrreversible: KnownBooleanSchema,
        authDelta: KnownBooleanSchema,
        persistentDataDelta: KnownBooleanSchema,
        runtimeDelta: KnownBooleanSchema,
        permissionDelta: KnownBooleanSchema,
        publicContractDelta: KnownBooleanSchema,
        newExternalDependency: KnownBooleanSchema,
        significantCost: KnownBooleanSchema,
      })
      .strict(),
    verification: z
      .object({
        objectiveOutcomeCheck: KnownBooleanSchema,
        mutatingWork: KnownBooleanSchema,
        crossIndividualReviewPlanned: KnownBooleanSchema,
        p1p2ClearancePlanned: KnownBooleanSchema,
      })
      .strict(),
  })
  .strict();

export type SopAdmissionFacts = z.infer<typeof SopAdmissionFactsSchema>;

const OPERATOR_PROTECTED_FACTS = [
  'data.productionUserDataInScope',
  'effects.externalUserEffect',
  'effects.destructiveOrIrreversible',
  'effects.authDelta',
  'effects.persistentDataDelta',
  'effects.runtimeDelta',
  'effects.permissionDelta',
  'effects.publicContractDelta',
  'effects.newExternalDependency',
  'effects.significantCost',
] as const;

const REQUIRED_REPOSITORY_FACTS = [
  'repository.worktreeRoot',
  'repository.branch',
  'repository.baseSha',
  'repository.changedFiles',
  'repository.diffFingerprint',
  'repository.isolatedWorktree',
  'repository.recoveryWithinOneCommit',
] as const;

export function parseSopAdmissionFacts(input: unknown): SopAdmissionFacts {
  if (!isRecord(input) || typeof input.schemaVersion !== 'string') {
    throw factContractError('invalid_contract', undefined, ['schemaVersion is required']);
  }
  if (input.schemaVersion !== SOP_ADMISSION_FACTS_SCHEMA_VERSION) {
    throw factContractError('unsupported_schema_version', input.schemaVersion, [
      `supported=${SOP_ADMISSION_FACTS_SCHEMA_VERSION}`,
      `received=${input.schemaVersion}`,
    ]);
  }

  const result = SopAdmissionFactsSchema.safeParse(input);
  if (!result.success) {
    throw factContractError(
      'invalid_contract',
      input.schemaVersion,
      result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function evaluateSopAdmission(planInput: unknown, factsInput: unknown): SopAdmissionDecision {
  const plan = parseAdaptiveSopPlan(planInput);
  const facts = parseSopAdmissionFacts(factsInput);

  const identityBlock = evaluateIdentityAndFactConsistency(plan, facts);
  if (identityBlock) return blocked(identityBlock, 'full_sop');

  const protectedFact = firstTrueProtectedFact(facts);
  if (protectedFact) return blocked(`protected surface: ${protectedFact}`, 'operator');

  const containmentFailure = firstContainmentFailure(facts);
  if (containmentFailure) return blocked(`containment failed: ${containmentFailure}`, 'full_sop');

  const revision = collectRevisionNeeds(facts);
  if (revision.requiredFacts.length > 0) {
    return {
      schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
      status: 'revise',
      violations: revision.violations,
      requiredFacts: revision.requiredFacts,
    };
  }

  return {
    schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
    status: 'admitted',
    episodeId: plan.episodeId,
    envelopeFingerprint: buildEnvelopeFingerprint(plan, facts),
  };
}

function evaluateIdentityAndFactConsistency(plan: AdaptiveSopPlan, facts: SopAdmissionFacts): string | undefined {
  if (plan.episodeId !== facts.episodeId) return 'contradictory episode identity';

  const scalarFacts: Array<
    [keyof Pick<AdaptiveSopPlan['repositoryFacts'], 'worktreeRoot' | 'branch' | 'baseSha' | 'diffFingerprint'>, string]
  > = [
    ['worktreeRoot', facts.repository.worktreeRoot],
    ['branch', facts.repository.branch],
    ['baseSha', facts.repository.baseSha],
    ['diffFingerprint', facts.repository.diffFingerprint],
  ];
  for (const [key, observed] of scalarFacts) {
    const claimed = plan.repositoryFacts[key];
    if (observed !== 'unknown' && claimed !== undefined && claimed !== observed) {
      return `contradictory repository fact: ${key}`;
    }
  }

  if (
    facts.repository.changedFiles !== 'unknown' &&
    plan.repositoryFacts.changedFiles !== undefined &&
    !sameStringSet(plan.repositoryFacts.changedFiles, facts.repository.changedFiles)
  ) {
    return 'contradictory repository fact: changedFiles';
  }
  return undefined;
}

function firstTrueProtectedFact(facts: SopAdmissionFacts): (typeof OPERATOR_PROTECTED_FACTS)[number] | undefined {
  return OPERATOR_PROTECTED_FACTS.find((path) => readFact(facts, path) === true);
}

function firstContainmentFailure(facts: SopAdmissionFacts): string | undefined {
  if (facts.repository.isolatedWorktree === false) return 'repository.isolatedWorktree';
  if (facts.repository.recoveryWithinOneCommit === false) return 'repository.recoveryWithinOneCommit';
  if (facts.data.testDataIsolated === false) return 'data.testDataIsolated';
  return undefined;
}

function collectRevisionNeeds(facts: SopAdmissionFacts): { violations: string[]; requiredFacts: string[] } {
  const violations: string[] = [];
  const requiredFacts: string[] = [];

  for (const path of REQUIRED_REPOSITORY_FACTS) {
    if (readFact(facts, path) === 'unknown') addRevision(path, `${path} is unknown`, violations, requiredFacts);
  }
  if (facts.data.testDataIsolated === 'unknown') {
    addRevision('data.testDataIsolated', 'data.testDataIsolated is unknown', violations, requiredFacts);
  }
  for (const path of OPERATOR_PROTECTED_FACTS) {
    if (readFact(facts, path) === 'unknown') addRevision(path, `${path} is unknown`, violations, requiredFacts);
  }

  collectVerificationRevisionNeeds(facts, violations, requiredFacts);
  return { violations, requiredFacts };
}

function collectVerificationRevisionNeeds(
  facts: SopAdmissionFacts,
  violations: string[],
  requiredFacts: string[],
): void {
  const { verification } = facts;
  if (verification.objectiveOutcomeCheck !== true) {
    addRevision(
      'verification.objectiveOutcomeCheck',
      verification.objectiveOutcomeCheck === false
        ? 'objective outcome check is not established'
        : 'verification.objectiveOutcomeCheck is unknown',
      violations,
      requiredFacts,
    );
  }
  if (verification.mutatingWork === 'unknown') {
    addRevision('verification.mutatingWork', 'verification.mutatingWork is unknown', violations, requiredFacts);
    return;
  }
  if (!verification.mutatingWork) return;

  if (verification.crossIndividualReviewPlanned !== true) {
    addRevision(
      'verification.crossIndividualReviewPlanned',
      verification.crossIndividualReviewPlanned === false
        ? 'cross-individual review is not planned'
        : 'verification.crossIndividualReviewPlanned is unknown',
      violations,
      requiredFacts,
    );
  }
  if (verification.p1p2ClearancePlanned !== true) {
    addRevision(
      'verification.p1p2ClearancePlanned',
      verification.p1p2ClearancePlanned === false
        ? 'P1/P2 clearance is not planned'
        : 'verification.p1p2ClearancePlanned is unknown',
      violations,
      requiredFacts,
    );
  }
}

function addRevision(path: string, violation: string, violations: string[], requiredFacts: string[]): void {
  if (!requiredFacts.includes(path)) requiredFacts.push(path);
  if (!violations.includes(violation)) violations.push(violation);
}

function blocked(invariant: string, fallback: 'full_sop' | 'operator'): SopAdmissionDecision {
  return {
    schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
    status: 'blocked',
    invariant,
    fallback,
  };
}

function buildEnvelopeFingerprint(plan: AdaptiveSopPlan, facts: SopAdmissionFacts): string {
  const normalizedPlan = {
    ...plan,
    repositoryFacts: {
      ...plan.repositoryFacts,
      changedFiles: plan.repositoryFacts.changedFiles ? [...plan.repositoryFacts.changedFiles].sort() : undefined,
    },
  };
  const { observedAt: _observedAt, ...stableFacts } = facts;
  const normalizedFacts = {
    ...stableFacts,
    repository: {
      ...stableFacts.repository,
      changedFiles:
        stableFacts.repository.changedFiles === 'unknown' ? 'unknown' : [...stableFacts.repository.changedFiles].sort(),
    },
  };
  return createHash('sha256')
    .update(canonicalJson({ plan: normalizedPlan, facts: normalizedFacts }))
    .digest('hex');
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

function readFact(facts: SopAdmissionFacts, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), facts);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function factContractError(
  code: 'unsupported_schema_version' | 'invalid_contract',
  receivedVersion: string | undefined,
  issues: readonly string[],
): AdaptiveSopContractError {
  return new AdaptiveSopContractError({
    code,
    contract: 'SopAdmissionFacts',
    supportedVersion: SOP_ADMISSION_FACTS_SCHEMA_VERSION,
    receivedVersion,
    issues,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
