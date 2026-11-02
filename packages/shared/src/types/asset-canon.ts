import { z } from 'zod';
import {
  type VideoProjectActor,
  videoProjectActorSchema,
  videoProjectAssetVersionSchema,
  videoProjectTextSchema,
} from './video-project-primitives.js';
import { workReferenceSchema } from './work-reference.js';

const text = videoProjectTextSchema;
export const indexedVersionRefSchema = z.string().regex(/^asset:sha256:[a-f0-9]{64}$/);
export const assetStatusSchema = z.enum(['canonical', 'experimental', 'failed']);
export const characterSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), catId: text(256) }).strict(),
  z.object({ kind: z.literal('series'), seriesKey: text(256), characterKey: text(256) }).strict(),
]);
export const characterAssetUseSchema = z
  .object({
    subjectRef: characterSubjectSchema,
    representation: text(128),
    styleKey: text(256),
    role: z.enum(['avatar', 'portrait', 'action', 'reference']),
    actionKey: text(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.role === 'action') !== (value.actionKey !== undefined))
      ctx.addIssue({ code: 'custom', path: ['actionKey'], message: 'Only action uses require an actionKey' });
  });
export const characterAssetSlotSchema = z.union([
  characterAssetUseSchema,
  z.object({ role: z.literal('member-avatar'), catId: text(256) }).strict(),
]);
export const assetBindingSelectionSchema = z
  .object({
    bindingRef: text(256),
    bindingRevision: z.number().int().positive().safe(),
    indexedVersionRef: indexedVersionRefSchema,
  })
  .strict();
export const assetWorkCoordinateSchema = z
  .object({
    reference: workReferenceSchema,
    metadataRevision: z.number().int().positive().safe(),
    assetId: text(256),
  })
  .strict();
export const assetCanonSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), threadId: text(256).optional() }).strict(),
  assetWorkCoordinateSchema.extend({ kind: z.literal('work'), threadId: text(256) }).strict(),
]);
const judgment = z
  .object({
    actor: videoProjectActorSchema,
    reason: text(4000),
    recordedAt: z.string().datetime(),
    operationId: text(256),
    requestDigest: z.string(),
    evidenceRefs: z.array(text(2048)).max(100),
  })
  .strict();
export const assetCanonRecordSchema = z
  .object({
    indexedVersionRef: indexedVersionRefSchema,
    ownerUserId: text(256),
    name: text(1000),
    kind: text(256),
    version: videoProjectAssetVersionSchema,
    applicability: z.array(characterAssetUseSchema).max(100),
    evidenceRefs: z.array(text(2048)).max(100).optional(),
    creator: videoProjectActorSchema,
    source: assetCanonSourceSchema,
    createdAt: z.string().datetime(),
    revision: z.number().int().nonnegative().safe(),
    status: assetStatusSchema.nullable(),
    judgment: judgment.nullable(),
    supersededBy: z
      .object({ eventRef: text(256), indexedVersionRef: indexedVersionRefSchema })
      .strict()
      .nullable(),
  })
  .strict();
export const characterAssetBindingSchema = z
  .object({
    bindingRef: text(256),
    bindingRevision: z.number().int().positive().safe(),
    ownerUserId: text(256),
    slot: characterAssetSlotSchema,
    indexedVersionRef: indexedVersionRefSchema.nullable(),
    memberCatId: text(256).optional(),
    actor: videoProjectActorSchema,
    reason: text(4000),
    evidenceRefs: z.array(text(2048)).min(1).max(100),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type CharacterAssetUse = z.infer<typeof characterAssetUseSchema>;
export type CharacterAssetSlot = z.infer<typeof characterAssetSlotSchema>;
export type CharacterAssetBinding = z.infer<typeof characterAssetBindingSchema>;
export type AssetCanonRecord = z.infer<typeof assetCanonRecordSchema>;
export type AssetWorkCoordinate = z.infer<typeof assetWorkCoordinateSchema>;
export type AssetBindingSelection = z.infer<typeof assetBindingSelectionSchema>;
export type AssetFileState = 'available' | 'source_changed' | 'source_missing' | 'access_denied' | 'unverified';
export interface AssetCanonItem {
  record: AssetCanonRecord;
  fileState: AssetFileState;
  canWrite: boolean;
  bindings: CharacterAssetBinding[];
  work?: AssetWorkCoordinate;
}
export interface AssetCanonUpdate {
  kind: 'replacement_available' | 'no_longer_canonical' | Exclude<AssetFileState, 'available'>;
  original: AssetCanonItem;
  replacement?: AssetCanonItem;
  reason: string;
  change?: { actor: VideoProjectActor; recordedAt: string };
  changeRef: string;
  uses: string[];
  noticeScope: string;
  updateFingerprint: string;
  decisionRevision: number;
  decision?: AssetUpdateDecision;
}
export interface AssetUpdateDecision {
  reference: { contentRef: string; ownerRevision: number };
  indexedVersionRef: string;
  noticeScope: string;
  updateFingerprint: string;
  observedMetadataRevision: number;
  revision: number;
  decision: 'keep_this_version';
  actor: { kind: 'human' | 'cat'; actorId: string };
  reason: string;
  recordedAt: string;
  operationId: string;
  requestDigest: string;
  evidence: unknown;
}

export interface MemberVisualAssets {
  state: 'unlinked' | 'selected' | 'cleared' | 'unavailable';
  bindingRef?: string;
  bindingRevision: number;
  indexedVersionRef?: string;
}
