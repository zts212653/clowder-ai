import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  type EvalDomainRegistryEntry,
  evalDomainIdSchema,
  isEvalDomainRegistryYamlFile,
  parseEvalDomainRegistryFile,
} from '../domain/eval-domain-registry.js';
import { hasEvalDomainInstructions, hasEvalDomainPublishInstructions } from '../eval-cat-invocation.js';
import { scanMeasurementVerdictCorpus } from './measurement-bundle-census-corpus.js';

export const MEASUREMENT_BUNDLE_ACTIVE_ACTIONS = ['keep_observe', 'fix', 'build', 'delete_sunset'] as const;
const MIGRATION_STATUSES = [
  'unmigrated',
  'contract_ready',
  'certified_insufficient',
  'certified_usable',
  'blocked_f275',
  'gated',
  'nonoperational',
] as const;

const ValidityMigrationSchema = z
  .object({
    riskRank: z.number().int().positive().nullable(),
    batch: z.number().int().positive().nullable(),
    status: z.enum(MIGRATION_STATUSES),
    certificateRef: z.string().min(1).nullable(),
    resultRef: z.string().min(1).nullable(),
    replayRef: z.string().min(1).nullable(),
    actionGate: z.enum(['keep_observe_only', 'certificate_actions_allowed']),
    hardBlockReason: z.string().min(1).nullable(),
  })
  .strict();

export const MeasurementBundleCensusEntrySchema = z
  .object({
    domainId: evalDomainIdSchema,
    classification: z.enum(['active_decision_bearing', 'gated', 'registered_nonoperational']),
    enabled: z.boolean(),
    decisionConsumer: z
      .object({
        featureId: z.string().regex(/^F\d{3}$/),
        ownerCatId: z.string().min(1),
        allowedActions: z.array(z.enum(MEASUREMENT_BUNDLE_ACTIVE_ACTIONS)),
      })
      .strict(),
    sourceSelector: z
      .object({
        adapter: z.string().min(1),
        kind: z.string().min(1),
      })
      .strict(),
    committedVerdictArtifactCount: z.number().int().nonnegative(),
    functionalEquivalents: z.array(z.string().min(1)).min(1),
    evidence: z
      .object({
        domainInstructions: z.boolean(),
        publishInstructions: z.boolean(),
      })
      .strict(),
    validityMigration: ValidityMigrationSchema,
  })
  .strict();

export const MeasurementBundleCensusSchema = z
  .object({
    kind: z.literal('f267-measurement-bundle-census'),
    schemaVersion: z.literal(2),
    generatedAt: z.string().datetime(),
    sources: z
      .object({
        registryDir: z.literal('docs/harness-feedback/eval-domains'),
        instructionMap: z.literal(
          'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts#DOMAIN_INSTRUCTIONS',
        ),
        publishMap: z.literal(
          'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts#PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN',
        ),
        verdictDir: z.literal('docs/harness-feedback/verdicts'),
      })
      .strict(),
    verdictCorpusHash: z.string().regex(/^[a-f0-9]{64}$/),
    committedVerdictArtifactCount: z.number().int().nonnegative(),
    entries: z.array(MeasurementBundleCensusEntrySchema).min(1),
  })
  .strict();

export type MeasurementBundleCensus = z.infer<typeof MeasurementBundleCensusSchema>;

export function assertMeasurementVerdictActionAllowed(
  input: unknown,
  domainId: string,
  verdict: (typeof MEASUREMENT_BUNDLE_ACTIVE_ACTIONS)[number],
): void {
  if (verdict === 'keep_observe') return;
  const census = MeasurementBundleCensusSchema.parse(input);
  const entry = census.entries.find((candidate) => candidate.domainId === domainId);
  if (!entry) throw new Error(`measurement_validity_gate: no census entry for ${domainId}`);
  if (entry.validityMigration.actionGate !== 'certificate_actions_allowed') {
    throw new Error(
      `measurement_validity_gate: ${domainId} is ${entry.validityMigration.actionGate} (${entry.validityMigration.status}); ${entry.validityMigration.hardBlockReason ?? 'certified usable evidence is required'}`,
    );
  }
  assertMigrationActionGate(entry, entry.validityMigration);
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error('measurement bundle census domain ids must be unique');
  }
}

type CensusEntry = MeasurementBundleCensus['entries'][number];
type ValidityMigration = CensusEntry['validityMigration'];

