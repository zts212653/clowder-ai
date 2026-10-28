import { z } from 'zod';
import {
  assetStatusSchema,
  characterAssetSlotSchema,
  characterAssetUseSchema,
  indexedVersionRefSchema,
} from './asset-canon.js';
import { videoProjectAssetVersionSchema, videoProjectTextSchema } from './video-project-primitives.js';
import { workReferenceSchema } from './work-reference.js';

const text = videoProjectTextSchema;
const revision = z.number().int().nonnegative().safe();
const mutation = { operationId: text(256), reason: text(4000), evidenceRefs: z.array(text(2048)).max(100).default([]) };
const context = z
  .object({ reference: workReferenceSchema, metadataRevision: z.number().int().positive().safe() })
  .strict();
const disposition = z
  .object({
    bindingRef: text(256),
    expectedBindingRevision: revision,
    indexedVersionRef: indexedVersionRefSchema.nullable(),
    expectedAssetRevision: revision.optional(),
    reason: text(4000),
  })
  .strict();
export const assetCanonCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('index-asset'),
      operationId: text(256),
      name: text(1000),
      kind: text(256),
      version: videoProjectAssetVersionSchema,
      applicability: z.array(characterAssetUseSchema).max(100).default([]),
      evidenceRefs: z.array(text(2048)).max(100).default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal('list-assets'),
      purpose: z.enum(['select', 'used']).default('select'),
      reference: workReferenceSchema.optional(),
      metadataRevision: z.number().int().positive().safe().optional(),
      status: assetStatusSchema.optional(),
      includeSuperseded: z.boolean().default(false),
      kind: text(256).optional(),
      use: characterAssetSlotSchema.optional(),
      memberAvatarCatId: text(256).optional(),
      verifyFiles: z.boolean().default(true),
      after: z.number().int().min(0).safe().default(0),
      limit: z.number().int().min(1).max(50).default(30),
      snapshot: text(256).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('read-asset'),
      indexedVersionRef: indexedVersionRefSchema,
      expectedRevision: revision.optional(),
      after: revision.default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal('read-asset-history'),
      indexedVersionRef: indexedVersionRefSchema,
      reference: workReferenceSchema.optional(),
      after: revision.default(0),
      limit: z.number().int().positive().max(50).default(30),
    })
    .strict(),
  z
    .object({
      action: z.literal('set-asset-status'),
      ...mutation,
      indexedVersionRef: indexedVersionRefSchema,
      expectedRevision: revision,
      status: assetStatusSchema,
      applicability: z.array(characterAssetUseSchema).max(100).optional(),
      bindings: z.array(disposition).max(100).default([]),
      context: context.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('supersede-asset'),
      ...mutation,
      mode: z.enum(['replace', 'revoke']),
      fromVersionRef: indexedVersionRefSchema,
      toVersionRef: indexedVersionRefSchema,
      expectedFromRevision: revision,
      expectedToRevision: revision,
      eventRef: text(256).optional(),
      promoteTarget: z.boolean().default(false),
      bindings: z.array(disposition).max(100).default([]),
      context: context.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('bind-character-asset'),
      ...mutation,
      mode: z.enum(['set', 'clear']),
      slot: characterAssetSlotSchema,
      expectedBindingRevision: revision,
      indexedVersionRef: indexedVersionRefSchema.optional(),
      expectedAssetRevision: revision.optional(),
      memberCatId: text(256).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('check-asset-updates'),
      reference: workReferenceSchema,
      metadataRevision: z.number().int().positive().safe().optional(),
      after: z.number().int().nonnegative().safe().default(0),
      limit: z.number().int().positive().max(50).default(30),
    })
    .strict(),
  z
    .object({
      action: z.literal('decide-asset-update'),
      ...mutation,
      reference: workReferenceSchema,
      indexedVersionRef: indexedVersionRefSchema,
      noticeScope: text(256),
      updateFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      expectedDecisionRevision: revision,
      decision: z.literal('keep_this_version'),
    })
    .strict(),
]);
export type AssetCanonCommand = z.infer<typeof assetCanonCommandSchema>;
export type AssetCanonMutation = Extract<AssetCanonCommand, { operationId: string }>;
export type AssetBindingDisposition = z.infer<typeof disposition>;
