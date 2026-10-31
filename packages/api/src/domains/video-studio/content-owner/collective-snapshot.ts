import { isDeepStrictEqual } from 'node:util';
import { COLLECTIVE_CUSTODY_MAX_BYTES } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  collectiveContentOperationContextSchema,
  collectiveContentScopeRef,
  collectiveContentScopeSchema,
} from './collective-scope.js';
import { createReceiptId, operationFingerprint } from './operation-identity.js';
import { type ProjectContentStateV1, parseProjectContentState } from './state/manifest.js';
import { digestBytes, type ProjectContentOwnerStore } from './store.js';

const id = z.string().min(1).max(512);
const positive = z.number().int().positive().safe();
const digest = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value),
);
const actor = z.object({ kind: z.enum(['human', 'cat']), actorId: id }).strict();
const revision = z
  .object({
    contentRef: id,
    ownerRevision: positive,
    blobDigest: digest,
    byteLength: z.number().int().nonnegative().max(65536),
    mediaType: z.literal('text/markdown'),
    parentRevision: z.number().int().nonnegative().nullable(),
    committedBy: actor,
    operationId: id,
    committedAt: z.string().datetime(),
  })
  .strict();
export const collectiveContentReceiptSchema = z
  .object({
    receiptId: id,
    contentRef: id,
    previousOwnerRevision: z.number().int().nonnegative(),
    ownerRevision: positive,
    blobDigest: digest,
    actor,
    operationId: id,
    outboxSequence: positive,
    operationContext: collectiveContentOperationContextSchema,
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentRef: id,
    mediaType: z.literal('text/markdown'),
    currentOwnerRevision: positive.max(10000),
    collectiveScope: collectiveContentScopeSchema,
    revisions: z.array(revision).min(1).max(10000),
    receipts: z.array(collectiveContentReceiptSchema).min(1).max(10000),
    operations: z.record(id, z.object({ fingerprint: digest, receiptId: id }).strict()),
  })
  .strict();
const snapshotSchema = z
  .object({
    v: z.literal(1),
    manifest: manifestSchema,
    blobs: z
      .array(z.object({ digest, base64: z.string().max(87384) }).strict())
      .min(1)
      .max(10000),
  })
  .strict();
export interface CollectiveContentSnapshot {
  v: 1;
  manifest: ProjectContentStateV1 & { collectiveScope: z.infer<typeof collectiveContentScopeSchema> };
  blobs: { digest: string; base64: string }[];
}

/** Strictly validate transport shape without reordering the historical manifest's fingerprint preimages. */
export function validateCollectiveContentSnapshot(unsafe: unknown, scopeRef: string): CollectiveContentSnapshot {
  const serialized = JSON.stringify(unsafe);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > COLLECTIVE_CUSTODY_MAX_BYTES)
    throw new Error('Collective snapshot exceeds its admitted bound');
  const validated = snapshotSchema.parse(unsafe);
  const original = JSON.parse(serialized) as { manifest: unknown };
  const manifest = parseProjectContentState(JSON.stringify(original.manifest), validated.manifest.contentRef);
  if (!manifest.collectiveScope || collectiveContentScopeRef(manifest.collectiveScope) !== scopeRef)
    throw new Error('Collective snapshot scope mismatch');
  validateSnapshotBlobs(manifest, validated.blobs);
  validateSnapshotReceipts(manifest);
  return { v: 1, manifest: { ...manifest, collectiveScope: manifest.collectiveScope }, blobs: validated.blobs };
}

function validateSnapshotBlobs(manifest: ProjectContentStateV1, blobs: CollectiveContentSnapshot['blobs']) {
  const byDigest = new Map<string, Buffer>();
  for (const blob of blobs) {
    const bytes = Buffer.from(blob.base64, 'base64');
    if (
      byDigest.has(blob.digest) ||
      bytes.toString('base64') !== blob.base64 ||
      digestBytes(bytes) !== blob.digest ||
      bytes.byteLength > 65536
    )
      throw new Error('Invalid Collective revision blob');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    byDigest.set(blob.digest, bytes);
  }
  const referenced = new Set<string>();
  for (const item of manifest.revisions) {
    if (byDigest.get(item.blobDigest)?.byteLength !== item.byteLength)
      throw new Error('Missing or inconsistent Collective revision blob');
    referenced.add(item.blobDigest);
  }
  if (referenced.size !== blobs.length) throw new Error('Unreferenced Collective snapshot blob');
}

