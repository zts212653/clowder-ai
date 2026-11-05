import { z } from 'zod';
import { evolutionOwnerHrefSchema } from './capability-evolution-asset-review.js';
import {
  evolutionExplorationConditionsSchema,
  evolutionExplorationMediaSchema,
  evolutionExplorationMetricSchema,
  evolutionExplorationNodeRefSchema,
  evolutionExplorationReadAssetRefSchema,
  evolutionExplorationReadFailureSchema,
  evolutionExplorationReadNodeRefSchema,
  evolutionExplorationReadOwnerRefSchema,
  evolutionExplorationReadRefSchema,
  evolutionExplorationRecordSchema,
  evolutionExplorationRefSchema,
  evolutionExplorationSourceSchema,
} from './capability-evolution-exploration-record.js';
import {
  validateExplorationExperiments,
  validateExplorationNodes,
} from './capability-evolution-exploration-validation.js';
import { bounded, ownerTruthRefV1Schema, refIdentity, timestampSchema } from './capability-evolution-refs.js';

export const HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH = 1_000;
export const HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_COUNT = 512;

const exact = evolutionExplorationRefSchema;
const readExact = evolutionExplorationReadRefSchema;
const readNodeRef = evolutionExplorationReadNodeRefSchema;
const readOwnerRef = evolutionExplorationReadOwnerRefSchema;
const readSelectionSchema = z
  .object({
    selectedSourceRef: readExact.optional(),
    selectedNodeRef: readNodeRef.optional(),
    selectedExperimentRef: readExact.optional(),
    comparisonExperimentRef: readExact.optional(),
  })
  .strip();
const readBlockerSchema = z.object({ code: bounded(120), ownerRef: readOwnerRef }).strip();
const baseNode = {
  nodeRef: readExact,
  title: bounded(240),
  summary: bounded(4_000),
  /** Stable authored article body; old adapters continue to use summary + changes. */
  bodyMarkdown: bounded(20_000).optional(),
  sourceRef: readOwnerRef,
  sources: z.array(evolutionExplorationSourceSchema).max(32).optional(),
  changes: z
    .array(
      z
        .object({
          label: bounded(240),
          detail: bounded(2_000),
          sourceRef: readExact,
          ownerHref: evolutionOwnerHrefSchema.optional(),
        })
        .strip(),
    )
    .max(32),
  parentEdges: z
    .array(
      z
        .object({
          parentNodeRef: readNodeRef,
          sourceRef: readOwnerRef,
          description: bounded(2000).optional(),
        })
        .strip(),
    )
    .max(32),
  /** A publisher-bound cover frame; fetching bytes still uses exact Program/experiment/record guards. */
  preview: z
    .object({ experimentRef: readExact, recordRef: readExact, media: evolutionExplorationMediaSchema })
    .strip()
    .optional(),
};
export const evolutionExplorationNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...baseNode,
      kind: z.literal('owner_version'),
      nodeRef: evolutionExplorationReadAssetRefSchema,
      versionRef: evolutionExplorationReadAssetRefSchema,
    })
    .strip(),
  z
    .object({
      ...baseNode,
      kind: z.literal('public_archive'),
      /** Source-declared historical reading; absence keeps the experiment presentation. */
      history: z
        .object({ period: bounded(80), updatedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .strip()
        .optional(),
    })
    .strip(),
]);

export const evolutionExplorationExperimentSchema = z
  .object({
    experimentRef: readExact,
    nodeRef: readNodeRef,
    sourceRef: readExact,
    title: bounded(240),
    status: z.enum(['recorded', 'partial', 'running', 'failed', 'unknown']),
    recordCount: z.number().int().min(0).max(128),
    conditions: evolutionExplorationConditionsSchema,
    metrics: z.array(evolutionExplorationMetricSchema).max(24),
  })
  .strip();

export const evolutionExplorationDetailSchema = z.discriminatedUnion('status', [
  evolutionExplorationReadFailureSchema
    .extend({
      experimentRef: readExact,
      nodeRef: readNodeRef,
    })
    .strip(),
  z
    .object({
      status: z.literal('resolved'),
      experimentRef: readExact,
      nodeRef: readNodeRef,
      records: z.array(evolutionExplorationRecordSchema).max(128),
    })
    .strip(),
]);

