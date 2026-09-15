import { z } from 'zod';
import { evolutionAssetReviewBlockerV1Schema } from './capability-evolution-asset-review.js';
import {
  evolutionExplorationConditionsSchema,
  evolutionExplorationMetricSchema,
  evolutionExplorationNodeRefSchema,
  evolutionExplorationReadFailureSchema,
  evolutionExplorationRecordSchema,
  evolutionExplorationRefSchema,
} from './capability-evolution-exploration-record.js';
import {
  bounded,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
  timestampSchema,
} from './capability-evolution-refs.js';

const exact = evolutionExplorationRefSchema;
const baseNode = {
  nodeRef: exact,
  title: bounded(240),
  summary: bounded(4_000),
  sourceRef: ownerTruthRefV1Schema,
  changes: z.array(z.object({ label: bounded(240), detail: bounded(2_000), sourceRef: exact }).strict()).max(32),
  parentEdges: z
    .array(z.object({ parentNodeRef: evolutionExplorationNodeRefSchema, sourceRef: ownerTruthRefV1Schema }).strict())
    .max(32),
};
export const evolutionExplorationNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...baseNode,
      kind: z.literal('owner_version'),
      nodeRef: exactAssetVersionRefV1Schema,
      versionRef: exactAssetVersionRefV1Schema,
    })
    .strict(),
  z.object({ ...baseNode, kind: z.literal('public_archive') }).strict(),
]);

export const evolutionExplorationExperimentSchema = z
  .object({
    experimentRef: exact,
    nodeRef: evolutionExplorationNodeRefSchema,
    sourceRef: exact,
    title: bounded(240),
    status: z.enum(['recorded', 'partial', 'running', 'failed', 'unknown']),
    recordCount: z.number().int().min(0).max(128),
    conditions: evolutionExplorationConditionsSchema,
    metrics: z.array(evolutionExplorationMetricSchema).max(24),
  })
  .strict();

export const evolutionExplorationDetailSchema = z.discriminatedUnion('status', [
  evolutionExplorationReadFailureSchema
    .extend({
      experimentRef: exact,
      nodeRef: evolutionExplorationNodeRefSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('resolved'),
      experimentRef: exact,
      nodeRef: evolutionExplorationNodeRefSchema,
      records: z.array(evolutionExplorationRecordSchema).max(128),
    })
    .strict(),
]);

export const evolutionExplorationSelectionSchema = z
  .object({
    selectedNodeRef: evolutionExplorationNodeRefSchema.optional(),
    selectedExperimentRef: exact.optional(),
    comparisonExperimentRef: exact.optional(),
  })
  .strict();
export const evolutionExplorationRequestV1Schema = evolutionExplorationSelectionSchema
  .extend({
    programRef: ownerTruthRefV1Schema,
    objectRef: ownerTruthRefV1Schema,
  })
  .strict();
export const evolutionExplorationMediaRequestV1Schema = z
  .object({
    programRef: ownerTruthRefV1Schema,
    objectRef: ownerTruthRefV1Schema,
    experimentRef: exact,
    recordRef: exact,
    mediaRef: exact,
  })
  .strict();

const envelope = { schemaVersion: z.literal(1), programRef: ownerTruthRefV1Schema, objectRef: ownerTruthRefV1Schema };
// Federation keeps the owner's complete bounded list plus the read-boundary diagnostics.
const blockers = z.array(evolutionAssetReviewBlockerV1Schema).max(64);
const reviewSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.enum(['unavailable', 'invalid']), blockers: blockers.min(1) }).strict(),
  z
    .object({
      ...envelope,
      status: z.literal('resolved'),
      sourceRef: ownerTruthRefV1Schema,
      readAt: timestampSchema,
      nodes: z.array(evolutionExplorationNodeSchema).max(512),
      experiments: z.array(evolutionExplorationExperimentSchema).max(512),
      details: z.array(evolutionExplorationDetailSchema).max(2),
      blockers,
    })
    .strict(),
]);

type Review = Extract<z.infer<typeof reviewSchema>, { status: 'resolved' }>;
function validateNodes(review: Review, ctx: z.RefinementCtx) {
  const nodes = new Map(review.nodes.map((node) => [refIdentity(node.nodeRef), node]));
  if (nodes.size !== review.nodes.length) ctx.addIssue({ code: 'custom', message: 'duplicate exploration nodes' });
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
      ctx.addIssue({ code: 'custom', message: 'lineage must be acyclic with published parents' });
      break;
    }
    if (node.kind === 'owner_version') {
      if (refIdentity(node.nodeRef) !== refIdentity(node.versionRef))
        ctx.addIssue({ code: 'custom', message: 'owner node must address its exact asset version' });
    }
  }
}