function assertMigrationClassification(entry: CensusEntry, migration: ValidityMigration): void {
  if (entry.classification !== 'active_decision_bearing') {
    if (migration.riskRank !== null || migration.batch !== null) {
      throw new Error(`non-active bundle ${entry.domainId} cannot have a validity migration risk rank or batch`);
    }
    const expectedStatus = entry.classification === 'gated' ? 'gated' : 'nonoperational';
    if (migration.status !== expectedStatus) {
      throw new Error(`validity migration status mismatch for non-active bundle ${entry.domainId}`);
    }
    return;
  }

  if (migration.riskRank === null) throw new Error(`validity migration risk rank missing for ${entry.domainId}`);
  if (migration.status === 'gated' || migration.status === 'nonoperational') {
    throw new Error(`validity migration status mismatch for active bundle ${entry.domainId}`);
  }
  if (migration.status === 'unmigrated' && migration.batch !== null) {
    throw new Error(`unmigrated bundle ${entry.domainId} cannot claim a validity migration batch`);
  }
  if (migration.batch !== null && migration.batch !== migration.riskRank) {
    throw new Error(`validity migration batch must match risk rank for ${entry.domainId}`);
  }
}

function assertMigrationEvidenceRefs(entry: CensusEntry, migration: ValidityMigration): void {
  const refs = [migration.certificateRef, migration.resultRef, migration.replayRef];
  const hasAllRefs = refs.every((ref) => ref !== null);
  const hasAnyRef = refs.some((ref) => ref !== null);
  const isCertified = migration.status === 'certified_insufficient' || migration.status === 'certified_usable';

  if (isCertified && !hasAllRefs) {
    throw new Error(`certified validity migration for ${entry.domainId} requires complete evidence refs`);
  }
  if (!isCertified && hasAnyRef) {
    throw new Error(`uncertified validity migration for ${entry.domainId} cannot claim evidence refs`);
  }
}

function assertMigrationActionGate(entry: CensusEntry, migration: ValidityMigration): void {
  if (migration.actionGate !== 'certificate_actions_allowed') {
    if (migration.hardBlockReason === null) {
      throw new Error(`keep_observe_only action gate requires a hard block reason for ${entry.domainId}`);
    }
    return;
  }

  if (migration.batch === null) {
    throw new Error(`measurement action gate requires an assigned migration batch for ${entry.domainId}`);
  }
  const hasAllRefs = [migration.certificateRef, migration.resultRef, migration.replayRef].every((ref) => ref !== null);
  if (migration.status !== 'certified_usable' || !hasAllRefs) {
    throw new Error(`measurement action gate requires certified usable evidence for ${entry.domainId}`);
  }
  if (migration.hardBlockReason !== null) {
    throw new Error(`usable measurement action gate cannot retain a hard block for ${entry.domainId}`);
  }
}

function assertMigrationEntry(entry: CensusEntry): void {
  const migration = entry.validityMigration;
  assertMigrationClassification(entry, migration);
  assertMigrationEvidenceRefs(entry, migration);
  assertMigrationActionGate(entry, migration);

  if (migration.status === 'blocked_f275' && entry.domainId !== 'eval:task-outcome') {
    throw new Error(`blocked_f275 is reserved for eval:task-outcome, not ${entry.domainId}`);
  }
}

function assertMigrationCoverage(census: MeasurementBundleCensus): void {
  const active = census.entries.filter((entry) => entry.classification === 'active_decision_bearing');
  const ranks = active.map((entry) => entry.validityMigration.riskRank as number).sort((left, right) => left - right);
  const expectedRanks = Array.from({ length: active.length }, (_, index) => index + 1);
  if (JSON.stringify(ranks) !== JSON.stringify(expectedRanks)) {
    throw new Error('validity migration risk ranks must be unique and contiguous across active bundles');
  }
  const assignedBatches = active
    .map((entry) => entry.validityMigration.batch)
    .filter((batch): batch is number => batch !== null)
    .sort((left, right) => left - right);
  if (assignedBatches.length === 0) return;
  const firstBatch = active.filter((entry) => entry.validityMigration.batch === 1);
  if (firstBatch.length !== 1 || firstBatch[0]?.domainId !== 'eval:memory') {
    throw new Error('validity migration batch 1 must contain only eval:memory');
  }
  const expectedBatches = Array.from({ length: assignedBatches.at(-1) ?? 0 }, (_, index) => index + 1);
  if (JSON.stringify(assignedBatches) !== JSON.stringify(expectedBatches)) {
    throw new Error('validity migration batches must be unique and contiguous in risk order');
  }
}

export function loadMeasurementBundleRegistry(repoRoot: string): EvalDomainRegistryEntry[] {
  const registryDir = join(repoRoot, 'docs/harness-feedback/eval-domains');
  return readdirSync(registryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isEvalDomainRegistryYamlFile(entry.name))
    .map((entry) => parseEvalDomainRegistryFile(parseYaml(readFileSync(join(registryDir, entry.name), 'utf8'))))
    .sort((left, right) => left.domainId.localeCompare(right.domainId));
}

