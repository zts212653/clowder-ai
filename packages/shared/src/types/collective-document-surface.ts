import { z } from 'zod';
import {
  collectiveArtifactCatalogueHistoryPageSchema,
  collectiveArtifactSelectionSchema,
} from './collective-artifact.js';
import { collectiveDocumentViewSchema } from './collective-document-view.js';
import { collectiveProjectArtifactReturnSchema } from './collective-project-artifact-return.js';

const id = z.string().trim().min(1).max(256),
  positive = z.number().int().positive().safe();
export const collectiveDocumentBridgeSchema = z
  .object({
    bridgeId: z.string().min(8).max(120),
    contextId: z.string().min(8).max(120),
    contextRevision: positive,
    serviceInstanceId: id,
    collectiveId: id,
    connectionId: id,
    humanId: id,
  })
  .strict();
export const collectiveDocumentClientReadySchema = collectiveDocumentBridgeSchema
  .extend({ type: z.literal('collective:client-document-ready') })
  .strict();
/** The project-aware Host adapter also acknowledges projectReturn on legacy media V1 refs.
 * A media-only Host never emits this acknowledgement and must receive the original strict media shape. */
export const collectiveDocumentHostReadySchema = collectiveDocumentBridgeSchema
  .extend({ type: z.literal('collective:host-document-ready') })
  .strict();

/** Public locator only. Persisting a tab never grants a Human or owner capability. */
export const collectiveDocumentTargetSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    connectionId: id,
    humanId: id,
    artifactId: id,
    sourceEventId: id,
    channelId: id,
    ownerRevision: positive,
    comparisonOwnerRevision: positive.optional(),
    projectReturn: collectiveProjectArtifactReturnSchema.optional(),
  })
  .strict();
export type CollectiveDocumentTarget = z.infer<typeof collectiveDocumentTargetSchema>;
export const collectiveDocumentRefSchema = collectiveDocumentTargetSchema
  .extend({
    bridgeId: z.string().min(8).max(120),
    contextId: z.string().min(8).max(120),
    contextRevision: positive,
  })
  .strict();
export type CollectiveDocumentRef = z.infer<typeof collectiveDocumentRefSchema>;
export const collectiveDocumentOpenSchema = z
  .object({
    type: z.literal('collective:client-document-open'),
    ref: collectiveDocumentRefSchema,
  })
  .strict();
export const collectiveDocumentOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), ownerRevision: positive }).strict(),
  z.object({ kind: z.literal('history'), offset: z.number().int().nonnegative().max(10000).default(0) }).strict(),
  z
    .object({
      kind: z.literal('stage-selection'),
      selection: collectiveArtifactSelectionSchema,
    })
    .strict(),
]);
export const collectiveDocumentRequestSchema = z
  .object({
    type: z.literal('collective:host-document-request'),
    ref: collectiveDocumentRefSchema,
    requestId: z.string().uuid(),
    operation: collectiveDocumentOperationSchema,
  })
  .strict();
export type CollectiveDocumentRequest = z.infer<typeof collectiveDocumentRequestSchema>;
export const collectiveDocumentResultSchema = z
  .object({
    type: z.literal('collective:client-document-result'),
    ref: collectiveDocumentRefSchema,
    requestId: z.string().uuid(),
    result: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('read'),
          title: z.string().trim().min(1).max(200),
          value: collectiveDocumentViewSchema,
        })
        .strict(),
      z.object({ kind: z.literal('history'), value: collectiveArtifactCatalogueHistoryPageSchema }).strict(),
      z.object({ kind: z.literal('selection_staged') }).strict(),
      z
        .object({
          kind: z.literal('error'),
          code: z.enum(['access_denied', 'owner_unavailable', 'conflict', 'unavailable']),
        })
        .strict(),
    ]),
  })
  .strict();
export type CollectiveDocumentResult = z.infer<typeof collectiveDocumentResultSchema>['result'];
export const collectiveDocumentReturnSchema = z
  .object({
    type: z.literal('collective:host-document-return'),
    ref: collectiveDocumentRefSchema,
    destination: z.enum(['project', 'source', 'discussion']),
  })
  .strict();
export const collectiveDocumentTargetKey = (target: CollectiveDocumentTarget) =>
  JSON.stringify(collectiveDocumentTargetSchema.parse(target));
