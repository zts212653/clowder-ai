import {
  type EvolutionExplorationExperimentV1,
  type EvolutionResolvedExplorationReviewV1,
  refIdentity,
} from '@cat-cafe/shared';
import type { ExplorationComparison } from './exploration-comparison';

/** Preserve owner list order; recorded evidence is not a positive outcome or a proof of validity. */
export function suggestedExperiment(
  catalog: EvolutionResolvedExplorationReviewV1,
  experiments: EvolutionExplorationExperimentV1[],
) {
  const recorded = experiments.filter((run) => run.status === 'recorded' && run.recordCount > 0);
  return recorded.findLast((run) => suggestedComparison(catalog, run)) ?? recorded.at(-1) ?? experiments.at(-1);
}

/** A reading suggestion only. The comparison contract still checks actual loaded records. */
export function suggestedComparison(
  catalog: EvolutionResolvedExplorationReviewV1,
  experiment: EvolutionExplorationExperimentV1,
) {
  if (experiment.status !== 'recorded' || !experiment.recordCount) return;
  const parents =
    catalog.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(experiment.nodeRef))?.parentEdges ?? [];
  const candidates = catalog.experiments.filter((candidate) => {
    if (
      candidate.status !== 'recorded' ||
      !candidate.recordCount ||
      !parents.some((edge) => refIdentity(edge.parentNodeRef) === refIdentity(candidate.nodeRef))
    )
      return false;
    const a = candidate.conditions,
      b = experiment.conditions;
    return (
      (['environment', 'sampleSet', 'measurement', 'groundTruth', 'window'] as const).every(
        (key) => refIdentity(a[key].sourceRef) === refIdentity(b[key].sourceRef),
      ) &&
      a.groundTruth.status === b.groundTruth.status &&
      a.exposure === b.exposure &&
      a.comparison.design === b.comparison.design &&
      a.comparison.design !== 'undeclared' &&
      a.comparison.planRef &&
      b.comparison.planRef &&
      refIdentity(a.comparison.planRef) === refIdentity(b.comparison.planRef)
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function summarizePairChanges(pairs: ExplorationComparison['pairs']) {
  const result: Record<'improved' | 'regressed' | 'unchanged' | 'unknown', ExplorationComparison['pairs']> = {
    improved: [],
    regressed: [],
    unchanged: [],
    unknown: [],
  };
  for (const pair of pairs) {
    const a = pair.left.result.status,
      b = pair.right.result.status;
    if (!['satisfied', 'violated'].includes(a) || !['satisfied', 'violated'].includes(b)) result.unknown.push(pair);
    else if (a === b) result.unchanged.push(pair);
    else if (b === 'satisfied') result.improved.push(pair);
    else result.regressed.push(pair);
  }
  return result;
}
