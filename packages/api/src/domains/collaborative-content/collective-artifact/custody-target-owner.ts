import type {
  CollectiveArtifactCustodyTransfer,
  CollectiveCustodyPage,
  CollectiveCustodyReady,
} from '@cat-cafe/shared';
import { validateCollectiveArtifactCustodyBundle } from './custody-bundle.js';
import { type CollectiveArtifactTransferJournal, type CollectiveCustodyJournalEntry } from './custody-journal.js';
import {
  assertTransferBundle,
  authorizeTransfer,
  type CollectiveCustodyOwners,
  custodyFenceBinding,
  requirePrepared,
  transferProofRef,
} from './custody-owner-support.js';
import type { CollectiveCustodyOwnerAuthority } from './owner-port.js';

/** Target stages all bytes invisibly; only canonical Service commit permits installation and final activation. */
export class CollectiveArtifactTargetOwner {
  constructor(
    private readonly stores: CollectiveCustodyOwners,
    private readonly journal: CollectiveArtifactTransferJournal,
  ) {}
  async stage(
    transfer: CollectiveArtifactCustodyTransfer,
    page: CollectiveCustodyPage,
    authority: CollectiveCustodyOwnerAuthority,
  ) {
    const fresh = await authorizeTransfer(transfer, authority, 'stageTarget');
    const prepared = fresh.prepared;
    if (fresh.state !== 'source_prepared' || !prepared) throw new Error('Collective target phase changed');
    const entry = {
      transfer: fresh,
      role: 'target' as const,
      phase: 'target_staging' as const,
      scopeRef: prepared.ownerScopeRef,
      manifest: prepared.manifest,
      preparedRef: prepared.preparedRef,
    };
    this.journal.validatePage(entry, page);
    await this.stores.owner.collectiveCustody.fence.stageTarget(
      custodyFenceBinding(fresh, prepared.ownerScopeRef, true),
      async () => {
        await authorizeTransfer(fresh, authority, 'stageTarget');
      },
    );
    this.journal.stage(entry, page);
  }
  async ready(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyReady> {
    const fresh = await authorizeTransfer(transfer, authority, 'attestReady');
    if (fresh.state !== 'source_prepared') throw new Error('Collective target phase changed');
    const entry = this.requireEntry(fresh);
    requirePrepared(entry, fresh);
    const readyRef = transferProofRef('ready', [
      fresh.transferId,
      fresh.targetEndpointId,
      entry.manifest.digest,
      entry.scopeRef,
    ]);
    if (entry.phase === 'target_ready')
      return {
        readyRef,
        preparedRef: entry.preparedRef,
        manifestDigest: entry.manifest.digest,
        ownerScopeRef: entry.scopeRef,
      };
    if (entry.phase !== 'target_staging') throw new Error('Collective target is not staging');
    const bundle = this.bundle(fresh, entry);
    await this.stores.owner.collectiveCustody.assertTargetAvailable(bundle.content, entry.scopeRef);
    if (bundle.review)
      this.stores.reviews.collectiveCustody.assertTargetAvailable(
        bundle.review,
        entry.scopeRef,
        fresh.version.contentRef,
        this.stores.ownerUserId,
      );
    this.stores.modifications.collectiveCustody.assertTargetAvailable(
      bundle.modifications,
      entry.scopeRef,
      fresh.version.contentRef,
      this.stores.ownerUserId,
    );
    await authorizeTransfer(fresh, authority, 'attestReady');
    this.journal.advance(fresh, ['target_staging'], 'target_ready', readyRef);
    return {
      readyRef,
      preparedRef: entry.preparedRef,
      manifestDigest: entry.manifest.digest,
      ownerScopeRef: entry.scopeRef,
    };
  }
  async finalize(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority) {
    const fresh = await authorizeTransfer(transfer, authority, 'finalize');
    const entry = this.journal.get(fresh);
    if (!entry && fresh.state === 'cancelled') return;
    if (!entry || entry.role !== 'target') throw new Error('Collective target journal unavailable');
    const binding = custodyFenceBinding(fresh, entry.scopeRef, true);
    const authorize = async () => {
      await authorizeTransfer(fresh, authority, 'finalize');
    };
    if (fresh.state === 'cancelled') {
      if (entry.phase === 'cancelled') return;
      await this.stores.owner.collectiveCustody.fence.cancelTarget(binding, authorize);
      this.journal.advance(fresh, ['target_staging', 'target_ready'], 'cancelled');
      return;
    }
    if (fresh.state !== 'committed') throw new Error('Collective target has no canonical commit');
    requirePrepared(entry, fresh);
    if (fresh.ready?.readyRef !== entry.readyRef) throw new Error('Collective target ready proof changed');
    if (entry.phase === 'target_active') return;
    const bundle = this.bundle(fresh, entry);
    if (entry.phase === 'target_ready') {
      await this.stores.owner.collectiveCustody.installSnapshot(bundle.content, entry.scopeRef, authorize);
      await authorize();
      if (bundle.review)
        this.stores.reviews.collectiveCustody.installSnapshot(
          bundle.review,
          entry.scopeRef,
          fresh.version.contentRef,
          this.stores.ownerUserId,
        );
      this.stores.modifications.collectiveCustody.installSnapshot(
        bundle.modifications,
        entry.scopeRef,
        fresh.version.contentRef,
        this.stores.ownerUserId,
      );
      this.journal.advance(fresh, ['target_ready'], 'target_installed');
    } else if (entry.phase !== 'target_installed') throw new Error('Collective target cannot activate');
    await this.stores.owner.collectiveCustody.fence.activateTarget({ ...binding, ...fresh.version }, authorize);
    this.journal.advance(fresh, ['target_installed'], 'target_active');
  }
  private requireEntry(transfer: CollectiveArtifactCustodyTransfer): CollectiveCustodyJournalEntry {
    const entry = this.journal.get(transfer);
    if (!entry || entry.role !== 'target') throw new Error('Collective target journal unavailable');
    return entry;
  }
  private bundle(transfer: CollectiveArtifactCustodyTransfer, entry: CollectiveCustodyJournalEntry) {
    const bundle = validateCollectiveArtifactCustodyBundle(
      JSON.parse(this.journal.targetBytes(transfer).toString('utf8')),
      entry.scopeRef,
      transfer.version.contentRef,
    );
    assertTransferBundle(transfer, bundle);
    return bundle;
  }
}
