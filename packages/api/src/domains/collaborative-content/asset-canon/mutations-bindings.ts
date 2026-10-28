import type {
  AssetBindingDisposition,
  AssetCanonMutation,
  AssetCanonRecord,
  CharacterAssetBinding,
  CharacterAssetSlot,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../works/types.js';
import { canonJson, characterBindingRef } from './identity.js';
import { assertCanonRevision, currentCanon, requireCanonAsset } from './mutations.js';
import { AssetCanonConflictError, type AssetCanonStore, type CanonReceipt } from './store.js';

function assertHuman(principal: WorkPrincipal) {
  if (principal.actor.kind !== 'human' || principal.invocationId) throw new MediaOwnerError('access_denied');
}
export function assertBindingCompatible(asset: AssetCanonRecord, slot: CharacterAssetSlot, memberCatId?: string) {
  if (!currentCanon(asset)) throw new AssetCanonConflictError('Binding target must be current canonical');
  if (slot.role === 'member-avatar') {
    if (!/^image\//.test(asset.version.mediaType)) throw new AssetCanonConflictError('Avatar must be an image');
    if (
      !asset.applicability.some(
        (use) =>
          use.role === 'avatar' &&
          (use.subjectRef.kind === 'member' ? use.subjectRef.catId === slot.catId : memberCatId === slot.catId),
      )
    )
      throw new AssetCanonConflictError('An avatar requires this member’s explicit avatar use');
  } else if (!asset.applicability.some((use) => canonJson(use) === canonJson(slot)))
    throw new AssetCanonConflictError('Character, form, style and use must match');
}
export function bindCharacterAsset(
  store: AssetCanonStore,
  command: Extract<AssetCanonMutation, { action: 'bind-character-asset' }>,
  principal: WorkPrincipal,
  receipt: CanonReceipt,
): CharacterAssetBinding {
  assertHuman(principal);
  const bindingRef = characterBindingRef(principal.userId, command.slot);
  const before = store.binding(principal.userId, bindingRef);
  if ((before?.bindingRevision ?? 0) !== command.expectedBindingRevision)
    throw new AssetCanonConflictError('Binding revision conflict');
  if (!command.evidenceRefs.length) throw new AssetCanonConflictError('Binding requires original selection evidence');
  if (command.mode === 'set') {
    if (!command.indexedVersionRef || command.expectedAssetRevision === undefined)
      throw new AssetCanonConflictError('Binding requires exact asset revision');
    const asset = requireCanonAsset(store, principal.userId, command.indexedVersionRef);
    assertCanonRevision(asset, command.expectedAssetRevision);
    assertBindingCompatible(asset, command.slot, command.memberCatId);
  } else if (command.indexedVersionRef || command.expectedAssetRevision !== undefined)
    throw new AssetCanonConflictError('Clear cannot silently select another asset');
  const binding: CharacterAssetBinding = {
    bindingRef,
    ownerUserId: principal.userId,
    bindingRevision: command.expectedBindingRevision + 1,
    slot: command.slot,
    indexedVersionRef: command.mode === 'set' ? command.indexedVersionRef! : null,
    ...(command.memberCatId ? { memberCatId: command.memberCatId } : {}),
    actor: principal.actor,
    reason: command.reason,
    evidenceRefs: command.evidenceRefs,
    recordedAt: receipt.recordedAt,
  };
  store.putBinding(binding, command.mode);
  return binding;
}
export function applyBindingDispositions(
  store: AssetCanonStore,
  dispositions: AssetBindingDisposition[],
  affectedRefs: string[],
  principal: WorkPrincipal,
  receipt: CanonReceipt,
  beforeRevisions: ReadonlyMap<string, number> = new Map(),
) {
  const affected = store
    .bindings(principal.userId)
    .filter((b) => b.indexedVersionRef && affectedRefs.includes(b.indexedVersionRef));
  if (new Set(dispositions.map((d) => d.bindingRef)).size !== dispositions.length)
    throw new AssetCanonConflictError('Duplicate binding disposition');
  if (affected.some((b) => !dispositions.some((d) => d.bindingRef === b.bindingRef)))
    throw new AssetCanonConflictError('Every affected binding needs explicit disposition');
  if (dispositions.length) assertHuman(principal);
  for (const disposition of dispositions) {
    const before = store.binding(principal.userId, disposition.bindingRef);
    if (!before || before.bindingRevision !== disposition.expectedBindingRevision)
      throw new AssetCanonConflictError('Binding revision conflict');
    if (disposition.indexedVersionRef) {
      const target = requireCanonAsset(store, principal.userId, disposition.indexedVersionRef);
      if (disposition.expectedAssetRevision === undefined)
        throw new AssetCanonConflictError('Disposition requires exact asset revision');
      if ((beforeRevisions.get(target.indexedVersionRef) ?? target.revision) !== disposition.expectedAssetRevision)
        throw new AssetCanonConflictError('Asset revision conflict');
      assertBindingCompatible(target, before.slot, before.memberCatId);
    }
    const next: CharacterAssetBinding = {
      ...before,
      bindingRevision: before.bindingRevision + 1,
      indexedVersionRef: disposition.indexedVersionRef,
      actor: principal.actor,
      reason: disposition.reason,
      recordedAt: receipt.recordedAt,
    };
    store.putBinding(next, 'disposition');
    receipt.bindings.push(next);
  }
}
