import {
  type EvolutionExplorationRequestV1,
  type EvolutionExplorationReviewV1,
  type EvolutionResolvedAssetReviewV1,
  type EvolutionResolvedExplorationReviewV1,
  evolutionAssetReviewV1Schema,
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  refIdentity,
} from '@cat-cafe/shared';
import { createModuleLogger } from '../../logger.js';
import type { ProgramAdapter } from '../adapters/program-adapter-registry.js';
import { retainPublishedExplorationNodes } from './exploration-lineage.js';

const log = createModuleLogger('capability-evolution:exploration');

type FailedExploration = Exclude<EvolutionExplorationReviewV1, { status: 'resolved' }>;
export function failedExploration(
  input: EvolutionExplorationRequestV1,
  status: FailedExploration['status'],
  code: string,
  blockers: FailedExploration['blockers'] = [],
): FailedExploration {
  return {
    schemaVersion: 1,
    programRef: input.programRef,
    objectRef: input.objectRef,
    status,
    blockers: [{ code, ownerRef: input.objectRef }, ...blockers],
  };
}
export const unavailableExploration = (input: EvolutionExplorationRequestV1, code: string) =>
  failedExploration(input, 'unavailable', code);

/** Isolate broken lineage components; all retained evidence still passes the complete shared contract. */
export function resolveExplorationProjection(
  input: EvolutionExplorationRequestV1,
  projection: EvolutionResolvedExplorationReviewV1,
): EvolutionExplorationReviewV1 {
  const parsed = evolutionExplorationReviewV1Schema.safeParse(projection);
  if (parsed.success) return parsed.data;
  const nodes = retainPublishedExplorationNodes(projection.nodes);
  const withheldNodes = projection.nodes.length - nodes.length;
  if (withheldNodes) {
    const nodeKeys = new Set(nodes.map((node) => refIdentity(node.nodeRef)));
    const experiments = projection.experiments.filter((run) => nodeKeys.has(refIdentity(run.nodeRef)));
    const experimentKeys = new Set(experiments.map((run) => refIdentity(run.experimentRef)));
    const repaired = evolutionExplorationReviewV1Schema.safeParse({
      ...projection,
      nodes,
      experiments,
      // Withhold dependent experiments as units; never trim cases or silently change a record denominator.
      details: projection.details.filter((detail) => experimentKeys.has(refIdentity(detail.experimentRef))),
      blockers: [{ code: 'owner_exploration_lineage_withheld', ownerRef: input.objectRef }, ...projection.blockers],
    });
    if (repaired.success && repaired.data.status === 'resolved') {
      log.warn(
        { ...input, withheldNodes, retainedNodes: nodes.length },
        'Exploration withheld unresolved lineage components',
      );
      return nodes.length && evolutionExplorationSelectionMatches(repaired.data, input)
        ? repaired.data
        : failedExploration(input, 'invalid', 'owner_exploration_lineage_withheld', projection.blockers);
    }
  }
  log.error(
    { ...input, withheldNodes, issueCodes: [...new Set(parsed.error.issues.map((issue) => issue.code))] },
    'Exploration projection failed its contract; source correction is required',
  );
  return failedExploration(input, 'invalid', 'owner_exploration_projection_invalid', projection.blockers);
}

/** Every exploration consumer of versionReview shares identity checks and the same failure vocabulary. */
export async function readExplorationVersions(
  input: EvolutionExplorationRequestV1,
  readVersions?: ProgramAdapter['versionReview'],
): Promise<{ status: 'resolved'; catalog: EvolutionResolvedAssetReviewV1 } | FailedExploration> {
  if (!readVersions) return unavailableExploration(input, 'owner_version_review_unavailable');
  let raw: unknown;
  try {
    raw = await readVersions({ programRef: input.programRef, objectRef: input.objectRef });
  } catch {
    return unavailableExploration(input, 'owner_version_review_failed');
  }
  const parsed = evolutionAssetReviewV1Schema.safeParse(raw);
  if (!parsed.success) return failedExploration(input, 'invalid', 'owner_version_review_invalid');
  const catalog = parsed.data;
  if (
    refIdentity(catalog.programRef) !== refIdentity(input.programRef) ||
    refIdentity(catalog.objectRef) !== refIdentity(input.objectRef)
  )
    return failedExploration(input, 'invalid', 'owner_version_review_identity_mismatch');
  if (catalog.status === 'unavailable')
    return failedExploration(input, 'unavailable', 'owner_version_review_unavailable', catalog.blockers);
  return { status: 'resolved', catalog };
}

export function projectOwnerExplorationNodes(
  catalog: EvolutionResolvedAssetReviewV1,
): EvolutionResolvedExplorationReviewV1['nodes'] {
  return catalog.versions.map((version) => ({
    kind: 'owner_version',
    nodeRef: version.versionRef,
    versionRef: version.versionRef,
    title: version.title ?? version.versionRef.assetId,
    summary: '资产来源已记录此版本；尚未发布可读取的实验。',
    sourceRef: catalog.sourceRef,
    changes: [],
    parentEdges: version.parentEdges.map((edge) => ({
      parentNodeRef: edge.parentVersionRef,
      sourceRef: edge.edgeRef,
    })),
  }));
}

export function projectOwnerExplorationReview(
  input: EvolutionExplorationRequestV1,
  catalog: EvolutionResolvedAssetReviewV1,
): EvolutionResolvedExplorationReviewV1 {
  return {
    schemaVersion: 1,
    status: 'resolved',
    programRef: input.programRef,
    objectRef: input.objectRef,
    sourceRef: catalog.sourceRef,
    readAt: catalog.readAt,
    nodes: projectOwnerExplorationNodes(catalog),
    experiments: [],
    details: [],
    blockers: catalog.blockers,
  };
}

/** Existing owners can expose their real, untested versions without inventing behaviour evidence. */
async function readVersionCatalog(adapter: ProgramAdapter, input: EvolutionExplorationRequestV1) {
  const versions = await readExplorationVersions(input, adapter.versionReview);
  return versions.status === 'resolved'
    ? resolveExplorationProjection(input, projectOwnerExplorationReview(input, versions.catalog))
    : versions;
}

export async function readExplorationOwner(adapter: ProgramAdapter, input: EvolutionExplorationRequestV1) {
  let raw: unknown;
  try {
    raw = adapter.explorationReview ? await adapter.explorationReview(input) : await readVersionCatalog(adapter, input);
  } catch {
    return { code: 503, body: unavailableExploration(input, 'owner_exploration_read_failed') };
  }
  const parsed = evolutionExplorationReviewV1Schema.safeParse(raw);
  if (!parsed.success) return { code: 422, body: failedExploration(input, 'invalid', 'owner_exploration_invalid') };
  const review = parsed.data;
  if (
    refIdentity(review.programRef) !== refIdentity(input.programRef) ||
    refIdentity(review.objectRef) !== refIdentity(input.objectRef) ||
    (review.status === 'resolved' && !evolutionExplorationSelectionMatches(review, input))
  )
    return { code: 422, body: failedExploration(input, 'invalid', 'owner_exploration_identity_mismatch') };
  return { code: review.status === 'resolved' ? 200 : review.status === 'invalid' ? 422 : 503, body: review };
}
