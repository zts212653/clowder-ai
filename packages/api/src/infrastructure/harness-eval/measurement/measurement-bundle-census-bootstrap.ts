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
  // eval:memory leads the public migration order while it is active. A dormant
  // memory gets no coordinate here; the batch-1 rule then keeps the instance
  // locked until memory is revived, instead of reassigning batch 1.
  const riskOrder = activeDomainIds.includes(PUBLIC_FIRST_MIGRATION_DOMAIN_ID)
    ? [
        PUBLIC_FIRST_MIGRATION_DOMAIN_ID,
        ...activeDomainIds.filter((domainId) => domainId !== PUBLIC_FIRST_MIGRATION_DOMAIN_ID),
      ]
    : activeDomainIds;
  return new Map(riskOrder.map((domainId, index) => [domainId, index + 1]));
}

const DORMANT_HARD_BLOCK_PREFIX = 'is dormant:';

/**
 * Activation never reopens actions and never reads validity off the coordinate
 * axis: an existing status and its evidence refs survive; a missing coordinate
 * takes the next historical rank; only an uncertified gated/nonoperational
 * record initialises to unmigrated. Lifecycle text left by dormancy is replaced.
 */
function reviveMigration(
  migration: CensusEntry['validityMigration'],
  domainId: string,
  nextRank: () => number,
): CensusEntry['validityMigration'] {
  const initialising = migration.status === 'gated' || migration.status === 'nonoperational';
  const staleLifecycle = migration.hardBlockReason?.includes(DORMANT_HARD_BLOCK_PREFIX) ?? false;
  if (migration.riskRank !== null && !initialising && !staleLifecycle) return migration;
  return {
    ...migration,
    riskRank: migration.riskRank ?? nextRank(),
    ...(initialising ? { status: 'unmigrated' as const } : {}),
    actionGate: 'keep_observe_only',
    hardBlockReason:
      initialising || staleLifecycle || migration.hardBlockReason === null
        ? `Domain ${domainId} is active again; awaiting a fresh F267 judgment before any action.`
        : migration.hardBlockReason,
  };
}

function dormantHardBlockReason(domain: EvalDomainRegistryEntry): string {
  return `Domain ${domain.domainId} ${DORMANT_HARD_BLOCK_PREFIX} ${domain.dormancy?.reason ?? 'scheduling stopped by its owner'}`;
}

function defaultMigration(
  classification: CensusEntry['classification'],
  domain: EvalDomainRegistryEntry,
  riskRank: number | null,
): CensusEntry['validityMigration'] {
  const domainId = domain.domainId;
  if (classification === 'dormant') {
    const operational = hasEvalDomainInstructions(domainId) && hasEvalDomainPublishInstructions(domainId);
    return {
      riskRank: null,
      batch: null,
      status: operational ? 'unmigrated' : 'nonoperational',
      certificateRef: null,
      resultRef: null,
      replayRef: null,
      actionGate: 'keep_observe_only',
      hardBlockReason: dormantHardBlockReason(domain),
    };
  }
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
    validityMigration: defaultMigration(classification, domain, riskRank),
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
  const registry = loadMeasurementBundleRegistry(repoRoot);
  const registryIds = new Set(registry.map((domain) => domain.domainId));
  const removed = current.entries.map((entry) => entry.domainId).filter((domainId) => !registryIds.has(domainId));
  if (removed.length > 0) {
    throw new Error(`measurement bundle census domain removal requires explicit migration: ${removed.join(', ')}`);
  }

  const corpus = scanMeasurementVerdictCorpus(repoRoot);
  const currentByDomain = new Map(current.entries.map((entry) => [entry.domainId, entry]));
  let nextRiskRank = Math.max(
    0,
    ...current.entries.map((entry) => entry.validityMigration.riskRank).filter((rank): rank is number => rank !== null),
  );
  const reconciled: MeasurementBundleCensus = {
    ...current,
    generatedAt,
    verdictCorpusHash: corpus.hash,
    committedVerdictArtifactCount: corpus.total,
    entries: registry.map((domain) => {
      const entry = buildEntry(domain, corpus.counts.get(domain.domainId) ?? 0, null);
      const existing = currentByDomain.get(entry.domainId);
      if (existing) {
        let validityMigration = existing.validityMigration;
        if (entry.classification === 'dormant' && validityMigration.actionGate !== 'keep_observe_only') {
          // Going dormant closes the current authorization but keeps the evidence chain.
          validityMigration = {
            ...validityMigration,
            actionGate: 'keep_observe_only',
            hardBlockReason: dormantHardBlockReason(domain),
          };
        }
        if (entry.classification === 'active_decision_bearing') {
          validityMigration = reviveMigration(validityMigration, domain.domainId, () => {
            nextRiskRank += 1;
            return nextRiskRank;
          });
        }
        return {
          ...entry,
          functionalEquivalents: existing.functionalEquivalents,
          validityMigration,
        };
      }
      if (entry.classification !== 'active_decision_bearing') return entry;
      nextRiskRank += 1;
      return { ...entry, validityMigration: { ...entry.validityMigration, riskRank: nextRiskRank } };
    }),
  };
  return validateMeasurementBundleCensus(reconciled, repoRoot);
}