function validateExperiments(review: Review, ctx: z.RefinementCtx) {
  const nodes = new Set(review.nodes.map((node) => refIdentity(node.nodeRef)));
  const experiments = new Map(
    review.experiments.map((experiment) => [refIdentity(experiment.experimentRef), experiment]),
  );
  if (experiments.size !== review.experiments.length)
    ctx.addIssue({ code: 'custom', message: 'experiment refs must be unique' });
  for (const experiment of review.experiments) {
    if (!nodes.has(refIdentity(experiment.nodeRef)))
      ctx.addIssue({ code: 'custom', message: 'experiment must belong to a published node' });
    if (new Set(experiment.metrics.map((metric) => metric.key)).size !== experiment.metrics.length)
      ctx.addIssue({ code: 'custom', message: 'metric definitions must be unique' });
  }
  const detailKeys = new Set<string>();
  for (const detail of review.details) {
    const key = refIdentity(detail.experimentRef);
    const experiment = experiments.get(key);
    if (!experiment || refIdentity(experiment.nodeRef) !== refIdentity(detail.nodeRef) || detailKeys.has(key)) {
      ctx.addIssue({ code: 'custom', message: 'detail must bind one exact published experiment' });
      continue;
    }
    detailKeys.add(key);
    if (detail.status !== 'resolved') continue;
    if (detail.records.length !== experiment.recordCount)
      ctx.addIssue({ code: 'custom', message: 'detail must disclose its complete declared record set' });
    const recordKeys = new Set<string>();
    const caseIds = new Set<string>();
    const metrics = new Set(experiment.metrics.map((metric) => metric.key));
    for (const record of detail.records) {
      const recordKey = refIdentity(record.recordRef);
      if (
        recordKeys.has(recordKey) ||
        caseIds.has(record.caseId) ||
        refIdentity(record.experimentRef) !== key ||
        refIdentity(record.nodeRef) !== refIdentity(experiment.nodeRef) ||
        refIdentity(record.windowRef) !== refIdentity(experiment.conditions.window.sourceRef) ||
        refIdentity(record.measurementRef) !== refIdentity(experiment.conditions.measurement.sourceRef) ||
        Object.keys(record.values).some((metric) => !metrics.has(metric))
      )
        ctx.addIssue({ code: 'custom', message: 'record identity, window or measurement escaped its experiment' });
      recordKeys.add(recordKey);
      caseIds.add(record.caseId);
    }
  }
}

export const evolutionExplorationReviewV1Schema = reviewSchema.superRefine((review, ctx) => {
  if (review.status !== 'resolved') return;
  validateNodes(review, ctx);
  validateExperiments(review, ctx);
});

export type EvolutionExplorationNodeV1 = z.infer<typeof evolutionExplorationNodeSchema>;
export type EvolutionExplorationExperimentV1 = z.infer<typeof evolutionExplorationExperimentSchema>;
export type EvolutionExplorationDetailV1 = z.infer<typeof evolutionExplorationDetailSchema>;
export type EvolutionExplorationSelectionV1 = z.infer<typeof evolutionExplorationSelectionSchema>;
export type EvolutionExplorationRequestV1 = z.infer<typeof evolutionExplorationRequestV1Schema>;
export type EvolutionExplorationMediaRequestV1 = z.infer<typeof evolutionExplorationMediaRequestV1Schema>;
export type EvolutionExplorationReviewV1 = z.infer<typeof evolutionExplorationReviewV1Schema>;
export type EvolutionResolvedExplorationReviewV1 = Extract<EvolutionExplorationReviewV1, { status: 'resolved' }>;

/** A valid envelope still must answer the exact user's read, never a neighbouring selection. */
export function evolutionExplorationSelectionMatches(
  review: EvolutionResolvedExplorationReviewV1,
  selection: EvolutionExplorationSelectionV1,
): boolean {
  const { selectedNodeRef, selectedExperimentRef, comparisonExperimentRef } = selection;
  if (selectedNodeRef && !review.nodes.some((node) => refIdentity(node.nodeRef) === refIdentity(selectedNodeRef)))
    return false;
  const requested = [selectedExperimentRef, comparisonExperimentRef].filter((ref) => ref !== undefined);
  const keys = new Set(requested.map(refIdentity));
  if (
    review.details.length !== keys.size ||
    review.details.some((detail) => !keys.has(refIdentity(detail.experimentRef)))
  )
    return false;
  if (selectedExperimentRef) {
    const experiment = review.experiments.find(
      (entry) => refIdentity(entry.experimentRef) === refIdentity(selectedExperimentRef),
    );
    if (!experiment || (selectedNodeRef && refIdentity(experiment.nodeRef) !== refIdentity(selectedNodeRef)))
      return false;
  }
  return true;
}