function validateSnapshotReceipts(manifest: ProjectContentStateV1) {
  const scope = manifest.collectiveScope;
  if (!scope) throw new Error('Collective scope is required');
  const scopeRef = collectiveContentScopeRef(scope);
  for (const receipt of manifest.receipts) {
    const context = receipt.operationContext;
    if (
      receipt.actor.kind !== 'human' ||
      (receipt.previousOwnerRevision === 0 && receipt.actor.actorId !== scope.publishedByHumanId)
    )
      throw new Error('Collective receipt publisher mismatch');
    if (
      context?.kind !==
        (receipt.previousOwnerRevision === 0 ? 'collective-artifact:publish' : 'collective-artifact:apply') ||
      context.scopeRef !== scopeRef ||
      context.actorHumanId !== receipt.actor.actorId
    )
      throw new Error('Collective receipt authority mismatch');
    const expected = operationFingerprint({
      contentRef: manifest.contentRef,
      expectedOwnerRevision: receipt.previousOwnerRevision,
      blobDigest: receipt.blobDigest,
      mediaType: manifest.mediaType,
      actor: receipt.actor,
      operationContext: context,
      collectiveScope: scope,
      publicationScope: undefined,
      projectScope: undefined,
      sourcePublication: undefined,
    });
    if (
      manifest.operations[receipt.operationId]?.fingerprint !== expected ||
      createReceiptId(manifest.contentRef, receipt.operationId, receipt.ownerRevision, receipt.blobDigest) !==
        receipt.receiptId
    )
      throw new Error('Collective receipt fingerprint mismatch');
  }
}

/** Internal typed owner capability; no raw store path, generic import, or private publication data crosses it. */
export class CollectiveContentCustody {
  readonly fence: ProjectContentOwnerStore['collectiveFence'];
  constructor(private readonly store: ProjectContentOwnerStore) {
    this.fence = store.collectiveFence;
  }
  validateSnapshot(unsafe: unknown, scopeRef: string) {
    return validateCollectiveContentSnapshot(unsafe, scopeRef);
  }
  async assertTargetAvailable(unsafe: unknown, scopeRef: string): Promise<CollectiveContentSnapshot> {
    const snapshot = this.validateSnapshot(unsafe, scopeRef);
    return this.store.withContentLock(snapshot.manifest.contentRef, async () => {
      if (await this.store.readState(snapshot.manifest.contentRef))
        throw new Error('Collective target content collision');
      return snapshot;
    });
  }

  /** Called only by the committed transfer's activation fence; never rebuild history through ordinary settle. */
  async installSnapshot(unsafe: unknown, scopeRef: string, authorizeEffect: () => Promise<void>): Promise<void> {
    const snapshot = this.validateSnapshot(unsafe, scopeRef);
    const { contentRef } = snapshot.manifest;
    await this.store.withContentLock(contentRef, async () => {
      await authorizeEffect();
      const existing = await this.store.readState(contentRef);
      if (existing && !isDeepStrictEqual(existing, snapshot.manifest))
        throw new Error('Collective target content collision');
      for (const blob of snapshot.blobs) {
        await this.store.writeBlob(contentRef, blob.digest as `sha256:${string}`, Buffer.from(blob.base64, 'base64'));
        await this.store.readBlob(contentRef, blob.digest as `sha256:${string}`);
      }
      if (!existing) await this.store.writeState(contentRef, snapshot.manifest, authorizeEffect);
    });
  }
  async exportSnapshot(contentRef: string, scopeRef: string): Promise<CollectiveContentSnapshot> {
    return this.store.withContentLock(contentRef, async () => {
      const manifest = await this.store.readState(contentRef);
      if (!manifest?.collectiveScope || collectiveContentScopeRef(manifest.collectiveScope) !== scopeRef)
        throw new Error('Collective snapshot scope mismatch');
      let budget = Buffer.byteLength(JSON.stringify(manifest));
      const blobs: CollectiveContentSnapshot['blobs'] = [];
      const seen = new Set<string>();
      for (const item of manifest.revisions) {
        if (seen.has(item.blobDigest)) continue;
        budget += Math.ceil(item.byteLength / 3) * 4 + 128;
        if (budget > COLLECTIVE_CUSTODY_MAX_BYTES) throw new Error('Collective snapshot exceeds its admitted bound');
        const bytes = await this.store.readBlob(contentRef, item.blobDigest);
        blobs.push({ digest: item.blobDigest, base64: bytes.toString('base64') });
        seen.add(item.blobDigest);
      }
      return validateCollectiveContentSnapshot({ v: 1, manifest, blobs }, scopeRef);
    });
  }
}