export function classifyMeasurementBundleDomain(
  domain: EvalDomainRegistryEntry,
): MeasurementBundleCensus['entries'][number]['classification'] {
  if (!domain.enabled) return 'gated';
  if (hasEvalDomainInstructions(domain.domainId) && hasEvalDomainPublishInstructions(domain.domainId)) {
    return 'active_decision_bearing';
  }
  return 'registered_nonoperational';
}

function assertEntryMatchesRegistry(
  entry: MeasurementBundleCensus['entries'][number],
  domain: EvalDomainRegistryEntry,
  verdictCount: number,
): void {
  const expectedDomainInstructions = hasEvalDomainInstructions(domain.domainId);
  const expectedPublishInstructions = hasEvalDomainPublishInstructions(domain.domainId);
  if (entry.classification !== classifyMeasurementBundleDomain(domain)) {
    throw new Error(`classification mismatch for ${domain.domainId}`);
  }
  if (entry.enabled !== domain.enabled) throw new Error(`enabled mismatch for ${domain.domainId}`);
  if (
    entry.decisionConsumer.featureId !== domain.handoffTargetResolver.featureId ||
    entry.decisionConsumer.ownerCatId !== domain.handoffTargetResolver.ownerCatId
  ) {
    throw new Error(`decision consumer mismatch for ${domain.domainId}`);
  }
  const expectedActions = entry.classification === 'active_decision_bearing' ? MEASUREMENT_BUNDLE_ACTIVE_ACTIONS : [];
  if (JSON.stringify(entry.decisionConsumer.allowedActions) !== JSON.stringify(expectedActions)) {
    throw new Error(`allowed actions mismatch for ${domain.domainId}`);
  }
  if (entry.sourceSelector.adapter !== domain.sourceAdapter || entry.sourceSelector.kind !== domain.sourceRefsKind) {
    throw new Error(`source selector mismatch for ${domain.domainId}`);
  }
  if (
    entry.evidence.domainInstructions !== expectedDomainInstructions ||
    entry.evidence.publishInstructions !== expectedPublishInstructions
  ) {
    throw new Error(`instruction evidence mismatch for ${domain.domainId}`);
  }
  if (entry.committedVerdictArtifactCount !== verdictCount) {
    throw new Error(`committed verdict artifact count mismatch for ${domain.domainId}`);
  }
}

export function validateMeasurementBundleCensus(input: unknown, repoRoot: string): MeasurementBundleCensus {
  const census = MeasurementBundleCensusSchema.parse(input);
  const ids = census.entries.map((entry) => entry.domainId);
  assertUnique(ids);

  const registry = loadMeasurementBundleRegistry(repoRoot);
  const registryIds = registry.map((domain) => domain.domainId);
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(registryIds)) {
    throw new Error('measurement bundle census registry coverage mismatch');
  }

  const verdictCorpus = scanMeasurementVerdictCorpus(repoRoot);
  for (const domain of registry) {
    const entry = census.entries.find((candidate) => candidate.domainId === domain.domainId);
    if (!entry) throw new Error(`measurement bundle census registry coverage missing ${domain.domainId}`);
    assertEntryMatchesRegistry(entry, domain, verdictCorpus.counts.get(domain.domainId) ?? 0);
  }
  census.entries.forEach(assertMigrationEntry);
  assertMigrationCoverage(census);

  if (census.committedVerdictArtifactCount !== verdictCorpus.total) {
    throw new Error('measurement bundle census committed verdict artifact total mismatch');
  }
  if (census.verdictCorpusHash !== verdictCorpus.hash) {
    throw new Error('measurement bundle census verdict corpus hash mismatch');
  }
  return census;
}

export function refreshMeasurementBundleCensus(
  input: unknown,
  repoRoot: string,
  generatedAt: string,
): MeasurementBundleCensus {
  const census = MeasurementBundleCensusSchema.parse(input);
  const verdictCorpus = scanMeasurementVerdictCorpus(repoRoot);
  const refreshed: MeasurementBundleCensus = {
    ...census,
    generatedAt,
    verdictCorpusHash: verdictCorpus.hash,
    committedVerdictArtifactCount: verdictCorpus.total,
    entries: census.entries.map((entry) => ({
      ...entry,
      committedVerdictArtifactCount: verdictCorpus.counts.get(entry.domainId) ?? 0,
    })),
  };
  return validateMeasurementBundleCensus(refreshed, repoRoot);
}
