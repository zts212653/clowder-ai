import type {
  AssetCanonCommand,
  AssetCanonItem,
  AssetCanonUpdate,
  AssetUpdateDecision,
  WorkContextRecord,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../works/types.js';
import { authorizeAssetDecision } from './decision-access.js';
import { canonDigest, canonJson, indexedVersionRef } from './identity.js';
import { requireCanonAsset } from './mutations.js';
import { noticeEvidence } from './notices.js';
import { CanonReadScope } from './read-scope.js';
import type { AssetCanonService } from './service.js';
import { AssetCanonConflictError } from './store.js';
import { readUsedItem } from './used.js';

export async function checkAssetUpdates(
  service: AssetCanonService,
  command: Extract<AssetCanonCommand, { action: 'check-asset-updates' }>,
  principal: WorkPrincipal,
) {
  const metadata = await service.metadata(command, principal);
  const reads = new CanonReadScope(service.deps.contexts, principal, metadata);
  const snapshot = service.deps.store.snapshot(principal.userId);
  const items: AssetCanonItem[] = [];
  for (let i = command.after; i < Math.min(metadata.context.assets.length, command.after + command.limit); i++) {
    const row = metadata.context.assets[i]!;
    const version = row.asset.versions.find((v) => v.id === row.versionId)!;
    const record = service.deps.store.get(principal.userId, indexedVersionRef(principal.userId, version));
    if (!record || (!record.status && !record.supersededBy && !row.bindingSelection)) continue;
    items.push(await readUsedItem(service.access, record, metadata, i, principal, true, reads));
  }
  const updates: AssetCanonUpdate[] = [];
  const kept: AssetCanonUpdate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const row = metadata.context.assets.find((r) => r.asset.id === item.work!.assetId)!;
    const rawOriginal = requireCanonAsset(service.deps.store, principal.userId, item.record.indexedVersionRef);
    if (item.fileState !== 'available')
      updates.push({
        kind: item.fileState,
        original: item,
        reason: item.fileState,
        uses: row.uses,
        changeRef: item.fileState,
        noticeScope: 'file',
        updateFingerprint: canonDigest([item.record.indexedVersionRef, item.fileState]),
        decisionRevision: 0,
      });
    for (const notice of noticeEvidence(service.deps.store, principal.userId, metadata, row, rawOriginal)) {
      const key = `${notice.noticeScope}:${notice.updateFingerprint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let replacement: AssetCanonItem | undefined;
      let kind: AssetCanonUpdate['kind'] = 'no_longer_canonical';
      let reason = notice.reason;
      let canReadChain = true;
      for (const ref of notice.versionRefs) {
        try {
          await service.access.authorize(
            requireCanonAsset(service.deps.store, principal.userId, ref),
            principal,
            false,
            reads,
          );
        } catch (error) {
          if (!(error instanceof MediaOwnerError && error.code === 'access_denied')) throw error;
          canReadChain = false;
        }
      }
      if (!canReadChain) {
        kind = 'access_denied';
        reason = '相关取代记录当前不可读取';
      } else if (notice.replacement) {
        try {
          replacement = await service.access.item(notice.replacement, principal, { reads });
          kind = replacement.fileState === 'available' ? 'replacement_available' : replacement.fileState;
        } catch (error) {
          if (!(error instanceof MediaOwnerError && error.code === 'access_denied')) throw error;
          kind = 'access_denied';
          reason = '替代件当前不可读取';
        }
      }
      const previous = service.deps.store
        .decisions(principal.userId, metadata.reference, item.record.indexedVersionRef)
        .filter((d) => d.noticeScope === notice.noticeScope)
        .at(-1);
      const decision = previous?.updateFingerprint === notice.updateFingerprint ? previous : undefined;
      const update: AssetCanonUpdate = {
        kind,
        original: item,
        ...(replacement ? { replacement } : {}),
        reason,
        ...(canReadChain && notice.change ? { change: notice.change } : {}),
        changeRef: notice.updateFingerprint,
        uses: row.uses,
        noticeScope: notice.noticeScope,
        updateFingerprint: notice.updateFingerprint,
        decisionRevision: previous?.revision ?? 0,
        ...(decision && kind !== 'access_denied' ? { decision: { ...decision, evidence: undefined } } : {}),
      };
      if (decision && (kind === 'replacement_available' || kind === 'no_longer_canonical')) kept.push(update);
      else updates.push(update);
    }
  }
  await reads.revalidate();
  await service.deps.authorize(principal);
  if (snapshot !== service.deps.store.snapshot(principal.userId))
    throw new AssetCanonConflictError('Asset update snapshot changed');
  return {
    reference: metadata.reference,
    metadataRevision: metadata.metadataRevision,
    items,
    updates,
    kept,
    snapshot: canonDigest([metadata.reference, metadata.metadataRevision, snapshot]),
    ...(command.after + command.limit < metadata.context.assets.length
      ? { nextAfter: command.after + command.limit }
      : {}),
  };
}

export async function decideAssetUpdate(
  service: AssetCanonService,
  command: Extract<AssetCanonCommand, { action: 'decide-asset-update' }>,
  principal: WorkPrincipal,
) {
  if (principal.actor.kind !== 'human' || principal.invocationId) throw new MediaOwnerError('access_denied');
  await service.deps.authorizeWork(command.reference, principal, 'write');
  const original = requireCanonAsset(service.deps.store, principal.userId, command.indexedVersionRef);
  await service.access.authorize(original, principal);
  // Replays are authorized before inspecting today's notice. A later C never rewrites an earlier A→B receipt.
  const replay = service.deps.store.replay(command, principal);
  if (replay) {
    if (replay.decision) await authorizeAssetDecision(service.access, replay.decision, principal);
    return replay;
  }
  const metadata = await service.metadata(command, principal);
  const findNotice = (record: WorkContextRecord) => {
    const row = record.context.assets.find((r) => {
      const version = r.asset.versions.find((v) => v.id === r.versionId)!;
      return (
        indexedVersionRef(principal.userId, version) === command.indexedVersionRef &&
        (command.noticeScope === 'asset' || r.bindingSelection?.bindingRef === command.noticeScope)
      );
    });
    if (!row) throw new AssetCanonConflictError('This version no longer uses this asset or binding');
    const notice = noticeEvidence(
      service.deps.store,
      principal.userId,
      record,
      row,
      requireCanonAsset(service.deps.store, principal.userId, command.indexedVersionRef),
    ).find((n) => n.noticeScope === command.noticeScope && n.updateFingerprint === command.updateFingerprint);
    if (!notice) throw new AssetCanonConflictError('Asset update changed; review the new prompt');
    return notice;
  };
  const observed = findNotice(metadata);
  for (const ref of observed.versionRefs)
    await service.access.authorize(requireCanonAsset(service.deps.store, principal.userId, ref), principal);
  if (observed.replacement) {
    const replacement = await service.access.item(observed.replacement, principal);
    if (replacement.fileState !== 'available') throw new AssetCanonConflictError('Replacement is unavailable');
  }
  await service.deps.authorizeWork(command.reference, principal, 'write');
  return service.deps.store.transact(command, principal, (receipt) => {
    const current = service.deps.contextStore.get(principal.userId, command.reference);
    if (!current || canonJson(current.context.sourceBinding) !== canonJson(metadata.context.sourceBinding))
      throw new AssetCanonConflictError('Work source changed');
    const notice = findNotice(current);
    const previous = service.deps.store
      .decisions(principal.userId, command.reference, command.indexedVersionRef)
      .filter((d) => d.noticeScope === command.noticeScope)
      .at(-1);
    if ((previous?.revision ?? 0) !== command.expectedDecisionRevision)
      throw new AssetCanonConflictError('Decision revision conflict');
    const decision: AssetUpdateDecision = {
      reference: command.reference,
      indexedVersionRef: command.indexedVersionRef,
      noticeScope: command.noticeScope,
      updateFingerprint: command.updateFingerprint,
      observedMetadataRevision: current.metadataRevision,
      revision: command.expectedDecisionRevision + 1,
      decision: command.decision,
      actor: principal.actor,
      reason: command.reason,
      recordedAt: receipt.recordedAt,
      operationId: command.operationId,
      requestDigest: receipt.requestDigest,
      evidence: { notice: notice.evidence, versionRefs: notice.versionRefs },
    };
    service.deps.store.saveDecision(principal.userId, decision);
    receipt.decision = decision;
  });
}
