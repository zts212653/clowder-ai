import type { AssetCanonMutation, AssetCanonRecord, VideoProjectAssetVersion } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../works/types.js';
import { canonJson, indexedVersionRef } from './identity.js';
import { applyBindingDispositions, assertBindingCompatible, bindCharacterAsset } from './mutations-bindings.js';
import { AssetCanonConflictError, type AssetCanonStore, type CanonReceipt } from './store.js';

export function requireCanonAsset(store: AssetCanonStore, owner: string, ref: string): AssetCanonRecord {
  const record = store.get(owner, ref);
  if (!record) throw new MediaOwnerError('access_denied');
  return record;
}
export function assertAssetWriter(record: AssetCanonRecord, principal: WorkPrincipal) {
  if (
    record.ownerUserId !== principal.userId ||
    (principal.actor.kind !== 'human' &&
      (record.creator.kind !== 'cat' || record.creator.actorId !== principal.actor.actorId))
  )
    throw new MediaOwnerError('access_denied');
}
export function assertCanonRevision(record: AssetCanonRecord, expected: number) {
  if (record.revision !== expected) throw new AssetCanonConflictError('Asset revision conflict');
}
export const currentCanon = (record: AssetCanonRecord) => record.status === 'canonical' && !record.supersededBy;

export function applyCanonMutation(
  store: AssetCanonStore,
  command: Exclude<AssetCanonMutation, { action: 'decide-asset-update' }>,
  principal: WorkPrincipal,
  receipt: CanonReceipt,
  normalizedVersion?: VideoProjectAssetVersion,
) {
  if (command.action === 'index-asset') {
    const version = normalizedVersion ?? command.version;
    receipt.assets.push(
      store.index({
        indexedVersionRef: indexedVersionRef(principal.userId, version),
        ownerUserId: principal.userId,
        name: command.name,
        kind: command.kind,
        version,
        applicability: command.applicability,
        evidenceRefs: command.evidenceRefs,
        creator: principal.actor,
        source: { kind: 'workspace', ...(principal.threadId ? { threadId: principal.threadId } : {}) },
        createdAt: receipt.recordedAt,
        revision: 0,
        status: null,
        judgment: null,
        supersededBy: null,
      }),
    );
    return;
  }
  if (command.action === 'bind-character-asset') {
    receipt.bindings.push(bindCharacterAsset(store, command, principal, receipt));
    return;
  }
  if (command.action === 'set-asset-status') {
    const record = requireCanonAsset(store, principal.userId, command.indexedVersionRef);
    assertAssetWriter(record, principal);
    assertCanonRevision(record, command.expectedRevision);
    const changed: AssetCanonRecord = {
      ...record,
      revision: record.revision + 1,
      status: command.status,
      ...(command.applicability ? { applicability: command.applicability } : {}),
      judgment: {
        actor: principal.actor,
        reason: command.reason,
        recordedAt: receipt.recordedAt,
        operationId: command.operationId,
        requestDigest: receipt.requestDigest,
        evidenceRefs: command.evidenceRefs,
      },
    };
    store.put(changed, 'set-asset-status', {
      operationId: receipt.operationId,
      actor: principal.actor,
      reason: command.reason,
      recordedAt: receipt.recordedAt,
    });
    receipt.assets.push(changed);
    const incompatibleBinding = store.bindings(principal.userId).some((binding) => {
      if (binding.indexedVersionRef !== record.indexedVersionRef) return false;
      try {
        assertBindingCompatible(changed, binding.slot, binding.memberCatId);
        return false;
      } catch (error) {
        if (error instanceof AssetCanonConflictError) return true;
        throw error;
      }
    });
    applyBindingDispositions(
      store,
      command.bindings,
      command.status !== 'canonical' || incompatibleBinding ? [record.indexedVersionRef] : [],
      principal,
      receipt,
    );
    return;
  }
  const from = requireCanonAsset(store, principal.userId, command.fromVersionRef);
  const to = requireCanonAsset(store, principal.userId, command.toVersionRef);
  for (const record of [from, to]) assertAssetWriter(record, principal);
  assertCanonRevision(from, command.expectedFromRevision);
  assertCanonRevision(to, command.expectedToRevision);
  if (from.indexedVersionRef === to.indexedVersionRef) throw new AssetCanonConflictError('Cannot supersede itself');
  if (command.mode === 'revoke') {
    if (
      !command.eventRef ||
      from.supersededBy?.eventRef !== command.eventRef ||
      from.supersededBy.indexedVersionRef !== to.indexedVersionRef
    )
      throw new AssetCanonConflictError('Supersession no longer active');
  } else {
    if (from.supersededBy) throw new AssetCanonConflictError('Asset already has a successor');
    if (!currentCanon(to) && !(command.promoteTarget && !to.supersededBy))
      throw new AssetCanonConflictError('Replacement must be current canonical');
    if (
      from.kind !== to.kind ||
      (from.applicability.length + to.applicability.length > 0 &&
        !from.applicability.some((a) => to.applicability.some((b) => canonJson(a) === canonJson(b))))
    )
      throw new AssetCanonConflictError('Incompatible character, form, style or use');
    let cursor: AssetCanonRecord | null = to;
    const visited = new Set([from.indexedVersionRef]);
    while (cursor) {
      if (visited.has(cursor.indexedVersionRef)) throw new AssetCanonConflictError('Supersession cycle');
      visited.add(cursor.indexedVersionRef);
      cursor = cursor.supersededBy ? store.get(principal.userId, cursor.supersededBy.indexedVersionRef) : null;
    }
  }
  const updatedFrom = {
    ...from,
    revision: from.revision + 1,
    supersededBy:
      command.mode === 'replace'
        ? { eventRef: `supersession:${command.operationId}`, indexedVersionRef: to.indexedVersionRef }
        : null,
  };
  const updatedTo: AssetCanonRecord = {
    ...to,
    revision: to.revision + 1,
    ...(command.mode === 'replace' && command.promoteTarget
      ? {
          status: 'canonical' as const,
          judgment: {
            actor: principal.actor,
            reason: command.reason,
            recordedAt: receipt.recordedAt,
            operationId: command.operationId,
            requestDigest: receipt.requestDigest,
            evidenceRefs: command.evidenceRefs,
          },
        }
      : {}),
  };
  const audit = {
    operationId: receipt.operationId,
    actor: principal.actor,
    reason: command.reason,
    recordedAt: receipt.recordedAt,
  };
  store.put(updatedFrom, command.mode, audit);
  store.put(updatedTo, command.mode, audit);
  receipt.assets.push(updatedFrom, updatedTo);
  applyBindingDispositions(
    store,
    command.bindings,
    command.mode === 'replace' ? [from.indexedVersionRef] : [from.indexedVersionRef, to.indexedVersionRef],
    principal,
    receipt,
    new Map([
      [from.indexedVersionRef, from.revision],
      [to.indexedVersionRef, to.revision],
    ]),
  );
}
