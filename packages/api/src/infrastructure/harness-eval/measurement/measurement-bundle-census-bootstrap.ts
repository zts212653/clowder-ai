import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import { hasEvalDomainInstructions, hasEvalDomainPublishInstructions } from '../eval-cat-invocation.js';
import {
  classifyMeasurementBundleDomain,
  loadMeasurementBundleRegistry,
  MEASUREMENT_BUNDLE_ACTIVE_ACTIONS,
  type MeasurementBundleCensus,
  MeasurementBundleCensusSchema,
  validateMeasurementBundleCensus,
} from './measurement-bundle-census.js';
import { scanMeasurementVerdictCorpus } from './measurement-bundle-census-corpus.js';

const SOURCES: MeasurementBundleCensus['sources'] = {
  registryDir: 'docs/harness-feedback/eval-domains',
  instructionMap: 'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts#DOMAIN_INSTRUCTIONS',
  publishMap:
    'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts#PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN',
  verdictDir: 'docs/harness-feedback/verdicts',
};

type CensusEntry = MeasurementBundleCensus['entries'][number];
const PUBLIC_FIRST_MIGRATION_DOMAIN_ID = 'eval:memory';

function buildPublicRiskRanks(registry: EvalDomainRegistryEntry[]): Map<string, number> {
  const activeDomainIds = registry
    .filter((domain) => classifyMeasurementBundleDomain(domain) === 'active_decision_bearing')
    .map((domain) => domain.domainId);
  if (!activeDomainIds.includes(PUBLIC_FIRST_MIGRATION_DOMAIN_ID)) {
    throw new Error(`public measurement census requires active ${PUBLIC_FIRST_MIGRATION_DOMAIN_ID}`);
  }
  const riskOrder = [
    PUBLIC_FIRST_MIGRATION_DOMAIN_ID,
    ...activeDomainIds.filter((domainId) => domainId !== PUBLIC_FIRST_MIGRATION_DOMAIN_ID),
  ];
  return new Map(riskOrder.map((domainId, index) => [domainId, index + 1]));
}

function defaultMigration(
  classification: CensusEntry['classification'],
  domainId: string,
  riskRank: number | null,
): CensusEntry['validityMigration'] {
  if (classification === 'active_decision_bearing') {
    return {
      riskRank,
      batch: null,
      status: 'unmigrated',
      certificateRef: null,
      resultRef: null,
      replayRef: null,
      actionGate: 'keep_observe_only',
      hardBlockReason: `This public instance has not certified measurement validity for ${domainId}.`,
    };
  }
  const gated = classification === 'gated';
  return {
    riskRank: null,
    batch: null,
    status: gated ? 'gated' : 'nonoperational',
    certificateRef: null,
    resultRef: null,
    replayRef: null,
    actionGate: 'keep_observe_only',
    hardBlockReason: gated
      ? `Domain ${domainId} is disabled in this public instance.`
      : `Domain ${domainId} has no operational publish path in this public instance.`,
  };
}

function buildEntry(domain: EvalDomainRegistryEntry, verdictCount: number, riskRank: number | null): CensusEntry {
  const classification = classifyMeasurementBundleDomain(domain);
  return {
    domainId: domain.domainId,
    classification,
    enabled: domain.enabled,
    decisionConsumer: {
      featureId: domain.handoffTargetResolver.featureId,
      ownerCatId: domain.handoffTargetResolver.ownerCatId,
      allowedActions: classification === 'active_decision_bearing' ? [...MEASUREMENT_BUNDLE_ACTIVE_ACTIONS] : [],
    },
    sourceSelector: { adapter: domain.sourceAdapter, kind: domain.sourceRefsKind },
    committedVerdictArtifactCount: verdictCount,
    functionalEquivalents: [`${domain.sourceAdapter}/${domain.sourceRefsKind} public registry contract`],
    evidence: {
      domainInstructions: hasEvalDomainInstructions(domain.domainId),
      publishInstructions: hasEvalDomainPublishInstructions(domain.domainId),
    },
    validityMigration: defaultMigration(classification, domain.domainId, riskRank),
  };
}

export function createPublicMeasurementBundleCensus(repoRoot: string, generatedAt: string): MeasurementBundleCensus {
  const registry = loadMeasurementBundleRegistry(repoRoot);
  const corpus = scanMeasurementVerdictCorpus(repoRoot);
  const riskRanks = buildPublicRiskRanks(registry);
  const census: MeasurementBundleCensus = {
    kind: 'f267-measurement-bundle-census',
    schemaVersion: 2,
    generatedAt,
    sources: SOURCES,
    verdictCorpusHash: corpus.hash,
    committedVerdictArtifactCount: corpus.total,
    entries: registry.map((domain) => {
      const classification = classifyMeasurementBundleDomain(domain);
      const riskRank = classification === 'active_decision_bearing' ? (riskRanks.get(domain.domainId) ?? null) : null;
      return buildEntry(domain, corpus.counts.get(domain.domainId) ?? 0, riskRank);
    }),
  };
  return validateMeasurementBundleCensus(census, repoRoot);
}

export function reconcilePublicMeasurementBundleCensus(
  input: unknown,
  repoRoot: string,
  generatedAt: string,
): MeasurementBundleCensus {
  const current = MeasurementBundleCensusSchema.parse(input);
  const registryIds = new Set(loadMeasurementBundleRegistry(repoRoot).map((domain) => domain.domainId));
  const removed = current.entries.map((entry) => entry.domainId).filter((domainId) => !registryIds.has(domainId));
  if (removed.length > 0) {
    throw new Error(`measurement bundle census domain removal requires explicit migration: ${removed.join(', ')}`);
  }

  const defaults = createPublicMeasurementBundleCensus(repoRoot, generatedAt);
  const currentByDomain = new Map(current.entries.map((entry) => [entry.domainId, entry]));
  let nextRiskRank = Math.max(
    0,
    ...current.entries.map((entry) => entry.validityMigration.riskRank).filter((rank): rank is number => rank !== null),
  );
  const reconciled: MeasurementBundleCensus = {
    ...defaults,
    entries: defaults.entries.map((entry) => {
      const existing = currentByDomain.get(entry.domainId);
      if (existing) {
        return {
          ...entry,
          functionalEquivalents: existing.functionalEquivalents,
          validityMigration: existing.validityMigration,
        };
      }
      if (entry.classification !== 'active_decision_bearing') return entry;
      nextRiskRank += 1;
      return { ...entry, validityMigration: { ...entry.validityMigration, riskRank: nextRiskRank } };
    }),
  };
  return validateMeasurementBundleCensus(reconciled, repoRoot);
}
