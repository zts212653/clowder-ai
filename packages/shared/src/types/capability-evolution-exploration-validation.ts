import { type RefinementCtx, z } from 'zod';
import type { EvolutionResolvedExplorationReviewV1 } from './capability-evolution-exploration.js';
import { refIdentity } from './capability-evolution-refs.js';

type Review = EvolutionResolvedExplorationReviewV1;
type Experiment = Review['experiments'][number];
type ResolvedDetail = Extract<Review['details'][number], { status: 'resolved' }>;
type Record = ResolvedDetail['records'][number];

const issue = (ctx: RefinementCtx, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });

export function validateExplorationNodes(review: Review, ctx: RefinementCtx): void {
  const nodes = new Map(review.nodes.map((node) => [refIdentity(node.nodeRef), node]));
  if (nodes.size !== review.nodes.length) issue(ctx, 'duplicate exploration nodes');
  const colors = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): boolean => {
    if (colors.get(key) === 'visiting') return false;
    if (colors.get(key) === 'done') return true;
    const node = nodes.get(key);
    if (!node) return false;
    colors.set(key, 'visiting');
    for (const edge of node.parentEdges) if (!visit(refIdentity(edge.parentNodeRef))) return false;
    colors.set(key, 'done');
    return true;
  };
  for (const node of review.nodes) {
    if (!visit(refIdentity(node.nodeRef))) {
      issue(ctx, 'lineage must be acyclic with published parents');
      break;
    }
    if (node.kind === 'owner_version' && refIdentity(node.nodeRef) !== refIdentity(node.versionRef))
      issue(ctx, 'owner node must address its exact asset version');
  }
}

function validateExperimentCatalog(
  review: Review,
  nodes: ReadonlySet<string>,
  experiments: ReadonlyMap<string, Experiment>,
  ctx: RefinementCtx,
): void {
  if (experiments.size !== review.experiments.length) issue(ctx, 'experiment refs must be unique');
  for (const experiment of review.experiments) {
    if (!nodes.has(refIdentity(experiment.nodeRef))) issue(ctx, 'experiment must belong to a published node');
    if (new Set(experiment.metrics.map((metric) => metric.key)).size !== experiment.metrics.length)
      issue(ctx, 'metric definitions must be unique');
  }
}

function validatePreviews(review: Review, experiments: ReadonlyMap<string, Experiment>, ctx: RefinementCtx): void {
  for (const node of review.nodes) {
    if (!node.preview) continue;
    const experiment = experiments.get(refIdentity(node.preview.experimentRef));
    if (
      !experiment ||
      refIdentity(experiment.nodeRef) !== refIdentity(node.nodeRef) ||
      node.preview.media.kind !== 'image'
    )
      issue(ctx, 'cover must bind an image in this published node experiment');
  }
}

function recordEscapesExperiment(
  record: Record,
  experiment: Experiment,
  experimentKey: string,
  recordKeys: ReadonlySet<string>,
  caseIds: ReadonlySet<string>,
  metrics: ReadonlySet<string>,
): boolean {
  return (
    recordKeys.has(refIdentity(record.recordRef)) ||
    caseIds.has(record.caseId) ||
    refIdentity(record.experimentRef) !== experimentKey ||
    refIdentity(record.nodeRef) !== refIdentity(experiment.nodeRef) ||
    refIdentity(record.windowRef) !== refIdentity(experiment.conditions.window.sourceRef) ||
    refIdentity(record.measurementRef) !== refIdentity(experiment.conditions.measurement.sourceRef) ||
    Object.keys(record.values).some((metric) => !metrics.has(metric))
  );
}

function validateRecords(
  detail: ResolvedDetail,
  experiment: Experiment,
  experimentKey: string,
  ctx: RefinementCtx,
): void {
  if (detail.records.length !== experiment.recordCount)
    issue(ctx, 'detail must disclose its complete declared record set');
  const recordKeys = new Set<string>();
  const caseIds = new Set<string>();
  const metrics = new Set(experiment.metrics.map((metric) => metric.key));
  for (const record of detail.records) {
    const recordKey = refIdentity(record.recordRef);
    if (recordEscapesExperiment(record, experiment, experimentKey, recordKeys, caseIds, metrics))
      issue(ctx, 'record identity, window or measurement escaped its experiment');
    recordKeys.add(recordKey);
    caseIds.add(record.caseId);
  }
}

function validateDetails(review: Review, experiments: ReadonlyMap<string, Experiment>, ctx: RefinementCtx): void {
  const detailKeys = new Set<string>();
  for (const detail of review.details) {
    const key = refIdentity(detail.experimentRef);
    const experiment = experiments.get(key);
    if (!experiment || refIdentity(experiment.nodeRef) !== refIdentity(detail.nodeRef) || detailKeys.has(key)) {
      issue(ctx, 'detail must bind one exact published experiment');
      continue;
    }
    detailKeys.add(key);
    if (detail.status === 'resolved') validateRecords(detail, experiment, key, ctx);
  }
}

export function validateExplorationExperiments(review: Review, ctx: RefinementCtx): void {
  const nodes = new Set(review.nodes.map((node) => refIdentity(node.nodeRef)));
  const experiments = new Map(
    review.experiments.map((experiment) => [refIdentity(experiment.experimentRef), experiment]),
  );
  validateExperimentCatalog(review, nodes, experiments, ctx);
  validatePreviews(review, experiments, ctx);
  validateDetails(review, experiments, ctx);
}