export const evolutionExplorationSelectionSchema = z
  .object({
    selectedSourceRef: exact.optional(),
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

/** Optional archive-owner receipts. F311 neither stores content nor decides when an owner publishes it. */
export const evolutionArchiveVersionSchema = z
  .object({
    ref: readExact,
    sourceRevision: bounded(240),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bundled: z.boolean(),
    occurredAt: timestampSchema.optional(),
    actorRef: bounded(240).optional(),
    reason: bounded(1_000).optional(),
  })
  .strip();
export const evolutionArchivePublicationSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    current: evolutionArchiveVersionSchema,
    selected: evolutionArchiveVersionSchema,
    attempts: z
      .array(
        z
          .object({
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            action: bounded(80),
            status: z.enum(['published', 'failed']),
            actorRef: bounded(240),
            originRef: bounded(2_000),
            reason: bounded(1_000),
            occurredAt: timestampSchema,
            failureCode: bounded(240).optional(),
            ignoredFieldPaths: z
              .array(bounded(HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_LENGTH))
              .max(HARNESS_HISTORY_IGNORED_FIELD_PATH_MAX_COUNT)
              .optional(),
          })
          .strip(),
      )
      .max(50),
    hasMore: z.boolean(),
    selectionUpdate: z
      .object({
        kind: z.enum(['unchanged', 'modified', 'moved', 'removed', 'legacy']),
        nextSelection: readSelectionSchema.optional(),
      })
      .strip()
      .optional(),
  })
  .strip();
export type EvolutionArchivePublicationV1 = z.infer<typeof evolutionArchivePublicationSchema>;
export const evolutionExplorationMediaRequestV1Schema = z
  .object({
    programRef: ownerTruthRefV1Schema,
    objectRef: ownerTruthRefV1Schema,
    experimentRef: exact,
    recordRef: exact,
    mediaRef: exact,
  })
  .strict();

const envelope = { schemaVersion: z.literal(1), programRef: readOwnerRef, objectRef: readOwnerRef };
// Federation keeps the owner's complete bounded list plus the read-boundary diagnostics.
const blockers = z.array(readBlockerSchema).max(64);
const reviewSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...envelope,
      status: z.enum(['unavailable', 'invalid']),
      blockers: blockers.min(1),
      recoverySelection: readSelectionSchema.optional(),
    })
    .strip(),
  z
    .object({
      ...envelope,
      status: z.literal('resolved'),
      sourceRef: readOwnerRef,
      readAt: timestampSchema,
      /** Optional owner-authored orientation for a published exploration or historical story. */
      overview: bounded(1_000).optional(),
      /** Stable Markdown orientation authored by the source owner. */
      overviewMarkdown: bounded(20_000).optional(),
      publication: evolutionArchivePublicationSchema.optional(),
      nodes: z.array(evolutionExplorationNodeSchema).max(512),
      experiments: z.array(evolutionExplorationExperimentSchema).max(512),
      details: z.array(evolutionExplorationDetailSchema).max(2),
      blockers,
    })
    .strip(),
]);

export const evolutionExplorationReviewV1Schema = reviewSchema.superRefine((review, ctx) => {
  if (review.status !== 'resolved') return;
  if (
    review.publication &&
    (refIdentity(review.publication.selected.ref) !== refIdentity(review.sourceRef) ||
      (review.publication.selectionUpdate?.nextSelection &&
        (!review.publication.selectionUpdate.nextSelection.selectedSourceRef ||
          refIdentity(review.publication.selectionUpdate.nextSelection.selectedSourceRef) !==
            refIdentity(review.publication.current.ref))))
  )
    ctx.addIssue({ code: 'custom', message: 'archive publication must bind its exact selected and target sources' });
  validateExplorationNodes(review, ctx);
  validateExplorationExperiments(review, ctx);
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
  const { selectedSourceRef, selectedNodeRef, selectedExperimentRef, comparisonExperimentRef } = selection;
  if (selectedSourceRef && refIdentity(selectedSourceRef) !== refIdentity(review.sourceRef)) return false;
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
