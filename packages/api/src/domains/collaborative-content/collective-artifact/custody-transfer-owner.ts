import { isDeepStrictEqual } from 'node:util';
import {
  COLLECTIVE_CUSTODY_PAGE_BYTES,
  type CollectiveArtifactCustodyTransfer,
  type CollectiveCustodyPage,
  type CollectiveCustodyPrepared,
  collectiveCustodyPageSchema,
} from '@cat-cafe/shared';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import { digestBytes } from '../../video-studio/content-owner/store.js';
import { validateCollectiveArtifactCustodyBundle } from './custody-bundle.js';
import { CollectiveArtifactTransferJournal } from './custody-journal.js';
import {
  assertTransferBundle,
  assertTransferScope,
  authorizeTransfer,
  type CollectiveCustodyOwners,
  custodyFenceBinding,
  preparedProof,
  requirePrepared,
  transferProofRef,
} from './custody-owner-support.js';
import { CollectiveArtifactTargetOwner } from './custody-target-owner.js';
import { reconcileCollectiveDisposition } from './markdown-modification-apply.js';
import type { CollectiveArtifactCustodyTransferPort, CollectiveCustodyOwnerAuthority } from './owner-port.js';

export class CollectiveArtifactTransferOwner implements CollectiveArtifactCustodyTransferPort {
  private readonly journal: CollectiveArtifactTransferJournal;
  private readonly target: CollectiveArtifactTargetOwner;
  constructor(
    private readonly stores: CollectiveCustodyOwners,
    dataDir: string,
  ) {
    this.journal = new CollectiveArtifactTransferJournal(dataDir);
    this.target = new CollectiveArtifactTargetOwner(stores, this.journal);
  }
  prepareSource(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPrepared> {
    return this.stores.scopeQueue.run(transfer.version.contentRef, () => this.prepare(transfer, authority));
  }
  private async prepare(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPrepared> {
    const fresh = await authorizeTransfer(transfer, authority, 'prepareSource');
    if (fresh.state !== 'offered') throw new Error('Collective source preparation phase changed');
    const contentRef = fresh.version.contentRef;
    const described = await this.stores.owner.describe(contentRef);
    if (!described.collectiveScope) throw new Error('Collective source scope missing');
    assertTransferScope(fresh, described.collectiveScope);
    const scopeRef = collectiveContentScopeRef(described.collectiveScope);
    const binding = custodyFenceBinding(fresh, scopeRef);
    const old = this.journal.get(fresh);
    if (old?.phase === 'source_prepared') {
      const fence = await this.stores.owner.collectiveCustody.fence.read(contentRef);
      if (fence?.state !== 'source_frozen' || fence.transferId !== fresh.transferId)
        throw new Error('Collective source fence unavailable');
      if (!isDeepStrictEqual(old.transfer.version, fresh.version)) throw new Error('Collective source version changed');
      return preparedProof(old);
    }
    await this.stores.owner.collectiveCustody.fence.freezeSource({ ...binding, ...fresh.version }, async () => {
      await authorizeTransfer(fresh, authority, 'prepareSource');
    });
    const modifications = this.stores.modifications.collectiveCustody.exportSnapshot(scopeRef, contentRef);
    for (const disposition of modifications.dispositions)
      if (disposition.state === 'pending') await reconcileCollectiveDisposition(disposition.intent, this.stores);
    this.stores.modifications.requests.collective.terminalizeForTransfer(
      scopeRef,
      fresh.transferId,
      fresh.expectedCustodyRevision,
    );
    const bundle = validateCollectiveArtifactCustodyBundle(
      {
        v: 1,
        content: await this.stores.owner.collectiveCustody.exportSnapshot(contentRef, scopeRef),
        review: this.stores.reviews.collectiveCustody.exportSnapshot(contentRef, scopeRef),
        modifications: this.stores.modifications.collectiveCustody.exportSnapshot(scopeRef, contentRef),
      },
      scopeRef,
      contentRef,
    );
    assertTransferBundle(fresh, bundle);
    const bytes = Buffer.from(JSON.stringify(bundle));
    const manifest = {
      digest: digestBytes(bytes),
      totalBytes: bytes.byteLength,
      pageCount: Math.ceil(bytes.byteLength / COLLECTIVE_CUSTODY_PAGE_BYTES),
    };
    const preparedRef = transferProofRef('prepared', [fresh.transferId, manifest.digest, scopeRef, fresh.version]);
    const entry = {
      transfer: fresh,
      role: 'source' as const,
      phase: 'source_archived' as const,
      manifest,
      preparedRef,
      scopeRef,
    };
    this.journal.saveSource(entry, bytes);
    this.journal.advance(fresh, ['source_archived'], 'source_prepared');
    return preparedProof(entry);
  }
  readPage(
    transfer: CollectiveArtifactCustodyTransfer,
    index: number,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPage> {
    return this.stores.scopeQueue.run(transfer.version.contentRef, async () => {
      const fresh = await authorizeTransfer(transfer, authority, 'readPage');
      const entry = this.journal.get(fresh);
      if (!entry || entry.role !== 'source' || entry.phase !== 'source_prepared')
        throw new Error('Collective source archive unavailable');
      requirePrepared(entry, fresh);
      const fence = await this.stores.owner.collectiveCustody.fence.read(fresh.version.contentRef);
      if (fence?.state !== 'source_frozen' || fence.transferId !== fresh.transferId)
        throw new Error('Collective source fence unavailable');
      if (!Number.isSafeInteger(index) || index < 0 || index >= entry.manifest.pageCount)
        throw new Error('Collective page out of range');
      const bytes = this.journal
        .sourceBytes(fresh)
        .subarray(index * COLLECTIVE_CUSTODY_PAGE_BYTES, (index + 1) * COLLECTIVE_CUSTODY_PAGE_BYTES);
      await authorizeTransfer(fresh, authority, 'readPage');
      return collectiveCustodyPageSchema.parse({
        transferId: fresh.transferId,
        index,
        digest: digestBytes(bytes),
        base64: bytes.toString('base64'),
      });
    });
  }
  stageTarget(...args: Parameters<CollectiveArtifactCustodyTransferPort['stageTarget']>) {
    return this.stores.scopeQueue.run(args[0].version.contentRef, () => this.target.stage(...args));
  }
  attestReady(...args: Parameters<CollectiveArtifactCustodyTransferPort['attestReady']>) {
    return this.stores.scopeQueue.run(args[0].version.contentRef, () => this.target.ready(...args));
  }
  finalize(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority) {
    return this.stores.scopeQueue.run(transfer.version.contentRef, async () => {
      const fresh = await authorizeTransfer(transfer, authority, 'finalize');
      const entry = this.journal.get(fresh);
      if (!entry && fresh.state === 'cancelled') return this.cancelOrphanFence(fresh, authority);
      if (!entry) throw new Error('Collective transfer journal unavailable');
      if (entry.role === 'target') return this.target.finalize(fresh, authority);
      if (entry.phase === 'cancelled' || entry.phase === 'source_retired') return;
      if (fresh.state !== 'committed' && fresh.state !== 'cancelled')
        throw new Error('Collective transfer has no terminal truth');
      await this.stores.owner.collectiveCustody.fence.finalizeSource(
        custodyFenceBinding(fresh, entry.scopeRef),
        fresh.state,
        async () => {
          await authorizeTransfer(fresh, authority, 'finalize');
        },
      );
      this.journal.advance(
        fresh,
        ['source_archived', 'source_prepared'],
        fresh.state === 'committed' ? 'source_retired' : 'cancelled',
      );
    });
  }
  private async cancelOrphanFence(
    fresh: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ) {
    const fence = this.stores.owner.collectiveCustody.fence;
    const orphan = await fence.read(fresh.version.contentRef);
    if (!orphan || orphan.transferId !== fresh.transferId) return;
    const authorize = async () => {
      await authorizeTransfer(fresh, authority, 'finalize');
    };
    if (orphan.state === 'source_frozen')
      await fence.finalizeSource(custodyFenceBinding(fresh, orphan.scopeRef), 'cancelled', authorize);
    if (orphan.state === 'target_staging')
      await fence.cancelTarget(custodyFenceBinding(fresh, orphan.scopeRef, true), authorize);
  }
}
